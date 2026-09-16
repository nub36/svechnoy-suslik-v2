/**
 * V2.2 TRAIN driver — 7-arm ablation across 15m/30m/1h/4h (Amendment 1 scope).
 *
 * TRAIN ONLY: per-series boundaries from the frozen splits.json. VALIDATION and
 * TEST windows are never read.
 *
 * Reports every fee environment (GROSS / SPOT 10bps / FUT_7 / FUT_4) using the
 * per-leg model, and evaluates the two preregistered success criteria.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { Settings } from '../../src/core/settings';
import { replayV22, V22_ARMS, type V22Trade } from './v22-replay';
import { FEE_ENVS, feeRPerLeg } from './v22-engine';
import { loadSeries, hasSeries } from './load';
import { HTF_MAP } from '../../src/strategy/v2/htf';
import { quantileSorted } from './audit-fee-readonly';
import type { Candle, Timeframe } from '../../src/core/types';

/** Amendment 1 scope. 'A' runs on the same set so the comparison is like-for-like. */
const SCOPE: Timeframe[] = ['15m', '30m', '1h', '4h'];
const FROZEN_FEE_PCT = 0.1;   // what trackOutcome already subtracted
const RES = 40000;

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

interface Sub { n: number; sum: number }
interface Acc {
  actionable: number; pending: number;
  terminal: Record<string, number>;
  reasons: Record<string, number>;
  closed: number; open: number; tp: number; sl: number; timeout: number;
  sumG: number; pos: number; neg: number; nPos: number;
  seq: number[]; gs: number[]; riskPct: number[]; riskAtr: number[];
  feeSum: Record<string, number>;
  nRev: number; nCont: number;
  byTf: Map<string, Sub>; byDir: Map<string, Sub>; byKind: Map<string, Sub>;
  bySym: Map<string, Sub>; byHtf: Map<string, Sub>; byTp1: Map<string, Sub>;
  latency: number[];
}
const mk = (): Acc => ({
  actionable: 0, pending: 0, terminal: {}, reasons: {},
  closed: 0, open: 0, tp: 0, sl: 0, timeout: 0,
  sumG: 0, pos: 0, neg: 0, nPos: 0, seq: [], gs: [], riskPct: [], riskAtr: [],
  feeSum: Object.fromEntries(FEE_ENVS.map((e) => [e.label, 0])),
  nRev: 0, nCont: 0,
  byTf: new Map(), byDir: new Map(), byKind: new Map(),
  bySym: new Map(), byHtf: new Map(), byTp1: new Map(),
  latency: [],
});
const push = (a: number[], v: number): void => {
  if (a.length < RES) a.push(v);
  else { const j = Math.floor(Math.random() * a.length); if (j < RES) a[j] = v; }
};
const bump = (m: Map<string, Sub>, k: string, r: number): void => {
  const e = m.get(k) ?? { n: 0, sum: 0 }; e.n++; e.sum += r; m.set(k, e);
};
const med = (x: number[]): number =>
  x.length ? quantileSorted(x.slice().sort((a, b) => a - b), .5) : NaN;
const qq = (x: number[], f: number): number =>
  x.length ? quantileSorted(x.slice().sort((a, b) => a - b), f) : NaN;
const maxDD = (s: number[]): number => {
  let peak = 0, eq = 0, dd = 0;
  for (const r of s) { eq += r; if (eq > peak) peak = eq; if (eq - peak < dd) dd = eq - peak; }
  return dd;
};
const sub = (m: Map<string, Sub>): Record<string, unknown> =>
  Object.fromEntries([...m].map(([k, v]) =>
    [k, { n: v.n, grossExpectancy: +(v.sum / v.n).toFixed(4) }]));

function add(a: Acc, t: V22Trade): void {
  a.terminal[t.terminal] = (a.terminal[t.terminal] ?? 0) + 1;
  if (t.reason) a.reasons[t.reason] = (a.reasons[t.reason] ?? 0) + 1;
  if (t.terminal !== 'FILLED') return;
  push(a.latency, t.barsWaited);
  if (t.result === undefined || t.result === 'OPEN') { a.open++; return; }

  const e = t.entryPrice!, risk = t.riskPerUnit!, exit = t.exitPrice ?? e;
  // storedR is net of the frozen 0.1 % lump; recover GROSS exactly.
  const g = (t.rMultiple ?? 0) + (FROZEN_FEE_PCT / 100) * e / risk;
  a.closed++; a.sumG += g; a.seq.push(g); push(a.gs, g);
  if (g > 0) { a.pos += g; a.nPos++; } else a.neg += -g;
  if (t.result === 'TP') a.tp++;
  else if (t.result === 'SL') a.sl++;
  else if (t.result === 'TIMEOUT') a.timeout++;
  if (t.setupKind === 'REVERSAL') a.nRev++; else a.nCont++;

  for (const env of FEE_ENVS) {
    a.feeSum[env.label] = (a.feeSum[env.label] ?? 0) + feeRPerLeg(e, exit, risk, env);
  }
  push(a.riskPct, (risk / e) * 100);
  if (t.riskAtr != null) push(a.riskAtr, t.riskAtr);

  bump(a.byTf, t.timeframe, g);
  bump(a.byDir, t.direction, g);
  bump(a.byKind, t.setupKind, g);
  bump(a.bySym, t.symbol, g);
  bump(a.byHtf, t.htfAlignment, g);
  bump(a.byTp1, t.tp1Basis, g);
}

async function main(): Promise<void> {
  const cache = arg('cache');
  const outFile = arg('out');
  const armNames = arg('arms', Object.keys(V22_ARMS).join(',')).split(',');
  const splits = (JSON.parse(readFileSync(arg('splits'), 'utf8')) as {
    splits: { symbol: string; timeframe: Timeframe; trainFromMs: number; trainToMs: number }[];
  }).splits.filter((s) => SCOPE.includes(s.timeframe));
  const settings = Settings.fromDefaults();

  const acc = new Map<string, Acc>();
  for (const n of armNames) acc.set(n, mk());

  for (const b of splits) {
    if (!hasSeries(cache, b.symbol, b.timeframe)) continue;
    const candles = loadSeries(cache, b.symbol, b.timeframe);
    const htf: Partial<Record<Timeframe, readonly Candle[]>> = {};
    for (const h of HTF_MAP[b.timeframe] ?? []) {
      if (hasSeries(cache, b.symbol, h)) htf[h] = loadSeries(cache, b.symbol, h);
    }
    for (const name of armNames) {
      const a = acc.get(name)!;
      const r = replayV22({
        symbol: b.symbol, timeframe: b.timeframe, candles, settings,
        htfCandles: htf, from: b.trainFromMs, to: b.trainToMs,
        gates: V22_ARMS[name]!,
      });
      a.actionable += r.actionableSetups;
      a.pending += r.pendingCreated;
      for (const t of r.trades) add(a, t);
    }
    console.error(`  ${b.symbol} ${b.timeframe} done`);
  }

  const out: Record<string, unknown> = {
    slice: 'train', scope: SCOPE,
    feeEnvironments: FEE_ENVS, arms: {},
  };
  const M = out['arms'] as Record<string, unknown>;
  for (const name of armNames) {
    const a = acc.get(name)!;
    const filled = a.terminal['FILLED'] ?? 0;
    const rr1Rej = a.terminal['REJECTED_RR1'] ?? 0;
    const noTp = a.terminal['NO_STRUCTURAL_TP'] ?? 0;
    const denom = a.actionable || 1;
    const expF = a.closed ? a.sumG / a.closed : 0;
    const net = (label: string): { perFilled: number; perSetup: number } => {
      const fee = a.feeSum[label] ?? 0;
      return {
        perFilled: a.closed ? +((a.sumG - fee) / a.closed).toFixed(4) : 0,
        perSetup: +((a.sumG - fee) / denom).toFixed(4),
      };
    };
    M[name] = {
      gates: V22_ARMS[name],
      actionableSetups: a.actionable,
      pendingCreated: a.pending,
      terminal: a.terminal,
      topReasons: Object.fromEntries(
        Object.entries(a.reasons).sort((x, y) => y[1] - x[1]).slice(0, 12)),
      closed: a.closed, open: a.open, tp: a.tp, sl: a.sl, timeout: a.timeout,
      // --- preregistered success criteria
      rr1RejectionRateOfSetups: +((rr1Rej / denom) * 100).toFixed(2),
      rr1RejectionRateOfPublished: a.pending ? +((rr1Rej / a.pending) * 100).toFixed(2) : 0,
      noStructuralTpRate: +((noTp / denom) * 100).toFixed(2),
      reversalShareOfClosed: a.closed ? +((a.nRev / a.closed) * 100).toFixed(2) : 0,
      criterionRr1Under40pct: (rr1Rej / denom) * 100 < 40,
      criterionReversalAtLeast10pct: a.closed ? (a.nRev / a.closed) * 100 >= 10 : false,
      // --- performance
      grossExpectancyPerFilled: +expF.toFixed(4),
      grossExpectancyPerActionableSetup: +(a.sumG / denom).toFixed(4),
      grossMedianR: +med(a.gs).toFixed(4),
      grossTotalR: +a.sumG.toFixed(2),
      grossPF: a.neg > 0 ? +(a.pos / a.neg).toFixed(4) : null,
      maxDrawdownR: +maxDD(a.seq).toFixed(2),
      positiveRRate: a.closed ? +((a.nPos / a.closed) * 100).toFixed(2) : 0,
      tpRate: a.closed ? +((a.tp / a.closed) * 100).toFixed(2) : 0,
      slRate: a.closed ? +((a.sl / a.closed) * 100).toFixed(2) : 0,
      timeoutRate: a.closed ? +((a.timeout / a.closed) * 100).toFixed(2) : 0,
      riskPct: {
        p25: +qq(a.riskPct, .25).toFixed(4), median: +med(a.riskPct).toFixed(4),
        p75: +qq(a.riskPct, .75).toFixed(4),
      },
      riskAtrMedian: +med(a.riskAtr).toFixed(4),
      fillLatencyBars: { median: +med(a.latency).toFixed(2), p90: +qq(a.latency, .9).toFixed(2) },
      netByFeeEnv: Object.fromEntries(FEE_ENVS.map((e) => [e.label, {
        ...net(e.label),
        meanFeeDragR: a.closed ? +((a.feeSum[e.label] ?? 0) / a.closed).toFixed(4) : 0,
      }])),
      byTimeframe: sub(a.byTf),
      byDirection: sub(a.byDir),
      bySetupKind: sub(a.byKind),
      bySymbol: sub(a.bySym),
      byHtfAlignment: sub(a.byHtf),
      byTp1Basis: sub(a.byTp1),
    };
  }

  writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log('wrote', outFile);
}

void main();

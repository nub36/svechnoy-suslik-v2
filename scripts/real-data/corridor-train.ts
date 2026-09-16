/**
 * V2.1 corridor — TRAIN driver with full ablation.
 *
 * TRAIN ONLY: per-series boundaries come from the frozen splits.json. The
 * validation and test windows are never read.
 *
 * Arms (each a full chronological replay, because gates change which setups
 * occupy the single position slot):
 *   A     baseline, no gates, OPEN N+1                  (fidelity anchor)
 *   E     + confirmed extreme only
 *   F     + fee drag guard only
 *   C     + confluence only
 *   EF    extreme + fee guard
 *   EFC   extreme + fee guard + confluence (all filters, still OPEN N+1)
 *   FULL  EFC + corridor entry
 * Comparing EFC with FULL isolates the ENTRY effect from the FILTER effect.
 */

import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Settings } from '../../src/core/settings';
import { replayCorridor, type Gates, type CorridorTrade } from './corridor-replay';
import { loadSeries, hasSeries } from './load';
import { HTF_MAP } from '../../src/strategy/v2/htf';
import { quantileSorted } from './audit-fee-readonly';
import type { Candle, Timeframe } from '../../src/core/types';

const FEE_PCT = 0.1;                 // frozen outcome.fee_pct
const BPS = [0, 2, 5, 10, 20];
const RES = 40000;

export const ARMS: Record<string, Gates> = {
  A:    { extreme: false, feeGuard: false, confluence: false, corridor: false },
  E:    { extreme: true,  feeGuard: false, confluence: false, corridor: false },
  F:    { extreme: false, feeGuard: true,  confluence: false, corridor: false },
  C:    { extreme: false, feeGuard: false, confluence: true,  corridor: false },
  EF:   { extreme: true,  feeGuard: true,  confluence: false, corridor: false },
  EFC:  { extreme: true,  feeGuard: true,  confluence: true,  corridor: false },
  FULL: { extreme: true,  feeGuard: true,  confluence: true,  corridor: true  },
};

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

interface Sub { n: number; sum: number }
interface Acc {
  actionable: number; pending: number;
  terminal: Record<string, number>;
  rejectReason: Record<string, number>;
  ambiguous: number;
  closed: number; open: number; tp: number; sl: number; timeout: number;
  sumG: number; pos: number; neg: number; nPos: number;
  seq: number[]; gs: number[];
  riskPct: number[]; riskAtr: number[]; invSum: number;
  u10: number; u20: number; u50: number;
  latency: number[];
  byKind: Map<string, Sub>; byDir: Map<string, Sub>;
  byTf: Map<string, Sub & { pending: number; filled: number }>;
  bySym: Map<string, Sub>; byPool: Map<string, Sub>;
}
const mk = (): Acc => ({
  actionable: 0, pending: 0, terminal: {}, rejectReason: {}, ambiguous: 0,
  closed: 0, open: 0, tp: 0, sl: 0, timeout: 0,
  sumG: 0, pos: 0, neg: 0, nPos: 0, seq: [], gs: [],
  riskPct: [], riskAtr: [], invSum: 0, u10: 0, u20: 0, u50: 0, latency: [],
  byKind: new Map(), byDir: new Map(), byTf: new Map(),
  bySym: new Map(), byPool: new Map(),
});
const push = (a: number[], v: number): void => {
  if (a.length < RES) a.push(v);
  else { const j = Math.floor(Math.random() * a.length); if (j < RES) a[j] = v; }
};
const bump = (m: Map<string, Sub>, k: string, r: number): void => {
  const e = m.get(k) ?? { n: 0, sum: 0 }; e.n++; e.sum += r; m.set(k, e);
};
const med = (x: number[]): number => {
  if (!x.length) return NaN;
  return quantileSorted(x.slice().sort((a, b) => a - b), .5);
};
const qq = (x: number[], f: number): number => {
  if (!x.length) return NaN;
  return quantileSorted(x.slice().sort((a, b) => a - b), f);
};
const maxDD = (s: number[]): number => {
  let peak = 0, eq = 0, dd = 0;
  for (const r of s) { eq += r; if (eq > peak) peak = eq; if (eq - peak < dd) dd = eq - peak; }
  return dd;
};

function add(a: Acc, t: CorridorTrade): void {
  a.terminal[t.terminal] = (a.terminal[t.terminal] ?? 0) + 1;
  if (t.ambiguous) a.ambiguous++;
  if (t.terminal.startsWith('REJECTED') || t.terminal === 'CANCELLED'
    || t.terminal === 'EXPIRED' || t.terminal === 'MISSED') {
    a.rejectReason[t.reason] = (a.rejectReason[t.reason] ?? 0) + 1;
  }
  const tfe = a.byTf.get(t.timeframe) ?? { n: 0, sum: 0, pending: 0, filled: 0 };
  if (t.terminal !== 'FILLED') { a.byTf.set(t.timeframe, tfe); return; }
  tfe.filled++;
  push(a.latency, t.barsWaited);
  if (t.result === undefined || t.result === 'OPEN') { a.open++; a.byTf.set(t.timeframe, tfe); return; }

  const e = t.entryPrice!, risk = t.riskPerUnit!;
  const g = (t.rMultiple ?? 0) + (FEE_PCT / 100) * e / risk;   // GROSS
  a.closed++; a.sumG += g; a.seq.push(g); push(a.gs, g);
  if (g > 0) { a.pos += g; a.nPos++; } else a.neg += -g;
  if (t.result === 'TP') a.tp++;
  else if (t.result === 'SL') a.sl++;
  else if (t.result === 'TIMEOUT') a.timeout++;

  const rp = (risk / e) * 100;
  push(a.riskPct, rp);
  if (rp < 0.10) a.u10++;
  if (rp < 0.20) a.u20++;
  if (rp < 0.50) a.u50++;
  a.invSum += e / risk;
  if (t.riskAtr != null) push(a.riskAtr, t.riskAtr);

  bump(a.byKind, t.setupKind, g);
  bump(a.byDir, t.direction, g);
  bump(a.bySym, t.symbol, g);
  bump(a.byPool, t.poolKind, g);
  tfe.n++; tfe.sum += g;
  a.byTf.set(t.timeframe, tfe);
}

const sub = (m: Map<string, Sub>): Record<string, unknown> =>
  Object.fromEntries([...m].map(([k, v]) =>
    [k, { n: v.n, grossExpectancy: +(v.sum / v.n).toFixed(4) }]));

async function main(): Promise<void> {
  const cache = arg('cache');
  const outDir = arg('out');
  const armNames = arg('arms', Object.keys(ARMS).join(',')).split(',');
  const poolKinds = arg('poolKinds', 'false') === 'true';

  const splits = (JSON.parse(readFileSync(arg('splits'), 'utf8')) as {
    splits: { symbol: string; timeframe: Timeframe; trainFromMs: number; trainToMs: number }[];
  }).splits;
  const settings = Settings.fromDefaults();

  const acc = new Map<string, Acc>();
  for (const n of armNames) acc.set(n, mk());
  const dump = `${outDir}/corridor-FULL-train.jsonl`;
  if (existsSync(dump)) rmSync(dump);

  for (const b of splits) {
    if (!hasSeries(cache, b.symbol, b.timeframe)) continue;
    const candles = loadSeries(cache, b.symbol, b.timeframe);
    const htf: Partial<Record<Timeframe, readonly Candle[]>> = {};
    for (const h of HTF_MAP[b.timeframe] ?? []) {
      if (hasSeries(cache, b.symbol, h)) htf[h] = loadSeries(cache, b.symbol, h);
    }
    for (const name of armNames) {
      const a = acc.get(name)!;
      const r = replayCorridor({
        symbol: b.symbol, timeframe: b.timeframe, candles, settings,
        htfCandles: htf, from: b.trainFromMs, to: b.trainToMs,
        gates: ARMS[name]!, poolKinds: poolKinds && name === 'FULL',
      });
      a.actionable += r.actionableSetups;
      a.pending += r.pendingCreated;
      for (const t of r.trades) {
        add(a, t);
        if (name === 'FULL') appendFileSync(dump, JSON.stringify(t) + '\n');
      }
    }
    console.error(`  ${b.symbol} ${b.timeframe} done`);
  }

  const out: Record<string, unknown> = { slice: 'train', feePct: FEE_PCT, arms: {} };
  const M = out['arms'] as Record<string, unknown>;
  for (const name of armNames) {
    const a = acc.get(name)!;
    const filled = a.terminal['FILLED'] ?? 0;
    const expF = a.closed ? a.sumG / a.closed : 0;
    const meanInv = a.closed ? a.invSum / a.closed : 0;
    M[name] = {
      gates: ARMS[name],
      actionableSetups: a.actionable,
      pendingCreated: a.pending,
      terminal: a.terminal,
      rejectReasons: a.rejectReason,
      ambiguous: a.ambiguous,
      fillRateOfPending: a.pending ? +((filled / a.pending) * 100).toFixed(2) : 0,
      fillRateOfActionable: a.actionable ? +((filled / a.actionable) * 100).toFixed(2) : 0,
      closed: a.closed, open: a.open, tp: a.tp, sl: a.sl, timeout: a.timeout,
      grossExpectancyPerFilled: +expF.toFixed(4),
      grossExpectancyPerActionableSetup: a.actionable ? +(a.sumG / a.actionable).toFixed(4) : 0,
      grossMedianR: +med(a.gs).toFixed(4),
      grossTotalR: +a.sumG.toFixed(2),
      grossPF: a.neg > 0 ? +(a.pos / a.neg).toFixed(4) : null,
      maxDrawdownR: +maxDD(a.seq).toFixed(2),
      positiveRRate: a.closed ? +((a.nPos / a.closed) * 100).toFixed(2) : 0,
      tpRate: a.closed ? +((a.tp / a.closed) * 100).toFixed(2) : 0,
      slRate: a.closed ? +((a.sl / a.closed) * 100).toFixed(2) : 0,
      timeoutRate: a.closed ? +((a.timeout / a.closed) * 100).toFixed(2) : 0,
      riskPct: { p25: +qq(a.riskPct, .25).toFixed(4), median: +med(a.riskPct).toFixed(4), p75: +qq(a.riskPct, .75).toFixed(4) },
      riskAtrMedian: +med(a.riskAtr).toFixed(4),
      shareUnder0_10pct: a.closed ? +((a.u10 / a.closed) * 100).toFixed(2) : 0,
      shareUnder0_20pct: a.closed ? +((a.u20 / a.closed) * 100).toFixed(2) : 0,
      shareUnder0_50pct: a.closed ? +((a.u50 / a.closed) * 100).toFixed(2) : 0,
      netExpectancyPerFilled: Object.fromEntries(
        BPS.map((b) => [`${b}bps`, +(expF - (b / 10000) * meanInv).toFixed(4)])),
      netExpectancyPerActionableSetup: Object.fromEntries(
        BPS.map((b) => [`${b}bps`,
          a.actionable ? +((a.sumG - (b / 10000) * a.invSum) / a.actionable).toFixed(4) : 0])),
      fillLatencyBars: {
        median: +med(a.latency).toFixed(2),
        p75: +qq(a.latency, .75).toFixed(2),
        p90: +qq(a.latency, .90).toFixed(2),
        max: a.latency.length ? Math.max(...a.latency) : null,
      },
      bySetupKind: sub(a.byKind),
      byDirection: sub(a.byDir),
      bySymbol: sub(a.bySym),
      byPoolKind: sub(a.byPool),
      byTimeframe: Object.fromEntries([...a.byTf].map(([k, v]) => [k, {
        filled: v.filled, closed: v.n,
        grossExpectancy: v.n ? +(v.sum / v.n).toFixed(4) : null,
      }])),
    };
  }

  writeFileSync(`${outDir}/corridor-train-metrics.json`, JSON.stringify(out, null, 2));
  console.log('wrote corridor-train-metrics.json');
}

void main();

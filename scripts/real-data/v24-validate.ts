/**
 * V2.4 VALIDATION driver — frozen S-asym candidate ONLY across 15m/30m/1h/4h.
 *
 * TRAIN ONLY: per-series boundaries from the frozen splits.json. VALIDATION and
 * TEST windows are never read.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { Settings } from '../../src/core/settings';
import { replayV24, V24_ARMS, type V24Trade } from './v24-replay';
import { FEE_ENVS, feeRPerLeg } from './v22-engine';
import { loadSeries, hasSeries } from './load';
import { HTF_MAP } from '../../src/strategy/v2/htf';
import { quantileSorted } from './audit-fee-readonly';
import type { Candle, Timeframe } from '../../src/core/types';

const SCOPE: Timeframe[] = ['15m', '30m', '1h', '4h'];
const FROZEN_FEE_PCT = 0.1;

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

interface Sub { n: number; sum: number }
interface Acc {
  actionable: number; pending: number;
  terminal: Record<string, number>; reasons: Record<string, number>;
  closed: number; open: number; tp: number; sl: number; timeout: number;
  sumG: number; pos: number; neg: number; nPos: number;
  seq: number[]; gs: number[]; riskPct: number[]; riskAtr: number[];
  feeSum: Record<string, number>; latency: number[];
  byTf: Map<string, Sub>; byDir: Map<string, Sub>; bySym: Map<string, Sub>;
  byHtf: Map<string, Sub>; byPool: Map<string, Sub>; byTp1: Map<string, Sub>; byLeg: Map<string, Sub>;
  // baseline linkage for anti-bias checks
  filledKeys: Set<string>; declinedKeys: Set<string>; asymRejKeys: Set<string>;
}
const mk = (): Acc => ({
  actionable: 0, pending: 0, terminal: {}, reasons: {},
  closed: 0, open: 0, tp: 0, sl: 0, timeout: 0,
  sumG: 0, pos: 0, neg: 0, nPos: 0, seq: [], gs: [], riskPct: [], riskAtr: [],
  feeSum: Object.fromEntries(FEE_ENVS.map((e) => [e.label, 0])),
  latency: [],
  byTf: new Map(), byDir: new Map(), bySym: new Map(),
  byHtf: new Map(), byPool: new Map(), byTp1: new Map(), byLeg: new Map(),
  filledKeys: new Set(), declinedKeys: new Set(), asymRejKeys: new Set(),
});
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

const keyOf = (t: V24Trade): string =>
  `${t.symbol}|${t.timeframe}|${t.setupCandleTime}`;

function add(a: Acc, t: V24Trade): void {
  a.terminal[t.terminal] = (a.terminal[t.terminal] ?? 0) + 1;
  if (t.reason) a.reasons[t.reason] = (a.reasons[t.reason] ?? 0) + 1;
  if (t.terminal === 'REJECTED_ASYMMETRY') a.asymRejKeys.add(keyOf(t));
  if (t.terminal !== 'FILLED') { a.declinedKeys.add(keyOf(t)); return; }
  a.filledKeys.add(keyOf(t));
  a.latency.push(t.barsWaited);
  if (t.result === undefined || t.result === 'OPEN') { a.open++; return; }

  const e = t.entryPrice!, risk = t.riskPerUnit!, exit = t.exitPrice ?? e;
  const g = (t.rMultiple ?? 0) + (FROZEN_FEE_PCT / 100) * e / risk;
  a.closed++; a.sumG += g; a.seq.push(g); a.gs.push(g);
  if (g > 0) { a.pos += g; a.nPos++; } else a.neg += -g;
  if (t.result === 'TP') a.tp++;
  else if (t.result === 'SL') a.sl++;
  else if (t.result === 'TIMEOUT') a.timeout++;
  for (const env of FEE_ENVS) {
    a.feeSum[env.label] = (a.feeSum[env.label] ?? 0) + feeRPerLeg(e, exit, risk, env);
  }
  a.riskPct.push((risk / e) * 100);
  if (t.riskAtr != null) a.riskAtr.push(t.riskAtr);
  bump(a.byTf, t.timeframe, g);
  bump(a.byDir, t.direction, g);
  bump(a.bySym, t.symbol, g);
  bump(a.byHtf, t.htfAlignment, g);
  bump(a.byPool, t.poolKind, g);
  bump(a.byTp1, t.tp1Basis, g);
  bump(a.byLeg, t.longLeg, g);
}

async function main(): Promise<void> {
  const cache = arg('cache');
  const outFile = arg('out');
  // Frozen candidate only. Baseline A is included solely as a comparison
  // anchor; no other arm may be run on VALIDATION.
  const armNames = arg('arms', 'A,S-asym').split(',');
  const splits = (JSON.parse(readFileSync(arg('splits'), 'utf8')) as {
    splits: {
      symbol: string; timeframe: Timeframe;
      validFromMs: number; validToMs: number; testFromMs: number;
    }[];
  }).splits.filter((s) => SCOPE.includes(s.timeframe));

  // TEST-SAFETY GUARD. Every window handed to the replay must end strictly
  // before that series' testFromMs. If this ever fails the run aborts rather
  // than silently reading TEST data.
  for (const b of splits) {
    if (!(b.validToMs < b.testFromMs)) {
      throw new Error(
        `TEST-SAFETY: ${b.symbol} ${b.timeframe} validTo ${b.validToMs} >= testFrom ${b.testFromMs}`);
    }
  }
  const settings = Settings.fromDefaults();

  const acc = new Map<string, Acc>();
  for (const n of armNames) acc.set(n, mk());
  /** baseline gross keyed by setup, for the anti-bias checks */
  const baseGross = new Map<string, number>();

  for (const b of splits) {
    if (!hasSeries(cache, b.symbol, b.timeframe)) continue;
    const candles = loadSeries(cache, b.symbol, b.timeframe);
    const htf: Partial<Record<Timeframe, readonly Candle[]>> = {};
    for (const h of HTF_MAP[b.timeframe] ?? []) {
      if (hasSeries(cache, b.symbol, h)) htf[h] = loadSeries(cache, b.symbol, h);
    }
    for (const name of armNames) {
      const a = acc.get(name)!;
      const r = replayV24({
        symbol: b.symbol, timeframe: b.timeframe, candles, settings,
        htfCandles: htf, from: b.validFromMs, to: b.validToMs,
        gates: V24_ARMS[name]!,
      });
      a.actionable += r.actionableSetups;
      a.pending += r.pendingCreated;
      for (const t of r.trades) {
        add(a, t);
        if (name === 'A' && t.terminal === 'FILLED' && t.result && t.result !== 'OPEN') {
          const g = (t.rMultiple ?? 0)
            + (FROZEN_FEE_PCT / 100) * t.entryPrice! / t.riskPerUnit!;
          baseGross.set(keyOf(t), g);
        }
      }
    }
    console.error(`  ${b.symbol} ${b.timeframe} done`);
  }

  const mean = (x: number[]): number =>
    x.length ? x.reduce((p, q) => p + q, 0) / x.length : NaN;

  const out: Record<string, unknown> = {
    slice: 'validation', scope: SCOPE, feeEnvironments: FEE_ENVS,
    candidate: 'S-asym', freezeCommit: '53c9ad8', arms: {},
  };
  const M = out['arms'] as Record<string, unknown>;
  for (const name of armNames) {
    const a = acc.get(name)!;
    const denom = a.actionable || 1;
    const expF = a.closed ? a.sumG / a.closed : 0;
    const net = (label: string): { perFilled: number; perSetup: number; meanFeeDragR: number } => {
      const fee = a.feeSum[label] ?? 0;
      return {
        perFilled: a.closed ? +((a.sumG - fee) / a.closed).toFixed(4) : 0,
        perSetup: +((a.sumG - fee) / denom).toFixed(4),
        meanFeeDragR: a.closed ? +(fee / a.closed).toFixed(4) : 0,
      };
    };
    // outlier dependence on GROSS
    const sorted = a.gs.slice().sort((x, y) => y - x);
    const drop = (k: number): number => {
      const rest = sorted.slice(Math.min(k, sorted.length));
      return rest.length ? rest.reduce((p, q) => p + q, 0) / rest.length : 0;
    };
    const k1 = Math.max(1, Math.ceil(sorted.length * 0.01));
    // anti-bias: baseline outcome of filled vs declined vs guard-rejected
    const bl = (keys: Set<string>): { n: number; mean: number } => {
      const v: number[] = [];
      for (const k of keys) { const g = baseGross.get(k); if (g !== undefined) v.push(g); }
      return { n: v.length, mean: +mean(v).toFixed(4) };
    };

    const netHeadline = net('FUT_7');   // 2 maker + 5 taker
    const netStress = net('SPOT');      // 5 + 5 stress
    M[name] = {
      gates: V24_ARMS[name],
      actionableSetups: a.actionable, pendingCreated: a.pending,
      terminal: a.terminal,
      topReasons: Object.fromEntries(
        Object.entries(a.reasons).sort((x, y) => y[1] - x[1]).slice(0, 12)),
      closed: a.closed, open: a.open, tp: a.tp, sl: a.sl, timeout: a.timeout,
      fillRateOfPending: a.pending ? +(((a.terminal['FILLED'] ?? 0) / a.pending) * 100).toFixed(2) : 0,
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
      netByFeeEnv: Object.fromEntries(FEE_ENVS.map((e) => [e.label, net(e.label)])),
      // --- preregistered success criteria
      // Preregistered criteria. Headline = 2 bps maker entry + 5 bps taker
      // exit (FEE_ENVS label FUT_7). Stress = 5/5 (label SPOT, 10 bps).
      headlineEnv: 'FUT_7 (2 maker / 5 taker)',
      stressEnv: 'SPOT (5 taker / 5 taker)',
      criterionHeadlinePerFilledPositive: netHeadline.perFilled > 0,
      criterionHeadlinePerSetupPositive: netHeadline.perSetup > 0,
      criterionStressPerFilledPositive: netStress.perFilled > 0,
      criterionOutlierRobust: drop(k1) > 0,
      criterionBothLegsNonNegative: (() => {
        const l = a.byDir.get('LONG'); const sh = a.byDir.get('SHORT');
        if (!l || !sh || l.n < 100 || sh.n < 100) return false;
        return l.sum / l.n >= 0 && sh.sum / sh.n >= 0;
      })(),
      criterionAllPassed: netHeadline.perFilled > 0 && netHeadline.perSetup > 0
        && netStress.perFilled > 0 && drop(k1) > 0,
      outlierDependence: {
        grossExpectancy: +expF.toFixed(4),
        exTop1: +drop(1).toFixed(4), exTop5: +drop(5).toFixed(4),
        exTop1Pct: +drop(k1).toFixed(4), removedForTop1Pct: k1,
      },
      antiBias: {
        baselineGrossOfFilled: bl(a.filledKeys),
        baselineGrossOfDeclined: bl(a.declinedKeys),
        baselineGrossOfAsymmetryRejectedLongs: bl(a.asymRejKeys),
      },
      byTimeframe: sub(a.byTf), byDirection: sub(a.byDir), bySymbol: sub(a.bySym),
      byHtfAlignment: sub(a.byHtf), byPoolKind: sub(a.byPool), byTp1Basis: sub(a.byTp1), byLongLeg: sub(a.byLeg),
    };
  }

  writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log('wrote', outFile);
}

void main();

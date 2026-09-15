/**
 * Metric definitions for the real-data run. Fixed by the protocol (§6).
 *
 * Every definition here is deliberately explicit about OPEN trades: they carry
 * no realised R and are excluded from every closed-trade statistic. Folding
 * them in (as a zero, or as an unrealised mark) is the classic way to make a
 * backtest look calmer than it was.
 */

import type { ReplayTrade } from '../../src/replay/runner';

export interface CoreMetrics {
  evaluatedCandles: number;
  totalTrades: number;
  closed: number;
  open: number;
  tp: number;
  sl: number;
  timeout: number;
  tpExitRate: number;
  positiveRRate: number;
  slRate: number;
  timeoutRate: number;
  avgR: number;
  medianR: number;
  totalR: number;
  expectancy: number;
  profitFactor: number;
  maxDrawdownR: number;
  avgBarsHeld: number;
  medianBarsHeld: number;
  /** DIAGNOSTIC SENSITIVITY ONLY — never the headline. */
  expectancyExTimeout: number;
  nExTimeout: number;
  long: number;
  short: number;
}

export const r4 = (x: number): number =>
  Number.isFinite(x) ? Math.round(x * 10000) / 10000 : 0;

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((p, q) => p - q);
  const m = Math.floor(a.length / 2);
  return a.length % 2 === 0 ? (a[m - 1]! + a[m]!) / 2 : a[m]!;
}

export function quantile(xs: readonly number[], f: number): number {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((p, q) => p - q);
  const idx = Math.min(a.length - 1, Math.max(0, Math.round(f * (a.length - 1))));
  return a[idx]!;
}

export interface Distribution {
  n: number;
  min: number; p25: number; median: number; p75: number;
  p90: number; p95: number; max: number;
}

export function distribution(xs: readonly number[]): Distribution {
  const a = xs.filter((x) => Number.isFinite(x));
  if (a.length === 0) {
    return { n: 0, min: 0, p25: 0, median: 0, p75: 0, p90: 0, p95: 0, max: 0 };
  }
  return {
    n: a.length,
    min: r4(quantile(a, 0)),
    p25: r4(quantile(a, 0.25)),
    median: r4(median(a)),
    p75: r4(quantile(a, 0.75)),
    p90: r4(quantile(a, 0.9)),
    p95: r4(quantile(a, 0.95)),
    max: r4(quantile(a, 1)),
  };
}

/**
 * Maximum peak-to-trough decline of the cumulative R curve, in R.
 * Trades are taken in chronological entry order.
 */
export function maxDrawdownR(trades: readonly ReplayTrade[]): number {
  const ordered = [...trades].sort((a, b) => a.entryCandleTime - b.entryCandleTime);
  let cum = 0, peak = 0, worst = 0;
  for (const t of ordered) {
    cum += t.rMultiple;
    if (cum > peak) peak = cum;
    const dd = cum - peak;
    if (dd < worst) worst = dd;
  }
  return worst;
}

export function computeCore(
  all: readonly ReplayTrade[], evaluatedCandles: number,
): CoreMetrics {
  const closed = all.filter((t) => t.result !== 'OPEN');
  const open = all.length - closed.length;
  const tp = closed.filter((t) => t.result === 'TP').length;
  const sl = closed.filter((t) => t.result === 'SL').length;
  const to = closed.filter((t) => t.result === 'TIMEOUT').length;
  const rs = closed.map((t) => t.rMultiple);
  const totalR = rs.reduce((a, b) => a + b, 0);
  const pos = rs.filter((r) => r > 0);
  const neg = rs.filter((r) => r < 0);
  const grossPos = pos.reduce((a, b) => a + b, 0);
  const grossNeg = Math.abs(neg.reduce((a, b) => a + b, 0));
  const exTo = closed.filter((t) => t.result !== 'TIMEOUT');
  const bars = closed.map((t) => t.barsHeld);
  const n = closed.length;
  const pct = (x: number): number => (n > 0 ? r4((x / n) * 100) : 0);

  return {
    evaluatedCandles,
    totalTrades: all.length,
    closed: n,
    open,
    tp, sl, timeout: to,
    tpExitRate: pct(tp),
    positiveRRate: pct(pos.length),
    slRate: pct(sl),
    timeoutRate: pct(to),
    avgR: n > 0 ? r4(totalR / n) : 0,
    medianR: r4(median(rs)),
    totalR: r4(totalR),
    expectancy: n > 0 ? r4(totalR / n) : 0,
    profitFactor: grossNeg > 0 ? r4(grossPos / grossNeg) : (grossPos > 0 ? Infinity : 0),
    maxDrawdownR: r4(maxDrawdownR(closed)),
    avgBarsHeld: n > 0 ? r4(bars.reduce((a, b) => a + b, 0) / n) : 0,
    medianBarsHeld: r4(median(bars)),
    expectancyExTimeout: exTo.length > 0
      ? r4(exTo.reduce((a, t) => a + t.rMultiple, 0) / exTo.length) : 0,
    nExTimeout: exTo.length,
    long: closed.filter((t) => t.direction === 'LONG').length,
    short: closed.filter((t) => t.direction === 'SHORT').length,
  };
}

/**
 * Spearman rank correlation. Ties get average ranks, so a bucketed predictor
 * (which produces many ties) is handled correctly.
 */
export function spearman(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return NaN;
  const rank = (v: readonly number[]): number[] => {
    const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(v.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k]![1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs.slice(0, n)), ry = rank(ys.slice(0, n));
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i]! - mx, b = ry[i]! - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx > 0 && dy > 0 ? r4(num / Math.sqrt(dx * dy)) : NaN;
}

/** Evidence buckets, boundaries fixed in the protocol before any results. */
export const EVIDENCE_BUCKETS: readonly [string, number, number][] = [
  ['0.45-0.50', 0.45, 0.50],
  ['0.50-0.60', 0.50, 0.60],
  ['0.60-0.70', 0.60, 0.70],
  ['0.70-0.80', 0.70, 0.80],
  ['0.80-1.00', 0.80, 1.0000001],
];

export function bucketOf(v: number): string {
  for (const [label, lo, hi] of EVIDENCE_BUCKETS) {
    if (v >= lo && v < hi) return label;
  }
  return v < 0.45 ? '<0.45' : '0.80-1.00';
}

export interface GroupStats {
  group: string;
  n: number;
  open: number;
  tp: number;
  sl: number;
  timeout: number;
  tpExitRate: number;
  positiveRRate: number;
  timeoutRate: number;
  avgR: number;
  medianR: number;
  totalR: number;
  profitFactor: number;
}

export function groupStats(label: string, all: readonly ReplayTrade[]): GroupStats {
  const closed = all.filter((t) => t.result !== 'OPEN');
  const n = closed.length;
  const rs = closed.map((t) => t.rMultiple);
  const pos = rs.filter((r) => r > 0);
  const grossPos = pos.reduce((a, b) => a + b, 0);
  const grossNeg = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const pct = (x: number): number => (n > 0 ? r4((x / n) * 100) : 0);
  return {
    group: label,
    n,
    open: all.length - n,
    tp: closed.filter((t) => t.result === 'TP').length,
    sl: closed.filter((t) => t.result === 'SL').length,
    timeout: closed.filter((t) => t.result === 'TIMEOUT').length,
    tpExitRate: pct(closed.filter((t) => t.result === 'TP').length),
    positiveRRate: pct(pos.length),
    timeoutRate: pct(closed.filter((t) => t.result === 'TIMEOUT').length),
    avgR: n > 0 ? r4(rs.reduce((a, b) => a + b, 0) / n) : 0,
    medianR: r4(median(rs)),
    totalR: r4(rs.reduce((a, b) => a + b, 0)),
    profitFactor: grossNeg > 0 ? r4(grossPos / grossNeg) : (grossPos > 0 ? Infinity : 0),
  };
}

export function groupBy<T>(xs: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const cur = m.get(k);
    if (cur) cur.push(x); else m.set(k, [x]);
  }
  return m;
}

/**
 * Outlier sensitivity (Step 20): how much of the result rests on a handful of
 * extreme winners.
 */
export function outlierSensitivity(trades: readonly ReplayTrade[]): {
  n: number; totalR: number; expectancy: number;
  exTop1: { totalR: number; expectancy: number };
  exTop5: { totalR: number; expectancy: number };
  exTop1Pct: { totalR: number; expectancy: number; removed: number };
  top1PctShareOfGrossPositive: number;
} {
  const closed = trades.filter((t) => t.result !== 'OPEN');
  const rs = closed.map((t) => t.rMultiple).sort((a, b) => b - a);
  const n = rs.length;
  const total = rs.reduce((a, b) => a + b, 0);
  const drop = (k: number): { totalR: number; expectancy: number } => {
    const rest = rs.slice(Math.min(k, n));
    const t = rest.reduce((a, b) => a + b, 0);
    return { totalR: r4(t), expectancy: rest.length > 0 ? r4(t / rest.length) : 0 };
  };
  const k1pct = Math.max(1, Math.ceil(n * 0.01));
  const grossPos = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const top1PctPos = rs.slice(0, k1pct).filter((r) => r > 0).reduce((a, b) => a + b, 0);
  return {
    n,
    totalR: r4(total),
    expectancy: n > 0 ? r4(total / n) : 0,
    exTop1: drop(1),
    exTop5: drop(5),
    exTop1Pct: { ...drop(k1pct), removed: k1pct },
    top1PctShareOfGrossPositive: grossPos > 0 ? r4((top1PctPos / grossPos) * 100) : 0,
  };
}

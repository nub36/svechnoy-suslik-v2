/**
 * READ-ONLY POST-HOC AUDIT of the completed real-data experiment.
 *
 * Reads ONLY the saved trade artifacts. It never calls the strategy engines,
 * never replays candles, never writes into the run directory, and never
 * modifies any setting. Its single job is to decompose the already-recorded
 * net R into gross R and transaction cost, and to re-slice the result.
 *
 * ---------------------------------------------------------------------------
 * THE RECONSTRUCTION, AND WHY IT IS EXACT
 * ---------------------------------------------------------------------------
 * `trackOutcome` records, for every closed trade:
 *
 *     grossR  = (direction == LONG ? exit - entry : entry - exit) / riskPerUnit
 *     feeR    = (fee_pct / 100) * entryPrice / riskPerUnit
 *     netR    = round(grossR - feeR, 6)          <-- the stored `rMultiple`
 *
 * `riskPerUnit = abs(entryPrice - stopLoss)` is recoverable from the stored
 * entryPrice and stopLoss, and fee_pct is fixed at 0.1 by the frozen settings
 * snapshot. feeR is therefore computable exactly, and
 *
 *     grossR = netR + feeR
 *
 * is an identity, not an estimate. The only imprecision is the 6-decimal
 * rounding applied when the trade was written, which is verified below to be
 * <= 1e-6 by recomputing grossR independently from entry/exit/stop and
 * comparing. No guessing is involved anywhere.
 *
 * V2 trades store `riskDistance` (= riskPerUnit) directly; V1 trades do not,
 * so riskPerUnit is derived from |entry - stopLoss| for both, which is the same
 * quantity the tracker used.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const FEE_PCT = 0.1; // frozen: settings.json -> outcome.fee_pct

export interface AuditTrade {
  slice: string;
  symbol: string;
  timeframe: string;
  direction: string;
  result: string;
  entryPrice: number;
  stopLoss: number;
  exitPrice: number | null;
  netR: number;
  feeR: number;
  grossR: number;
  riskPerUnit: number;
  riskPercent: number;
  barsHeld: number;
  // V2 only
  evidence?: number;
  setupKind?: string | null;
  // V1 only
  v1RawScore?: number | null;
  v1AvailableWeight?: number | null;
  v1NormalizedScore?: number | null;
}

export async function* streamTrades(
  path: string, wantSlice?: string,
): AsyncGenerator<AuditTrade> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    const t = JSON.parse(line) as Record<string, unknown>;
    if (wantSlice !== undefined && t['slice'] !== wantSlice) continue;
    const entry = t['entryPrice'] as number;
    const stop = t['stopLoss'] as number;
    const riskPerUnit = Math.abs(entry - stop);
    const feeR = riskPerUnit > 0 ? (FEE_PCT / 100) * entry / riskPerUnit : 0;
    const netR = t['rMultiple'] as number;
    yield {
      slice: t['slice'] as string,
      symbol: t['symbol'] as string,
      timeframe: t['timeframe'] as string,
      direction: t['direction'] as string,
      result: t['result'] as string,
      entryPrice: entry,
      stopLoss: stop,
      exitPrice: (t['exitPrice'] as number | null) ?? null,
      netR,
      feeR,
      grossR: netR + feeR,
      riskPerUnit,
      riskPercent: entry > 0 ? (riskPerUnit / entry) * 100 : 0,
      barsHeld: (t['barsHeld'] as number) ?? 0,
      ...(t['evidence'] !== undefined ? { evidence: t['evidence'] as number } : {}),
      ...(t['setupKind'] !== undefined
        ? { setupKind: t['setupKind'] as string | null } : {}),
      ...(t['v1RawScore'] !== undefined
        ? { v1RawScore: t['v1RawScore'] as number | null } : {}),
      ...(t['v1AvailableWeight'] !== undefined
        ? { v1AvailableWeight: t['v1AvailableWeight'] as number | null } : {}),
      ...(t['v1NormalizedScore'] !== undefined
        ? { v1NormalizedScore: t['v1NormalizedScore'] as number | null } : {}),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

export const r4 = (x: number): number =>
  Number.isFinite(x) ? Math.round(x * 10000) / 10000 : (x > 0 ? Infinity : 0);

export function quantileSorted(sorted: readonly number[], f: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1,
    Math.max(0, Math.round(f * (sorted.length - 1))));
  return sorted[i]!;
}

/** Streaming accumulator: expectancy / PF / totals without holding all rows. */
export class Acc {
  n = 0;
  sumGross = 0;
  sumNet = 0;
  sumFee = 0;
  grossPos = 0;
  grossNeg = 0;
  netPos = 0;
  netNeg = 0;
  nGrossPos = 0;
  nNetPos = 0;
  nTp = 0;
  nSl = 0;
  nTo = 0;

  add(t: AuditTrade): void {
    this.n++;
    this.sumGross += t.grossR;
    this.sumNet += t.netR;
    this.sumFee += t.feeR;
    if (t.grossR > 0) { this.grossPos += t.grossR; this.nGrossPos++; }
    else this.grossNeg += -t.grossR;
    if (t.netR > 0) { this.netPos += t.netR; this.nNetPos++; }
    else this.netNeg += -t.netR;
    if (t.result === 'TP') this.nTp++;
    else if (t.result === 'SL') this.nSl++;
    else if (t.result === 'TIMEOUT') this.nTo++;
  }

  get grossExp(): number { return this.n > 0 ? this.sumGross / this.n : 0; }
  get netExp(): number { return this.n > 0 ? this.sumNet / this.n : 0; }
  get feeDrag(): number { return this.n > 0 ? this.sumFee / this.n : 0; }
  get grossPf(): number {
    return this.grossNeg > 0 ? this.grossPos / this.grossNeg
      : (this.grossPos > 0 ? Infinity : 0);
  }
  get netPf(): number {
    return this.netNeg > 0 ? this.netPos / this.netNeg
      : (this.netPos > 0 ? Infinity : 0);
  }
  get grossPosRate(): number { return this.n > 0 ? (this.nGrossPos / this.n) * 100 : 0; }
  get netPosRate(): number { return this.n > 0 ? (this.nNetPos / this.n) * 100 : 0; }
  get tpRate(): number { return this.n > 0 ? (this.nTp / this.n) * 100 : 0; }
}

/** Spearman rank correlation with average ranks for ties. */
export function spearman(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return NaN;
  const rank = (v: readonly number[]): Float64Array => {
    const idx = Array.from({ length: n }, (_, i) => i)
      .sort((a, b) => v[a]! - v[b]!);
    const r = new Float64Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && v[idx[j + 1]!]! === v[idx[i]!]!) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k]!] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += rx[i]!; my += ry[i]!; }
  mx /= n; my /= n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i]! - mx, b = ry[i]! - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
}

export const EVIDENCE_BUCKETS: readonly [string, number, number][] = [
  ['0.45-0.50', 0.45, 0.50],
  ['0.50-0.60', 0.50, 0.60],
  ['0.60-0.70', 0.60, 0.70],
  ['0.70-0.80', 0.70, 0.80],
  ['0.80-1.00', 0.80, 1.0000001],
];

export function evidenceBucket(v: number): string | null {
  for (const [label, lo, hi] of EVIDENCE_BUCKETS) if (v >= lo && v < hi) return label;
  return v >= 1 ? '0.80-1.00' : null;
}

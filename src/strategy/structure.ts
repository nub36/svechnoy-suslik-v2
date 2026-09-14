/**
 * Market structure primitives: swing pivots, dealing range, ATR, SMA.
 *
 * CRITICAL: every function here is "causal" — the value produced at index i
 * depends only on candles[0..i]. Pivot confirmation is explicitly delayed by
 * `strength` bars so a pivot at index p is only *known* at index p + strength.
 * This is what prevents future leakage.
 */

import type { Candle, Direction } from '../core/types';

export interface Swing {
  /** index of the pivot candle itself */
  index: number;
  /** index at which this pivot became KNOWN (index + strength) */
  confirmedIndex: number;
  time: number;
  price: number;
  kind: 'HIGH' | 'LOW';
}

/**
 * Fractal swing pivots. A high at index i is a pivot if it is the strict max of
 * the window [i-strength, i+strength]. It is only *confirmed* (usable) at
 * i + strength.
 */
export function findSwings(candles: readonly Candle[], strength: number): Swing[] {
  const out: Swing[] = [];
  const s = Math.max(1, Math.floor(strength));
  for (let i = s; i < candles.length - s; i++) {
    const c = candles[i];
    if (!c) continue;
    let isHigh = true;
    let isLow = true;
    for (let j = i - s; j <= i + s; j++) {
      if (j === i) continue;
      const o = candles[j];
      if (!o) continue;
      if (o.high >= c.high) isHigh = false;
      if (o.low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) {
      out.push({ index: i, confirmedIndex: i + s, time: c.openTime, price: c.high, kind: 'HIGH' });
    }
    if (isLow) {
      out.push({ index: i, confirmedIndex: i + s, time: c.openTime, price: c.low, kind: 'LOW' });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Swings that are already confirmed as of `atIndex` (no lookahead). */
export function swingsKnownAt(swings: readonly Swing[], atIndex: number): Swing[] {
  return swings.filter((s) => s.confirmedIndex <= atIndex);
}

export function lastSwing(
  swings: readonly Swing[],
  kind: 'HIGH' | 'LOW',
  atIndex: number,
): Swing | null {
  let found: Swing | null = null;
  for (const s of swings) {
    if (s.kind !== kind) continue;
    if (s.confirmedIndex > atIndex) continue;
    if (!found || s.index > found.index) found = s;
  }
  return found;
}

/** Wilder's ATR. Returns an array aligned to candles (null until warm). */
export function atrSeries(candles: readonly Candle[], period: number): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n === 0 || period < 1) return out;
  const trs: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    if (!c) continue;
    if (i === 0) {
      trs[i] = c.high - c.low;
    } else {
      const p = candles[i - 1];
      const pc = p ? p.close : c.open;
      trs[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    }
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (i < period) {
      sum += trs[i] ?? 0;
      if (i === period - 1) out[i] = sum / period;
      continue;
    }
    const prev = out[i - 1];
    if (prev === null || prev === undefined) continue;
    out[i] = (prev * (period - 1) + (trs[i] ?? 0)) / period;
  }
  return out;
}

export function atrAt(candles: readonly Candle[], period: number, index: number): number | null {
  const s = atrSeries(candles.slice(0, index + 1), period);
  return s[index] ?? null;
}

/** Simple moving average of a numeric selector, causal. */
export function smaAt(
  candles: readonly Candle[],
  index: number,
  period: number,
  pick: (c: Candle) => number,
): number | null {
  if (index + 1 < period || period < 1) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const c = candles[i];
    if (!c) return null;
    sum += pick(c);
  }
  return sum / period;
}

export interface DealingRange {
  high: number;
  low: number;
  mid: number;
  /** 0 = at low (deep discount), 1 = at high (deep premium) */
  position: number;
}

/**
 * Dealing range from the most recent confirmed swing high/low pair known at
 * `atIndex`.
 */
export function dealingRange(
  candles: readonly Candle[],
  swings: readonly Swing[],
  atIndex: number,
): DealingRange | null {
  const hi = lastSwing(swings, 'HIGH', atIndex);
  const lo = lastSwing(swings, 'LOW', atIndex);
  if (!hi || !lo) return null;
  const high = hi.price;
  const low = lo.price;
  if (!(high > low)) return null;
  const c = candles[atIndex];
  if (!c) return null;
  const position = (c.close - low) / (high - low);
  return { high, low, mid: (high + low) / 2, position: Math.max(0, Math.min(1, position)) };
}

/** Structural trend from the sequence of confirmed swings (HH/HL vs LH/LL). */
export function structuralTrend(
  swings: readonly Swing[],
  atIndex: number,
): Direction | 'RANGE' {
  const known = swingsKnownAt(swings, atIndex);
  const highs = known.filter((s) => s.kind === 'HIGH').slice(-2);
  const lows = known.filter((s) => s.kind === 'LOW').slice(-2);
  if (highs.length < 2 || lows.length < 2) return 'RANGE';
  const [h1, h2] = highs as [Swing, Swing];
  const [l1, l2] = lows as [Swing, Swing];
  const hh = h2.price > h1.price;
  const hl = l2.price > l1.price;
  const lh = h2.price < h1.price;
  const ll = l2.price < l1.price;
  if (hh && hl) return 'LONG';
  if (lh && ll) return 'SHORT';
  return 'RANGE';
}

export function pct(a: number, b: number): number {
  if (b === 0) return 0;
  return ((a - b) / b) * 100;
}

export function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

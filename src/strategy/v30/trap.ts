/**
 * V3.0 — TRAP DETECTION on the execution timeframe.
 *
 * Ported from `research/v30_htf_trap.ts` (`bodyRatio`, `detectTrap`).
 *
 * A trap is ONE closed bar that
 *   - pierces a confirmed higher-timeframe swing (takes the liquidity), and
 *   - closes back behind that level (the reclaim),
 * with a decisive body and a volume surge.
 *
 * Pierce and reclaim must happen on the SAME bar — there is no multi-bar
 * reclaim window here, unlike the V2.x sniper family.
 */

import type { Candle } from '../../core/types';
import type { TrapLevels } from './levels';
import type { V30Params } from './params';

export type Direction = 'LONG' | 'SHORT';

export interface TrapSignal {
  direction: Direction;
  /** The higher-timeframe level that was swept. */
  level: number;
  /** The wick extreme of the reclaim bar — the stop anchors here. */
  sweepExtreme: number;
  bodyRatio: number;
  rvol: number;
}

/** Body / full range of a candle, 0 when the range is degenerate. */
export function bodyRatio(c: Candle): number {
  const range = c.high - c.low;
  if (!(range > 0)) return 0;
  return Math.abs(c.close - c.open) / range;
}

/**
 * Detect a liquidation trap on a CLOSED bar.
 *
 * SHORT: pierces a swing HIGH and closes back below it.
 * LONG : pierces a swing LOW  and closes back above it.
 *
 * Order of the checks is part of the frozen behaviour and is preserved: the
 * body/volume filters run first, and the SHORT branch is evaluated before the
 * LONG one, so a bar that sweeps both edges resolves to SHORT.
 */
export function detectTrap(
  c: Candle,
  levels: TrapLevels,
  rvol: number | null,
  p: V30Params,
): TrapSignal | null {
  const br = bodyRatio(c);
  if (br < p.bodyRatioMin) return null;
  if (rvol === null || !(rvol > p.rvolMin)) return null;

  if (
    levels.swingHigh !== null &&
    c.high > levels.swingHigh &&
    c.close < levels.swingHigh
  ) {
    return {
      direction: 'SHORT',
      level: levels.swingHigh,
      sweepExtreme: c.high,
      bodyRatio: br,
      rvol,
    };
  }

  if (
    levels.swingLow !== null &&
    c.low < levels.swingLow &&
    c.close > levels.swingLow
  ) {
    return {
      direction: 'LONG',
      level: levels.swingLow,
      sweepExtreme: c.low,
      bodyRatio: br,
      rvol,
    };
  }

  return null;
}

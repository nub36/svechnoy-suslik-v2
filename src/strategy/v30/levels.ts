/**
 * V3.0 — 4H STRUCTURE LEVELS.
 *
 * Ported from `research/v30_htf_trap.ts` (`confirmedLevels`). Two causality
 * filters are applied, both required:
 *
 *   1. only higher-timeframe candles that had CLOSED by the evaluated bar's
 *      close time are visible (`closedHtfCandles`);
 *   2. within those, a pivot counts only from its `confirmedIndex` onward, i.e.
 *      only once its right-bars have printed.
 *
 * Dropping either filter is look-ahead bias: the level would move with
 * information that did not exist at decision time.
 */

import type { Candle, Timeframe } from '../../core/types';
import { findSwingsV2 } from '../v2/structure';
import { closedHtfCandles } from '../v2/htf';

export interface TrapLevels {
  /** Confirmed swing high available at this moment, or null. */
  swingHigh: number | null;
  /** Confirmed swing low available at this moment, or null. */
  swingLow: number | null;
}

/**
 * Most recent CONFIRMED swing high/low as of `asOfCloseTime`.
 *
 * The last swing of each kind wins, which is what "most recent" means here and
 * is exactly what the frozen research implementation does.
 */
export function confirmedLevels(
  htfCandles: readonly Candle[],
  asOfCloseTime: number,
  strength: number,
  htfTimeframe: Timeframe,
): TrapLevels {
  const usable = closedHtfCandles(htfCandles, htfTimeframe, asOfCloseTime);
  if (usable.length < strength * 2 + 2) return { swingHigh: null, swingLow: null };

  const swings = findSwingsV2(usable, strength);
  const lastIdx = usable.length - 1;

  let swingHigh: number | null = null;
  let swingLow: number | null = null;
  for (const s of swings) {
    if (s.confirmedIndex > lastIdx) continue; // right-bars not yet printed
    if (s.kind === 'HIGH') swingHigh = s.price;
    else swingLow = s.price;
  }
  return { swingHigh, swingLow };
}

/** The active 4H range, or null when either edge is missing. */
export function activeRange(levels: TrapLevels): { low: number; high: number } | null {
  if (levels.swingHigh === null || levels.swingLow === null) return null;
  if (!(levels.swingHigh > levels.swingLow)) return null;
  return { low: levels.swingLow, high: levels.swingHigh };
}

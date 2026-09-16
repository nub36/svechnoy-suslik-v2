/**
 * V2.5 DYNAMIC TRAILING STOP + BREAKEVEN EXIT ENGINE — research simulator.
 *
 * Implements docs/V2_5_TRAILING_STOP_PREREGISTRATION.md exactly.
 *
 * WHY THIS IS NOT IN src/outcome/tracker.ts
 * -----------------------------------------
 * `src/outcome/tracker.ts` is part of the frozen surface: every stage since
 * `4839074` enforces `git diff 4839074 -- src/outcome/tracker.ts` == empty, and
 * `trackOutcome` IS the frozen exit model. Baseline A must keep calling the
 * unmodified tracker, otherwise "V2.5 vs A" would compare two modified engines
 * and the ablation would be meaningless. The trailing logic therefore lives
 * here, in research code, and the frozen tracker is untouched.
 *
 * MECHANIC (fixed, not swept)
 *   initial   stop = S0 (structural, from the frozen engine)
 *   breakeven MFE >= 1.0R  -> stop = entry
 *   trailing  after breakeven, stop = peakMFE - 1.0R (in R terms)
 *   step      stop only updates when MFE advances >= 0.25R since last update
 *   targets   NONE — exit is trail, original SL, or timeout
 *   timeout   MFE < 1.0R within 10 bars -> close at that bar's CLOSE
 *
 * INTRABAR RULES (R1-R5), all conservative and fixed in advance:
 *   R1 stop is checked BEFORE the same bar's favourable extreme; a bar that
 *      both makes a new MFE high and breaches the stop books as a STOP exit.
 *   R2 the stop in force on a bar is computed from COMPLETED prior bars only,
 *      so a new high cannot retroactively protect itself.
 *   R3 the stop never moves backwards.
 *   R4 breakeven cannot arm on the entry bar.
 *   R5 timeout counts the entry bar as 1 (frozen `i + 1 >= timeoutBars`).
 */

import type { Candle } from '../../src/core/types';

export const BREAKEVEN_R = 1.0;
export const TRAIL_DISTANCE_R = 1.0;
export const TRAIL_STEP_R = 0.25;
export const TIMEOUT_BARS = 10;

export type V25ExitReason = 'TRAIL' | 'BE' | 'SL' | 'TIMEOUT';

export interface V25Input {
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;            // S0, structural
  /** Bars from the entry bar onward, chronological, closed only. */
  bars: readonly Candle[];
}

export interface V25Outcome {
  reason: V25ExitReason;
  exitPrice: number;
  barsHeld: number;
  /** Gross R, fees excluded. */
  grossR: number;
  /** Peak favourable excursion in R over the life of the trade. */
  mfeR: number;
  /** MFE in R at the moment of exit (same as mfeR; kept explicit). */
  mfeAtExitR: number;
  /** Worst adverse excursion in R. */
  maeR: number;
  /** Did the trade ever arm breakeven? */
  reachedBreakeven: boolean;
  /** Final stop level in force at exit. */
  finalStop: number;
}

/**
 * Simulate one trade. Returns null only when the input is degenerate or the
 * series ends before any exit condition fires (dataset boundary).
 */
export function simulateTrailing(input: V25Input): V25Outcome | null {
  const { direction, entryPrice, stopLoss, bars } = input;
  const risk = Math.abs(entryPrice - stopLoss);
  if (!(risk > 0) || bars.length === 0) return null;

  const long = direction === 'LONG';
  /** Favourable excursion of a price, in R. */
  const rOf = (p: number): number =>
    (long ? p - entryPrice : entryPrice - p) / risk;
  /** Price that corresponds to a given R level. */
  const priceAtR = (r: number): number =>
    long ? entryPrice + r * risk : entryPrice - r * risk;

  let stop = stopLoss;               // current stop PRICE
  let stopR = rOf(stopLoss);         // same, in R (negative before breakeven)
  let peakMfe = 0;                   // R, from completed bars (R2)
  let lastUpdateMfe = 0;             // R at which the stop was last moved
  let armed = false;                 // breakeven reached
  let maxFav = -Infinity;
  let maxAdv = Infinity;

  for (let i = 0; i < bars.length; i++) {
    const c = bars[i]!;
    const favPrice = long ? c.high : c.low;
    const advPrice = long ? c.low : c.high;
    const favR = rOf(favPrice);
    const advR = rOf(advPrice);
    if (favR > maxFav) maxFav = favR;
    if (advR < maxAdv) maxAdv = advR;

    // ---- R1 + R2: the stop in force comes from COMPLETED bars, and is
    //      checked BEFORE this bar's favourable extreme can move it.
    const hitStop = long ? c.low <= stop : c.high >= stop;
    if (hitStop) {
      const reason: V25ExitReason = !armed
        ? 'SL'
        : (Math.abs(stopR) < 1e-9 ? 'BE' : 'TRAIL');
      return {
        reason,
        exitPrice: stop,
        barsHeld: i + 1,
        grossR: rOf(stop),
        mfeR: Math.max(0, maxFav),
        mfeAtExitR: Math.max(0, maxFav),
        maeR: Number.isFinite(maxAdv) ? maxAdv : 0,
        reachedBreakeven: armed,
        finalStop: stop,
      };
    }

    // ---- update peak MFE from THIS bar, then move the stop for FUTURE bars.
    if (favR > peakMfe) peakMfe = favR;

    if (!armed && peakMfe >= BREAKEVEN_R) {
      armed = true;
      stop = entryPrice;
      stopR = 0;
      lastUpdateMfe = peakMfe;
      // After arming, immediately consider a trail if MFE is already far along.
      const trailR = peakMfe - TRAIL_DISTANCE_R;
      if (trailR > stopR) {
        stopR = trailR;
        stop = priceAtR(trailR);
        lastUpdateMfe = peakMfe;
      }
    } else if (armed && peakMfe - lastUpdateMfe >= TRAIL_STEP_R) {
      const trailR = peakMfe - TRAIL_DISTANCE_R;
      if (trailR > stopR) {                    // R3: never backwards
        stopR = trailR;
        stop = priceAtR(trailR);
      }
      lastUpdateMfe = peakMfe;
    }

    // ---- R5: timeout only when +1R was never reached.
    if (!armed && i + 1 >= TIMEOUT_BARS) {
      return {
        reason: 'TIMEOUT',
        exitPrice: c.close,
        barsHeld: i + 1,
        grossR: rOf(c.close),
        mfeR: Math.max(0, maxFav),
        mfeAtExitR: Math.max(0, maxFav),
        maeR: Number.isFinite(maxAdv) ? maxAdv : 0,
        reachedBreakeven: false,
        finalStop: stop,
      };
    }
  }

  return null; // unresolved at the dataset boundary
}

/** Per-leg fee in R: maker on entry, taker on exit. No rebate. */
export function feeR(
  entryPrice: number, exitPrice: number, riskPerUnit: number,
  makerBps: number, takerBps: number,
): number {
  if (!(riskPerUnit > 0)) return 0;
  return ((makerBps / 10000) * entryPrice
    + (takerBps / 10000) * Math.abs(exitPrice)) / riskPerUnit;
}

export interface FeeEnv { label: string; makerBps: number; takerBps: number }

/**
 * Headline is 2 bps maker entry + 5 bps taker exit. The task labels this
 * "FUT_4"; earlier reports labelled the identical 2/5 model "FUT_7". Both names
 * denote the same arithmetic here.
 */
export const V25_FEE_ENVS: readonly FeeEnv[] = [
  { label: 'GROSS', makerBps: 0, takerBps: 0 },
  { label: 'FUT_4', makerBps: 2, takerBps: 5 },
  { label: 'SPOT', makerBps: 5, takerBps: 5 },
];

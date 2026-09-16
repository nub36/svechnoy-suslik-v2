/**
 * V2.1 "CONFIRMED EXTREME CORRIDOR ENTRY" — research replay.
 *
 * Implements docs/V2_1_CONFIRMED_EXTREME_CORRIDOR_PREREGISTRATION.md exactly.
 * Frozen V2 (4839074) is NOT modified: `evaluateV2` supplies the signal, stop
 * and target ladder, and `trackOutcome` resolves the outcome. This file only
 * decides (a) whether a confirmed extreme exists, (b) whether the setup clears
 * the Fee Drag Guard and the confluence filter, and (c) when/at what price the
 * position is entered.
 *
 * CAUSALITY. Every gate reads the V2Setup produced at CLOSED bar N. The
 * corridor is published at N and can only fill at N+1 or later. No N+1 high/low
 * is used to build it, no future pivot, no future FVG/OB.
 */

import {
  findLiquidityPools, findSwingsV2,
} from '../../src/strategy/v2/structure';
import type { Settings } from '../../src/core/settings';
import type { Candle } from '../../src/core/types';
import type { LiquidityPool, V2Setup } from '../../src/strategy/v2/types';

/* ---------------- preregistered constants (NOT swept) ---------------- */

export const CORRIDOR_ATR_FRAC = 0.10;
export const CORRIDOR_MAX_PCT = 0.0015;      // 0.15 % of price
export const EXPIRY_BARS = 3;
export const FEE_GUARD_PCT = 0.0035;         // stop >= 0.35 % of entry
export const FEE_GUARD_ATR = 0.50;           // stop >= 0.50 ATR
export const RVOL_MIN = 1.2;
export const RSI_LONG_MAX = 45;
export const RSI_SHORT_MIN = 55;
export const CONFLUENCE_MIN = 3;             // of 4

// Reversal confirmation
export const RECLAIM_MAX_BARS = 3;
export const DISPLACEMENT_MIN_BODY_ATR = 0.60;
export const SWEEP_MIN_PENETRATION_ATR = 0.10;
export const SWEEP_MIN_WICK_RATIO = 0.25;
// Continuation confirmation
export const BREAKOUT_MIN_CLOSE_ATR = 0.25;
export const BREAKOUT_MIN_BODY_RATIO = 0.50;
export const BREAKOUT_MIN_HOLD_BARS = 1;

/** Empirically measured Binance Spot tick sizes. */
export const TICK_SIZE: Readonly<Record<string, number>> = {
  BTCUSDT: 0.01, ETHUSDT: 0.01, BNBUSDT: 0.01, SOLUSDT: 0.01,
  XRPUSDT: 0.0001, DOGEUSDT: 0.00001,
};

export type PoolKind = 'SWING' | 'EQUAL' | 'CLUSTER' | 'NONE';

/* ---------------- gate 1: confirmed extreme ---------------- */

export interface ExtremeVerdict {
  confirmed: boolean;
  path: 'REVERSAL' | 'CONTINUATION' | null;
  reason: string;
}

export function confirmedExtreme(s: V2Setup): ExtremeVerdict {
  const dir = s.direction;
  if (dir === 'WAIT') return { confirmed: false, path: null, reason: 'wait' };

  // 2a REVERSAL — sweep + reclaim + displacement
  if (s.kind === 'REVERSAL') {
    const sw = s.sweep;
    if (!sw || sw.direction !== dir) {
      return { confirmed: false, path: 'REVERSAL', reason: 'no_directional_sweep' };
    }
    if (sw.reclaimed !== true) {
      return { confirmed: false, path: 'REVERSAL', reason: 'not_reclaimed' };
    }
    if (sw.reclaimBars === null || sw.reclaimBars > RECLAIM_MAX_BARS) {
      return { confirmed: false, path: 'REVERSAL', reason: 'reclaim_too_slow' };
    }
    if (sw.penetrationAtr < SWEEP_MIN_PENETRATION_ATR) {
      return { confirmed: false, path: 'REVERSAL', reason: 'shallow_penetration' };
    }
    if (sw.wickRatio < SWEEP_MIN_WICK_RATIO) {
      return { confirmed: false, path: 'REVERSAL', reason: 'weak_rejection_wick' };
    }
    const d = s.displacement;
    if (!d || d.direction !== dir) {
      return { confirmed: false, path: 'REVERSAL', reason: 'no_displacement' };
    }
    if (d.bodyAtr < DISPLACEMENT_MIN_BODY_ATR) {
      return { confirmed: false, path: 'REVERSAL', reason: 'weak_displacement' };
    }
    return { confirmed: true, path: 'REVERSAL', reason: 'sweep_reclaim_displacement' };
  }

  // 2b CONTINUATION — body close + hold
  if (s.kind === 'CONTINUATION') {
    const b = s.breakout;
    if (!b || b.direction !== dir) {
      return { confirmed: false, path: 'CONTINUATION', reason: 'no_directional_breakout' };
    }
    if (b.closeBeyondAtr < BREAKOUT_MIN_CLOSE_ATR) {
      return { confirmed: false, path: 'CONTINUATION', reason: 'close_not_beyond' };
    }
    if (b.bodyRatio < BREAKOUT_MIN_BODY_RATIO) {
      return { confirmed: false, path: 'CONTINUATION', reason: 'wick_not_body' };
    }
    if (b.held !== true) {
      return { confirmed: false, path: 'CONTINUATION', reason: 'did_not_hold' };
    }
    if (b.holdBars < BREAKOUT_MIN_HOLD_BARS) {
      return { confirmed: false, path: 'CONTINUATION', reason: 'hold_too_short' };
    }
    if (b.immediateReclaim === true) {
      return { confirmed: false, path: 'CONTINUATION', reason: 'immediate_reclaim' };
    }
    return { confirmed: true, path: 'CONTINUATION', reason: 'body_close_and_hold' };
  }

  return { confirmed: false, path: null, reason: 'no_setup_kind' };
}

/* ---------------- gate 2: fee drag guard ---------------- */

export function feeGuardPasses(entry: number, stop: number, atr: number): boolean {
  const d = Math.abs(entry - stop);
  // The stop is NEVER widened to satisfy this; the setup is simply skipped.
  return d >= FEE_GUARD_PCT * entry && d >= FEE_GUARD_ATR * atr;
}

/* ---------------- gate 3: confluence ---------------- */

export interface ConfluenceVerdict { votes: number; detail: Record<string, boolean> }

export function confluence(s: V2Setup): ConfluenceVerdict {
  const long = s.direction === 'LONG';
  const rvol = s.vol.rvol;
  const rsi = s.rsi.rsi;
  const hs = s.macd.histogramSlope;

  const volumeVote = rvol !== null && rvol > RVOL_MIN;
  const rsiVote = long
    ? (s.rsi.bullishDivergence || (rsi !== null && rsi <= RSI_LONG_MAX))
    : (s.rsi.bearishDivergence || (rsi !== null && rsi >= RSI_SHORT_MIN));
  const macdVote = long
    ? (s.macd.crossUp || (hs !== null && hs > 0))
    : (s.macd.crossDown || (hs !== null && hs < 0));
  const emaVote = long
    ? s.ema.alignment === 'BULLISH'
    : s.ema.alignment === 'BEARISH';

  const detail = { volume: volumeVote, rsi: rsiVote, macd: macdVote, ema: emaVote };
  const votes = Object.values(detail).filter(Boolean).length;
  return { votes, detail };
}

/* ---------------- corridor construction ---------------- */

export interface Corridor { low: number; high: number; halfWidth: number }

const quantize = (v: number, tick: number): number =>
  tick > 0 ? Math.round(v / tick) * tick : v;

/**
 * Corridor centred on close(N). Width is ATR-scaled, floored at one tick and
 * capped at CORRIDOR_MAX_PCT of price, then quantized to the symbol's tick.
 */
export function buildCorridor(centre: number, atr: number, tick: number): Corridor | null {
  if (!(centre > 0) || !(atr > 0)) return null;
  const half = Math.min(
    Math.max(CORRIDOR_ATR_FRAC * atr, tick),
    CORRIDOR_MAX_PCT * centre,
  );
  const low = quantize(centre - half, tick);
  const high = quantize(centre + half, tick);
  if (!(high >= low)) return null;
  return { low, high, halfWidth: half };
}

/**
 * Recover the pool kind of the swept/broken extreme by recomputing pools with
 * the ENGINE'S EXACT WINDOW (`visible.slice(-lookback)`), the same technique the
 * liquidity-invariant audit uses. `V2Setup` does not expose the pool list, and
 * frozen code must not be changed to publish it.
 *
 * Diagnostic only: no rule depends on the result, it is reported separately.
 */
export function extremePoolKind(
  s: V2Setup, visible: readonly Candle[], settings: Settings,
): PoolKind {
  const atr = s.atr.atr;
  if (atr === null || atr <= 0) return 'NONE';
  const level = s.kind === 'REVERSAL' ? s.sweep?.level : s.breakout?.level;
  if (level === undefined) return 'NONE';

  const lookback = Math.floor(settings.num('engine.lookback_candles'));
  const swingStrength = Math.floor(settings.num('engine.swing_lookback'));
  const tolAtr = settings.num('v2.liquidity_tol_atr');
  const window = visible.slice(Math.max(0, visible.length - lookback));
  const wi = window.length - 1;
  const swings = findSwingsV2(window, swingStrength);
  const pools: LiquidityPool[] = findLiquidityPools(
    window, swings, wi, atr, tolAtr, lookback, {
      sweepPenetrationAtr: settings.num('v2.sweep_min_penetration_atr'),
      acceptanceAtr: settings.num('v2.breakout_min_close_atr'),
    });

  let best: LiquidityPool | null = null;
  let bestD = Infinity;
  for (const p of pools) {
    const d = Math.abs(p.price - level);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (!best || bestD > atr * tolAtr) return 'NONE';
  return best.kind;
}

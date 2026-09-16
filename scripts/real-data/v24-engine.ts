/**
 * V2.4 ASYMMETRIC SNIPER ENGINE — filter, LONG asymmetry, structural targets.
 *
 * Implements docs/V2_4_ASYMMETRIC_SNIPER_PREREGISTRATION.md exactly.
 * Frozen V2 (4839074) is NOT modified: `evaluateV2` supplies the signal and the
 * structural stop, `trackOutcome` resolves outcomes, and the HTF EMA200 leg
 * reuses the FROZEN `buildEmaContext` / `closedHtfCandles`.
 *
 * CAUSALITY: every input is bounded at CLOSED bar N. `closedHtfCandles` admits
 * only HTF bars whose close time <= the evaluated bar's close time, so no future
 * HTF candle can enter the EMA200 leg.
 */

import { buildEmaContext } from '../../src/strategy/v2/indicators';
import { HTF_MAP, closedHtfCandles } from '../../src/strategy/v2/htf';
import type { Candle, Timeframe } from '../../src/core/types';
import type { TargetPlan, V2Setup } from '../../src/strategy/v2/types';
import type { PoolKind } from './corridor-entry';

/* ---------------- preregistered constants (NOT swept) ---------------- */

export const RECLAIM_MAX_BARS = 3;
export const MIN_PENETRATION_ATR = 0.10;
export const MIN_WICK_RATIO = 0.25;
export const MIN_BODY_RATIO = 0.35;
export const MIN_RVOL = 1.2;
/** EMA200 needs at least this many closed HTF bars, else the leg is false. */
export const HTF_EMA_MIN_BARS = 200;

export interface FilterVerdict { ok: boolean; reason: string }

/* ---------------- base sniper filter (both sides) ---------------- */

export function baseSniper(s: V2Setup, poolKind: PoolKind): FilterVerdict {
  if (s.direction === 'WAIT') return { ok: false, reason: 'wait' };
  if (s.kind !== 'REVERSAL') return { ok: false, reason: 'continuation_disabled' };

  const sw = s.sweep;
  if (!sw) return { ok: false, reason: 'no_sweep' };
  if (poolKind !== 'SWING' && poolKind !== 'EQUAL' && poolKind !== 'CLUSTER') {
    return { ok: false, reason: 'no_structural_extreme' };
  }
  if (sw.direction !== s.direction) return { ok: false, reason: 'sweep_wrong_direction' };
  if (sw.reclaimed !== true) return { ok: false, reason: 'not_reclaimed' };
  if (sw.reclaimBars === null || sw.reclaimBars > RECLAIM_MAX_BARS) {
    return { ok: false, reason: 'reclaim_too_slow' };
  }
  if (sw.penetrationAtr < MIN_PENETRATION_ATR) {
    return { ok: false, reason: 'shallow_penetration' };
  }
  if (sw.wickRatio < MIN_WICK_RATIO) return { ok: false, reason: 'weak_rejection_wick' };
  if (sw.bodyRatio < MIN_BODY_RATIO) return { ok: false, reason: 'weak_body_reclaim' };
  if (!(sw.rvol > MIN_RVOL)) return { ok: false, reason: 'low_rvol' };
  return { ok: true, reason: 'base_sniper' };
}

/* ---------------- LONG confluence asymmetry ---------------- */

export type LongLeg = 'HTF_EMA200' | 'HTF_STRUCTURE' | 'RSI_DIVERGENCE' | 'NONE';

export interface AsymVerdict { ok: boolean; leg: LongLeg; reason: string }

/**
 * Compute `close(N) > EMA200` on the causally-bounded primary HTF series.
 *
 * The primary HTF is the FIRST entry of the frozen HTF_MAP for this timeframe.
 * `closedHtfCandles` filters to bars that had actually closed by `asOfCloseTime`,
 * so a future HTF bar cannot leak in. Fewer than HTF_EMA_MIN_BARS closed bars
 * => the leg is FALSE, never true-by-default.
 */
export function htfEma200Bullish(
  timeframe: Timeframe,
  htfCandles: Partial<Record<Timeframe, readonly Candle[]>> | undefined,
  asOfCloseTime: number,
  closeN: number,
): boolean {
  const primary = (HTF_MAP[timeframe] ?? [])[0];
  if (primary === undefined) return false;
  const raw = htfCandles?.[primary];
  if (!raw || raw.length === 0) return false;
  const usable = closedHtfCandles(raw, primary, asOfCloseTime);
  if (usable.length < HTF_EMA_MIN_BARS) return false;
  const ema = buildEmaContext(usable, usable.length - 1, null);
  return ema.ema200 !== null && closeN > ema.ema200;
}

/**
 * LONG asymmetry. SHORTs always pass — no symmetric gate exists, by design.
 */
export function longAsymmetry(
  s: V2Setup,
  timeframe: Timeframe,
  htfCandles: Partial<Record<Timeframe, readonly Candle[]>> | undefined,
  asOfCloseTime: number,
  closeN: number,
): AsymVerdict {
  if (s.direction !== 'LONG') return { ok: true, leg: 'NONE', reason: 'short_unaffected' };

  if (htfEma200Bullish(timeframe, htfCandles, asOfCloseTime, closeN)) {
    return { ok: true, leg: 'HTF_EMA200', reason: 'htf_ema200_bullish' };
  }
  for (const h of s.htf ?? []) {
    if (h.available && h.bias === 'BULLISH') {
      return { ok: true, leg: 'HTF_STRUCTURE', reason: 'htf_structure_bullish' };
    }
  }
  if (s.rsi.bullishDivergence === true) {
    return { ok: true, leg: 'RSI_DIVERGENCE', reason: 'rsi_bullish_divergence' };
  }
  return { ok: false, leg: 'NONE', reason: 'long_no_htf_bullish_confluence' };
}

/* ---------------- structural SMC targets (no R-multiple) ---------------- */

export type Tp1Basis = 'INTERNAL_LIQUIDITY' | 'RANGE_EDGE' | 'EQUILIBRIUM' | 'NONE';

export interface StructTargets {
  targets: number[]; tp1Basis: Tp1Basis; ok: boolean;
}

/**
 * TP1 = nearest opposing structural liquidity (INTERNAL_LIQUIDITY or
 * RANGE_EDGE), else EQUILIBRIUM, else SKIP. No fixed R-multiple rung is ever
 * emitted — V2.3 measured the R-multiple ladder to hurt reversals.
 */
export function structuralTargetsV24(plans: readonly TargetPlan[]): StructTargets {
  const structural = plans.filter((t) => t.basis !== 'R_MULTIPLE');
  if (structural.length === 0) return { targets: [], tp1Basis: 'NONE', ok: false };

  const liquidity = structural.find(
    (t) => t.basis === 'INTERNAL_LIQUIDITY' || t.basis === 'RANGE_EDGE');
  const tp1 = liquidity ?? structural[0]!;
  const basis: Tp1Basis =
    tp1.basis === 'INTERNAL_LIQUIDITY' ? 'INTERNAL_LIQUIDITY'
      : tp1.basis === 'RANGE_EDGE' ? 'RANGE_EDGE'
        : tp1.basis === 'EQUILIBRIUM' ? 'EQUILIBRIUM' : 'NONE';
  if (basis === 'NONE') return { targets: [], tp1Basis: 'NONE', ok: false };

  const rest = structural.filter((t) => t !== tp1 && t.r > tp1.r);
  return {
    targets: [tp1, ...rest].slice(0, 3).map((t) => t.price),
    tp1Basis: basis, ok: true,
  };
}

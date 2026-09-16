/**
 * V2.2 HTF-FOCUSED SPOT/FUTURES ENGINE — research gates and target placement.
 *
 * Implements docs/V2_2_HTF_SPOT_ENGINE_PREREGISTRATION.md + AMENDMENT 1.
 * Frozen V2 (4839074) is NOT modified: `evaluateV2` supplies the signal and
 * structural stop, `trackOutcome` resolves outcomes. This file changes only
 * (a) the confirmation gates and (b) where TP1 is placed.
 *
 * CAUSALITY: every field read here is on the V2Setup produced at CLOSED bar N.
 */

import type { V2Setup, TargetPlan } from '../../src/strategy/v2/types';

/* ---------------- preregistered constants (NOT swept) ---------------- */

// Reversal — sweep + BODY RECLAIM + RVOL (replaces the displacement object)
export const REV_RECLAIM_MAX_BARS = 3;
export const REV_MIN_PENETRATION_ATR = 0.10;   // frozen v2.sweep_min_penetration_atr
export const REV_MIN_WICK_RATIO = 0.25;        // frozen v2.sweep_min_wick_ratio
export const REV_MIN_BODY_RATIO = 0.35;        // NEW — body reclaim
export const REV_MIN_RVOL = 1.2;               // NEW — participation

// Continuation — relaxed hold
export const CONT_MIN_CLOSE_ATR = 0.25;        // frozen v2.breakout_min_close_atr
export const CONT_MIN_BODY_RATIO = 0.50;
// holdBars >= 1 REMOVED; hold is evidenced by the absence of an immediate reclaim

export type ConfirmPath = 'REVERSAL' | 'CONTINUATION' | null;
export interface ConfirmVerdict {
  confirmed: boolean; path: ConfirmPath; reason: string;
}

/**
 * V2.2 confirmed extreme.
 *
 * Difference from V2.1, both preregistered:
 *  - REVERSAL no longer requires a separate `Displacement` object (the measured
 *    blocker: 205,534 `no_displacement` rejections reduced reversals to 0.8 % of
 *    trades). It now requires a body reclaim and participation on the sweep
 *    candle itself.
 *  - CONTINUATION no longer requires `holdBars >= 1` (639,450 rejections); hold
 *    is evidenced by `immediateReclaim === false`.
 */
export function confirmedExtremeV22(s: V2Setup): ConfirmVerdict {
  const dir = s.direction;
  if (dir === 'WAIT') return { confirmed: false, path: null, reason: 'wait' };

  if (s.kind === 'REVERSAL') {
    const sw = s.sweep;
    if (!sw || sw.direction !== dir) {
      return { confirmed: false, path: 'REVERSAL', reason: 'no_directional_sweep' };
    }
    if (sw.reclaimed !== true) {
      return { confirmed: false, path: 'REVERSAL', reason: 'not_reclaimed' };
    }
    if (sw.reclaimBars === null || sw.reclaimBars > REV_RECLAIM_MAX_BARS) {
      return { confirmed: false, path: 'REVERSAL', reason: 'reclaim_too_slow' };
    }
    if (sw.penetrationAtr < REV_MIN_PENETRATION_ATR) {
      return { confirmed: false, path: 'REVERSAL', reason: 'shallow_penetration' };
    }
    if (sw.wickRatio < REV_MIN_WICK_RATIO) {
      return { confirmed: false, path: 'REVERSAL', reason: 'weak_rejection_wick' };
    }
    if (sw.bodyRatio < REV_MIN_BODY_RATIO) {
      return { confirmed: false, path: 'REVERSAL', reason: 'weak_body_reclaim' };
    }
    if (!(sw.rvol > REV_MIN_RVOL)) {
      return { confirmed: false, path: 'REVERSAL', reason: 'low_rvol' };
    }
    return { confirmed: true, path: 'REVERSAL', reason: 'sweep_body_reclaim_rvol' };
  }

  if (s.kind === 'CONTINUATION') {
    const b = s.breakout;
    if (!b || b.direction !== dir) {
      return { confirmed: false, path: 'CONTINUATION', reason: 'no_directional_breakout' };
    }
    if (b.closeBeyondAtr < CONT_MIN_CLOSE_ATR) {
      return { confirmed: false, path: 'CONTINUATION', reason: 'close_not_beyond' };
    }
    if (b.bodyRatio < CONT_MIN_BODY_RATIO) {
      return { confirmed: false, path: 'CONTINUATION', reason: 'wick_not_body' };
    }
    if (b.immediateReclaim === true) {
      return { confirmed: false, path: 'CONTINUATION', reason: 'immediate_reclaim' };
    }
    return { confirmed: true, path: 'CONTINUATION', reason: 'body_close_no_reclaim' };
  }

  return { confirmed: false, path: null, reason: 'no_setup_kind' };
}

/* ---------------- structural target placement ---------------- */

export type Tp1Basis = 'INTERNAL_LIQUIDITY' | 'RANGE_EDGE' | 'EQUILIBRIUM' | 'NONE';

export interface StructuralTargets {
  targets: number[];      // shifted to the reference/fill price by the caller
  tp1Basis: Tp1Basis;
  ok: boolean;            // false => NO_STRUCTURAL_TP, skip the setup
}

/**
 * V2.2 target placement.
 *
 * TP1 = nearest opposing structural liquidity ahead of entry
 *       (INTERNAL_LIQUIDITY or RANGE_EDGE), else EQUILIBRIUM, else SKIP.
 *
 * The frozen 1R/2R/3R fallback is REMOVED: it manufactured targets that sat
 * close to the stop by construction and then failed the rr1 gate, which caused
 * 176,707 of 234,478 published corridors (75.36 %) to be rejected in V2.1.
 *
 * TP2/TP3 keep the frozen next-structural-level ordering — we simply drop any
 * R_MULTIPLE rung rather than re-deriving structure.
 */
export function structuralTargets(plans: readonly TargetPlan[]): StructuralTargets {
  // `plans` arrives ordered by distance from entry ascending (frozen builder).
  const structural = plans.filter((t) => t.basis !== 'R_MULTIPLE');
  if (structural.length === 0) {
    return { targets: [], tp1Basis: 'NONE', ok: false };
  }
  const first = structural[0]!;
  const liquidityFirst = structural.find(
    (t) => t.basis === 'INTERNAL_LIQUIDITY' || t.basis === 'RANGE_EDGE');

  // Preferred TP1 is the nearest liquidity/range-edge rung. If the nearest
  // structural rung is EQUILIBRIUM and no liquidity rung exists, equilibrium is
  // the declared fallback.
  const tp1 = liquidityFirst ?? first;
  const basis: Tp1Basis =
    tp1.basis === 'INTERNAL_LIQUIDITY' ? 'INTERNAL_LIQUIDITY'
      : tp1.basis === 'RANGE_EDGE' ? 'RANGE_EDGE'
        : tp1.basis === 'EQUILIBRIUM' ? 'EQUILIBRIUM' : 'NONE';
  if (basis === 'NONE') return { targets: [], tp1Basis: 'NONE', ok: false };

  // Ladder: TP1 then every further structural rung beyond it, distance-ordered.
  const rest = structural
    .filter((t) => t !== tp1)
    .filter((t) => t.r > tp1.r);
  const out = [tp1, ...rest].slice(0, 3).map((t) => t.price);
  return { targets: out, tp1Basis: basis, ok: true };
}

/* ---------------- fee environments (Amendment 1) ---------------- */

export interface FeeEnv { label: string; makerBps: number; takerBps: number }

export const FEE_ENVS: readonly FeeEnv[] = [
  { label: 'GROSS', makerBps: 0, takerBps: 0 },
  { label: 'SPOT', makerBps: 5, takerBps: 5 },   // 10 bps round trip, taker both
  { label: 'FUT_7', makerBps: 2, takerBps: 5 },  // maker entry, taker exit
  { label: 'FUT_4', makerBps: 2, takerBps: 2 },  // best case, both maker
];

/**
 * Per-leg fee in R. Entry is charged at the maker rate (the corridor is a
 * resting limit order); the exit is charged at the taker rate because SL and
 * TIMEOUT exits are market events.
 */
export function feeRPerLeg(
  entryPrice: number, exitPrice: number, riskPerUnit: number, env: FeeEnv,
): number {
  if (!(riskPerUnit > 0)) return 0;
  const entryFee = (env.makerBps / 10000) * entryPrice;
  const exitFee = (env.takerBps / 10000) * Math.abs(exitPrice);
  return (entryFee + exitFee) / riskPerUnit;
}

/**
 * V2.3 SNIPER REVERSAL ENGINE — filter and target ladder.
 *
 * Implements docs/V2_3_SNIPER_REVERSAL_PREREGISTRATION.md exactly.
 * Frozen V2 (4839074) is NOT modified: `evaluateV2` supplies the signal and the
 * structural stop, `trackOutcome` resolves outcomes. This file decides only
 * (a) whether a reversal qualifies and (b) where the targets sit.
 *
 * CAUSALITY: every field read here is on the V2Setup produced at CLOSED bar N.
 */

import type { TargetPlan, V2Setup } from '../../src/strategy/v2/types';
import type { PoolKind } from './corridor-entry';

/* ---------------- preregistered constants (NOT swept) ---------------- */

export const RECLAIM_MAX_BARS = 3;
export const MIN_PENETRATION_ATR = 0.10;   // frozen v2.sweep_min_penetration_atr
export const MIN_WICK_RATIO = 0.25;        // frozen v2.sweep_min_wick_ratio
export const MIN_BODY_RATIO = 0.35;        // sniper gate
export const MIN_RVOL = 1.2;               // sniper gate

export const TP1_R = 1.5;
export const TP2_R = 2.5;

export interface SniperVerdict { ok: boolean; reason: string }

/**
 * V2.3 reversal filter.
 *
 * CONTINUATION IS DISABLED: any non-REVERSAL setup is rejected outright, which
 * is the defining scope decision of this engine.
 *
 * `poolKind` is passed in because `V2Setup` does not expose the pool list; the
 * caller recovers it with the engine's exact window. It is used ONLY as the
 * "a real extreme was swept" gate (condition 1) — the specific kind never
 * filters, since V2.1 measured EQH/EQL to be the worst-performing kind.
 */
export function sniperReversal(s: V2Setup, poolKind: PoolKind): SniperVerdict {
  if (s.direction === 'WAIT') return { ok: false, reason: 'wait' };
  if (s.kind !== 'REVERSAL') return { ok: false, reason: 'continuation_disabled' };

  const sw = s.sweep;
  if (!sw) return { ok: false, reason: 'no_sweep' };
  // 1. a real structural extreme must have been swept
  if (poolKind !== 'SWING' && poolKind !== 'EQUAL' && poolKind !== 'CLUSTER') {
    return { ok: false, reason: 'no_structural_extreme' };
  }
  // 2. directional
  if (sw.direction !== s.direction) return { ok: false, reason: 'sweep_wrong_direction' };
  // 3-4. causal reclaim, promptly
  if (sw.reclaimed !== true) return { ok: false, reason: 'not_reclaimed' };
  if (sw.reclaimBars === null || sw.reclaimBars > RECLAIM_MAX_BARS) {
    return { ok: false, reason: 'reclaim_too_slow' };
  }
  // 5-6. frozen sweep quality floors
  if (sw.penetrationAtr < MIN_PENETRATION_ATR) {
    return { ok: false, reason: 'shallow_penetration' };
  }
  if (sw.wickRatio < MIN_WICK_RATIO) return { ok: false, reason: 'weak_rejection_wick' };
  // 7-8. sniper gates
  if (sw.bodyRatio < MIN_BODY_RATIO) return { ok: false, reason: 'weak_body_reclaim' };
  if (!(sw.rvol > MIN_RVOL)) return { ok: false, reason: 'low_rvol' };

  return { ok: true, reason: 'sniper_reversal' };
}

/* ---------------- R-multiple target ladder ---------------- */

export interface Ladder { targets: number[]; tp2Source: 'R_MULTIPLE' | 'STRUCTURE' }

/**
 * V2.3 ladder, restored to R-multiples because V2.2 measured the structural-only
 * ladder to be strictly worse (R_MULTIPLE TP1 +0.0449 vs INTERNAL_LIQUIDITY
 * -0.0058).
 *
 *   TP1 = 1.5R                       — always clears risk.min_rr = 1 by construction
 *   TP2 = min(2.5R, nearest opposing liquidity beyond TP1)
 *   TP3 = nearest opposing liquidity beyond TP2, if any
 *
 * `plans` are the frozen builder's structural candidates, already ordered by
 * distance from entry. Only genuinely structural rungs are considered for the
 * TP2/TP3 substitution; R_MULTIPLE plans are ignored there because we generate
 * our own R levels.
 */
export function buildLadderV23(
  direction: 'LONG' | 'SHORT', entry: number, stop: number,
  plans: readonly TargetPlan[],
): Ladder {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return { targets: [], tp2Source: 'R_MULTIPLE' };
  const sign = direction === 'LONG' ? 1 : -1;
  const at = (r: number): number => entry + sign * r * risk;
  const ahead = (p: number): boolean => direction === 'LONG' ? p > entry : p < entry;
  const rOf = (p: number): number =>
    (direction === 'LONG' ? p - entry : entry - p) / risk;

  const tp1 = at(TP1_R);

  // Structural candidates strictly beyond TP1, nearest first.
  const structural = plans
    .filter((t) => t.basis !== 'R_MULTIPLE')
    .map((t) => t.price)
    .filter((p) => ahead(p) && rOf(p) > TP1_R)
    .sort((a, b) => Math.abs(a - entry) - Math.abs(b - entry));

  const rMultiple2 = at(TP2_R);
  const nearestStruct = structural[0];
  // TP2 = min(2.5R, nearest opposing liquidity beyond TP1)
  let tp2: number;
  let tp2Source: 'R_MULTIPLE' | 'STRUCTURE';
  if (nearestStruct !== undefined && rOf(nearestStruct) < TP2_R) {
    tp2 = nearestStruct; tp2Source = 'STRUCTURE';
  } else {
    tp2 = rMultiple2; tp2Source = 'R_MULTIPLE';
  }

  // TP3 = nearest structural level strictly beyond TP2 (structure only).
  const tp3 = structural.find((p) => rOf(p) > rOf(tp2));

  const out = tp3 === undefined ? [tp1, tp2] : [tp1, tp2, tp3];
  return { targets: out, tp2Source };
}

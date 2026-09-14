/**
 * Risk, stop-loss and take-profit planning.
 *
 * ATR IS USED HERE AND ONLY HERE — for position risk sizing and stop distance.
 * It is never a signal confirmation input (see smart-money.ts).
 */

import type { Direction, RiskPlan } from '../core/types';
import type { Settings } from '../core/settings';

export interface BuildRiskArgs {
  direction: Direction;
  /** The ACTUAL fill price = OPEN of candle N+1 */
  entry: number;
  atr: number;
  settings: Settings;
  /** Optional structural invalidation level (e.g. swept low) */
  structuralStop?: number | null;
}

/**
 * Stop = entry -/+ ATR * multiple, widened to the structural invalidation level
 * when one is supplied. Take-profits are pure R multiples of the final risk.
 */
export function buildRiskPlan(args: BuildRiskArgs): RiskPlan | null {
  const { direction, entry, atr, settings } = args;
  if (!Number.isFinite(entry) || entry <= 0) return null;
  if (!Number.isFinite(atr) || atr <= 0) return null;

  const slMult = settings.num('risk.sl_atr_mult');
  const atrDistance = atr * slMult;
  const policy = settings.slPolicy();

  const atrStop = direction === 'LONG' ? entry - atrDistance : entry + atrDistance;
  const structural = args.structuralStop;
  const hasStructural =
    structural !== null && structural !== undefined && Number.isFinite(structural);

  let stopLoss: number;
  if (policy === 'STRUCTURE' && hasStructural) {
    // Pure structural invalidation.
    stopLoss = structural as number;
  } else if (policy === 'ATR_OR_STRUCTURE' && hasStructural) {
    // Whichever is further away (safer) — never tighten the stop.
    stopLoss = atrStop;
    const st = structural as number;
    if (direction === 'LONG' && st < stopLoss && st > 0) stopLoss = st;
    if (direction === 'SHORT' && st > stopLoss) stopLoss = st;
  } else {
    // 'ATR', or a policy needing a structural level we do not have.
    stopLoss = atrStop;
  }

  const riskPerUnit = Math.abs(entry - stopLoss);
  if (!(riskPerUnit > 0)) return null;
  if (direction === 'LONG' && stopLoss >= entry) return null;
  if (direction === 'SHORT' && stopLoss <= entry) return null;

  // TP1 / TP2 / TP3 come from their own explicit settings.
  const tps = settings.tpMultiples();

  const takeProfits = tps.map((r) =>
    direction === 'LONG' ? entry + riskPerUnit * r : entry - riskPerUnit * r,
  );

  const account = settings.num('risk.account_quote');
  const riskPct = settings.num('risk.risk_pct');
  const riskQuote = (account * riskPct) / 100;
  const qty = riskQuote / riskPerUnit;
  const positionSizeQuote = qty * entry;

  const firstTp = takeProfits[0] ?? entry;
  const rrTp1 = Math.abs(firstTp - entry) / riskPerUnit;

  return {
    direction,
    entry,
    stopLoss,
    takeProfits,
    riskPerUnit,
    rrTp1,
    atr,
    positionSizeQuote,
    qty,
  };
}

/**
 * R multiple of an exit. Positive = profit in units of initial risk.
 * Direction-aware and fee-adjusted by the caller.
 */
export function rMultiple(
  direction: Direction,
  entry: number,
  exit: number,
  riskPerUnit: number,
): number {
  if (!(riskPerUnit > 0)) return 0;
  const move = direction === 'LONG' ? exit - entry : entry - exit;
  return move / riskPerUnit;
}

export function pnlPct(direction: Direction, entry: number, exit: number): number {
  if (entry <= 0) return 0;
  const move = direction === 'LONG' ? exit - entry : entry - exit;
  return (move / entry) * 100;
}

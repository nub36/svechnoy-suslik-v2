/**
 * V3.0 — OUTCOME RESOLUTION for a live signal.
 *
 * The V1 ladder tracker (`src/outcome/tracker.ts`) has no partial-exit
 * accounting: milestone timestamps are written but the position is closed as a
 * whole at the final rung. V3.0 exits HALF at TP1 and moves the stop to
 * breakeven, so the realised R is a weighted sum of two legs and the fee is
 * charged on three legs (maker entry + two taker exits). This module performs
 * that walk using the same `manageTrade` the strategy module uses, so the live
 * record and the validated simulator cannot diverge.
 *
 * Reported R is NET of fees at the configured maker/taker bps, because that is
 * the number the VALIDATION passed on (+0.0600 R/trade @2/5 bps). The gross
 * figure and the leg detail are kept alongside it so nothing is hidden.
 */

import type { Candle } from '../../core/types';
import type { Settings } from '../../core/settings';
import { manageTrade, type ExitReason, type V30Trade } from './execution';
import { v30Params, type V30Params } from './params';
import type { V30SignalPlan } from './runner';
import type { SignalState } from '../../core/types';

export interface V30Outcome {
  terminal: boolean;
  exit: ExitReason;
  /** Net R after per-leg fees — the headline figure. */
  netR: number;
  /** Gross R before fees. */
  grossR: number;
  /** Fees paid, in R. */
  feeR: number;
  barsHeld: number;
  hitTp1: boolean;
  hitTp2: boolean;
  exitPrice: number;
  exitCandleTime: number;
  legs: readonly { price: number; weight: number; taker: boolean }[];
  /** Signal state implied by the exit. */
  state: SignalState;
}

/** The exit price implied by an exit reason (needed for the outcome row). */
function exitPriceOf(trade: V30Trade, direction: 'LONG' | 'SHORT', entry: number): number {
  const last = trade.legs[trade.legs.length - 1];
  if (trade.exit === 'TP1_THEN_BE') return entry; // stop moved to the entry price
  void direction;
  return last ? last.price : entry;
}

/**
 * Walk a filled V3.0 position forward over CLOSED bars only.
 *
 * Returns null while the trade is still open — a trade that has not resolved
 * must never be recorded as a completed outcome.
 */
export function resolveV30Outcome(args: {
  plan: V30SignalPlan;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;
  entryCandleTime: number;
  candles: readonly Candle[];
  settings: Settings;
}): V30Outcome | null {
  const p: V30Params = v30Params(args.settings);
  const { plan } = args;

  const bars = args.candles
    .filter((c) => c.isClosed && c.openTime >= args.entryCandleTime)
    .sort((a, b) => a.openTime - b.openTime);
  if (bars.length === 0) return null;

  const trade = manageTrade(
    args.direction,
    args.entryPrice,
    args.stopLoss,
    plan.plan.tp1,
    plan.plan.tp2,
    bars,
    p,
  );
  if (!trade) return null;

  const feeR = trade.feeR(p.makerBps, p.takerBps);
  const lastIdx = Math.min(trade.barsHeld - 1, bars.length - 1);
  const exitCandle = bars[lastIdx];

  return {
    terminal: true,
    exit: trade.exit,
    grossR: trade.grossR,
    feeR,
    netR: trade.grossR - feeR,
    barsHeld: trade.barsHeld,
    hitTp1: trade.hitTp1,
    hitTp2: trade.hitTp2,
    exitPrice: exitPriceOf(trade, args.direction, args.entryPrice),
    exitCandleTime: exitCandle ? exitCandle.openTime : args.entryCandleTime,
    legs: trade.legs,
    state: signalStateFor(trade),
  };
}

/**
 * Map the exit reason onto the site's signal lifecycle.
 *
 *   TP2                  -> TP2_HIT   (the final target; terminal)
 *   TP1_THEN_BE          -> STOPPED   (a scratch: TP1 banked, remainder flat)
 *   TP1_THEN_SL          -> STOPPED
 *   SL                   -> STOPPED
 *   TIMEOUT              -> EXPIRED
 *   TP1_THEN_TIMEOUT     -> EXPIRED
 *
 * The TP1 milestone itself is recorded separately (tp1_hit_at) and survives a
 * later stop, which is why TP1_THEN_BE/TP1_THEN_SL still prove TP1 was reached.
 */
export function signalStateFor(trade: V30Trade): SignalState {
  switch (trade.exit) {
    case 'TP2':
      return 'TP2_HIT';
    case 'SL':
    case 'TP1_THEN_BE':
    case 'TP1_THEN_SL':
      return 'STOPPED';
    case 'TIMEOUT':
    case 'TP1_THEN_TIMEOUT':
      return 'EXPIRED';
    default:
      return 'OPEN';
  }
}

/**
 * Milestone scan — TP1 progress and excursions, for DISPLAY and milestone
 * timestamps only. P&L always comes from `resolveV30Outcome`, so the two can
 * never disagree about money.
 *
 * It mirrors the same intrabar rules (stop before targets; breakeven arms only
 * after the TP1 bar) so a TP1 timestamp can never be recorded for a trade that
 * in fact stopped out first.
 */
export interface V30Milestones {
  tp1Hit: boolean;
  tp1CandleTime: number | null;
  maxFavorablePct: number;
  maxAdversePct: number;
}

export function v30Milestones(args: {
  plan: V30SignalPlan;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;
  entryCandleTime: number;
  candles: readonly Candle[];
  settings: Settings;
}): V30Milestones {
  const p = v30Params(args.settings);
  const long = args.direction === 'LONG';
  const tp1 = args.plan.plan.tp1;
  const bars = args.candles
    .filter((c) => c.isClosed && c.openTime >= args.entryCandleTime)
    .sort((a, b) => a.openTime - b.openTime);

  let tp1Hit = false;
  let tp1Bar = -1;
  let tp1CandleTime: number | null = null;
  let maxFav = 0;
  let maxAdv = 0;

  for (let i = 0; i < bars.length && i < p.timeoutBars; i++) {
    const c = bars[i];
    if (!c) continue;

    const fav = long ? c.high : c.low;
    const adv = long ? c.low : c.high;
    const favPct = long
      ? ((fav - args.entryPrice) / args.entryPrice) * 100
      : ((args.entryPrice - fav) / args.entryPrice) * 100;
    const advPct = long
      ? ((adv - args.entryPrice) / args.entryPrice) * 100
      : ((args.entryPrice - adv) / args.entryPrice) * 100;
    maxFav = Math.max(maxFav, favPct);
    maxAdv = Math.min(maxAdv, advPct);

    const armed =
      p.breakevenTrigger === 'tp1' && tp1Hit && tp1Bar >= 0 && i > tp1Bar;
    const stopNow = armed ? args.entryPrice : args.stopLoss;
    const hitStop = long ? c.low <= stopNow : c.high >= stopNow;

    if (!tp1Hit) {
      const hitT1 = long ? c.high >= tp1 : c.low <= tp1;
      // R1: a bar that touches both the stop and TP1 books the STOP.
      if (hitStop) break;
      if (hitT1) {
        tp1Hit = true;
        tp1Bar = i;
        tp1CandleTime = c.openTime;
        continue;
      }
      continue;
    }

    if (hitStop) break; // TP1 already banked; the milestone stands
  }

  return { tp1Hit, tp1CandleTime, maxFavorablePct: maxFav, maxAdversePct: maxAdv };
}

/**
 * Outcome tracking: walk CLOSED candles AFTER the entry candle and decide
 * TP / SL / TIMEOUT.
 *
 * Rules:
 *  - Only candles with openTime >= entryCandleTime are considered, and only
 *    CLOSED ones (a forming bar must never resolve an outcome).
 *  - If a single candle touches BOTH the stop and a take-profit, we cannot know
 *    the intrabar order from OHLC alone. With
 *    `outcome.sl_priority_on_ambiguous_bar` = true (default) we assume the
 *    WORST case (SL). This removes optimistic bias from the statistics.
 *  - TIMEOUT closes at the CLOSE of the last allowed bar.
 *  - Fees are applied as a round-trip percentage on the notional.
 */

import type { Candle, Direction } from '../core/types';
import type { Settings } from '../core/settings';
import { pnlPct, rMultiple } from '../strategy/risk';

export type OutcomeResult = 'TP' | 'SL' | 'TIMEOUT';

export interface TrackInput {
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  takeProfits: readonly number[];
  entryCandleTime: number;
  /** Candles from the entry candle onward (will be filtered to closed ones). */
  candles: readonly Candle[];
  settings: Settings;
  qty?: number;
}

export interface TrackOutput {
  result: OutcomeResult;
  exitPrice: number;
  exitCandleTime: number;
  barsHeld: number;
  pnlPct: number;
  pnlQuote: number;
  rMultiple: number;
  maxFavorablePct: number;
  maxAdversePct: number;
  tpHitIndex: number | null;
}

/**
 * Returns null when the trade is still OPEN (no TP/SL hit and the timeout has
 * not elapsed yet).
 */
export function trackOutcome(input: TrackInput): TrackOutput | null {
  const { direction, entryPrice, stopLoss, settings } = input;
  const timeoutBars = Math.floor(settings.num('outcome.timeout_bars'));
  const slPriority = settings.bool('outcome.sl_priority_on_ambiguous_bar');
  const feePct = settings.num('outcome.fee_pct');
  const riskPerUnit = Math.abs(entryPrice - stopLoss);

  // Highest R take-profit first is NOT what we want: we must detect the FIRST
  // (nearest) TP that is touched, so sort by distance from entry ascending.
  const tps = [...input.takeProfits]
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => Math.abs(a - entryPrice) - Math.abs(b - entryPrice));

  // Only closed candles at/after the entry candle.
  const bars = input.candles
    .filter((c) => c.isClosed && c.openTime >= input.entryCandleTime)
    .sort((a, b) => a.openTime - b.openTime);

  if (bars.length === 0) return null;

  let maxFav = 0;
  let maxAdv = 0;

  for (let i = 0; i < bars.length; i++) {
    const c = bars[i];
    if (!c) continue;

    // Excursions (always from the extremes of the bar).
    const favPrice = direction === 'LONG' ? c.high : c.low;
    const advPrice = direction === 'LONG' ? c.low : c.high;
    maxFav = Math.max(maxFav, pnlPct(direction, entryPrice, favPrice));
    maxAdv = Math.min(maxAdv, pnlPct(direction, entryPrice, advPrice));

    const hitSl =
      direction === 'LONG' ? c.low <= stopLoss : c.high >= stopLoss;

    // Find the FURTHEST tp reached on this bar (nearest ones are implied).
    let tpIndex: number | null = null;
    for (let t = 0; t < tps.length; t++) {
      const tp = tps[t];
      if (tp === undefined) continue;
      const reached = direction === 'LONG' ? c.high >= tp : c.low <= tp;
      if (reached) tpIndex = t;
    }

    if (hitSl && tpIndex !== null) {
      // Ambiguous bar — OHLC cannot tell us which came first.
      if (slPriority) {
        return finish('SL', stopLoss, c, i);
      }
      const tp = tps[tpIndex] ?? entryPrice;
      return finish('TP', tp, c, i, tpIndex);
    }
    if (hitSl) return finish('SL', stopLoss, c, i);
    if (tpIndex !== null) {
      const tp = tps[tpIndex] ?? entryPrice;
      return finish('TP', tp, c, i, tpIndex);
    }

    if (i + 1 >= timeoutBars) {
      return finish('TIMEOUT', c.close, c, i);
    }
  }

  return null; // still open

  function finish(
    result: OutcomeResult,
    exitPrice: number,
    bar: Candle,
    idx: number,
    tpHitIndex: number | null = null,
  ): TrackOutput {
    const grossPct = pnlPct(direction, entryPrice, exitPrice);
    const netPct = grossPct - feePct; // round-trip fee
    const qty = input.qty ?? 0;
    const pnlQuote = (netPct / 100) * entryPrice * qty;
    const grossR = rMultiple(direction, entryPrice, exitPrice, riskPerUnit);
    // Convert the fee into R so the R stats stay consistent with pnl.
    const feeR = riskPerUnit > 0 ? (feePct / 100) * entryPrice / riskPerUnit : 0;
    return {
      result,
      exitPrice,
      exitCandleTime: bar.openTime,
      barsHeld: idx + 1,
      pnlPct: round(netPct, 6),
      pnlQuote: round(pnlQuote, 6),
      rMultiple: round(grossR - feeR, 6),
      maxFavorablePct: round(maxFav, 6),
      maxAdversePct: round(maxAdv, 6),
      tpHitIndex,
    };
  }
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** Aggregate outcome statistics (used by replay + monitoring). */
export interface OutcomeStats {
  total: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number;
  avgR: number;
  totalR: number;
  profitFactor: number;
  maxDrawdownR: number;
}

export function aggregate(
  rows: ReadonlyArray<{ result: string; r_multiple: number }>,
): OutcomeStats {
  const total = rows.length;
  const wins = rows.filter((r) => r.result === 'TP').length;
  const losses = rows.filter((r) => r.result === 'SL').length;
  const timeouts = rows.filter((r) => r.result === 'TIMEOUT').length;
  const totalR = rows.reduce((s, r) => s + r.r_multiple, 0);
  const gross = rows.filter((r) => r.r_multiple > 0).reduce((s, r) => s + r.r_multiple, 0);
  const grossLoss = Math.abs(
    rows.filter((r) => r.r_multiple < 0).reduce((s, r) => s + r.r_multiple, 0),
  );

  // Max drawdown on the cumulative R equity curve.
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const r of rows) {
    equity += r.r_multiple;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, equity - peak);
  }

  return {
    total,
    wins,
    losses,
    timeouts,
    winRate: total > 0 ? round((wins / total) * 100, 4) : 0,
    avgR: total > 0 ? round(totalR / total, 6) : 0,
    totalR: round(totalR, 6),
    profitFactor: grossLoss > 0 ? round(gross / grossLoss, 6) : gross > 0 ? Infinity : 0,
    maxDrawdownR: round(maxDd, 6),
  };
}

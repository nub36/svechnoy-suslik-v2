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
 * Walk a trade forward bar by bar and decide how it ended.
 *
 * EXIT SEMANTICS — the three states are distinct and must stay distinct:
 *
 *   TP      the FINAL rung of the ladder was reached. Intermediate rungs are
 *           milestones only: this build has no partial-exit accounting, so
 *           touching TP1/TP2 neither realises PnL nor closes the position.
 *
 *   SL      the stop was touched.
 *
 *   TIMEOUT a FORCED TIME EXIT. The position reached neither the terminal TP
 *           nor the SL within `outcome.timeout_bars` bars, so it is closed at
 *           the CLOSE of the timeout bar — that bar being the last one the
 *           trade is permitted to occupy (`i + 1 >= timeoutBars`, zero-based,
 *           so `barsHeld === timeoutBars` exactly). The exit price is that
 *           candle's close: a real printed price from a CLOSED candle, never an
 *           extreme, never a target, never a future bar. TIMEOUT is NOT a
 *           take-profit and must never be reported as one, even when its R is
 *           positive. On the timeout bar itself SL and the final TP still take
 *           priority, resolved by the same deterministic intrabar policy used
 *           everywhere else (`outcome.sl_priority_on_ambiguous_bar`).
 *
 * Returns null when the trade is still OPEN — no TP/SL hit and the timeout has
 * not elapsed yet, which is also what happens when the supplied data simply
 * runs out first. A dataset boundary therefore yields OPEN, never TIMEOUT: the
 * caller must record it as OPEN and exclude it from closed-trade statistics.
 *
 * Only candles at or after the entry candle are considered, and the function
 * returns the moment an exit condition is met, so no candle beyond the exit is
 * ever inspected.
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

    // A take-profit only ENDS the trade when it is the LAST rung of the
    // ladder. Touching TP1 or TP2 is a milestone, not an exit: this build has
    // no partial-exit accounting, so nothing is realised there and the
    // position keeps running with the same stop. Treating an intermediate TP
    // as a close is what produced a STOPPED signal carrying a POSITIVE R —
    // the trade was recorded as exiting at TP1 even though price then ran
    // through the stop.
    const finalRung = tps.length - 1;
    const hitFinalTp = tpIndex !== null && tpIndex >= finalRung;

    if (hitSl && hitFinalTp) {
      // Ambiguous bar — OHLC cannot tell us which came first.
      if (slPriority) {
        return finish('SL', stopLoss, c, i);
      }
      const tp = tps[finalRung] ?? entryPrice;
      return finish('TP', tp, c, i, finalRung);
    }
    if (hitSl) return finish('SL', stopLoss, c, i);
    if (hitFinalTp) {
      const tp = tps[finalRung] ?? entryPrice;
      return finish('TP', tp, c, i, finalRung);
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

/* ===================================================================
 * PROGRESSIVE MILESTONE TRACKING
 *
 * `trackOutcome` above answers "how did this trade finally end?" and is what
 * the replay statistics need. It is NOT enough for the live lifecycle, which
 * must record TP1 -> TP2 -> TP3 as they happen and keep every milestone even
 * if the trade is later stopped.
 *
 * `trackMilestones` walks the same CLOSED candles and returns the FULL ladder
 * of events in order, so the caller can persist each timestamp exactly once.
 * =================================================================== */

import type { SignalState } from '../core/types';

export type MilestoneKind = 'TP1' | 'TP2' | 'TP3' | 'SL' | 'TIMEOUT';

export interface Milestone {
  kind: MilestoneKind;
  /** openTime of the CLOSED candle on which it happened. */
  candleTime: number;
  price: number;
  /** Index into the sorted bar list (0 = entry bar). */
  barIndex: number;
}

export interface MilestoneTrack {
  /** In chronological order. At most one terminal entry, always last. */
  milestones: Milestone[];
  /** Highest TP index reached (0..3). */
  tpLevel: 0 | 1 | 2 | 3;
  /** Terminal milestone, or null when the trade is still running. */
  terminal: Milestone | null;
  /** Resulting signal state after applying every milestone. */
  state: SignalState;
  maxFavorablePct: number;
  maxAdversePct: number;
  barsHeld: number;
}

export interface MilestoneInput {
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  takeProfits: readonly number[];
  entryCandleTime: number;
  candles: readonly Candle[];
  settings: Settings;
  /** Milestones already persisted — used only to keep the walk idempotent. */
  alreadyReachedTp?: number;
}

/**
 * Walk CLOSED candles and produce the ordered milestone ladder.
 *
 * Rules mirror `trackOutcome` exactly so live and replay cannot diverge:
 *  - CLOSED candles only, at/after the entry candle.
 *  - An ambiguous bar (touches both a TP and the stop) resolves to SL when
 *    `outcome.sl_priority_on_ambiguous_bar` is set, because OHLC cannot tell
 *    us the intrabar order and we refuse to bias the statistics upward.
 *  - TP3 is terminal success; SL -> STOPPED; timeout -> EXPIRED.
 */
export function trackMilestones(input: MilestoneInput): MilestoneTrack {
  const { direction, entryPrice, stopLoss, settings } = input;
  const timeoutBars = Math.floor(settings.num('outcome.timeout_bars'));
  const slPriority = settings.bool('outcome.sl_priority_on_ambiguous_bar');

  // Ladder ordered by distance from entry: TP1 nearest.
  const tps = [...input.takeProfits]
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => Math.abs(a - entryPrice) - Math.abs(b - entryPrice))
    .slice(0, 3);

  const bars = input.candles
    .filter((c) => c.isClosed && c.openTime >= input.entryCandleTime)
    .sort((a, b) => a.openTime - b.openTime);

  const milestones: Milestone[] = [];
  let tpLevel: 0 | 1 | 2 | 3 = 0;
  let terminal: Milestone | null = null;
  let maxFav = 0;
  let maxAdv = 0;
  let barsHeld = 0;

  for (let i = 0; i < bars.length && terminal === null; i++) {
    const c = bars[i];
    if (!c) continue;
    barsHeld = i + 1;

    const favPrice = direction === 'LONG' ? c.high : c.low;
    const advPrice = direction === 'LONG' ? c.low : c.high;
    maxFav = Math.max(maxFav, pnlPct(direction, entryPrice, favPrice));
    maxAdv = Math.min(maxAdv, pnlPct(direction, entryPrice, advPrice));

    const hitSl = direction === 'LONG' ? c.low <= stopLoss : c.high >= stopLoss;

    // Every TP newly reached on this bar (a big bar can clear several).
    const reachedHere: number[] = [];
    for (let t = tpLevel; t < tps.length; t++) {
      const tp = tps[t];
      if (tp === undefined) continue;
      const reached = direction === 'LONG' ? c.high >= tp : c.low <= tp;
      if (reached) reachedHere.push(t);
      else break; // ladder is ordered; stop at the first unreached rung
    }

    const slWins = hitSl && (reachedHere.length === 0 || slPriority);

    if (!slWins) {
      for (const t of reachedHere) {
        const tp = tps[t];
        if (tp === undefined) continue;
        tpLevel = (t + 1) as 0 | 1 | 2 | 3;
        const m: Milestone = {
          kind: (`TP${t + 1}` as MilestoneKind),
          candleTime: c.openTime,
          price: tp,
          barIndex: i,
        };
        milestones.push(m);
        // The trade completes when the LAST rung of the configured ladder is
        // taken. With the standard 3-TP ladder that is TP3; with a shorter
        // ladder it is whatever the final rung happens to be — otherwise a
        // fully-won trade would hang open forever waiting for a TP3 that the
        // risk plan never defined.
        if (tpLevel >= tps.length || tpLevel === 3) terminal = m;
      }
    }

    if (terminal !== null) break;

    if (hitSl) {
      terminal = { kind: 'SL', candleTime: c.openTime, price: stopLoss, barIndex: i };
      milestones.push(terminal);
      break;
    }

    if (i + 1 >= timeoutBars) {
      terminal = { kind: 'TIMEOUT', candleTime: c.openTime, price: c.close, barIndex: i };
      milestones.push(terminal);
      break;
    }
  }

  let state: SignalState;
  if (terminal?.kind === 'SL') state = 'STOPPED';
  else if (terminal?.kind === 'TIMEOUT') state = 'EXPIRED';
  else if (tpLevel === 3) state = 'TP3_HIT';
  else if (tpLevel === 2) state = 'TP2_HIT';
  else if (tpLevel === 1) state = 'TP1_HIT';
  else state = 'OPEN';

  return {
    milestones,
    tpLevel,
    terminal,
    state,
    maxFavorablePct: round(maxFav, 6),
    maxAdversePct: round(maxAdv, 6),
    barsHeld,
  };
}

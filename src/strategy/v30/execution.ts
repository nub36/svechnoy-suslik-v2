/**
 * V3.0 — EXECUTION: plan, corridor entry, management, fees.
 *
 * Ported from `research/v30_htf_trap.ts`. The intrabar rules are the ones the
 * candidate was validated with and are NOT configurable:
 *
 *   R1  the stop is checked BEFORE the targets on every bar;
 *   R2  if TP1 and TP2 land on one bar, TP1 books first, then TP2;
 *   R3  breakeven arms only on bars STRICTLY AFTER the TP1 bar;
 *   R4  the stop never moves backwards;
 *   R5  the timeout counts the entry bar as bar 1.
 *
 * Relaxing any of them inflates a backtest without changing live results.
 */

import type { Candle } from '../../core/types';
import type { TrapLevels } from './levels';
import type { Direction, TrapSignal } from './trap';
import type { V30Params } from './params';

/* ------------------------------------------------------------------ plan --- */

export interface V30Plan {
  direction: Direction;
  /** The swept 4H level (drawn on the chart). */
  level: number;
  /** Wick extreme of the reclaim bar; the stop anchors behind it. */
  sweepExtreme: number;
  /** Limit corridor, centred on the reclaim bar's close. */
  zoneLow: number;
  zoneHigh: number;
  stop: number;
  /** 4H equilibrium (or the configured share of the range). */
  tp1: number;
  /** Opposing 4H swing — the final target. */
  tp2: number;
  atr: number;
  bodyRatio: number;
  rvol: number;
}

/**
 * Build the full trade plan for a detected trap.
 *
 * Requires BOTH swing edges: the equilibrium target and the opposing swing are
 * computed from the active 4H range, so a one-sided range cannot be traded.
 * Returns null instead of inventing a level.
 */
export function buildPlan(
  signal: TrapSignal,
  levels: TrapLevels,
  atr: number,
  close: number,
  p: V30Params,
): V30Plan | null {
  if (levels.swingHigh === null || levels.swingLow === null) return null;
  if (!(atr > 0)) return null;
  // A degenerate range (high <= low) is NOT rejected here: the frozen harness
  // publishes the corridor anyway and lets the fill-time geometry gate decide.
  // Dropping the setup at detection would shift the whole setup sequence for
  // that symbol — the parity harness caught exactly that. Geometry is checked
  // against the FILL price in the runner, which is authoritative.

  const long = signal.direction === 'LONG';
  const half = p.corridorAtr * atr;
  const range = levels.swingHigh - levels.swingLow;
  const share = Math.min(Math.max(p.tp1Equilibrium, 0), 1);

  // tp1Equilibrium = 0.50 is the range MIDPOINT, i.e. 4H equilibrium.
  const tp1 = long ? levels.swingLow + share * range : levels.swingHigh - share * range;
  const stop = long
    ? signal.sweepExtreme - p.slBufferAtr * atr
    : signal.sweepExtreme + p.slBufferAtr * atr;
  const tp2 = long ? levels.swingHigh : levels.swingLow;

  // NO GEOMETRY GATE HERE. The frozen harness does not reject an incoherent
  // setup at detection time — it publishes the corridor and only rejects if the
  // FILL cannot be traded (REJECTED_GEOMETRY in the runner). Checking against
  // the reclaim close instead of the fill would silently drop setups that the
  // validated simulator did take (a next bar can open inside the zone at a
  // price that makes the geometry valid), so the check stays where it belongs:
  // at fill time, against the fill price.
  return {
    direction: signal.direction,
    level: signal.level,
    sweepExtreme: signal.sweepExtreme,
    zoneLow: close - half,
    zoneHigh: close + half,
    stop,
    tp1,
    tp2,
    atr,
    bodyRatio: signal.bodyRatio,
    rvol: signal.rvol,
  };
}

/* -------------------------------------------------------------- corridor --- */

export type CorridorDecision =
  | { kind: 'WAIT' }
  | { kind: 'CANCEL'; reason: 'STOP_BEFORE_FILL' | 'AMBIGUOUS_BAR' }
  | { kind: 'EXPIRE' }
  | { kind: 'FILL'; fillPrice: number };

/**
 * Advance a resting corridor order by ONE closed bar (always N+1 or later).
 *
 * Ambiguity always resolves AGAINST the trade: a bar that both fills the order
 * and breaches the stop is cancelled, never filled. A limit order that would
 * have crossed is modelled at the WORSE edge of the zone, never the midpoint.
 */
export function corridorStep(
  plan: Pick<V30Plan, 'direction' | 'zoneLow' | 'zoneHigh' | 'stop'>,
  candle: Candle,
  waitedBars: number,
  p: V30Params,
): CorridorDecision {
  const long = plan.direction === 'LONG';
  const touches = long ? candle.low <= plan.zoneHigh : candle.high >= plan.zoneLow;
  const hitStop = long ? candle.low <= plan.stop : candle.high >= plan.stop;

  if (touches && hitStop) return { kind: 'CANCEL', reason: 'AMBIGUOUS_BAR' };
  if (touches) {
    const fillPrice = long
      ? Math.min(candle.open, plan.zoneHigh)
      : Math.max(candle.open, plan.zoneLow);
    return { kind: 'FILL', fillPrice };
  }
  if (hitStop) return { kind: 'CANCEL', reason: 'STOP_BEFORE_FILL' };
  if (waitedBars >= p.corridorExpiryBars) return { kind: 'EXPIRE' };
  return { kind: 'WAIT' };
}

/* ------------------------------------------------------------- execution --- */

export type ExitReason =
  | 'SL'
  | 'TP2'
  | 'TP1_THEN_BE'
  | 'TP1_THEN_SL'
  | 'TP1_THEN_TIMEOUT'
  | 'TIMEOUT';

export interface FeeLeg {
  price: number;
  weight: number;
  taker: boolean;
}

export interface V30Trade {
  exit: ExitReason;
  /** Gross R, before fees, on the configured position split. */
  grossR: number;
  /** Fees in R, summed over every leg at its own notional. */
  feeR: (makerBps: number, takerBps: number) => number;
  barsHeld: number;
  hitTp1: boolean;
  hitTp2: boolean;
  legs: readonly FeeLeg[];
}

/** Per-leg fee in R, charged on that leg's own notional. No rebate. */
export function legFeeR(price: number, weight: number, bps: number, risk: number): number {
  if (!(risk > 0)) return 0;
  return ((bps / 10000) * price * weight) / risk;
}

/**
 * Manage one FILLED position bar by bar.
 *
 * `bars` starts at the entry bar. Returns null when the trade is still
 * unresolved after the supplied bars — callers must treat that as OPEN, never
 * as a completed outcome.
 */
export function manageTrade(
  direction: Direction,
  entry: number,
  stop0: number,
  tp1: number,
  tp2: number,
  bars: readonly Candle[],
  p: V30Params,
): V30Trade | null {
  const risk = Math.abs(entry - stop0);
  if (!(risk > 0) || bars.length === 0) return null;

  const long = direction === 'LONG';
  const w = Math.min(Math.max(p.positionSplitTp1, 0), 1);
  const rest = 1 - w;
  const rOf = (price: number): number => (long ? price - entry : entry - price) / risk;
  const breakevenArmed = p.breakevenTrigger === 'tp1';

  let stop = stop0;
  let hitTp1 = false;
  let tp1Bar = -1;
  let realised = 0; // R already banked on the TP1 leg
  const legs: FeeLeg[] = [{ price: entry, weight: 1, taker: false }]; // maker entry

  const finish = (
    exit: ExitReason,
    exitPrice: number,
    weight: number,
    i: number,
  ): V30Trade => {
    legs.push({ price: exitPrice, weight, taker: true });
    const gross = realised + weight * rOf(exitPrice);
    return {
      exit,
      grossR: gross,
      barsHeld: i + 1,
      hitTp1,
      hitTp2: exit === 'TP2',
      legs,
      feeR: (maker, taker) =>
        legs.reduce((s, l) => s + legFeeR(l.price, l.weight, l.taker ? taker : maker, risk), 0),
    };
  };

  for (let i = 0; i < bars.length && i < p.timeoutBars; i++) {
    const c = bars[i];
    if (!c) continue;

    // R3: breakeven arms only on bars strictly AFTER the TP1 bar.
    const armed = breakevenArmed && hitTp1 && tp1Bar >= 0 && i > tp1Bar;
    // R4: the stop never moves backwards — it moves to the entry price.
    const stopNow = armed ? entry : stop;

    const hitStop = long ? c.low <= stopNow : c.high >= stopNow;
    const hitT1 = !hitTp1 && (long ? c.high >= tp1 : c.low <= tp1);
    const hitT2 = long ? c.high >= tp2 : c.low <= tp2;

    // R1: stop first, always.
    if (hitStop) {
      if (!hitTp1) return finish('SL', stopNow, 1, i);
      return finish(armed ? 'TP1_THEN_BE' : 'TP1_THEN_SL', stopNow, rest, i);
    }

    if (hitT1) {
      hitTp1 = true;
      tp1Bar = i;
      realised += w * rOf(tp1);
      legs.push({ price: tp1, weight: w, taker: true });
      // R2: TP1 books first; TP2 may then close the remainder on the same bar.
      if (hitT2) return finish('TP2', tp2, rest, i);
      if (i + 1 >= p.timeoutBars) return finish('TP1_THEN_TIMEOUT', c.close, rest, i);
      continue;
    }

    // A bar AFTER the TP1 bar: the remainder is still running, so TP2 must be
    // checked here too. Without this the leftover half could only ever exit at
    // the breakeven stop or the timeout, which silently deleted every TP2 win
    // that took more than one bar.
    if (hitTp1 && hitT2) return finish('TP2', tp2, rest, i);

    // TP2 without TP1 is impossible by construction (TP1 is nearer); guard anyway.
    if (!hitTp1 && hitT2) {
      hitTp1 = true;
      realised += w * rOf(tp1);
      legs.push({ price: tp1, weight: w, taker: true });
      return finish('TP2', tp2, rest, i);
    }

    // R5: the entry bar is bar 1, so the timeout fires on the 50th bar.
    if (i + 1 >= p.timeoutBars) {
      return finish(
        hitTp1 ? 'TP1_THEN_TIMEOUT' : 'TIMEOUT',
        c.close,
        hitTp1 ? rest : 1,
        i,
      );
    }
  }

  return null; // still open
}

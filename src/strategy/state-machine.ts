/**
 * Persistent per-(strategy,symbol,timeframe) STRATEGY state machine.
 *
 * States: NEUTRAL / EDGE_LONG / EDGE_SHORT / HOLD_LONG / HOLD_SHORT / REARM
 *
 * GENUINE EDGE ONLY
 * -----------------
 * A signal is emitted only on a real RISING EDGE: an evaluation that PASSES
 * immediately after an observed baseline in which it did NOT pass.
 *
 * The critical property is the BOOTSTRAP rule. A slot that has never been
 * observed (`initialised === false`, i.e. no persisted row yet) cannot produce
 * an edge on its very first evaluation, no matter how strong the score is.
 * There is no previous closed-candle baseline, so "it passes right now" is a
 * LEVEL, not a transition. The first observation only records the baseline.
 * Previously this machine started in IDLE and treated the first passing
 * evaluation as IDLE -> WAITING_ENTRY, which is exactly why starting the
 * worker in production instantly produced a batch of bootstrap signals.
 *
 * REARM
 * -----
 * Once the condition has fired it must FALL before it may fire again:
 *
 *   NEUTRAL --pass L--> EDGE_LONG --still pass--> HOLD_LONG --fail--> REARM
 *   REARM --fail--> NEUTRAL --pass--> EDGE_...
 *
 * REARM exists as its own state (rather than going straight back to NEUTRAL)
 * so that the "condition dropped" observation is itself persisted. A slot in
 * REARM will not emit on the same candle that ended the hold.
 *
 * A direction FLIP while holding (HOLD_LONG and a short condition passes) is a
 * genuine new edge and emits immediately — the previous condition ended and a
 * different one began, which is a transition, not a persisting level.
 *
 * N+1 ENTRY: the setup is detected on CLOSED candle N. The entry price is the
 * OPEN of candle N+1. Until candle N+1 exists, entry stays null — we never
 * invent it from candle N's close.
 */

import type {
  Direction,
  Evaluation,
  StrategyState,
  Timeframe,
} from '../core/types';
import { edgeFor, holdFor } from '../core/types';

export interface MachineState {
  symbol: string;
  timeframe: Timeframe;
  state: StrategyState;
  direction: Direction | null;
  /**
   * False when this slot has never been observed. The first step() only
   * establishes the baseline and can never emit. Persisted rows are always
   * initialised.
   */
  initialised: boolean;
  /** open_time of the last CLOSED candle already processed */
  lastCandleTime: number;
  /** candle N of the current setup */
  setupCandleTime: number | null;
  setupScore: number | null;
  activeSignalId: number | null;
}

/**
 * A brand new, never-observed slot. Note `initialised: false` — this is what
 * makes bootstrap signals impossible.
 */
export function initialState(symbol: string, timeframe: Timeframe): MachineState {
  return {
    symbol,
    timeframe,
    state: 'NEUTRAL',
    direction: null,
    initialised: false,
    lastCandleTime: 0,
    setupCandleTime: null,
    setupScore: null,
    activeSignalId: null,
  };
}

export type TransitionAction =
  | { kind: 'NONE'; reason: string }
  | {
      kind: 'EMIT_SIGNAL';
      direction: Direction;
      score: number;
      threshold: number;
      setupCandleTime: number;
      setupClose: number;
      reason: string;
    };

export interface TransitionResult {
  next: MachineState;
  action: TransitionAction;
}

/**
 * Feed ONE closed candle evaluation into the machine.
 *
 * Idempotency: re-feeding the same (or an older) candle is a no-op, which makes
 * the strategy worker safe to restart or run twice on the same data.
 */
export function step(current: MachineState, ev: Evaluation): TransitionResult {
  const unchanged = (reason: string): TransitionResult => ({
    next: current,
    action: { kind: 'NONE', reason },
  });

  // --- idempotency / replay guard -------------------------------------
  if (current.initialised && ev.candleTime <= current.lastCandleTime) {
    return unchanged(
      `candle ${ev.candleTime} already processed (last=${current.lastCandleTime})`,
    );
  }

  const decision = ev.decision;
  const passed = Boolean(decision && decision.passed);
  const advanced: MachineState = {
    ...current,
    lastCandleTime: ev.candleTime,
    initialised: true,
  };

  // --- BOOTSTRAP: first ever observation establishes the baseline only --
  //
  // If it already passes we go straight to HOLD, NOT to EDGE: the condition is
  // present but we never saw it arrive, so there is nothing to signal. It must
  // fall and come back before it can emit.
  if (!current.initialised) {
    if (passed && decision) {
      return {
        next: {
          ...advanced,
          state: holdFor(decision.direction),
          direction: decision.direction,
          setupCandleTime: null,
          setupScore: null,
        },
        action: {
          kind: 'NONE',
          reason:
            `bootstrap: first observation of ${current.symbol} ${current.timeframe} ` +
            `already passes (score ${decision.score.toFixed(2)}); baseline recorded as ` +
            `${holdFor(decision.direction)}, no signal without an observed rising edge`,
        },
      };
    }
    return {
      next: { ...advanced, state: 'NEUTRAL', direction: null, setupCandleTime: null, setupScore: null },
      action: {
        kind: 'NONE',
        reason: `bootstrap: baseline recorded as NEUTRAL for ${current.symbol} ${current.timeframe}`,
      },
    };
  }

  // --- the slot already owns a live signal -----------------------------
  // While a trade is outstanding the slot is busy. We still track whether the
  // condition persists, but we never emit.
  if (current.activeSignalId !== null) {
    return {
      next: advanced,
      action: {
        kind: 'NONE',
        reason: `slot busy: signal ${current.activeSignalId} still live`,
      },
    };
  }

  // --- condition NOT satisfied -----------------------------------------
  if (!passed || !decision) {
    // Holding -> the condition just dropped: go to REARM (not NEUTRAL) so the
    // fall is itself an observed, persisted step.
    const wasEngaged =
      current.state === 'HOLD_LONG' ||
      current.state === 'HOLD_SHORT' ||
      current.state === 'EDGE_LONG' ||
      current.state === 'EDGE_SHORT';
    const nextState: StrategyState = wasEngaged ? 'REARM' : 'NEUTRAL';
    return {
      next: {
        ...advanced,
        state: nextState,
        direction: null,
        setupCandleTime: null,
        setupScore: null,
      },
      action: {
        kind: 'NONE',
        reason: decision
          ? `score ${decision.score.toFixed(2)} < threshold ${decision.threshold}` +
            (wasEngaged ? `; ${current.state} -> REARM` : '')
          : 'no decision',
      },
    };
  }

  // --- condition satisfied ---------------------------------------------
  const dir = decision.direction;
  const hold = holdFor(dir);

  // Already holding the SAME direction: a persisting level, never a new edge.
  if (current.state === hold || current.state === edgeFor(dir)) {
    return {
      next: { ...advanced, state: hold, direction: dir },
      action: {
        kind: 'NONE',
        reason: `condition persists (${current.state} -> ${hold}); edge-only policy suppresses re-emission`,
      },
    };
  }

  // Genuine rising edge: from NEUTRAL, from REARM, or a direction FLIP.
  const from = current.state;
  return {
    next: {
      ...advanced,
      state: edgeFor(dir),
      direction: dir,
      setupCandleTime: ev.candleTime,
      setupScore: decision.score,
    },
    action: {
      kind: 'EMIT_SIGNAL',
      direction: dir,
      score: decision.score,
      threshold: decision.threshold,
      setupCandleTime: ev.candleTime,
      setupClose: ev.closePrice,
      reason: `edge ${from}->${edgeFor(dir)} at score ${decision.score.toFixed(2)}`,
    },
  };
}

/**
 * Collapse an emitted edge into the corresponding hold.
 *
 * Used after a signal is persisted AND whenever an edge is SUPPRESSED
 * (capacity, missing ATR, R:R too low). Suppression must land in HOLD, never
 * back in NEUTRAL: leaving a still-passing condition in NEUTRAL would let the
 * very next evaluation of the same persisting level look like a fresh rising
 * edge, which is the "delayed fake edge" bug.
 */
export function settleEdge(state: MachineState): MachineState {
  const dir = state.direction;
  if (state.state === 'EDGE_LONG' || state.state === 'EDGE_SHORT') {
    return {
      ...state,
      state: dir ? holdFor(dir) : 'REARM',
    };
  }
  return state;
}

/** Legal transitions. Used to validate any state write. */
const ALLOWED: Record<StrategyState, readonly StrategyState[]> = {
  NEUTRAL: ['NEUTRAL', 'EDGE_LONG', 'EDGE_SHORT'],
  EDGE_LONG: ['HOLD_LONG', 'EDGE_SHORT', 'REARM', 'NEUTRAL'],
  EDGE_SHORT: ['HOLD_SHORT', 'EDGE_LONG', 'REARM', 'NEUTRAL'],
  HOLD_LONG: ['HOLD_LONG', 'EDGE_SHORT', 'REARM', 'NEUTRAL'],
  HOLD_SHORT: ['HOLD_SHORT', 'EDGE_LONG', 'REARM', 'NEUTRAL'],
  REARM: ['REARM', 'NEUTRAL', 'EDGE_LONG', 'EDGE_SHORT'],
};

export function canTransition(from: StrategyState, to: StrategyState): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

export function assertTransition(from: StrategyState, to: StrategyState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal state transition ${from} -> ${to}`);
  }
}

/**
 * Resolve the N+1 entry.
 *
 * `nextCandle` MUST be the candle whose openTime == setupCandleTime + tfMs.
 * Returns null when N+1 does not exist yet — the caller must then leave the
 * signal in WAITING_ENTRY and try again later. We never fabricate an entry.
 */
export function resolveEntry(
  setupCandleTime: number,
  timeframeMs: number,
  nextCandle: { openTime: number; open: number; isClosed: boolean } | null | undefined,
): { entryCandleTime: number; entryPrice: number } | null {
  if (!nextCandle) return null;
  const expected = setupCandleTime + timeframeMs;
  if (nextCandle.openTime !== expected) return null;
  if (!Number.isFinite(nextCandle.open) || nextCandle.open <= 0) return null;
  // NOTE: the candle does NOT need to be closed — its OPEN is known the instant
  // it starts. That is precisely the realistic fill.
  return { entryCandleTime: nextCandle.openTime, entryPrice: nextCandle.open };
}

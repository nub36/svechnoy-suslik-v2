/**
 * Persistent per-(symbol,timeframe) state machine.
 *
 * States: IDLE -> WAITING_ENTRY -> ACTIVE -> CLOSED_* / CANCELLED
 *
 * EDGE-ONLY: a signal is emitted only on the TRANSITION IDLE -> WAITING_ENTRY.
 * While the machine merely *remains* in WAITING_ENTRY or ACTIVE, no new signal
 * is created no matter how many times the evaluation keeps passing.
 *
 * N+1 ENTRY: the setup is detected on CLOSED candle N. The entry price is the
 * OPEN of candle N+1. Until candle N+1 exists, entry stays null — we never
 * invent it from candle N's close.
 */

import type { Direction, Evaluation, SignalState, Timeframe } from '../core/types';

export interface MachineState {
  symbol: string;
  timeframe: Timeframe;
  state: SignalState;
  direction: Direction | null;
  /** open_time of the last CLOSED candle already processed */
  lastCandleTime: number;
  /** candle N of the current setup */
  setupCandleTime: number | null;
  setupScore: number | null;
  activeSignalId: number | null;
}

export function initialState(symbol: string, timeframe: Timeframe): MachineState {
  return {
    symbol,
    timeframe,
    state: 'IDLE',
    direction: null,
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
  if (ev.candleTime <= current.lastCandleTime) {
    return unchanged(
      `candle ${ev.candleTime} already processed (last=${current.lastCandleTime})`,
    );
  }

  const advanced: MachineState = { ...current, lastCandleTime: ev.candleTime };

  // --- occupied slots do not re-emit (EDGE ONLY) ----------------------
  if (current.state === 'WAITING_ENTRY' || current.state === 'ACTIVE') {
    return {
      next: advanced,
      action: {
        kind: 'NONE',
        reason: `slot busy in ${current.state}; edge-only policy suppresses new signals`,
      },
    };
  }

  const decision = ev.decision;
  if (!decision || !decision.passed) {
    return {
      next: { ...advanced, state: 'IDLE', direction: null, setupCandleTime: null, setupScore: null },
      action: {
        kind: 'NONE',
        reason: decision
          ? `score ${decision.score.toFixed(2)} < threshold ${decision.threshold}`
          : 'no decision',
      },
    };
  }

  // --- RISING EDGE: IDLE -> WAITING_ENTRY -----------------------------
  return {
    next: {
      ...advanced,
      state: 'WAITING_ENTRY',
      direction: decision.direction,
      setupCandleTime: ev.candleTime,
      setupScore: decision.score,
    },
    action: {
      kind: 'EMIT_SIGNAL',
      direction: decision.direction,
      score: decision.score,
      threshold: decision.threshold,
      setupCandleTime: ev.candleTime,
      setupClose: ev.closePrice,
      reason: `edge IDLE->WAITING_ENTRY at score ${decision.score.toFixed(2)}`,
    },
  };
}

/** Legal transitions. Used to validate any state write. */
const ALLOWED: Record<SignalState, readonly SignalState[]> = {
  IDLE: ['IDLE', 'SETUP', 'WAITING_ENTRY'],
  SETUP: ['SETUP', 'WAITING_ENTRY', 'IDLE', 'CANCELLED'],
  WAITING_ENTRY: ['WAITING_ENTRY', 'ACTIVE', 'CANCELLED'],
  ACTIVE: ['ACTIVE', 'CLOSED_TP', 'CLOSED_SL', 'CLOSED_TIMEOUT'],
  CLOSED_TP: ['IDLE'],
  CLOSED_SL: ['IDLE'],
  CLOSED_TIMEOUT: ['IDLE'],
  CANCELLED: ['IDLE'],
};

export function canTransition(from: SignalState, to: SignalState): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

export function assertTransition(from: SignalState, to: SignalState): void {
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

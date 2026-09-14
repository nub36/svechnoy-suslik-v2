/**
 * Trading-mode gate.
 *
 * HARD REQUIREMENT: LIVE trading MUST REMAIN LOCKED/DISABLED.
 *
 * There is no code path in this repository that places a real order. This
 * module is the single choke point that any future execution layer must pass
 * through, and it throws unconditionally for LIVE.
 */

import type { TradingMode } from './types';
import { TRADING_MODES } from './types';

export class LiveTradingLockedError extends Error {
  constructor(msg = 'LIVE trading is permanently locked in this build') {
    super(msg);
    this.name = 'LiveTradingLockedError';
  }
}

/** Compile-time + runtime constant. Never flip this to true. */
export const LIVE_TRADING_ENABLED = false as const;

export function isTradingMode(v: unknown): v is TradingMode {
  return typeof v === 'string' && (TRADING_MODES as readonly string[]).includes(v);
}

/**
 * Validate a mode coming from DB/env/admin UI.
 * Throws for LIVE (and anything unknown) so a misconfiguration fails loudly
 * instead of silently arming real execution.
 */
export function assertAllowedMode(v: unknown): TradingMode {
  if (v === 'LIVE' || v === 'live') {
    throw new LiveTradingLockedError(
      'LIVE mode is locked: this build supports DRY_RUN and FORWARD_TEST only',
    );
  }
  if (!isTradingMode(v)) {
    throw new Error(`Invalid trading mode: ${String(v)} (allowed: ${TRADING_MODES.join(', ')})`);
  }
  return v;
}

/** Never returns true. Guards any hypothetical order-placement path. */
export function canPlaceRealOrders(): boolean {
  return false;
}

/**
 * Called by any execution-like path. Always throws.
 * Kept so that the lock is enforced by code, not by convention.
 */
export function assertNoRealExecution(context: string): never {
  throw new LiveTradingLockedError(
    `Refusing real order execution from "${context}": LIVE is locked (DRY_RUN/FORWARD_TEST only)`,
  );
}

/**
 * FORWARD_TEST = paper trading against live market data, signals persisted and
 * tracked to outcome. DRY_RUN = same engine but signals are marked as dry and
 * are not counted in forward-test performance stats.
 */
export function isPaperTracked(mode: TradingMode): boolean {
  return mode === 'FORWARD_TEST';
}

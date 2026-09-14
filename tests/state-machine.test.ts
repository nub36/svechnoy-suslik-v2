/**
 * EDGE-only signal emission + N+1 entry semantics.
 */

import { describe, expect, it } from 'vitest';
import {
  initialState,
  step,
  resolveEntry,
  canTransition,
  assertTransition,
  type MachineState,
} from '../src/strategy/state-machine';
import type { Evaluation } from '../src/core/types';
import { tfMs } from '../src/core/types';
import { candle } from './helpers';

function mkEval(candleTime: number, passed: boolean, score = 80): Evaluation {
  return {
    symbol: 'BTCUSDT',
    timeframe: '1h',
    candleTime,
    closePrice: 100,
    atr: 2,
    events: [],
    long: { direction: 'LONG', rawScore: 0, totalWeight: 0, score, components: [], duplicatesRemoved: 0, confirmations: 2 },
    short: { direction: 'SHORT', rawScore: 0, totalWeight: 0, score: 0, components: [], duplicatesRemoved: 0, confirmations: 0 },
    longScore: score,
    shortScore: 0,
    confirmations: 2,
    decision: { direction: 'LONG', score, threshold: 55, passed, confirmations: 2, minConfirmations: 2 },
  };
}

const H = 3_600_000;
const T0 = 1_700_000_000_000;

describe('EDGE-only signal emission', () => {
  it('emits exactly once on the IDLE -> WAITING_ENTRY rising edge', () => {
    let st = initialState('BTCUSDT', '1h');
    const r1 = step(st, mkEval(T0, true));
    expect(r1.action.kind).toBe('EMIT_SIGNAL');
    expect(r1.next.state).toBe('WAITING_ENTRY');
    st = r1.next;

    // Condition STILL true on the next candle -> must NOT emit again.
    const r2 = step(st, mkEval(T0 + H, true));
    expect(r2.action.kind).toBe('NONE');
    expect(r2.next.state).toBe('WAITING_ENTRY');

    const r3 = step(r2.next, mkEval(T0 + 2 * H, true));
    expect(r3.action.kind).toBe('NONE');
  });

  it('does not emit while ACTIVE no matter how strong the signal', () => {
    const st: MachineState = { ...initialState('BTCUSDT', '1h'), state: 'ACTIVE', lastCandleTime: T0 };
    for (let i = 1; i <= 5; i++) {
      const r = step(st, mkEval(T0 + i * H, true, 99));
      expect(r.action.kind).toBe('NONE');
    }
  });

  it('re-arms only after returning to IDLE', () => {
    let st = initialState('BTCUSDT', '1h');
    st = step(st, mkEval(T0, true)).next;
    expect(st.state).toBe('WAITING_ENTRY');

    // Simulate the outcome worker releasing the slot.
    st = { ...st, state: 'IDLE', direction: null, setupCandleTime: null, activeSignalId: null };

    const r = step(st, mkEval(T0 + 5 * H, true));
    expect(r.action.kind).toBe('EMIT_SIGNAL');
  });

  it('a failing evaluation keeps the machine IDLE and emits nothing', () => {
    const st = initialState('BTCUSDT', '1h');
    const r = step(st, mkEval(T0, false, 20));
    expect(r.action.kind).toBe('NONE');
    expect(r.next.state).toBe('IDLE');
  });

  it('is idempotent: replaying the same candle never double-emits', () => {
    let st = initialState('BTCUSDT', '1h');
    const r1 = step(st, mkEval(T0, true));
    expect(r1.action.kind).toBe('EMIT_SIGNAL');
    st = r1.next;
    // exact same candle again
    const r2 = step(st, mkEval(T0, true));
    expect(r2.action.kind).toBe('NONE');
    expect(r2.next.lastCandleTime).toBe(T0);
  });

  it('ignores out-of-order (older) candles', () => {
    let st = initialState('BTCUSDT', '1h');
    st = step(st, mkEval(T0 + 10 * H, false)).next;
    const r = step(st, mkEval(T0 + 3 * H, true));
    expect(r.action.kind).toBe('NONE');
    expect(r.next.lastCandleTime).toBe(T0 + 10 * H);
  });

  it('advances the candle cursor on every processed candle', () => {
    let st = initialState('BTCUSDT', '1h');
    for (let i = 0; i < 4; i++) {
      st = step(st, mkEval(T0 + i * H, false)).next;
    }
    expect(st.lastCandleTime).toBe(T0 + 3 * H);
  });

  it('records the setup candle time as candle N', () => {
    const st = initialState('BTCUSDT', '1h');
    const r = step(st, mkEval(T0, true));
    expect(r.next.setupCandleTime).toBe(T0);
    if (r.action.kind === 'EMIT_SIGNAL') expect(r.action.setupCandleTime).toBe(T0);
  });
});

describe('WAITING_ENTRY -> entry at OPEN of N+1', () => {
  const tf = tfMs('1h');

  it('returns null when candle N+1 does not exist yet', () => {
    expect(resolveEntry(T0, tf, null)).toBeNull();
    expect(resolveEntry(T0, tf, undefined)).toBeNull();
  });

  it('uses the OPEN of N+1 as the entry price', () => {
    const next = candle(T0 + tf, 123.45, 130, 120, 128);
    const entry = resolveEntry(T0, tf, next);
    expect(entry).not.toBeNull();
    expect(entry!.entryPrice).toBe(123.45);
    expect(entry!.entryCandleTime).toBe(T0 + tf);
  });

  it('never uses candle N close as the entry', () => {
    const nClose = 100;
    const next = candle(T0 + tf, 107.5, 110, 105, 109);
    const entry = resolveEntry(T0, tf, next);
    expect(entry!.entryPrice).not.toBe(nClose);
    expect(entry!.entryPrice).toBe(107.5);
  });

  it('rejects a candle that is not exactly N+1', () => {
    expect(resolveEntry(T0, tf, candle(T0 + 2 * tf, 100, 101, 99, 100))).toBeNull();
    expect(resolveEntry(T0, tf, candle(T0, 100, 101, 99, 100))).toBeNull();
    expect(resolveEntry(T0, tf, candle(T0 + tf - 1, 100, 101, 99, 100))).toBeNull();
  });

  it('accepts an N+1 candle that is still forming (its OPEN is already known)', () => {
    const forming = candle(T0 + tf, 55.5, 56, 55, 55.8, 10, false);
    const entry = resolveEntry(T0, tf, forming);
    expect(entry).not.toBeNull();
    expect(entry!.entryPrice).toBe(55.5);
  });

  it('rejects an invalid open price', () => {
    expect(resolveEntry(T0, tf, candle(T0 + tf, 0, 1, 0, 0))).toBeNull();
    expect(resolveEntry(T0, tf, candle(T0 + tf, Number.NaN, 1, 0, 0))).toBeNull();
  });

  it('works for every timeframe', () => {
    for (const t of ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const) {
      const ms = tfMs(t);
      const next = candle(T0 + ms, 42, 43, 41, 42.5, 100, true, t);
      const e = resolveEntry(T0, ms, next);
      expect(e, `timeframe ${t}`).not.toBeNull();
      expect(e!.entryPrice).toBe(42);
    }
  });
});

describe('transition legality', () => {
  it('allows the documented transitions', () => {
    expect(canTransition('IDLE', 'WAITING_ENTRY')).toBe(true);
    expect(canTransition('WAITING_ENTRY', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'CLOSED_TP')).toBe(true);
    expect(canTransition('ACTIVE', 'CLOSED_SL')).toBe(true);
    expect(canTransition('ACTIVE', 'CLOSED_TIMEOUT')).toBe(true);
    expect(canTransition('CLOSED_TP', 'IDLE')).toBe(true);
  });

  it('rejects illegal jumps', () => {
    expect(canTransition('IDLE', 'ACTIVE')).toBe(false);
    expect(canTransition('IDLE', 'CLOSED_TP')).toBe(false);
    expect(canTransition('WAITING_ENTRY', 'CLOSED_TP')).toBe(false);
    expect(canTransition('CLOSED_SL', 'ACTIVE')).toBe(false);
    expect(() => assertTransition('IDLE', 'CLOSED_TP')).toThrow(/Illegal state transition/);
  });
});

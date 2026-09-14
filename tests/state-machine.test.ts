/**
 * GENUINE-EDGE signal emission + N+1 entry semantics.
 *
 * These tests pin the corrected semantics. The previous version of this file
 * asserted that the FIRST passing evaluation of a fresh slot emits a signal —
 * that was the bootstrap defect, and it is now asserted to be impossible.
 */

import { describe, expect, it } from 'vitest';
import {
  initialState,
  step,
  settleEdge,
  resolveEntry,
  canTransition,
  assertTransition,
  type MachineState,
} from '../src/strategy/state-machine';
import type { Direction, Evaluation } from '../src/core/types';
import { tfMs } from '../src/core/types';
import { candle } from './helpers';

function mkEval(
  candleTime: number,
  passed: boolean,
  score = 80,
  direction: Direction = 'LONG',
): Evaluation {
  const long = direction === 'LONG' ? score : 0;
  const short = direction === 'SHORT' ? score : 0;
  return {
    symbol: 'BTCUSDT',
    timeframe: '1h',
    candleTime,
    closePrice: 100,
    atr: 2,
    events: [],
    long: { direction: 'LONG', rawScore: 0, totalWeight: 0, score: long, components: [], duplicatesRemoved: 0, confirmations: 2 },
    short: { direction: 'SHORT', rawScore: 0, totalWeight: 0, score: short, components: [], duplicatesRemoved: 0, confirmations: 2 },
    longScore: long,
    shortScore: short,
    confirmations: 2,
    decision: { direction, score, threshold: 55, passed, confirmations: 2, minConfirmations: 2 },
  };
}

const H = 3_600_000;
const T0 = 1_700_000_000_000;

/** Drive a fresh slot to an OBSERVED not-passing baseline. */
function baselined(): MachineState {
  const st = initialState('BTCUSDT', '1h');
  const r = step(st, mkEval(T0 - H, false, 10));
  expect(r.action.kind).toBe('NONE');
  expect(r.next.state).toBe('NEUTRAL');
  expect(r.next.initialised).toBe(true);
  return r.next;
}

describe('bootstrap: a fresh slot can never emit', () => {
  it('first observation that ALREADY passes records a baseline and emits NOTHING', () => {
    const st = initialState('BTCUSDT', '1h');
    expect(st.initialised).toBe(false);

    const r = step(st, mkEval(T0, true, 99));

    // This is the regression that produced 8 bootstrap signals in production.
    expect(r.action.kind).toBe('NONE');
    expect(r.action.reason).toMatch(/bootstrap/i);
    // It parks in HOLD, not NEUTRAL: the condition is present, we just never
    // saw it ARRIVE, so it must fall before it can fire.
    expect(r.next.state).toBe('HOLD_LONG');
    expect(r.next.initialised).toBe(true);
  });

  it('a passing condition that persists after bootstrap still never emits', () => {
    let st = initialState('BTCUSDT', '1h');
    for (let i = 0; i < 10; i++) {
      const r = step(st, mkEval(T0 + i * H, true, 95));
      expect(r.action.kind, `candle ${i}`).toBe('NONE');
      st = r.next;
    }
    expect(st.state).toBe('HOLD_LONG');
  });

  it('first observation that does NOT pass records a NEUTRAL baseline', () => {
    const r = step(initialState('BTCUSDT', '1h'), mkEval(T0, false, 12));
    expect(r.action.kind).toBe('NONE');
    expect(r.next.state).toBe('NEUTRAL');
    expect(r.next.initialised).toBe(true);
  });

  it('bootstrapped-as-HOLD only emits after the condition falls and returns', () => {
    let st = step(initialState('BTCUSDT', '1h'), mkEval(T0, true, 90)).next;
    expect(st.state).toBe('HOLD_LONG');

    // falls
    st = step(st, mkEval(T0 + H, false, 10)).next;
    expect(st.state).toBe('REARM');
    // observed absent
    st = step(st, mkEval(T0 + 2 * H, false, 10)).next;
    expect(st.state).toBe('NEUTRAL');
    // and now a genuine rising edge
    const r = step(st, mkEval(T0 + 3 * H, true, 90));
    expect(r.action.kind).toBe('EMIT_SIGNAL');
    expect(r.next.state).toBe('EDGE_LONG');
  });
});

describe('genuine EDGE emission', () => {
  it('baseline not-passed -> passed emits EXACTLY ONE signal', () => {
    const st = baselined();
    const r = step(st, mkEval(T0, true));
    expect(r.action.kind).toBe('EMIT_SIGNAL');
    expect(r.next.state).toBe('EDGE_LONG');
    expect(r.next.setupCandleTime).toBe(T0);
  });

  it('passed -> passed produces no duplicate edge', () => {
    let st = baselined();
    const r1 = step(st, mkEval(T0, true));
    expect(r1.action.kind).toBe('EMIT_SIGNAL');

    // The engine settles a fired edge into HOLD.
    st = settleEdge(r1.next);
    expect(st.state).toBe('HOLD_LONG');

    for (let i = 1; i <= 5; i++) {
      const r = step(st, mkEval(T0 + i * H, true, 99));
      expect(r.action.kind, `candle ${i}`).toBe('NONE');
      expect(r.next.state).toBe('HOLD_LONG');
      st = r.next;
    }
  });

  it('does not emit while the slot still owns a live signal', () => {
    const st: MachineState = {
      ...baselined(),
      state: 'HOLD_LONG',
      direction: 'LONG',
      activeSignalId: 42,
    };
    for (let i = 1; i <= 5; i++) {
      const r = step(st, mkEval(T0 + i * H, true, 99));
      expect(r.action.kind).toBe('NONE');
      expect(r.action.reason).toMatch(/slot busy/);
    }
  });

  it('a direction FLIP while holding is a genuine new edge', () => {
    let st = baselined();
    st = settleEdge(step(st, mkEval(T0, true, 90, 'LONG')).next);
    expect(st.state).toBe('HOLD_LONG');

    const r = step(st, mkEval(T0 + H, true, 90, 'SHORT'));
    expect(r.action.kind).toBe('EMIT_SIGNAL');
    if (r.action.kind === 'EMIT_SIGNAL') expect(r.action.direction).toBe('SHORT');
    expect(r.next.state).toBe('EDGE_SHORT');
  });

  it('SHORT edges work symmetrically', () => {
    const st = baselined();
    const r = step(st, mkEval(T0, true, 88, 'SHORT'));
    expect(r.action.kind).toBe('EMIT_SIGNAL');
    expect(r.next.state).toBe('EDGE_SHORT');
    expect(r.next.direction).toBe('SHORT');
  });
});

describe('REARM behaviour', () => {
  it('HOLD -> fail goes to REARM, not straight to NEUTRAL', () => {
    let st = baselined();
    st = settleEdge(step(st, mkEval(T0, true)).next);
    expect(st.state).toBe('HOLD_LONG');

    const r = step(st, mkEval(T0 + H, false, 20));
    expect(r.next.state).toBe('REARM');
    expect(r.next.direction).toBeNull();
  });

  it('REARM -> fail settles to NEUTRAL', () => {
    let st = baselined();
    st = settleEdge(step(st, mkEval(T0, true)).next);
    st = step(st, mkEval(T0 + H, false, 20)).next;
    expect(st.state).toBe('REARM');

    const r = step(st, mkEval(T0 + 2 * H, false, 20));
    expect(r.next.state).toBe('NEUTRAL');
  });

  it('REARM -> pass is a legitimate edge (the condition genuinely returned)', () => {
    let st = baselined();
    st = settleEdge(step(st, mkEval(T0, true)).next);
    st = step(st, mkEval(T0 + H, false, 20)).next;
    expect(st.state).toBe('REARM');

    const r = step(st, mkEval(T0 + 2 * H, true, 85));
    expect(r.action.kind).toBe('EMIT_SIGNAL');
  });
});

describe('suppression cannot create a delayed fake edge', () => {
  it('settleEdge parks a suppressed edge in HOLD so it cannot re-fire', () => {
    const st = baselined();
    const r = step(st, mkEval(T0, true));
    expect(r.action.kind).toBe('EMIT_SIGNAL');

    // Engine suppressed it (capacity / no ATR / R:R too low).
    const suppressed = settleEdge(r.next);
    expect(suppressed.state).toBe('HOLD_LONG');

    // The SAME condition persisting must not look like a new rising edge.
    let cur = suppressed;
    for (let i = 1; i <= 6; i++) {
      const rr = step(cur, mkEval(T0 + i * H, true, 99));
      expect(rr.action.kind, `candle ${i}`).toBe('NONE');
      cur = rr.next;
    }
  });

  it('settleEdge is a no-op for non-edge states', () => {
    const st: MachineState = { ...baselined(), state: 'NEUTRAL' };
    expect(settleEdge(st).state).toBe('NEUTRAL');
  });
});

describe('idempotency', () => {
  it('replaying the same candle never double-emits', () => {
    let st = baselined();
    const r1 = step(st, mkEval(T0, true));
    expect(r1.action.kind).toBe('EMIT_SIGNAL');
    st = r1.next;

    const r2 = step(st, mkEval(T0, true));
    expect(r2.action.kind).toBe('NONE');
    expect(r2.next.lastCandleTime).toBe(T0);
  });

  it('ignores out-of-order (older) candles', () => {
    let st = baselined();
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
    const r = step(baselined(), mkEval(T0, true));
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
    expect(canTransition('NEUTRAL', 'EDGE_LONG')).toBe(true);
    expect(canTransition('NEUTRAL', 'EDGE_SHORT')).toBe(true);
    expect(canTransition('EDGE_LONG', 'HOLD_LONG')).toBe(true);
    expect(canTransition('HOLD_LONG', 'REARM')).toBe(true);
    expect(canTransition('REARM', 'NEUTRAL')).toBe(true);
    expect(canTransition('REARM', 'EDGE_LONG')).toBe(true);
    // direction flip straight out of a hold
    expect(canTransition('HOLD_LONG', 'EDGE_SHORT')).toBe(true);
  });

  it('rejects illegal jumps', () => {
    // NEUTRAL cannot jump straight into a hold without an edge.
    expect(canTransition('NEUTRAL', 'HOLD_LONG')).toBe(false);
    expect(canTransition('NEUTRAL', 'REARM')).toBe(false);
    // A long hold cannot silently become a short hold.
    expect(canTransition('HOLD_LONG', 'HOLD_SHORT')).toBe(false);
    expect(canTransition('EDGE_LONG', 'EDGE_LONG')).toBe(false);
    expect(() => assertTransition('NEUTRAL', 'HOLD_LONG')).toThrow(/Illegal state transition/);
  });
});

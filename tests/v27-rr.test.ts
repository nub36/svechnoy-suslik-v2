/**
 * Tests for the V2.7 fixed-RR simulator.
 * Research tooling only; frozen strategy untouched.
 */

import { describe, expect, it } from 'vitest';
import {
  MAKER_BPS, MAX_BARS, RR_ARMS, TAKER_BPS, feeR, simulateFixedRr,
} from '../research/v27_rr_test';
import type { Candle } from '../src/core/types';

const H = 3_600_000;
const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  openTime: i * H, closeTime: i * H + H - 1, open: o, high: h, low: l,
  close: c, volume: 1, isClosed: true,
} as Candle);

/** entry 100, stop 90 -> risk = 10. */
const L = { dir: 'LONG' as const, entry: 100, stop: 90 };
const S = { dir: 'SHORT' as const, entry: 100, stop: 110 };

describe('preregistered arm set', () => {
  it('is exactly 1.5 / 2.0 / 2.5 / 3.0 / 4.0', () => {
    expect(RR_ARMS.map((a) => a.mult)).toEqual([1.5, 2.0, 2.5, 3.0, 4.0]);
    expect(RR_ARMS.map((a) => a.label))
      .toEqual(['RR15', 'RR20', 'RR25', 'RR30', 'RR40']);
  });
  it('uses the task-specified 50-bar horizon', () => {
    expect(MAX_BARS).toBe(50);
  });
});

describe('target placement', () => {
  it('LONG TP sits at entry + mult * risk', () => {
    // 2.0R target = 120; bar reaches 121 -> TP
    const r = simulateFixedRr('LONG', L.entry, L.stop, 2.0, [bar(1, 100, 121, 99, 120)])!;
    expect(r.exit).toBe('TP');
    expect(r.exitPrice).toBeCloseTo(120, 9);
    expect(r.grossR).toBeCloseTo(2.0, 9);
  });

  it('SHORT TP mirrors below entry', () => {
    const r = simulateFixedRr('SHORT', S.entry, S.stop, 3.0, [bar(1, 100, 101, 69, 70)])!;
    expect(r.exit).toBe('TP');
    expect(r.exitPrice).toBeCloseTo(70, 9);
    expect(r.grossR).toBeCloseTo(3.0, 9);
  });

  it('a higher arm does NOT trigger where a lower one does', () => {
    const bars = [bar(1, 100, 116, 99, 115)];   // reaches 1.5R (115) only
    expect(simulateFixedRr('LONG', L.entry, L.stop, 1.5, bars)!.exit).toBe('TP');
    const rr20 = simulateFixedRr('LONG', L.entry, L.stop, 2.0, bars)!;
    expect(rr20.exit).not.toBe('TP');
  });
});

describe('stop loss', () => {
  it('books exactly -1R', () => {
    const r = simulateFixedRr('LONG', L.entry, L.stop, 3.0, [bar(1, 100, 101, 89, 92)])!;
    expect(r.exit).toBe('SL');
    expect(r.grossR).toBeCloseTo(-1, 9);
  });

  it('SL WINS a same-bar TP+SL tie (conservative, preregistered)', () => {
    // bar hits both 130 (3R) and 89 (below stop) -> must book SL
    const r = simulateFixedRr('LONG', L.entry, L.stop, 3.0, [bar(1, 100, 130, 89, 95)])!;
    expect(r.exit).toBe('SL');
    expect(r.grossR).toBeCloseTo(-1, 9);
  });

  it('SHORT same-bar tie also resolves to SL', () => {
    const r = simulateFixedRr('SHORT', S.entry, S.stop, 3.0, [bar(1, 100, 111, 69, 90)])!;
    expect(r.exit).toBe('SL');
    expect(r.grossR).toBeCloseTo(-1, 9);
  });
});

describe('timeout', () => {
  it('closes at the 50th bar CLOSE when neither level is touched', () => {
    const bars = Array.from({ length: 60 }, (_, i) => bar(i + 1, 100, 104, 96, 102));
    const r = simulateFixedRr('LONG', L.entry, L.stop, 3.0, bars)!;
    expect(r.exit).toBe('TIMEOUT');
    expect(r.barsHeld).toBe(MAX_BARS);
    expect(r.exitPrice).toBe(102);
    expect(r.grossR).toBeCloseTo(0.2, 9);   // (102-100)/10
  });

  it('closes at the last available bar when the series ends early', () => {
    const bars = Array.from({ length: 5 }, (_, i) => bar(i + 1, 100, 104, 96, 103));
    const r = simulateFixedRr('LONG', L.entry, L.stop, 3.0, bars)!;
    expect(r.exit).toBe('TIMEOUT');
    expect(r.barsHeld).toBe(5);
  });
});

describe('degenerate inputs', () => {
  it('null on zero risk', () => {
    expect(simulateFixedRr('LONG', 100, 100, 2, [bar(1, 100, 101, 99, 100)])).toBeNull();
  });
  it('null with no bars', () => {
    expect(simulateFixedRr('LONG', 100, 90, 2, [])).toBeNull();
  });
});

describe('fee model — the core of the V2.7 hypothesis', () => {
  it('is 2 bps maker entry + 5 bps taker exit', () => {
    expect(MAKER_BPS).toBe(2);
    expect(TAKER_BPS).toBe(5);
    // entry 100, exit 100, risk 1 -> (2+5) bps of 100 = 0.07 R
    expect(feeR(100, 100, 1)).toBeCloseTo(0.07, 9);
  });

  it('scales inversely with stop distance', () => {
    expect(feeR(100, 100, 0.1)).toBeCloseTo(feeR(100, 100, 1) * 10, 9);
  });

  it('is essentially INDEPENDENT of the take-profit level (pre-reg §1)', () => {
    // Same entry and risk; only the exit price differs (1.5R vs 4R target).
    const risk = 10;
    const f15 = feeR(100, 115, risk);
    const f40 = feeR(100, 140, risk);
    // The taker leg moves slightly with exit price, but the effect is tiny —
    // far too small to convert a -0.009 R net into a positive one.
    expect(Math.abs(f40 - f15)).toBeLessThan(0.002);
  });

  it('never returns a negative fee (no maker rebate)', () => {
    expect(feeR(100, 140, 10)).toBeGreaterThan(0);
  });
});

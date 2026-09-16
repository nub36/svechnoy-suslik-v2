/**
 * Tests required by docs/V2_5_TRAILING_STOP_PREREGISTRATION.md §6.
 * Research tooling only; frozen strategy untouched.
 */

import { describe, expect, it } from 'vitest';
import {
  BREAKEVEN_R, TIMEOUT_BARS, TRAIL_DISTANCE_R, TRAIL_STEP_R,
  V25_FEE_ENVS, feeR, simulateTrailing,
} from '../scripts/real-data/v25-trailing';
import type { Candle } from '../src/core/types';

const H = 3_600_000;
const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  openTime: i * H, closeTime: i * H + H - 1, open: o, high: h, low: l,
  close: c, volume: 1, isClosed: true,
} as Candle);

/** entry 100, stop 90 -> R = 10. LONG unless stated. */
const LONG = { direction: 'LONG' as const, entryPrice: 100, stopLoss: 90 };
const SHORT = { direction: 'SHORT' as const, entryPrice: 100, stopLoss: 110 };

describe('V2.5 constants are the preregistered values', () => {
  it('matches the spec exactly', () => {
    expect(BREAKEVEN_R).toBe(1.0);
    expect(TRAIL_DISTANCE_R).toBe(1.0);
    expect(TRAIL_STEP_R).toBe(0.25);
    expect(TIMEOUT_BARS).toBe(10);
  });
});

describe('initial stop and plain SL', () => {
  it('exits at the original SL when price never advances', () => {
    const r = simulateTrailing({ ...LONG, bars: [bar(1, 100, 101, 89, 92)] })!;
    expect(r.reason).toBe('SL');
    expect(r.exitPrice).toBe(90);
    expect(r.grossR).toBeCloseTo(-1, 9);
    expect(r.reachedBreakeven).toBe(false);
  });

  it('R4: breakeven cannot arm on the entry bar before the stop is checked', () => {
    // Entry bar both reaches +1R (high 110) and breaches S0 (low 89).
    // R1 says the stop is checked first -> SL, not a protected breakeven.
    const r = simulateTrailing({ ...LONG, bars: [bar(1, 100, 110, 89, 95)] })!;
    expect(r.reason).toBe('SL');
    expect(r.grossR).toBeCloseTo(-1, 9);
  });
});

describe('breakeven arming at exactly +1R', () => {
  it('does NOT arm below +1R', () => {
    const r = simulateTrailing({
      ...LONG,
      bars: [bar(1, 100, 109.9, 99, 105), bar(2, 105, 106, 89, 91)],
    })!;
    expect(r.reachedBreakeven).toBe(false);
    expect(r.reason).toBe('SL');          // still protected by S0 only
    expect(r.exitPrice).toBe(90);
  });

  it('arms at exactly +1R and then exits at breakeven, not at S0', () => {
    const r = simulateTrailing({
      ...LONG,
      bars: [bar(1, 100, 110, 99, 105), bar(2, 105, 106, 95, 96)],
    })!;
    expect(r.reachedBreakeven).toBe(true);
    expect(r.reason).toBe('BE');
    expect(r.exitPrice).toBe(100);
    expect(r.grossR).toBeCloseTo(0, 9);
  });
});

describe('trailing distance and step gating', () => {
  it('trails exactly 1R below peak MFE', () => {
    // bar1 peak +2R (120) -> stop = 2R - 1R = +1R = 110
    const r = simulateTrailing({
      ...LONG,
      bars: [bar(1, 100, 120, 99, 118), bar(2, 118, 119, 109, 110)],
    })!;
    expect(r.reason).toBe('TRAIL');
    expect(r.exitPrice).toBeCloseTo(110, 9);
    expect(r.grossR).toBeCloseTo(1, 9);
  });

  it('0.25R step SUPPRESSES a smaller advance', () => {
    // bar1 peak 2.0R -> stop 1.0R (=110). bar2 peak 2.1R (+0.1R only):
    // step gate blocks the update, so the stop stays at 110, not 1.1R (=111).
    const r = simulateTrailing({
      ...LONG,
      bars: [
        bar(1, 100, 120, 99, 118),
        bar(2, 118, 121, 118, 120),   // +0.1R advance, below the 0.25R step
        bar(3, 120, 120, 109, 110),   // retrace into 110
      ],
    })!;
    expect(r.exitPrice).toBeCloseTo(110, 9);   // 110, not 111
  });

  it('a >= 0.25R advance DOES move the stop', () => {
    const r = simulateTrailing({
      ...LONG,
      bars: [
        bar(1, 100, 120, 99, 118),
        bar(2, 118, 122.5, 118, 122), // +0.25R advance -> stop to 1.25R = 112.5
        bar(3, 122, 122, 112, 113),
      ],
    })!;
    expect(r.exitPrice).toBeCloseTo(112.5, 9);
  });

  it('R3: the stop never moves backwards when MFE falls', () => {
    const r = simulateTrailing({
      ...LONG,
      bars: [
        bar(1, 100, 130, 99, 128),   // peak 3R -> stop 2R = 120
        bar(2, 128, 128, 121, 122),  // MFE falls, stop must stay 120
        bar(3, 122, 122, 119, 120),  // now hits 120
      ],
    })!;
    expect(r.exitPrice).toBeCloseTo(120, 9);
    expect(r.grossR).toBeCloseTo(2, 9);
  });
});

describe('R1/R2: same-bar conservatism', () => {
  it('R1: a bar that makes a new high AND breaches the stop books the STOP', () => {
    // bar1 sets stop at 110 (peak 2R). bar2 spikes to 140 but also trades 109.
    // The stop in force (110) is checked first -> exit 110, NOT a trail to 3R.
    const r = simulateTrailing({
      ...LONG,
      bars: [bar(1, 100, 120, 99, 118), bar(2, 118, 140, 109, 139)],
    })!;
    expect(r.reason).toBe('TRAIL');
    expect(r.exitPrice).toBeCloseTo(110, 9);
    expect(r.grossR).toBeCloseTo(1, 9);
  });

  it('R2: a new MFE high cannot protect itself within its own bar', () => {
    // Single bar reaches +3R then collapses to breakeven-ish. There is no
    // completed prior bar, so only S0 is in force.
    const r = simulateTrailing({ ...LONG, bars: [bar(1, 100, 130, 89, 95)] })!;
    expect(r.reason).toBe('SL');
    expect(r.exitPrice).toBe(90);
  });
});

describe('timeout', () => {
  it('fires at bar 10 when +1R was never reached', () => {
    const bars = Array.from({ length: 12 },
      (_, i) => bar(i + 1, 100, 104, 96, 101));
    const r = simulateTrailing({ ...LONG, bars })!;
    expect(r.reason).toBe('TIMEOUT');
    expect(r.barsHeld).toBe(TIMEOUT_BARS);
    expect(r.exitPrice).toBe(101);
  });

  it('does NOT fire once breakeven has armed', () => {
    const bars = [
      bar(1, 100, 110, 99, 105),                               // arms at +1R
      ...Array.from({ length: 14 }, (_, i) => bar(i + 2, 105, 106, 101, 105)),
    ];
    const r = simulateTrailing({ ...LONG, bars });
    // Never hits the breakeven stop (low 101 > 100) and never times out.
    expect(r).toBeNull();
  });
});

describe('SHORT symmetry', () => {
  it('arms breakeven and trails downward', () => {
    // entry 100, stop 110, R = 10. Price falls to 80 = +2R -> stop 90.
    const r = simulateTrailing({
      ...SHORT,
      bars: [bar(1, 100, 101, 80, 82), bar(2, 82, 91, 81, 90)],
    })!;
    expect(r.reason).toBe('TRAIL');
    expect(r.exitPrice).toBeCloseTo(90, 9);
    expect(r.grossR).toBeCloseTo(1, 9);
  });

  it('SHORT plain SL', () => {
    const r = simulateTrailing({ ...SHORT, bars: [bar(1, 100, 111, 99, 108)] })!;
    expect(r.reason).toBe('SL');
    expect(r.grossR).toBeCloseTo(-1, 9);
  });
});

describe('degenerate inputs', () => {
  it('returns null for zero risk', () => {
    expect(simulateTrailing({
      direction: 'LONG', entryPrice: 100, stopLoss: 100, bars: [bar(1, 100, 101, 99, 100)],
    })).toBeNull();
  });
  it('returns null with no bars', () => {
    expect(simulateTrailing({ ...LONG, bars: [] })).toBeNull();
  });
});

describe('fee model', () => {
  it('headline is 2 bps maker entry + 5 bps taker exit', () => {
    const env = V25_FEE_ENVS.find((e) => e.label === 'FUT_4')!;
    expect(env.makerBps).toBe(2);
    expect(env.takerBps).toBe(5);
    // entry 100, exit 100, risk 1 -> (2bps + 5bps) * 100 = 0.07 R
    expect(feeR(100, 100, 1, env.makerBps, env.takerBps)).toBeCloseTo(0.07, 9);
  });
  it('GROSS charges nothing and no env is negative (no rebate)', () => {
    for (const e of V25_FEE_ENVS) {
      expect(feeR(100, 100, 1, e.makerBps, e.takerBps)).toBeGreaterThanOrEqual(0);
    }
    expect(feeR(100, 100, 1, 0, 0)).toBe(0);
  });
  it('scales inversely with stop distance', () => {
    expect(feeR(100, 100, 0.1, 2, 5)).toBeCloseTo(feeR(100, 100, 1, 2, 5) * 10, 9);
  });
});

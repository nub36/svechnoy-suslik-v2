/**
 * Tests for the V3.0 HTF Liquidation Trap simulator.
 * Research tooling only; frozen strategy untouched.
 */

import { describe, expect, it } from 'vitest';
import {
  CORRIDOR_ATR_FRAC, MIN_BODY_RATIO, MIN_RVOL, STOP_BUFFER_ATR, TIMEOUT_BARS,
  bodyRatio, confirmedLevels, detectTrap, legFeeR, manageTrade,
} from '../research/v30_htf_trap';
import type { Candle } from '../src/core/types';

const H = 3_600_000;
const H4 = 4 * H;
const bar = (i: number, o: number, h: number, l: number, c: number, span = H): Candle => ({
  openTime: i * span, closeTime: i * span + span - 1, open: o, high: h, low: l,
  close: c, volume: 100, isClosed: true,
} as Candle);

describe('preregistered constants', () => {
  it('match the specification exactly', () => {
    expect(MIN_BODY_RATIO).toBe(0.35);
    expect(MIN_RVOL).toBe(1.25);         // NOT 1.2 — V3.0 uses 1.25
    expect(CORRIDOR_ATR_FRAC).toBe(0.10);
    expect(STOP_BUFFER_ATR).toBe(0.15);
    expect(TIMEOUT_BARS).toBe(50);
  });
});

describe('bodyRatio', () => {
  it('is |close-open| / range', () => {
    expect(bodyRatio(bar(1, 100, 110, 90, 105))).toBeCloseTo(0.25, 9);
    expect(bodyRatio(bar(1, 100, 110, 100, 110))).toBeCloseTo(1.0, 9);
  });
  it('returns 0 for a zero-range bar', () => {
    expect(bodyRatio(bar(1, 100, 100, 100, 100))).toBe(0);
  });
});

/* ---------------- trap detection ---------------- */

const LV = { swingHigh: 110, swingLow: 90 };

describe('detectTrap', () => {
  it('SHORT: pierces the 4H high and closes back below', () => {
    // high 115 > 110, close 104 < 110, body |104-112|/(115-103)=0.667
    const t = detectTrap(bar(1, 112, 115, 103, 104), LV, 2.0);
    expect(t).toMatchObject({ direction: 'SHORT', level: 110, sweepExtreme: 115 });
  });

  it('LONG: pierces the 4H low and closes back above', () => {
    const t = detectTrap(bar(1, 88, 97, 85, 96), LV, 2.0);
    expect(t).toMatchObject({ direction: 'LONG', level: 90, sweepExtreme: 85 });
  });

  it('rejects a pierce that does NOT reclaim (closes beyond)', () => {
    // high 115 > 110 but close 114 is still above the level -> breakout, not trap
    expect(detectTrap(bar(1, 105, 115, 104, 114), LV, 2.0)).toBeNull();
  });

  it('rejects when the level is never pierced', () => {
    expect(detectTrap(bar(1, 100, 108, 95, 101), LV, 2.0)).toBeNull();
  });

  it('enforces bodyRatio >= 0.35', () => {
    // tiny body: |100.5-100|/(115-99) = 0.031
    expect(detectTrap(bar(1, 100, 115, 99, 100.5), LV, 2.0)).toBeNull();
  });

  it('enforces RVOL strictly > 1.25', () => {
    const c = bar(1, 112, 115, 103, 104);
    expect(detectTrap(c, LV, MIN_RVOL)).toBeNull();          // equal fails
    expect(detectTrap(c, LV, MIN_RVOL + 0.01)).not.toBeNull();
    expect(detectTrap(c, LV, null)).toBeNull();
  });

  it('returns null when no level exists on that side', () => {
    expect(detectTrap(bar(1, 112, 115, 103, 104),
      { swingHigh: null, swingLow: 90 }, 2.0)).toBeNull();
  });
});

/* ---------------- causality: 4H pivot confirmation ---------------- */

describe('confirmedLevels — causality', () => {
  /** Rising then falling 4H series producing a clean pivot high. */
  const make4h = (): Candle[] => {
    const out: Candle[] = [];
    const px = [10, 11, 12, 13, 14, 20, 14, 13, 12, 11, 10, 9, 8, 9, 10, 11];
    for (let i = 0; i < px.length; i++) {
      out.push(bar(i, px[i]!, px[i]! + 0.5, px[i]! - 0.5, px[i]!, H4));
    }
    return out;
  };

  it('does not expose a pivot before its right-bars have printed', () => {
    const h4 = make4h();
    // Pivot high is at index 5 (price 20.5). With strength 3 it confirms at 8.
    const early = confirmedLevels(h4, h4[6]!.closeTime, 3);
    const late = confirmedLevels(h4, h4[11]!.closeTime, 3);
    expect(early.swingHigh).not.toBe(20.5);   // too early to know
    expect(late.swingHigh).toBe(20.5);        // confirmed by now
  });

  it('never reads a 4H bar that has not closed by the cutoff', () => {
    const h4 = make4h();
    const atIdx6 = confirmedLevels(h4, h4[6]!.closeTime, 3);
    // Appending violent future bars must not change the verdict.
    const future = [...h4, bar(99, 1e5, 1e5, 1e5, 1e5, H4)];
    expect(confirmedLevels(future, h4[6]!.closeTime, 3)).toEqual(atIdx6);
  });

  it('returns nulls when there is not enough history', () => {
    expect(confirmedLevels([bar(0, 10, 11, 9, 10, H4)], 1e15, 3))
      .toEqual({ swingHigh: null, swingLow: null });
  });
});

/* ---------------- trade management ---------------- */

/** LONG: entry 100, stop 90 (R=10), TP1 120 (2R), TP2 140 (4R). */
const L = { dir: 'LONG' as const, entry: 100, stop: 90, tp1: 120, tp2: 140 };

describe('manageTrade', () => {
  it('books a full -1R stop before TP1', () => {
    const r = manageTrade(L.dir, L.entry, L.stop, L.tp1, L.tp2,
      [bar(1, 100, 105, 89, 92)])!;
    expect(r.exit).toBe('SL');
    expect(r.grossR).toBeCloseTo(-1, 9);
    expect(r.hitTp1).toBe(false);
  });

  it('R1: a bar hitting BOTH stop and TP1 books the stop', () => {
    const r = manageTrade(L.dir, L.entry, L.stop, L.tp1, L.tp2,
      [bar(1, 100, 125, 89, 95)])!;
    expect(r.exit).toBe('SL');
    expect(r.grossR).toBeCloseTo(-1, 9);
  });

  it('TP1 books half at +2R, then TP2 the rest at +4R', () => {
    const r = manageTrade(L.dir, L.entry, L.stop, L.tp1, L.tp2,
      [bar(1, 100, 121, 99, 120), bar(2, 120, 141, 119, 140)])!;
    expect(r.exit).toBe('TP2');
    expect(r.hitTp1).toBe(true);
    expect(r.hitTp2).toBe(true);
    expect(r.grossR).toBeCloseTo(0.5 * 2 + 0.5 * 4, 9);   // 3.0R
  });

  it('R2: TP1 and TP2 on one bar book in order', () => {
    const r = manageTrade(L.dir, L.entry, L.stop, L.tp1, L.tp2,
      [bar(1, 100, 145, 99, 144)])!;
    expect(r.exit).toBe('TP2');
    expect(r.grossR).toBeCloseTo(3.0, 9);
  });

  it('R3: breakeven arms only AFTER the TP1 bar', () => {
    // bar1 hits TP1 and dips to 99 — must NOT stop at breakeven on that bar.
    const r = manageTrade(L.dir, L.entry, L.stop, L.tp1, L.tp2,
      [bar(1, 100, 121, 99, 118), bar(2, 118, 119, 95, 99)])!;
    expect(r.hitTp1).toBe(true);
    expect(r.exit).toBe('TP1_THEN_BE');
    // half at +2R, half at breakeven (0R)
    expect(r.grossR).toBeCloseTo(1.0, 9);
  });

  it('after TP1, a timeout closes the remainder at market', () => {
    const bars = [bar(1, 100, 121, 99, 120),
      ...Array.from({ length: 60 }, (_, i) => bar(i + 2, 118, 119, 101, 118))];
    const r = manageTrade(L.dir, L.entry, L.stop, L.tp1, L.tp2, bars)!;
    expect(r.exit).toBe('TP1_THEN_TIMEOUT');
    expect(r.barsHeld).toBe(TIMEOUT_BARS);
  });

  it('R5: plain timeout at bar 50 when nothing is hit', () => {
    const bars = Array.from({ length: 60 }, (_, i) => bar(i + 1, 100, 104, 96, 102));
    const r = manageTrade(L.dir, L.entry, L.stop, L.tp1, L.tp2, bars)!;
    expect(r.exit).toBe('TIMEOUT');
    expect(r.barsHeld).toBe(TIMEOUT_BARS);
    expect(r.grossR).toBeCloseTo(0.2, 9);
  });

  it('SHORT mirrors correctly', () => {
    // entry 100, stop 110 (R=10), TP1 80 (2R), TP2 60 (4R)
    const r = manageTrade('SHORT', 100, 110, 80, 60,
      [bar(1, 100, 101, 79, 80), bar(2, 80, 81, 59, 60)])!;
    expect(r.exit).toBe('TP2');
    expect(r.grossR).toBeCloseTo(3.0, 9);
  });

  it('returns null on zero risk or no bars', () => {
    expect(manageTrade(L.dir, 100, 100, 120, 140, [bar(1, 100, 101, 99, 100)])).toBeNull();
    expect(manageTrade(L.dir, L.entry, L.stop, L.tp1, L.tp2, [])).toBeNull();
  });
});

/* ---------------- fees ---------------- */

describe('fee model', () => {
  it('charges per leg on that leg notional', () => {
    // 2 bps on a full-weight 100 price with risk 1 -> 0.02 R
    expect(legFeeR(100, 1, 2, 1)).toBeCloseTo(0.02, 9);
    // half weight halves it
    expect(legFeeR(100, 0.5, 2, 1)).toBeCloseTo(0.01, 9);
  });

  it('scales inversely with risk — the whole V3.0 thesis', () => {
    expect(legFeeR(100, 1, 7, 1)).toBeCloseTo(legFeeR(100, 1, 7, 2) * 2, 9);
  });

  it('a partial exit charges THREE legs, not two', () => {
    const r = manageTrade(L.dir, L.entry, L.stop, L.tp1, L.tp2,
      [bar(1, 100, 121, 99, 120), bar(2, 120, 141, 119, 140)])!;
    // entry(1.0) + tp1(0.5) + tp2(0.5) at 100/120/140, risk 10
    const expected = (2 / 10000 * 100 * 1
      + 5 / 10000 * 120 * 0.5
      + 5 / 10000 * 140 * 0.5) / 10;
    expect(r.feeR(2, 5)).toBeCloseTo(expected, 9);
  });

  it('is never negative (no rebate modelled)', () => {
    const r = manageTrade(L.dir, L.entry, L.stop, L.tp1, L.tp2,
      [bar(1, 100, 105, 89, 92)])!;
    expect(r.feeR(2, 5)).toBeGreaterThan(0);
    expect(r.feeR(0, 0)).toBe(0);
  });
});

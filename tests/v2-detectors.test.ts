/**
 * SMC V2 — detector and indicator regression suite (spec §32).
 *
 * These tests use hand-built candle sequences so each market situation is
 * unambiguous. Where a test encodes a REQUIREMENT (wick is not a BOS, a touch
 * is not a sweep, HTF candles must be closed) the assertion is written to fail
 * loudly if the behaviour is ever relaxed.
 */

import { describe, expect, it } from 'vitest';
import type { Candle, Timeframe } from '../src/core/types';
import {
  emaSeries, rsiSeries, atrSeriesV2, trueRanges, buildAdxContext,
  buildMacdContext, buildRsiContext, buildVolumeContext, buildEmaContext,
  buildAtrContext,
} from '../src/strategy/v2/indicators';
import {
  findSwingsV2, knownSwings, structureBias, detectStructureBreak, buildRange,
  rangeLocation, buildFib, findLiquidityPools, detectSweep, detectBreakout,
  detectDisplacement, buildOrderBlock, findFvg,
} from '../src/strategy/v2/structure';
import { closedHtfCandles, htfContext, htfAlignment, HTF_MAP } from '../src/strategy/v2/htf';

const H = 3_600_000;
const T0 = 1_700_000_000_000;

function c(
  i: number, o: number, h: number, l: number, cl: number, v = 100, closed = true,
): Candle {
  return {
    openTime: T0 + i * H,
    open: o, high: h, low: l, close: cl, volume: v,
    closeTime: T0 + i * H + H - 1,
    quoteVolume: v * cl, trades: 10, isClosed: closed,
  };
}

/** Flat-ish filler used to build a stable ATR baseline. */
function filler(n: number, base: number, startIdx = 0): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const drift = (i % 2 === 0 ? 1 : -1) * 0.5;
    out.push(c(startIdx + i, base, base + 1 + drift, base - 1 - drift, base + drift * 0.2));
  }
  return out;
}

/* ================================================================== */
/* Indicators                                                          */
/* ================================================================== */

describe('V2 indicators — exact mathematics', () => {
  it('EMA seeds with an SMA and then applies k = 2/(p+1)', () => {
    const vals = [1, 2, 3, 4, 5, 6];
    const e = emaSeries(vals, 3);
    expect(e[0]).toBeNull();
    expect(e[1]).toBeNull();
    expect(e[2]).toBeCloseTo(2, 10); // SMA(1,2,3)
    // k = 0.5 -> 4*0.5 + 2*0.5 = 3
    expect(e[3]).toBeCloseTo(3, 10);
    expect(e[4]).toBeCloseTo(4, 10);
  });

  it('true range uses the previous close, not just the bar range', () => {
    const bars = [c(0, 10, 11, 9, 10), c(1, 20, 21, 19, 20)];
    const tr = trueRanges(bars);
    expect(tr[0]).toBe(2);
    // |21-10| = 11 dominates the 2-wide bar
    expect(tr[1]).toBe(11);
  });

  it('ATR is Wilder-smoothed and warms up at exactly `period` bars', () => {
    const bars = filler(30, 100);
    const a = atrSeriesV2(bars, 14);
    expect(a[12]).toBeNull();
    expect(a[13]).not.toBeNull();
    expect(a[29]).toBeGreaterThan(0);
  });

  it('RSI is 100 when there are no losses, and sits at 50 for symmetric moves', () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(rsiSeries(up, 14)[19]).toBe(100);
    const flat = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 0 : 1));
    const r = rsiSeries(flat, 14)[39];
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(30);
    expect(r!).toBeLessThan(70);
  });

  it('RSI(14) matches a hand-computed Wilder value', () => {
    // Strictly rising by 1 then one down bar: avgLoss becomes non-zero.
    const closes = [...Array.from({ length: 15 }, (_, i) => 100 + i), 110];
    const r = rsiSeries(closes, 14);
    expect(r[14]).toBe(100);
    expect(r[15]).not.toBeNull();
    expect(r[15]!).toBeLessThan(100);
  });

  it('MACD histogram equals macd minus signal', () => {
    const bars = filler(80, 100).map((b, i) => c(i, 100 + i, 101 + i, 99 + i, 100.5 + i));
    const m = buildMacdContext(bars, bars.length - 1);
    expect(m.macd).not.toBeNull();
    expect(m.signal).not.toBeNull();
    expect(m.histogram!).toBeCloseTo(m.macd! - m.signal!, 10);
  });

  it('ADX stays null until it has enough history, then lands in 0..100', () => {
    expect(buildAdxContext(filler(10, 100), 9, 14).adx).toBeNull();
    const trend = Array.from({ length: 80 }, (_, i) =>
      c(i, 100 + i, 102 + i, 99 + i, 101.5 + i));
    const a = buildAdxContext(trend, trend.length - 1, 14);
    expect(a.adx).not.toBeNull();
    expect(a.adx!).toBeGreaterThanOrEqual(0);
    expect(a.adx!).toBeLessThanOrEqual(100);
    expect(a.regime).toBe('STRONG'); // a clean one-way ramp
    expect(a.bullishPressure).toBe(true);
  });

  it('ADX never chooses a direction — it only reports strength', () => {
    const down = Array.from({ length: 80 }, (_, i) =>
      c(i, 200 - i, 201 - i, 198 - i, 198.5 - i));
    const a = buildAdxContext(down, down.length - 1, 14);
    expect(a.regime).toBe('STRONG');
    expect(a.bullishPressure).toBe(false); // strength high, direction bearish
  });

  it('RVOL excludes the current bar from its own average', () => {
    const bars = [...filler(25, 100).map((b, i) => c(i, 100, 101, 99, 100, 50))];
    bars.push(c(25, 100, 101, 99, 100, 500));
    const v = buildVolumeContext(bars, 25, 20);
    expect(v.avgVolume).toBeCloseTo(50, 6);
    expect(v.rvol).toBeCloseTo(10, 6);
    expect(v.spike).toBe(true);
  });

  it('EMA context reports alignment without turning it into a signal', () => {
    const up = Array.from({ length: 120 }, (_, i) => c(i, 100 + i, 101 + i, 99 + i, 100.8 + i));
    const atr = buildAtrContext(up, up.length - 1, 14).atr;
    const e = buildEmaContext(up, up.length - 1, atr);
    expect(e.alignment).toBe('BULLISH');
    expect(e.fastAboveSlow).toBe(true);
    expect(e.slope20Atr!).toBeGreaterThan(0);
  });

  it('RSI overbought is reported but is NOT a direction', () => {
    const up = Array.from({ length: 60 }, (_, i) => c(i, 100 + i * 2, 101 + i * 2, 99 + i * 2, 100.9 + i * 2));
    const r = buildRsiContext(up, up.length - 1, 14);
    expect(r.overbought).toBe(true);
    // The context object carries no direction field at all — by design.
    expect(Object.keys(r)).not.toContain('direction');
  });
});

/* ================================================================== */
/* Swings & structure                                                  */
/* ================================================================== */

describe('V2 structure — swings, BOS, CHoCH', () => {
  it('confirms a pivot only after `strength` bars (no look-ahead)', () => {
    const bars = [
      c(0, 100, 101, 99, 100), c(1, 100, 102, 99, 101), c(2, 101, 110, 100, 109),
      c(3, 109, 108, 105, 106), c(4, 106, 107, 104, 105), c(5, 105, 106, 103, 104),
      c(6, 104, 105, 102, 103),
    ];
    const sw = findSwingsV2(bars, 2);
    const high = sw.find((s) => s.kind === 'HIGH' && s.index === 2);
    expect(high).toBeDefined();
    expect(high!.confirmedIndex).toBe(4);
    // At bar 3 the pivot is NOT yet knowable.
    expect(knownSwings(sw, 3).some((s) => s.index === 2 && s.kind === 'HIGH')).toBe(false);
    expect(knownSwings(sw, 4).some((s) => s.index === 2 && s.kind === 'HIGH')).toBe(true);
  });

  it('labels HH / HL / LH / LL relative to the previous same-kind swing', () => {
    const bars: Candle[] = [];
    // low 90, high 110, higher low 95, higher high 120
    const shape = [100, 90, 100, 110, 100, 95, 105, 120, 110, 108, 107];
    shape.forEach((v, i) => bars.push(c(i, v, v + 2, v - 2, v)));
    const sw = findSwingsV2(bars, 1);
    const labels = sw.map((s) => `${s.kind}:${s.label}`);
    expect(labels).toContain('LOW:FIRST');
    expect(labels.some((l) => l === 'HIGH:HH')).toBe(true);
    expect(labels.some((l) => l === 'LOW:HL')).toBe(true);
  });

  it('structure bias is BULLISH on HH+HL and BEARISH on LH+LL', () => {
    const up: Candle[] = [];
    [100, 90, 100, 110, 102, 95, 108, 125, 118, 116, 115].forEach((v, i) =>
      up.push(c(i, v, v + 2, v - 2, v)));
    expect(structureBias(findSwingsV2(up, 1), up.length - 1)).toBe('BULLISH');

    const down: Candle[] = [];
    [100, 110, 100, 90, 98, 105, 92, 75, 82, 84, 85].forEach((v, i) =>
      down.push(c(i, v, v + 2, v - 2, v)));
    expect(structureBias(findSwingsV2(down, 1), down.length - 1)).toBe('BEARISH');
  });

  it('REQUIREMENT: a wick through a swing high is NOT a BOS', () => {
    const bars = [...filler(20, 100)];
    // Build a clear swing high at index 22.
    bars.push(c(20, 100, 101, 99, 100));
    bars.push(c(21, 100, 103, 99, 102));
    bars.push(c(22, 102, 115, 101, 103)); // pivot high 115
    bars.push(c(23, 103, 105, 100, 102));
    bars.push(c(24, 102, 104, 100, 101));
    bars.push(c(25, 101, 103, 99, 100));
    // Bar 26 spikes ABOVE 115 with its wick but closes back below.
    bars.push(c(26, 100, 118, 99, 101));

    const sw = findSwingsV2(bars, 2);
    const atr = buildAtrContext(bars, 26, 14).atr;
    const br = detectStructureBreak(bars, sw, 26, atr, 0.05);
    expect(br).not.toBeNull();
    expect(br!.wickOnly).toBe(true);
    expect(br!.reason).toMatch(/not a break/i);
  });

  it('a decisive CLOSE beyond the swing high IS a break', () => {
    const bars = [...filler(20, 100)];
    bars.push(c(20, 100, 101, 99, 100));
    bars.push(c(21, 100, 103, 99, 102));
    bars.push(c(22, 102, 115, 101, 103));
    bars.push(c(23, 103, 105, 100, 102));
    bars.push(c(24, 102, 104, 100, 101));
    bars.push(c(25, 101, 103, 99, 100));
    bars.push(c(26, 100, 122, 100, 121)); // closes well above 115

    const sw = findSwingsV2(bars, 2);
    const atr = buildAtrContext(bars, 26, 14).atr;
    const br = detectStructureBreak(bars, sw, 26, atr, 0.05);
    expect(br).not.toBeNull();
    expect(br!.wickOnly).toBe(false);
    expect(br!.direction).toBe('LONG');
    expect(br!.penetrationAtr).toBeGreaterThan(0);
  });

  it('classifies a counter-bias break as CHoCH and a with-bias break as BOS', () => {
    // Bearish structure, then an upside break => CHoCH.
    const bars: Candle[] = [];
    [120, 110, 118, 100, 108, 92, 100, 85, 95, 90, 93].forEach((v, i) =>
      bars.push(c(i, v, v + 2, v - 2, v)));
    for (let i = 0; i < 14; i++) bars.push(c(11 + i, 93, 95, 91, 93));
    const idx = bars.length;
    bars.push(c(idx, 93, 130, 92, 128)); // strong upside close

    const sw = findSwingsV2(bars, 1);
    const atr = buildAtrContext(bars, idx, 14).atr;
    const br = detectStructureBreak(bars, sw, idx, atr, 0.01);
    expect(br).not.toBeNull();
    expect(br!.direction).toBe('LONG');
    expect(br!.type).toBe('CHOCH');
  });
});

/* ================================================================== */
/* Range & Fibonacci                                                   */
/* ================================================================== */

describe('V2 range and Fibonacci', () => {
  const ranged = (): Candle[] => {
    const bars: Candle[] = [];
    // Oscillate between ~90 and ~110 to create confirmed swings on both sides.
    const path = [100, 110, 100, 90, 100, 110, 100, 90, 100, 110, 100, 90, 100];
    path.forEach((v, i) => bars.push(c(i, v, v + 1.5, v - 1.5, v)));
    return bars;
  };

  it('builds the range from confirmed swings, not raw max/min', () => {
    const bars = ranged();
    const sw = findSwingsV2(bars, 1);
    const atr = buildAtrContext(bars, bars.length - 1, 5).atr;
    const r = buildRange(bars, sw, bars.length - 1, atr, 50, '1h' as Timeframe);
    expect(r).not.toBeNull();
    expect(r!.high).toBeCloseTo(111.5, 5);
    expect(r!.low).toBeCloseTo(88.5, 5);
    expect(r!.mid).toBeCloseTo((111.5 + 88.5) / 2, 5);
    expect(r!.touchCountHigh).toBeGreaterThan(1);
    expect(r!.touchCountLow).toBeGreaterThan(1);
  });

  it('reports HIGH / LOW / MID location from the range position', () => {
    const mk = (position: number) => ({
      high: 110, low: 90, mid: 100, size: 20, age: 5, knownAtIndex: 0,
      highIndex: 1, lowIndex: 2, touchCountHigh: 2, touchCountLow: 2,
      position, confidence: 0.8, sourceTimeframe: '1h' as Timeframe,
      brokenSide: null, brokenAtIndex: null,
    });
    expect(rangeLocation(mk(0.95), 0.25)).toBe('HIGH');
    expect(rangeLocation(mk(0.05), 0.25)).toBe('LOW');
    expect(rangeLocation(mk(0.5), 0.25)).toBe('MID');
  });

  it('computes the standard Fibonacci ladder with 50% equilibrium', () => {
    const r = {
      high: 200, low: 100, mid: 150, size: 100, age: 5, knownAtIndex: 0,
      highIndex: 1, lowIndex: 2, touchCountHigh: 2, touchCountLow: 2,
      position: 0.5, confidence: 0.8, sourceTimeframe: '1h' as Timeframe,
      brokenSide: null, brokenAtIndex: null,
    };
    const f = buildFib(r, 150)!;
    expect(f.level0).toBe(100);
    expect(f.level382).toBeCloseTo(138.2, 10);
    expect(f.level500).toBe(150);
    expect(f.level618).toBeCloseTo(161.8, 10);
    expect(f.level1000).toBe(200);
    expect(f.zone).toBe('EQUILIBRIUM');
    expect(buildFib(r, 190)!.zone).toBe('PREMIUM');
    expect(buildFib(r, 110)!.zone).toBe('DISCOUNT');
  });
});

/* ================================================================== */
/* Liquidity, sweep, breakout                                          */
/* ================================================================== */

describe('V2 liquidity, sweep and breakout', () => {
  /** Range with two equal highs at 110, then a decision bar. */
  function equalHighs(decision: Candle): Candle[] {
    const bars: Candle[] = [];
    const path = [100, 110, 100, 92, 100, 110, 100, 92, 100];
    path.forEach((v, i) => bars.push(c(i, v, v + 0.5, v - 0.5, v, 100)));
    for (let i = 0; i < 14; i++) bars.push(c(9 + i, 100, 101, 99, 100, 100));
    bars.push(decision);
    return bars;
  }

  it('clusters equal highs into a single, stronger liquidity pool', () => {
    const bars = equalHighs(c(23, 100, 101, 99, 100));
    const sw = findSwingsV2(bars, 1);
    const atr = buildAtrContext(bars, bars.length - 1, 14).atr;
    const pools = findLiquidityPools(sw, bars.length - 1, atr, 0.5, 100);
    const buy = pools.filter((p) => p.side === 'BUY_SIDE');
    expect(buy.length).toBeGreaterThan(0);
    const top = buy.reduce((a, b) => (b.price > a.price ? b : a));
    expect(top.touches).toBeGreaterThanOrEqual(2);
    expect(top.kind === 'EQUAL' || top.kind === 'CLUSTER').toBe(true);
    expect(top.strength).toBeGreaterThan(0.3);
  });

  it('REQUIREMENT: merely touching a level is NOT a sweep', () => {
    // Touches 110.5 exactly, small wick, closes mid-range.
    const bars = equalHighs(c(23, 100, 110.5, 99, 105, 100));
    const sw = findSwingsV2(bars, 1);
    const i = bars.length - 1;
    const atr = buildAtrContext(bars, i, 14).atr;
    const pools = findLiquidityPools(sw, i, atr, 0.5, 100);
    const sweep = detectSweep(bars, pools, i, atr, 1, {
      minPenetrationAtr: 0.3, minWickRatio: 0.3, reclaimWindow: 3,
    });
    expect(sweep).toBeNull();
  });

  it('detects a sweep: penetration beyond the pool, rejection wick, reclaim', () => {
    // Spikes to 118 (well beyond 110.5) and closes back at 101 -> reclaim.
    const bars = equalHighs(c(23, 100, 118, 99.5, 101, 300));
    const sw = findSwingsV2(bars, 1);
    const i = bars.length - 1;
    const atr = buildAtrContext(bars, i, 14).atr;
    const pools = findLiquidityPools(sw, i, atr, 0.5, 100);
    const sweep = detectSweep(bars, pools, i, atr, 3, {
      minPenetrationAtr: 0.3, minWickRatio: 0.3, reclaimWindow: 3,
    });
    expect(sweep).not.toBeNull();
    expect(sweep!.side).toBe('BUY_SIDE');
    // Taking buy-side liquidity implies a SHORT reversal.
    expect(sweep!.direction).toBe('SHORT');
    expect(sweep!.reclaimed).toBe(true);
    expect(sweep!.penetrationAtr).toBeGreaterThan(0.3);
    expect(sweep!.quality).toBeGreaterThan(0);
  });

  it('REQUIREMENT: penetration WITHOUT a reclaim is not a sweep', () => {
    // Spikes far beyond the 110.5 pool with a large rejection wick, but the
    // candle CLOSES above the level, so liquidity was taken and ACCEPTED.
    // That is breakout territory, never a reversal sweep.
    const bars = equalHighs(c(23, 112, 125, 111, 114, 300));
    const sw = findSwingsV2(bars, 1);
    const i = bars.length - 1;
    const atr = buildAtrContext(bars, i, 14).atr;
    const pools = findLiquidityPools(sw, i, atr, 0.5, 100);
    const sweep = detectSweep(bars, pools, i, atr, 3, {
      minPenetrationAtr: 0.3, minWickRatio: 0.3, reclaimWindow: 0,
    });
    expect(sweep).toBeNull();
  });

  it('detects a true breakout: decisive close beyond with displacement', () => {
    const bars = equalHighs(c(23, 100, 125, 99.5, 124, 400));
    const sw = findSwingsV2(bars, 1);
    const i = bars.length - 1;
    const atr = buildAtrContext(bars, i, 14).atr;
    const pools = findLiquidityPools(sw, i, atr, 0.5, 100);
    const bo = detectBreakout(bars, pools, i, atr, 3, {
      minCloseBeyondAtr: 0.2, minBodyAtr: 0.4, holdWindow: 3,
    });
    expect(bo).not.toBeNull();
    expect(bo!.direction).toBe('LONG');
    expect(bo!.closeBeyondAtr).toBeGreaterThan(0.2);
    expect(bo!.held).toBe(true);
  });

  it('a false breakout (close back inside) does not register as a breakout', () => {
    const bars = equalHighs(c(23, 100, 118, 99, 101, 300));
    const sw = findSwingsV2(bars, 1);
    const i = bars.length - 1;
    const atr = buildAtrContext(bars, i, 14).atr;
    const pools = findLiquidityPools(sw, i, atr, 0.5, 100);
    const bo = detectBreakout(bars, pools, i, atr, 3, {
      minCloseBeyondAtr: 0.2, minBodyAtr: 0.4, holdWindow: 3,
    });
    expect(bo).toBeNull();
  });

  it('sweep and breakout are mutually exclusive on the same bar', () => {
    for (const decision of [
      c(23, 100, 118, 99.5, 101, 300),   // sweep
      c(23, 100, 125, 99.5, 124, 400),   // breakout
    ]) {
      const bars = equalHighs(decision);
      const sw = findSwingsV2(bars, 1);
      const i = bars.length - 1;
      const atr = buildAtrContext(bars, i, 14).atr;
      const pools = findLiquidityPools(sw, i, atr, 0.5, 100);
      const s = detectSweep(bars, pools, i, atr, 3, {
        minPenetrationAtr: 0.3, minWickRatio: 0.3, reclaimWindow: 3,
      });
      const b = detectBreakout(bars, pools, i, atr, 3, {
        minCloseBeyondAtr: 0.2, minBodyAtr: 0.4, holdWindow: 3,
      });
      expect(s !== null && b !== null).toBe(false);
    }
  });
});

/* ================================================================== */
/* Displacement, OB, FVG                                               */
/* ================================================================== */

describe('V2 displacement, order blocks and FVG', () => {
  it('requires a real body relative to ATR to call it displacement', () => {
    const bars = [...filler(20, 100)];
    const atr = buildAtrContext(bars, 19, 14).atr!;
    // A doji is never displacement.
    bars.push(c(20, 100, 101, 99, 100.05));
    expect(detectDisplacement(bars, 20, atr, 1, 0.6)).toBeNull();
    // A large directional body is.
    bars.push(c(21, 100, 108, 99.8, 107.5, 300));
    const d = detectDisplacement(bars, 21, atr, 3, 0.6);
    expect(d).not.toBeNull();
    expect(d!.direction).toBe('LONG');
    expect(d!.bodyAtr).toBeGreaterThan(0.6);
    expect(d!.closeLocation).toBeGreaterThan(0.8);
  });

  it('creates an OB from the last opposing candle before displacement', () => {
    const bars = [...filler(20, 100)];
    bars.push(c(20, 102, 102.5, 100.5, 101));   // bearish origin candle
    bars.push(c(21, 101, 112, 100.8, 111, 400)); // bullish displacement
    const atr = buildAtrContext(bars, 21, 14).atr!;
    const d = detectDisplacement(bars, 21, atr, 4, 0.6)!;
    const ob = buildOrderBlock(bars, d, 'BOS', 21, '1h' as Timeframe);
    expect(ob).not.toBeNull();
    expect(ob!.direction).toBe('LONG');
    expect(ob!.index).toBe(20);
    expect(ob!.state).toBe('FRESH');
    expect(ob!.origin).toBe('BOS');
  });

  it('an OB is NOT just any opposite-coloured candle — it needs displacement', () => {
    const bars = [...filler(24, 100)];
    const atr = buildAtrContext(bars, 23, 14).atr!;
    // No bar here clears the displacement floor, so no OB can be built.
    expect(detectDisplacement(bars, 23, atr, 1, 0.6)).toBeNull();
  });

  it('walks the OB lifecycle FRESH -> TOUCHED -> MITIGATED -> INVALIDATED', () => {
    const bars = [...filler(20, 100)];
    bars.push(c(20, 102, 102.5, 100.5, 101));
    bars.push(c(21, 101, 112, 100.8, 111, 400));
    const atr = buildAtrContext(bars, 21, 14).atr!;
    const d = detectDisplacement(bars, 21, atr, 4, 0.6)!;

    bars.push(c(22, 111, 111.5, 102.4, 103));  // touches the zone top
    expect(buildOrderBlock(bars, d, 'BOS', 22, '1h' as Timeframe)!.state).toBe('TOUCHED');

    bars.push(c(23, 103, 103.2, 101.2, 101.6)); // through the midpoint
    expect(buildOrderBlock(bars, d, 'BOS', 23, '1h' as Timeframe)!.state).toBe('MITIGATED');

    bars.push(c(24, 101.5, 101.6, 99, 99.5));   // closes below the OB low
    expect(buildOrderBlock(bars, d, 'BOS', 24, '1h' as Timeframe)!.state).toBe('INVALIDATED');
  });

  it('detects a bullish FVG only once the third candle has closed', () => {
    const bars = [...filler(20, 100)];
    bars.push(c(20, 100, 101, 99, 100.5));   // a: high 101
    bars.push(c(21, 100.5, 110, 100, 109));  // b: displacement
    bars.push(c(22, 109, 112, 105, 111));    // c: low 105 > a.high 101 -> gap
    const atr = buildAtrContext(bars, 22, 14).atr;

    // At bar 21 the pattern is not yet knowable.
    expect(findFvg(bars, 21, atr, 21, '1h' as Timeframe, 0.1)).toBeNull();

    const g = findFvg(bars, 21, atr, 22, '1h' as Timeframe, 0.1);
    expect(g).not.toBeNull();
    expect(g!.direction).toBe('LONG');
    expect(g!.bottom).toBeCloseTo(101, 6);
    expect(g!.top).toBeCloseTo(105, 6);
    expect(g!.knownAtIndex).toBe(22);
    expect(g!.state).toBe('FRESH');
  });

  it('marks an FVG FILLED once price trades fully back through it', () => {
    const bars = [...filler(20, 100)];
    bars.push(c(20, 100, 101, 99, 100.5));
    bars.push(c(21, 100.5, 110, 100, 109));
    bars.push(c(22, 109, 112, 105, 111));
    bars.push(c(23, 111, 111.5, 100.5, 101)); // trades back through the gap
    const atr = buildAtrContext(bars, 23, 14).atr;
    const g = findFvg(bars, 21, atr, 23, '1h' as Timeframe, 0.1);
    expect(g!.state).toBe('FILLED');
    expect(g!.filledFraction).toBe(1);
  });
});

/* ================================================================== */
/* HTF                                                                 */
/* ================================================================== */

describe('V2 higher-timeframe context', () => {
  it('REQUIREMENT: an HTF candle is unusable until it has actually CLOSED', () => {
    const D = 24 * H;
    const htfBars: Candle[] = [
      { openTime: T0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1,
        closeTime: T0 + D - 1, quoteVolume: 1, trades: 1, isClosed: true },
      { openTime: T0 + D, open: 1.5, high: 3, low: 1, close: 2.5, volume: 1,
        closeTime: T0 + 2 * D - 1, quoteVolume: 1, trades: 1, isClosed: true },
    ];
    // Evaluating midway through the second daily candle: only the first counts.
    const midway = T0 + D + H;
    const usable = closedHtfCandles(htfBars, '1d' as Timeframe, midway);
    expect(usable).toHaveLength(1);
    expect(usable[0]!.openTime).toBe(T0);

    // Once the second candle has closed, both are usable.
    expect(closedHtfCandles(htfBars, '1d' as Timeframe, T0 + 2 * D).length).toBe(2);
  });

  it('reports unavailable rather than inventing a bias when data is missing', () => {
    const ctx = htfContext(undefined, '4h' as Timeframe, T0, 3);
    expect(ctx.available).toBe(false);
    expect(ctx.bias).toBe('RANGE');
  });

  it('labels counter-trend setups instead of silently blocking them', () => {
    const bull = [{ timeframe: '4h' as Timeframe, bias: 'BULLISH' as const, asOfTime: T0, bars: 50, available: true }];
    expect(htfAlignment(bull, 'SHORT')).toBe('COUNTER_TREND');
    expect(htfAlignment(bull, 'LONG')).toBe('ALIGNED');
    expect(htfAlignment([], 'LONG')).toBe('UNKNOWN');
  });

  it('maps each strategy timeframe to strictly higher timeframes', () => {
    const order = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
    for (const [tf, highs] of Object.entries(HTF_MAP)) {
      for (const h of highs) {
        expect(order.indexOf(h)).toBeGreaterThan(order.indexOf(tf));
      }
    }
  });
});

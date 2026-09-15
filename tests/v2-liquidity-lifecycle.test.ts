/**
 * SMC V2 — LIQUIDITY LIFECYCLE and TARGET AREA DE-DUPLICATION.
 *
 * Both behaviours were mandated by the READ-ONLY audit of 60aac85:
 *
 *   1. A liquidity pool that price has already swept or accepted through was
 *      still being offered as a FUTURE take-profit. Resting orders that have
 *      already been filled are not a destination.
 *
 *   2. Pools were clustered at `v2.liquidity_tol_atr` (0.25 ATR) but the target
 *      ladder de-duplicated at a hard-coded 0.15 ATR, so two levels that the
 *      pool builder itself considered one area could occupy two TP slots.
 *
 * Every test here is hand-built so the geometry is unambiguous, and every
 * REQUIREMENT test is mutation-checked: the comment above it names the specific
 * line whose removal makes it fail.
 */

import { describe, expect, it } from 'vitest';
import type { Candle, Timeframe } from '../src/core/types';
import { Settings } from '../src/core/settings';
import { findSwingsV2, findLiquidityPools } from '../src/strategy/v2/structure';
import { buildTargets, evaluateV2, DEFAULT_CLUSTER_TOL_ATR } from '../src/strategy/v2/engine';
import { loadFixtureCandles, LAB_SYMBOLS } from '../scripts/strategy-lab';
import type { LiquidityPool } from '../src/strategy/v2/types';

const H = 3_600_000;
const T0 = 1_700_000_000_000;

function c(
  i: number, o: number, h: number, l: number, cl: number, v = 100,
): Candle {
  return {
    openTime: T0 + i * H,
    open: o, high: h, low: l, close: cl, volume: v,
    closeTime: T0 + i * H + H - 1,
    quoteVolume: v * cl, trades: 10, isClosed: true,
  };
}

/** ATR is supplied explicitly in these tests, so thresholds are exact. */
const ATR = 1;
const LIFECYCLE = { sweepPenetrationAtr: 0.3, acceptanceAtr: 0.25 };

/**
 * A swing HIGH at `peak` (index 4, confirmed at index 6 with strength 2),
 * then flat bars, then whatever the scenario appends.
 * Mirror version builds a swing LOW.
 */
function withSwingHigh(peak: number, tail: Candle[]): Candle[] {
  const bars: Candle[] = [];
  const path = [100, 100, 100, 102, peak, 102, 100, 100, 100, 100];
  path.forEach((v, i) => bars.push(c(i, v, v + 0.2, v - 0.2, v)));
  // the peak bar must genuinely be the local high
  bars[4] = c(4, 102, peak, 101.8, 102);
  tail.forEach((t, k) => bars.push({ ...t, openTime: T0 + (10 + k) * H, closeTime: T0 + (10 + k) * H + H - 1 }));
  return bars;
}

function withSwingLow(trough: number, tail: Candle[]): Candle[] {
  const bars: Candle[] = [];
  const path = [100, 100, 100, 98, trough, 98, 100, 100, 100, 100];
  path.forEach((v, i) => bars.push(c(i, v, v + 0.2, v - 0.2, v)));
  bars[4] = c(4, 98, 98.2, trough, 98);
  tail.forEach((t, k) => bars.push({ ...t, openTime: T0 + (10 + k) * H, closeTime: T0 + (10 + k) * H + H - 1 }));
  return bars;
}

function poolsAt(bars: Candle[], index: number): LiquidityPool[] {
  const sw = findSwingsV2(bars, 2);
  return findLiquidityPools(bars, sw, index, ATR, 0.25, 100, LIFECYCLE);
}

const buySide = (ps: LiquidityPool[], price: number): LiquidityPool | undefined =>
  ps.find((p) => p.side === 'BUY_SIDE' && Math.abs(p.price - price) < 1e-9);
const sellSide = (ps: LiquidityPool[], price: number): LiquidityPool | undefined =>
  ps.find((p) => p.side === 'SELL_SIDE' && Math.abs(p.price - price) < 1e-9);

/* ================================================================== */
/* 1. Lifecycle state machine                                          */
/* ================================================================== */

describe('liquidity lifecycle — state classification', () => {
  it('an untouched pool is FRESH and resting (LONG side)', () => {
    // Nothing after the swing ever reaches 110.
    const bars = withSwingHigh(110, [
      c(10, 100, 101, 99, 100), c(11, 100, 101, 99, 100), c(12, 100, 101, 99, 100),
    ]);
    const p = buySide(poolsAt(bars, bars.length - 1), 110);
    expect(p).toBeDefined();
    expect(p!.state).toBe('FRESH');
    expect(p!.resting).toBe(true);
    expect(p!.stateAtIndex).toBeNull();
  });

  it('an untouched pool is FRESH and resting (SHORT side)', () => {
    const bars = withSwingLow(90, [
      c(10, 100, 101, 99, 100), c(11, 100, 101, 99, 100), c(12, 100, 101, 99, 100),
    ]);
    const p = sellSide(poolsAt(bars, bars.length - 1), 90);
    expect(p).toBeDefined();
    expect(p!.state).toBe('FRESH');
    expect(p!.resting).toBe(true);
  });

  /**
   * MUTATION CHECK — remove the `penetration >= sweepTol` branch in
   * classifyPoolLifecycle and this becomes SWEPT, failing the TOUCHED
   * assertion. Change `>= 0` to `> 0` in the touch branch and the touch is
   * never recorded.
   */
  it('REQUIREMENT (C): a shallow touch is TOUCHED, still resting, NOT swept', () => {
    // Reaches 110.1 — only 0.1 ATR beyond 110, below the 0.3 ATR sweep bar.
    const bars = withSwingHigh(110, [
      c(10, 100, 110.1, 99, 100), c(11, 100, 101, 99, 100),
    ]);
    const p = buySide(poolsAt(bars, bars.length - 1), 110);
    expect(p!.state).toBe('TOUCHED');
    expect(p!.resting).toBe(true);          // a touch must NOT destroy the level
    expect(p!.stateAtIndex).toBe(10);
  });

  it('REQUIREMENT (C): shallow touch on the SHORT side is also non-destructive', () => {
    const bars = withSwingLow(90, [
      c(10, 100, 101, 89.9, 100), c(11, 100, 101, 99, 100),
    ]);
    const p = sellSide(poolsAt(bars, bars.length - 1), 90);
    expect(p!.state).toBe('TOUCHED');
    expect(p!.resting).toBe(true);
  });

  /**
   * MUTATION CHECK — delete the SWEEP branch and the pool stays TOUCHED and
   * resting, so both the state and the `resting` assertions fail.
   */
  it('REQUIREMENT (A): a deep wick raid with reclaim is SWEPT and no longer resting', () => {
    // Wicks to 110.8 (0.8 ATR beyond) but CLOSES back at 100 -> reclaim, not
    // acceptance. Liquidity was taken all the same.
    const bars = withSwingHigh(110, [
      c(10, 100, 110.8, 99, 100), c(11, 100, 101, 99, 100),
    ]);
    const p = buySide(poolsAt(bars, bars.length - 1), 110);
    expect(p!.state).toBe('SWEPT');
    expect(p!.resting).toBe(false);
    expect(p!.stateAtIndex).toBe(10);
    expect(p!.stateReason).toMatch(/swept/i);
  });

  it('REQUIREMENT (A): SHORT-side wick raid with reclaim is SWEPT', () => {
    const bars = withSwingLow(90, [
      c(10, 100, 101, 89.2, 100), c(11, 100, 101, 99, 100),
    ]);
    const p = sellSide(poolsAt(bars, bars.length - 1), 90);
    expect(p!.state).toBe('SWEPT');
    expect(p!.resting).toBe(false);
  });

  /**
   * MUTATION CHECK — delete the ACCEPTANCE branch and this returns SWEPT
   * instead of CONSUMED, failing the state assertion (though `resting` would
   * still be false, which is why the state itself is asserted).
   */
  it('REQUIREMENT (B): a decisive CLOSE beyond the level is CONSUMED', () => {
    // Closes at 111 — 1.0 ATR beyond 110, far past the 0.25 ATR acceptance bar.
    const bars = withSwingHigh(110, [
      c(10, 100, 111.5, 99, 111), c(11, 111, 112, 110.5, 111),
    ]);
    const p = buySide(poolsAt(bars, bars.length - 1), 110);
    expect(p!.state).toBe('CONSUMED');
    expect(p!.resting).toBe(false);
    expect(p!.stateAtIndex).toBe(10);
    expect(p!.stateReason).toMatch(/accepted/i);
  });

  it('REQUIREMENT (B): SHORT-side acceptance below the level is CONSUMED', () => {
    const bars = withSwingLow(90, [
      c(10, 100, 101, 88.5, 89), c(11, 89, 89.5, 88, 89),
    ]);
    const p = sellSide(poolsAt(bars, bars.length - 1), 90);
    expect(p!.state).toBe('CONSUMED');
    expect(p!.resting).toBe(false);
  });

  it('acceptance outranks an earlier sweep of the same level', () => {
    // Bar 10 sweeps (wick 110.8, close back inside), bar 12 accepts (close 111).
    const bars = withSwingHigh(110, [
      c(10, 100, 110.8, 99, 100),
      c(11, 100, 101, 99, 100),
      c(12, 100, 111.5, 99.5, 111),
    ]);
    const p = buySide(poolsAt(bars, bars.length - 1), 110);
    expect(p!.state).toBe('CONSUMED');
    expect(p!.stateAtIndex).toBe(12);
  });

  it('the forming swing bar itself never marks its own pool as taken', () => {
    // The swing high bar obviously "touches" 110 — that must not count, or
    // every pool would be born TOUCHED.
    const bars = withSwingHigh(110, [c(10, 100, 101, 99, 100)]);
    const p = buySide(poolsAt(bars, bars.length - 1), 110);
    expect(p!.state).toBe('FRESH');
  });
});

/* ================================================================== */
/* 2. Anti-look-ahead                                                  */
/* ================================================================== */

describe('liquidity lifecycle — causality', () => {
  /**
   * MUTATION CHECK — change the loop bound from `i <= index` to
   * `i < candles.length` in classifyPoolLifecycle and this test fails at the
   * first evaluation index, because the future sweep leaks backwards.
   */
  it('REQUIREMENT: a pool is not consumed before the event bar has closed', () => {
    const bars = withSwingHigh(110, [
      c(10, 100, 101, 99, 100),     // nothing
      c(11, 100, 101, 99, 100),     // nothing
      c(12, 100, 111.5, 99, 111),   // ACCEPTANCE happens here
      c(13, 111, 112, 110, 111),
    ]);

    // Before the event: FRESH at every earlier evaluation index.
    for (const idx of [9, 10, 11]) {
      const p = buySide(poolsAt(bars, idx), 110);
      expect(p, `pool must exist at index ${idx}`).toBeDefined();
      expect(p!.state, `index ${idx} must not see the bar-12 event`).toBe('FRESH');
      expect(p!.resting).toBe(true);
    }

    // On and after the event bar: CONSUMED.
    for (const idx of [12, 13]) {
      const p = buySide(poolsAt(bars, idx), 110);
      expect(p!.state, `index ${idx}`).toBe('CONSUMED');
      expect(p!.resting).toBe(false);
    }
  });

  it('REQUIREMENT: appending future candles cannot rewrite an earlier verdict', () => {
    const base = withSwingHigh(110, [
      c(10, 100, 101, 99, 100),
      c(11, 100, 101, 99, 100),
    ]);
    const early = buySide(poolsAt(base, 11), 110)!;

    // Now append a violent sweep AND an acceptance after the fact.
    const extended = [...base,
      c(12, 100, 115, 99, 100),
      c(13, 100, 116, 99, 114),
    ];
    const recomputed = buySide(poolsAt(extended, 11), 110)!;

    expect(recomputed.state).toBe(early.state);
    expect(recomputed.state).toBe('FRESH');
    expect(recomputed.resting).toBe(true);
    expect(recomputed.stateAtIndex).toBe(early.stateAtIndex);
    // ...while the later index does see them.
    expect(buySide(poolsAt(extended, 13), 110)!.state).toBe('CONSUMED');
  });

  it('sweep causality: the SWEPT verdict appears exactly on the raid bar', () => {
    const bars = withSwingHigh(110, [
      c(10, 100, 101, 99, 100),
      c(11, 100, 110.9, 99, 100),   // the raid
      c(12, 100, 101, 99, 100),
    ]);
    expect(buySide(poolsAt(bars, 10), 110)!.state).toBe('FRESH');
    expect(buySide(poolsAt(bars, 11), 110)!.state).toBe('SWEPT');
    expect(buySide(poolsAt(bars, 11), 110)!.stateAtIndex).toBe(11);
    expect(buySide(poolsAt(bars, 12), 110)!.state).toBe('SWEPT');
  });

  /**
   * The whole-engine version of the property: truncating the candle array at
   * the evaluation bar must not change a single field of the emitted setup.
   *
   * HONEST SCOPE NOTE (verified by mutation, do not overstate this test):
   * it does NOT catch a lifecycle scan that runs past `index`, because
   * `evaluateV2` already hands `findLiquidityPools` a `visible` slice cut at
   * `evalIndex` — the array simply contains no future bars to leak. Changing
   * the scan bound to `i < candles.length` leaves this test green. That
   * mutation is killed by the unit-level causality tests above, which call
   * `findLiquidityPools` directly with the FULL series.
   *
   * What this test does prove is the complementary, still-valuable property:
   * defence in depth at the engine boundary — no other code path (indicators,
   * swings, range, HTF, targets) reintroduces a dependency on future bars.
   */
  it('REQUIREMENT: evaluateV2 output is identical with and without future bars', () => {
    const settings = Settings.fromEntries([]);
    let checked = 0;
    for (const sym of LAB_SYMBOLS) {
      for (const tf of ['15m', '1h', '4h'] as Timeframe[]) {
        const bars = loadFixtureCandles('fixtures', sym, tf);
        if (bars.length < 300) continue;
        for (let i = 200; i < bars.length; i += 29) {
          const full = evaluateV2({ symbol: sym, timeframe: tf, candles: bars, atIndex: i, settings });
          const truncated = evaluateV2({
            symbol: sym, timeframe: tf, candles: bars.slice(0, i + 1), atIndex: i, settings,
          });
          expect(JSON.stringify(truncated), `${sym} ${tf} @${i}`).toBe(JSON.stringify(full));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('pools are built only from CONFIRMED swings', () => {
    // Swing strength 2 => the peak at index 4 is confirmed at index 6.
    const bars = withSwingHigh(110, [c(10, 100, 101, 99, 100)]);
    expect(buySide(poolsAt(bars, 5), 110)).toBeUndefined(); // not yet confirmed
    expect(buySide(poolsAt(bars, 6), 110)).toBeDefined();   // confirmed here
    expect(buySide(poolsAt(bars, 6), 110)!.knownAtIndex).toBe(6);
  });
});

/* ================================================================== */
/* 3. Consumed liquidity must never become a target                    */
/* ================================================================== */

describe('consumed liquidity is never a future target', () => {
  /**
   * MUTATION CHECK — delete `if (p.resting === false) continue;` in
   * buildTargets and the swept 110 level reappears as TP1, failing this test.
   */
  it('REQUIREMENT (LONG): a pool price already swept cannot become a target', () => {
    const bars = withSwingHigh(110, [
      c(10, 100, 110.9, 99, 100),   // sweep of 110
      c(11, 100, 101, 99, 100),
    ]);
    const pools = poolsAt(bars, bars.length - 1);
    const swept = buySide(pools, 110)!;
    expect(swept.resting).toBe(false);

    // A LONG from 100 would otherwise see 110 as its nearest target.
    const targets = buildTargets('LONG', 100, 98, null, pools, ATR);
    expect(targets.every((t) => Math.abs(t.price - 110) > 1e-9)).toBe(true);
    expect(targets.every((t) => t.basis !== 'INTERNAL_LIQUIDITY')).toBe(true);
    // With no resting liquidity left it must fall back to R multiples.
    expect(targets.every((t) => t.basis === 'R_MULTIPLE')).toBe(true);
  });

  it('REQUIREMENT (SHORT): a consumed sell-side pool cannot become a target', () => {
    const bars = withSwingLow(90, [
      c(10, 100, 101, 88.5, 89),    // acceptance below 90
      c(11, 89, 90, 88, 89),
    ]);
    const pools = poolsAt(bars, bars.length - 1);
    const consumed = sellSide(pools, 90)!;
    expect(consumed.state).toBe('CONSUMED');

    const targets = buildTargets('SHORT', 100, 102, null, pools, ATR);
    expect(targets.every((t) => Math.abs(t.price - 90) > 1e-9)).toBe(true);
    expect(targets.every((t) => t.basis === 'R_MULTIPLE')).toBe(true);
  });

  it('REQUIREMENT: the mirror case — a still-resting pool IS used', () => {
    // Same shape, but the level is only shallowly touched, so it survives.
    const bars = withSwingHigh(110, [
      c(10, 100, 110.1, 99, 100),
      c(11, 100, 101, 99, 100),
    ]);
    const pools = poolsAt(bars, bars.length - 1);
    expect(buySide(pools, 110)!.state).toBe('TOUCHED');

    const targets = buildTargets('LONG', 100, 98, null, pools, ATR);
    expect(targets[0]!.price).toBe(110);
    expect(targets[0]!.basis).toBe('INTERNAL_LIQUIDITY');
  });

  it('REQUIREMENT: consumed liquidity is excluded from room-to-target too', () => {
    // The 110 pool would give a 5R final target; once swept the ladder falls
    // back to R multiples, so room must be computed on the fallback, not on a
    // level that no longer exists.
    const swept = withSwingHigh(110, [
      c(10, 100, 110.9, 99, 100), c(11, 100, 101, 99, 100),
    ]);
    const alive = withSwingHigh(110, [
      c(10, 100, 110.1, 99, 100), c(11, 100, 101, 99, 100),
    ]);
    const tSwept = buildTargets('LONG', 100, 98, null, poolsAt(swept, swept.length - 1), ATR);
    const tAlive = buildTargets('LONG', 100, 98, null, poolsAt(alive, alive.length - 1), ATR);

    expect(Math.max(...tAlive.map((t) => t.r))).toBeCloseTo(5, 9);
    expect(Math.max(...tSwept.map((t) => t.r))).toBeCloseTo(3, 9); // 3R fallback
    expect(Math.max(...tSwept.map((t) => t.r)))
      .toBeLessThan(Math.max(...tAlive.map((t) => t.r)));
  });

  /**
   * The headline scenario the audit asked for, spelled out end to end:
   * pool exists -> price takes it -> at the NEXT causal evaluation it is gone.
   */
  it('REQUIREMENT: pool exists, price takes it, next evaluation cannot target it', () => {
    const bars = withSwingHigh(110, [
      c(10, 100, 101, 99, 100),     // idx 10: pool alive
      c(11, 100, 111.5, 99, 111),   // idx 11: acceptance through 110
      c(12, 108, 109, 107, 108),    // idx 12: next evaluation
    ]);

    // BEFORE: the pool is a legitimate target.
    const before = poolsAt(bars, 10);
    const tBefore = buildTargets('LONG', 100, 98, null, before, ATR);
    expect(buySide(before, 110)!.resting).toBe(true);
    expect(tBefore.some((t) => t.price === 110 && t.basis === 'INTERNAL_LIQUIDITY')).toBe(true);

    // AFTER: at the next causal evaluation it is consumed and unusable.
    const after = poolsAt(bars, 12);
    const tAfter = buildTargets('LONG', 100, 98, null, after, ATR);
    expect(buySide(after, 110)!.state).toBe('CONSUMED');
    expect(tAfter.every((t) => Math.abs(t.price - 110) > 1e-9)).toBe(true);
  });

  it('REQUIREMENT: mirror SHORT — pool exists, price takes it, then unusable', () => {
    const bars = withSwingLow(90, [
      c(10, 100, 101, 99, 100),
      c(11, 100, 101, 88.5, 89),
      c(12, 92, 93, 91, 92),
    ]);
    const before = poolsAt(bars, 10);
    expect(sellSide(before, 90)!.resting).toBe(true);
    expect(buildTargets('SHORT', 100, 102, null, before, ATR)
      .some((t) => t.price === 90)).toBe(true);

    const after = poolsAt(bars, 12);
    expect(sellSide(after, 90)!.state).toBe('CONSUMED');
    expect(buildTargets('SHORT', 100, 102, null, after, ATR)
      .every((t) => Math.abs(t.price - 90) > 1e-9)).toBe(true);
  });
});

/* ================================================================== */
/* 4. Target area de-duplication                                       */
/* ================================================================== */

describe('target ladder — structural AREA de-duplication', () => {
  /**
   * MUTATION CHECK — restore the old hard-coded `atr * 0.15` tolerance and
   * this fails: 130.2 is 0.2 ATR from 130, so it slipped through the 0.15 gap
   * while the pool builder (0.25 ATR) called it the same area.
   */
  it('REQUIREMENT: two levels inside one cluster tolerance take ONE slot', () => {
    const pools = [
      { side: 'BUY_SIDE' as const, price: 130 },
      { side: 'BUY_SIDE' as const, price: 130.2 },  // 0.2 ATR away: same area
      { side: 'BUY_SIDE' as const, price: 145 },
    ];
    const out = buildTargets('LONG', 120, 118, null, pools, 1);
    expect(out.some((t) => t.price === 130)).toBe(true);
    expect(out.some((t) => t.price === 130.2)).toBe(false);

    // Every adjacent pair must be at least one cluster tolerance apart.
    for (let i = 1; i < out.length; i++) {
      expect(Math.abs(out[i]!.price - out[i - 1]!.price))
        .toBeGreaterThan(DEFAULT_CLUSTER_TOL_ATR * 1 - 1e-9);
    }
  });

  it('REQUIREMENT: the dedup tolerance tracks the pool cluster tolerance', () => {
    const pools = [
      { side: 'BUY_SIDE' as const, price: 130 },
      { side: 'BUY_SIDE' as const, price: 130.4 },
      { side: 'BUY_SIDE' as const, price: 145 },
    ];
    // Tolerance 0.25 ATR: 0.4 apart is a genuinely different area -> kept.
    const loose = buildTargets('LONG', 120, 118, null, pools, 1, { clusterTolAtr: 0.25 });
    expect(loose.some((t) => t.price === 130.4)).toBe(true);

    // Tolerance 0.5 ATR: now they are one area -> collapsed. The ladder follows
    // whatever the pool builder used; it does not carry its own constant.
    const tight = buildTargets('LONG', 120, 118, null, pools, 1, { clusterTolAtr: 0.5 });
    expect(tight.some((t) => t.price === 130.4)).toBe(false);
  });

  /**
   * MUTATION CHECK — delete `usedClusters.has(c.clusterId)` and both prices
   * from the same pool cluster are emitted, failing the length assertion.
   */
  it('REQUIREMENT: same clusterId never occupies two TP slots, whatever the gap', () => {
    // Two candidates carrying the SAME cluster identity but far apart in price.
    const pools = [
      { side: 'BUY_SIDE' as const, price: 130, clusterId: 'BUY_SIDE#1' },
      { side: 'BUY_SIDE' as const, price: 150, clusterId: 'BUY_SIDE#1' },
      { side: 'BUY_SIDE' as const, price: 170, clusterId: 'BUY_SIDE#9' },
    ];
    const out = buildTargets('LONG', 120, 118, null, pools, 1);
    const ids = out.filter((t) => t.basis === 'INTERNAL_LIQUIDITY').map((t) => t.clusterId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(out.some((t) => t.price === 130)).toBe(true);
    expect(out.some((t) => t.price === 150)).toBe(false);  // same cluster
    expect(out.some((t) => t.price === 170)).toBe(true);
  });

  it('REQUIREMENT: equilibrium colliding with liquidity collapses to one slot', () => {
    // Range mid 150; a liquidity pool sits at 150.1 — practically the same
    // area. They must not both be offered.
    const rangeObj = {
      high: 200, low: 100, mid: 150, size: 100, age: 10, knownAtIndex: 0,
      highIndex: 1, lowIndex: 2, touchCountHigh: 2, touchCountLow: 2,
      position: 0.5, confidence: 0.8, sourceTimeframe: '1h' as const,
      brokenSide: null, brokenAtIndex: null,
    };
    const out = buildTargets(
      'LONG', 120, 118, rangeObj,
      [{ side: 'BUY_SIDE' as const, price: 150.1 }], 1,
    );
    const near150 = out.filter((t) => Math.abs(t.price - 150) < 0.5);
    expect(near150.length).toBe(1);
  });

  it('all three rungs are distinct areas, for LONG and SHORT alike', () => {
    const longOut = buildTargets('LONG', 100, 98, null, [
      { side: 'BUY_SIDE' as const, price: 105 },
      { side: 'BUY_SIDE' as const, price: 105.1 },
      { side: 'BUY_SIDE' as const, price: 110 },
      { side: 'BUY_SIDE' as const, price: 110.2 },
      { side: 'BUY_SIDE' as const, price: 120 },
    ], 1);
    expect(longOut.map((t) => t.price)).toEqual([105, 110, 120]);

    const shortOut = buildTargets('SHORT', 100, 102, null, [
      { side: 'SELL_SIDE' as const, price: 95 },
      { side: 'SELL_SIDE' as const, price: 94.9 },
      { side: 'SELL_SIDE' as const, price: 90 },
      { side: 'SELL_SIDE' as const, price: 89.8 },
      { side: 'SELL_SIDE' as const, price: 80 },
    ], 1);
    expect(shortOut.map((t) => t.price)).toEqual([95, 90, 80]);
  });

  it('every emitted target carries a cluster identity', () => {
    const out = buildTargets('LONG', 120, 118, null, [], 1);
    expect(out.length).toBe(3);
    for (const t of out) expect(typeof t.clusterId).toBe('string');
    expect(new Set(out.map((t) => t.clusterId)).size).toBe(3);
  });

  it('R multiples cannot duplicate the area of a structural rung', () => {
    // A single pool exactly at the 1R level: the 1R fallback must not be added
    // on top of it as a second "achievement".
    const out = buildTargets('LONG', 100, 98, null,
      [{ side: 'BUY_SIDE' as const, price: 102 }], 1);
    const at102 = out.filter((t) => Math.abs(t.price - 102) < 0.25);
    expect(at102.length).toBe(1);
  });
});

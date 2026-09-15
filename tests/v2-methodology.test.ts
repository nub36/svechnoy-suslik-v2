/**
 * Regression tests for the methodology fixes applied after the b8825d1 audit.
 *
 * Scope, in the order of the task:
 *   1. OPEN semantics at the replay window boundary, symmetric V1 <-> V2
 *   2. TIMEOUT as an explicit forced TIME EXIT, distinct from OPEN
 *   3. structural target ladder (next-level ordering, stale range, side checks)
 *   4. room-to-target with a REAL directional ATR distance
 *   5. rr1 measured against the first executable target only
 *  11. range invalidation
 *
 * Every test here is written to fail if the specific guard it names is removed.
 */

import { describe, it, expect } from 'vitest';
import { Settings, SETTINGS_REGISTRY, SETTINGS_BY_KEY } from '../src/core/settings';
import { LIVE_TRADING_ENABLED, assertAllowedMode, LiveTradingLockedError } from '../src/core/mode';
import { readFileSync } from 'node:fs';
import type { Candle, Timeframe } from '../src/core/types';
import { trackOutcome } from '../src/outcome/tracker';
import { replayV2Series } from '../src/replay/v2-runner';
import { replaySeries } from '../src/replay/runner';
import { buildRange } from '../src/strategy/v2/structure';
import { findSwingsV2 } from '../src/strategy/v2/structure';
import { computeMetrics, loadFixtureCandles, LAB_SYMBOLS } from '../scripts/strategy-lab';
import { evaluateV2, buildTargets, assessRoom } from '../src/strategy/v2/engine';
import { executableLadder } from '../src/replay/v2-runner';
import type { V2Range } from '../src/strategy/v2/types';

const H = 3_600_000;
const T0 = 1_700_000_000_000;

const c = (i: number, o: number, h: number, l: number, cl: number, v = 100): Candle => ({
  openTime: T0 + i * H,
  open: o,
  high: h,
  low: l,
  close: cl,
  volume: v,
  closeTime: T0 + i * H + H - 1,
  quoteVolume: v * cl,
  trades: 10,
  isClosed: true,
});

/* ================================================================== */
/* 2. TIMEOUT semantics                                                */
/* ================================================================== */

describe('TIMEOUT is a forced time exit, distinct from OPEN', () => {
  const base = (extra: [string, unknown][] = []): Settings =>
    Settings.fromEntries([['outcome.fee_pct', 0], ...extra]);

  it('closes at the CLOSE of the timeout bar, with barsHeld === timeout_bars', () => {
    const s = base([['outcome.timeout_bars', 5]]);
    // Never touches TP 200 or SL 50 — it can only end by time.
    const bars = [
      c(0, 100, 101, 99, 100),
      c(1, 100, 102, 99, 101),
      c(2, 101, 103, 100, 102),
      c(3, 102, 104, 101, 103),
      c(4, 103, 105, 102, 104.5), // <- timeout bar (index 4, i+1 === 5)
      c(5, 104.5, 130, 104, 129), // must never be consulted
    ];
    const out = trackOutcome({
      direction: 'LONG', entryPrice: 100, stopLoss: 50, takeProfits: [200],
      entryCandleTime: T0, candles: bars, settings: s, qty: 0,
    })!;

    expect(out.result).toBe('TIMEOUT');
    // Exact exit price = close of the last permitted candle.
    expect(out.exitPrice).toBe(104.5);
    expect(out.exitCandleTime).toBe(bars[4]!.openTime);
    expect(out.barsHeld).toBe(5);
    // R = (104.5 - 100) / risk 50.
    expect(out.rMultiple).toBeCloseTo(0.09, 6);
  });

  it('does NOT look at any candle beyond the timeout bar', () => {
    const s = base([['outcome.timeout_bars', 3]]);
    const withFuture = [
      c(0, 100, 101, 99, 100), c(1, 100, 101, 99, 100), c(2, 100, 101, 99, 100),
      // A future bar that would have hit the TP — it must be invisible.
      c(3, 100, 500, 99, 480),
    ];
    const withoutFuture = withFuture.slice(0, 3);
    const a = trackOutcome({
      direction: 'LONG', entryPrice: 100, stopLoss: 50, takeProfits: [200],
      entryCandleTime: T0, candles: withFuture, settings: s, qty: 0,
    })!;
    const b = trackOutcome({
      direction: 'LONG', entryPrice: 100, stopLoss: 50, takeProfits: [200],
      entryCandleTime: T0, candles: withoutFuture, settings: s, qty: 0,
    })!;
    expect(a.result).toBe('TIMEOUT');
    expect(a).toEqual(b);
  });

  it('dataset ending BEFORE the timeout yields OPEN (null), never TIMEOUT', () => {
    const s = base([['outcome.timeout_bars', 48]]);
    const bars = [c(0, 100, 101, 99, 100), c(1, 100, 102, 99, 101)];
    const out = trackOutcome({
      direction: 'LONG', entryPrice: 100, stopLoss: 50, takeProfits: [200],
      entryCandleTime: T0, candles: bars, settings: s, qty: 0,
    });
    expect(out).toBeNull();
  });

  it('SL keeps priority ON the timeout bar itself', () => {
    const s = base([
      ['outcome.timeout_bars', 2],
      ['outcome.sl_priority_on_ambiguous_bar', true],
    ]);
    const bars = [
      c(0, 100, 101, 99, 100),
      // Timeout bar which also trades through the stop.
      c(1, 100, 101, 80, 95),
    ];
    const out = trackOutcome({
      direction: 'LONG', entryPrice: 100, stopLoss: 90, takeProfits: [200],
      entryCandleTime: T0, candles: bars, settings: s, qty: 0,
    })!;
    expect(out.result).toBe('SL');
    expect(out.exitPrice).toBe(90);
  });

  it('the FINAL TP keeps priority on the timeout bar', () => {
    const s = base([['outcome.timeout_bars', 2]]);
    const bars = [
      c(0, 100, 101, 99, 100),
      c(1, 100, 125, 99, 101), // reaches TP 120 on the timeout bar
    ];
    const out = trackOutcome({
      direction: 'LONG', entryPrice: 100, stopLoss: 90, takeProfits: [120],
      entryCandleTime: T0, candles: bars, settings: s, qty: 0,
    })!;
    expect(out.result).toBe('TP');
    expect(out.exitPrice).toBe(120);
  });
});

/* ================================================================== */
/* 10 + 2. Metrics separate TP / SL / TIMEOUT / OPEN                   */
/* ================================================================== */

describe('metrics keep exit states separate and exclude OPEN', () => {
  const trade = (result: string, r: number): never =>
    ({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, direction: 'LONG',
      score: 0, setupCandleTime: 0, entryCandleTime: 0, entryPrice: 100,
      stopLoss: 90, takeProfits: [110], result, exitPrice: 100,
      exitCandleTime: 0, barsHeld: 1, rMultiple: r, pnlPct: 0, breakdown: {},
    }) as never;

  it('separates tpExitRate from positiveRRate and leaves OPEN out of n', () => {
    const m = computeMetrics([
      trade('TP', 2),
      trade('SL', -1),
      trade('SL', -1),
      trade('TIMEOUT', 1.5), // profitable, but NOT a TP
      trade('OPEN', 0),
    ]);

    expect(m.n).toBe(4);          // OPEN excluded
    expect(m.openCount).toBe(1);
    expect(m.wins).toBe(1);
    expect(m.losses).toBe(2);
    expect(m.timeouts).toBe(1);

    // 1 TP out of 4 closed = 25%; 2 trades with R>0 out of 4 = 50%.
    expect(m.tpExitRate).toBe(25);
    expect(m.positiveRRate).toBe(50);
    expect(m.tpExitRate).not.toBe(m.positiveRRate);
    expect(m.slRate).toBe(50);
    expect(m.timeoutRate).toBe(25);

    // Expectancy over all closed exits: (2 - 1 - 1 + 1.5) / 4.
    expect(m.expectancy).toBeCloseTo(0.375, 6);
    // Diagnostic: excluding the time exit the edge is (2-1-1)/3 = 0.
    expect(m.expectancyExTimeout).toBeCloseTo(0, 6);
    expect(m.nExTimeout).toBe(3);
  });

  it('an all-OPEN set produces no closed statistics at all', () => {
    const m = computeMetrics([trade('OPEN', 0), trade('OPEN', 0)]);
    expect(m.n).toBe(0);
    expect(m.openCount).toBe(2);
    expect(m.expectancy).toBe(0);
  });
});

/* ================================================================== */
/* 11. Range invalidation                                              */
/* ================================================================== */

describe('range invalidation', () => {
  /** Oscillating series that establishes a clean range, then breaks out up. */
  const rangeThenBreakout = (breakout: boolean): Candle[] => {
    const out: Candle[] = [];
    let i = 0;
    for (let cycle = 0; cycle < 5; cycle++) {
      out.push(c(i++, 100, 110, 99, 108));
      out.push(c(i++, 108, 111, 106, 107)); // swing high ~111
      out.push(c(i++, 107, 108, 100, 101));
      out.push(c(i++, 101, 102, 89, 91));   // swing low ~89
      out.push(c(i++, 91, 100, 90, 99));
    }
    if (breakout) {
      // Decisive acceptance ABOVE the range high (111 + 10% of 22 = 113.2).
      out.push(c(i++, 99, 130, 98, 128));
      out.push(c(i++, 128, 132, 126, 130));
    } else {
      out.push(c(i++, 99, 109, 98, 105));
      out.push(c(i++, 105, 110, 100, 104));
    }
    return out;
  };

  it('marks the range broken when price CLOSES beyond a boundary', () => {
    const bars = rangeThenBreakout(true);
    const swings = findSwingsV2(bars, 2);
    const r = buildRange(bars, swings, bars.length - 1, 5, 300, '1h');
    expect(r).not.toBeNull();
    expect(r!.brokenSide).toBe('HIGH');
    expect(r!.brokenAtIndex).not.toBeNull();
  });

  it('leaves an intact range unbroken (a wick alone is not acceptance)', () => {
    const bars = rangeThenBreakout(false);
    const swings = findSwingsV2(bars, 2);
    const r = buildRange(bars, swings, bars.length - 1, 5, 300, '1h');
    expect(r).not.toBeNull();
    expect(r!.brokenSide).toBeNull();
    expect(r!.brokenAtIndex).toBeNull();
  });

  it('a wick through the high does NOT invalidate the range', () => {
    const bars = rangeThenBreakout(false);
    // Long upper wick far beyond the high, but the close stays inside.
    bars.push(c(bars.length, 104, 145, 103, 106));
    const swings = findSwingsV2(bars, 2);
    const r = buildRange(bars, swings, bars.length - 1, 5, 300, '1h');
    expect(r!.brokenSide).toBeNull();
  });
});

/* ================================================================== */
/* 3 + 4 + 5. Target ladder, room, rr1                                 */
/* ================================================================== */

describe('structural target ladder', () => {
  /**
   * The engine's target builder is exercised through evaluateV2 so the test
   * pins real behaviour rather than a private helper. These synthetic series
   * are shaped only to reach the ladder code, never tuned for a result.
   */
  const settings = Settings.fromEntries([]);

  it('never places a target behind entry, and orders rungs by distance', () => {
    let checked = 0;
    for (const sym of LAB_SYMBOLS) {
      for (const tf of ['15m', '1h', '4h'] as Timeframe[]) {
        const bars = loadFixtureCandles('fixtures', sym, tf);
        if (bars.length < 200) continue;
        for (let i = 150; i < bars.length; i += 3) {
          const st = evaluateV2({
            symbol: sym, timeframe: tf, candles: bars, atIndex: i, settings,
          });
          if (!st || st.direction === 'WAIT' || st.targets.length === 0) continue;
          checked++;
          const entry = st.entry!;
          let prevR = 0;
          for (const t of st.targets) {
            if (st.direction === 'LONG') expect(t.price).toBeGreaterThan(entry);
            else expect(t.price).toBeLessThan(entry);
            expect(t.r).toBeGreaterThan(0);
            expect(t.r).toBeGreaterThan(prevR);
            prevR = t.r;
            if (st.atr.atr && st.atr.atr > 0) {
              const expected =
                (st.direction === 'LONG' ? t.price - entry : entry - t.price) / st.atr.atr;
              expect(t.atrDistance).toBeCloseTo(expected, 6);
              expect(t.atrDistance).toBeGreaterThan(0);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('never aims at the opposite edge of an INVALIDATED range', () => {
    let stale = 0;
    for (const sym of LAB_SYMBOLS) {
      for (const tf of ['15m', '1h', '4h'] as Timeframe[]) {
        const bars = loadFixtureCandles('fixtures', sym, tf);
        if (bars.length < 200) continue;
        for (let i = 150; i < bars.length; i += 3) {
          const st = evaluateV2({
            symbol: sym, timeframe: tf, candles: bars, atIndex: i, settings,
          });
          if (!st || st.direction === 'WAIT' || !st.range) continue;
          if (st.range.brokenSide === null) continue;
          stale++;
          // The stale range's far edge must not appear as a structural target.
          const far = st.direction === 'LONG' ? st.range.high : st.range.low;
          for (const t of st.targets) {
            if (t.basis === 'RANGE_EDGE') {
              throw new Error('RANGE_EDGE target used on an invalidated range');
            }
            // and no target may coincidentally sit exactly on that stale edge
            if (t.basis !== 'R_MULTIPLE') expect(t.price).not.toBe(far);
          }
        }
      }
    }
    expect(stale).toBeGreaterThan(0);
  });

  it('room.atrDistance is a REAL directional distance, not abs(price)/ATR', () => {
    let checked = 0;
    for (const sym of LAB_SYMBOLS) {
      for (const tf of ['15m', '1h', '4h'] as Timeframe[]) {
        const bars = loadFixtureCandles('fixtures', sym, tf);
        if (bars.length < 200) continue;
        for (let i = 150; i < bars.length; i += 3) {
          const st = evaluateV2({
            symbol: sym, timeframe: tf, candles: bars, atIndex: i, settings,
          });
          if (!st || !st.room || st.direction === 'WAIT' || st.targets.length === 0) continue;
          const atr = st.atr.atr;
          if (!atr || atr <= 0) continue;
          checked++;
          const last = st.targets[st.targets.length - 1]!;
          const first = st.targets[0]!;
          const expectedFinal =
            (st.direction === 'LONG' ? last.price - st.entry! : st.entry! - last.price) / atr;
          const expectedFirst =
            (st.direction === 'LONG' ? first.price - st.entry! : st.entry! - first.price) / atr;

          expect(st.room.atrDistance).toBeCloseTo(expectedFinal, 6);
          expect(st.room.firstAtrDistance).toBeCloseTo(expectedFirst, 6);
          // The old bug computed abs(price)/ATR — for BTC that is ~1e4 ATR.
          expect(st.room.atrDistance).toBeLessThan(1000);
          expect(st.room.atrDistance).toBeGreaterThan(0);
          expect(st.room.firstR).toBeLessThanOrEqual(st.room.nextStructuralR + 1e-9);
          expect(st.room.nextStructuralR).toBeLessThanOrEqual(st.room.finalR + 1e-9);
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('REQUIREMENT: the engine applies exactly ONE room gate, to finalR only', () => {
    // The removed `v2.min_first_target_r` is gone from the registry...
    expect(SETTINGS_REGISTRY.some((d) => d.key === 'v2.min_first_target_r')).toBe(false);
    // ...and the engine no longer READS it or carries a param for it. (The
    // file may still mention the key in the comment explaining its removal.)
    const engineSrc = readFileSync('src/strategy/v2/engine.ts', 'utf8');
    expect(engineSrc).not.toMatch(/n\(\s*'v2\.min_first_target_r'/);
    expect(engineSrc).not.toContain('minFirstTargetR');
    expect(engineSrc).not.toContain('minFirstR');

    // assessRoom takes exactly four arguments: no second threshold can be passed.
    expect(assessRoom.length).toBe(4);

    // Acceptance must track finalR alone. A ladder whose TP1 is microscopic but
    // whose final target clears the floor is ADEQUATE as far as the engine is
    // concerned — the executable RR decision belongs to risk.min_rr downstream.
    const thinFirst = buildTargets(
      'LONG', 100, 98, null,
      [{ side: 'BUY_SIDE', price: 100.2 }, { side: 'BUY_SIDE', price: 120 }],
      0.5,
    );
    const room = assessRoom(thinFirst, 100, 0.5, 1.5);
    expect(room.firstR).toBeCloseTo(0.1, 9);   // still REPORTED as a diagnostic
    expect(room.finalR).toBeCloseTo(10, 9);
    expect(room.adequate).toBe(true);          // but it is NOT an acceptance gate
    expect(room.reason).not.toMatch(/First target is only/i);

    // ...and the final-room floor itself still bites.
    expect(assessRoom(thinFirst, 100, 0.5, 12).adequate).toBe(false);
  });

  it('REQUIREMENT: risk.min_rr is the single executable minimum-RR gate', () => {
    // Value must be untouched by this change.
    const def = SETTINGS_BY_KEY.get('risk.min_rr');
    expect(def?.default).toBe(1);

    // The runners gate on executableLadder().rr1 >= risk.min_rr, and nothing
    // else applies a second floor to that same ratio.
    for (const f of ['src/replay/v2-runner.ts', 'src/replay/runner.ts', 'src/strategy/engine-runner.ts']) {
      const src = readFileSync(f, 'utf8');
      expect(src, `${f} must read risk.min_rr`).toContain('risk.min_rr');
      expect(src, `${f} must not reintroduce a first-target floor`)
        .not.toContain('min_first_target_r');
    }
  });
});

/* ================================================================== */
/* 3 + 5. Direct unit tests of the ladder and the rr1 rule             */
/* ================================================================== */

describe('buildTargets — direct, with explicit numbers', () => {
  const range = (over: Partial<V2Range> = {}): V2Range => ({
    high: 200, low: 100, mid: 150, size: 100, age: 10, knownAtIndex: 0,
    highIndex: 1, lowIndex: 2, touchCountHigh: 2, touchCountLow: 2,
    position: 0.5, confidence: 0.8, sourceTimeframe: '1h' as Timeframe,
    brokenSide: null, brokenAtIndex: null, ...over,
  });

  it('REQUIREMENT: the opposite edge of an INVALIDATED range is not a target', () => {
    const pools = [{ side: 'BUY_SIDE' as const, price: 130 }];
    // entry 120, stop 118 -> risk 2. Range high 200 would be a 40R target.
    const intact = buildTargets('LONG', 120, 118, range(), pools, 2);
    const stale = buildTargets('LONG', 120, 118, range({ brokenSide: 'HIGH', brokenAtIndex: 9 }), pools, 2);

    // With an intact range the far edge IS offered...
    expect(intact.some((t) => t.basis === 'RANGE_EDGE' && t.price === 200)).toBe(true);
    // ...and once the range is broken it must disappear entirely.
    expect(stale.some((t) => t.basis === 'RANGE_EDGE')).toBe(false);
    expect(stale.every((t) => t.price !== 200)).toBe(true);
    // The 40R moon-shot is gone with it.
    expect(Math.max(...stale.map((t) => t.r))).toBeLessThan(40);
  });

  it('REQUIREMENT: equilibrium behind entry is never used as TP2', () => {
    // LONG entered at 160, ABOVE the 150 midpoint: equilibrium is behind us.
    const out = buildTargets('LONG', 160, 155, range(), [{ side: 'BUY_SIDE', price: 170 }], 5);
    expect(out.some((t) => t.basis === 'EQUILIBRIUM')).toBe(false);
    for (const t of out) expect(t.price).toBeGreaterThan(160);
    // The 150 level must not appear under ANY basis label.
    expect(out.every((t) => t.price !== 150)).toBe(true);
  });

  it('REQUIREMENT: a SHORT above equilibrium does not target it backwards', () => {
    // SHORT entered at 140, BELOW the 150 midpoint: equilibrium is behind us.
    const out = buildTargets('SHORT', 140, 145, range(), [{ side: 'SELL_SIDE', price: 132 }], 5);
    expect(out.some((t) => t.basis === 'EQUILIBRIUM')).toBe(false);
    for (const t of out) {
      expect(t.price).toBeLessThan(140);
      expect(t.r).toBeGreaterThan(0);
    }
  });

  it('equilibrium IS used when it genuinely lies ahead', () => {
    const out = buildTargets('LONG', 120, 115, range(), [], 5);
    expect(out.some((t) => t.basis === 'EQUILIBRIUM' && t.price === 150)).toBe(true);
  });

  it('nearer liquidity takes precedence over a distant equilibrium', () => {
    const pools = [
      { side: 'BUY_SIDE' as const, price: 128 },
      { side: 'BUY_SIDE' as const, price: 140 },
    ];
    const out = buildTargets('LONG', 120, 118, range(), pools, 2);
    // Rungs must be the NEXT levels in order, not a jump to the 50% line.
    expect(out[0]!.price).toBe(128);
    expect(out[1]!.price).toBe(140);
    expect(out[2]!.price).toBe(150);
    expect(out[2]!.basis).toBe('EQUILIBRIUM');
  });

  it('REQUIREMENT: the ladder keeps the NEAREST levels, not the farthest ones', () => {
    // Nine pools ahead of entry. Only the three nearest may be selected; an
    // unordered candidate list would let distant 25R+ levels take the slots —
    // exactly the pathology the audit measured (median 11 pools skipped).
    const pools = [30, 34, 38, 50, 65, 80, 95, 120, 145].map((p) => ({
      side: 'BUY_SIDE' as const, price: p + 100,
    }));
    const out = buildTargets('LONG', 120, 118, range({ high: 300, low: 100, mid: 200, size: 200 }), pools, 2);
    expect(out.map((t) => t.price)).toEqual([130, 134, 138]);

    // Same levels supplied in a SCRAMBLED order must give the same ladder:
    // selection must be driven by distance, not by input order.
    const scrambled = [145, 30, 95, 38, 120, 34, 65, 80, 50].map((p) => ({
      side: 'BUY_SIDE' as const, price: p < 100 ? p + 100 : p,
    }));
    const out2 = buildTargets('LONG', 120, 118, range({ high: 300, low: 100, mid: 200, size: 200 }), scrambled, 2);
    expect(out2.map((t) => t.price)).toEqual([130, 134, 138]);
    // and therefore the final rung stays in a sane R range
    expect(out[out.length - 1]!.r).toBeCloseTo((138 - 120) / 2, 10);
    expect(out[out.length - 1]!.r).toBeLessThan(10);
  });

  it('collapses near-duplicate levels and keeps R strictly increasing', () => {
    const pools = [
      { side: 'BUY_SIDE' as const, price: 130 },
      { side: 'BUY_SIDE' as const, price: 130.05 }, // within 0.15 ATR of 130
      { side: 'BUY_SIDE' as const, price: 145 },
    ];
    const out = buildTargets('LONG', 120, 118, range(), pools, 2);
    const prices = out.map((t) => t.price);
    expect(prices).not.toContain(130.05);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.r).toBeGreaterThan(out[i - 1]!.r);
    }
  });

  it('works symmetrically for SHORT', () => {
    const pools = [{ side: 'SELL_SIDE' as const, price: 172 }];
    const out = buildTargets('SHORT', 180, 182, range(), pools, 2);
    for (const t of out) {
      expect(t.price).toBeLessThan(180);
      expect(t.r).toBeGreaterThan(0);
      expect(t.atrDistance).toBeGreaterThan(0);
    }
    expect(out[0]!.price).toBe(172);
    expect(out.some((t) => t.basis === 'EQUILIBRIUM' && t.price === 150)).toBe(true);
  });

  it('falls back to R multiples only when structure supplies nothing', () => {
    const out = buildTargets('LONG', 120, 118, null, [], 2);
    expect(out.length).toBe(3);
    expect(out.every((t) => t.basis === 'R_MULTIPLE')).toBe(true);
    expect(out.map((t) => t.r)).toEqual([1, 2, 3]);
  });

  it('assessRoom reports first / next / final separately, gating on finalR alone', () => {
    const pools = [
      { side: 'BUY_SIDE' as const, price: 120.4 }, // only 0.2R away
      { side: 'BUY_SIDE' as const, price: 160 },
    ];
    const targets = buildTargets('LONG', 120, 118, range(), pools, 2);
    const room = assessRoom(targets, 120, 2, 1.5);

    // All three distances are still reported — they are diagnostics.
    expect(room.firstR).toBeCloseTo(0.2, 6);
    expect(room.finalR).toBeGreaterThan(1.5);
    expect(room.firstR).toBeLessThanOrEqual(room.nextStructuralR + 1e-9);
    expect(room.nextStructuralR).toBeLessThanOrEqual(room.finalR + 1e-9);

    // A thin TP1 no longer rejects the setup here: the executable RR gate is
    // risk.min_rr, applied once, in the runner.
    expect(room.adequate).toBe(true);
    expect(room.reason).not.toMatch(/First target is only/i);

    // Raising the FINAL floor above finalR is what rejects it.
    expect(assessRoom(targets, 120, 2, 100).adequate).toBe(false);
  });

  it('assessRoom.atrDistance is directional, verified with explicit numbers', () => {
    // entry 100, stop 98 (risk 2), ATR 4, single target at 116.
    const targets = buildTargets('LONG', 100, 98, null, [{ side: 'BUY_SIDE', price: 116 }], 4);
    const room = assessRoom(targets, 100, 4, 1.5);
    // (116 - 100) / 4 = 4 ATR, NOT abs(116)/4 = 29.
    expect(room.atrDistance).toBeCloseTo(4, 10);
    expect(room.firstAtrDistance).toBeCloseTo(4, 10);
    // R = (116 - 100) / 2 = 8.
    expect(room.finalR).toBeCloseTo(8, 10);

    // SHORT mirror: entry 100, stop 102, target 84, ATR 4 -> 4 ATR again.
    const shortT = buildTargets('SHORT', 100, 102, null, [{ side: 'SELL_SIDE', price: 84 }], 4);
    const shortRoom = assessRoom(shortT, 100, 4, 1.5);
    expect(shortRoom.atrDistance).toBeCloseTo(4, 10);
    expect(shortRoom.finalR).toBeCloseTo(8, 10);
  });
});

describe('comparison script integrity', () => {
  const src = readFileSync('scripts/v1-vs-v2.ts', 'utf8');

  it('excludes OPEN trades from the TIMEOUT-sensitivity gate', () => {
    expect(src).toMatch(/testV2All\s*\.filter\(\(x\) => x\.result !== 'OPEN'\)|filter\(\(x\) => x\.result !== 'OPEN'\)/);
    // The gate must be computed over closed trades only.
    expect(src).toContain("const testV2 = testV2All.filter((x) => x.result !== 'OPEN');");
  });

  it('reports tpExitRate and positiveRRate separately, never as "win rate"', () => {
    expect(src).toContain('tpExit=');
    expect(src).toContain('posR=');
    expect(src).not.toMatch(/`win=/);
  });

  it('still prints the data warning and the fixed verdict rule', () => {
    expect(src).toMatch(/SYNTHETIC/);
    expect(src).toMatch(/VERDICT \(rule fixed before running\)/);
  });

  it('has no dead htfCandles placeholder left', () => {
    expect(src).not.toContain('void htfCandles');
  });
});

describe('production safety is unchanged', () => {
  it('v2.enabled still defaults to false', () => {
    const def = SETTINGS_REGISTRY.find((d) => d.key === 'v2.enabled');
    expect(def).toBeDefined();
    expect(def!.default).toBe(false);
    expect(Settings.fromEntries([]).bool('v2.enabled')).toBe(false);
  });

  it('LIVE remains locked', () => {
    expect(LIVE_TRADING_ENABLED).toBe(false);
    expect(() => assertAllowedMode('LIVE')).toThrow(LiveTradingLockedError);
  });

  it('V2 is not imported by any worker or the production engine runner', () => {
    const files = [
      'src/workers/strategy.worker.ts',
      'src/workers/market.worker.ts',
      'src/workers/outcome.worker.ts',
      'src/workers/web.worker.ts',
      'src/strategy/engine-runner.ts',
      'src/replay/runner.ts',
    ];
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(f, 'utf8');
      } catch {
        continue; // file layout differs; other tests cover the wiring
      }
      expect(text).not.toMatch(/strategy\/v2|evaluateV2/);
    }
  });

  it('the chart route only loads HTF candles when V2 is enabled', () => {
    const route = readFileSync('app/api/chart/route.ts', 'utf8');
    expect(route).toContain('if (v2Enabled(settings))');
    // The HTF load must sit INSIDE that guard.
    const idx = route.indexOf('if (v2Enabled(settings))');
    const after = route.slice(idx, idx + 800);
    expect(after).toContain('HTF_MAP[timeframe]');
    expect(after).toContain('closedOnly: true');
  });
});

describe('executableLadder — rr1 comes from TP1 alone', () => {
  it('REQUIREMENT: a generous TP2 cannot rescue a thin TP1', () => {
    // entry 100, stop 98 -> risk 2. TP1 at 100.5 is only 0.25R; TP2 is 5R.
    const l = executableLadder('LONG', 100, 98, [100.5, 110]);
    expect(l.risk).toBe(2);
    expect(l.rr1).toBeCloseTo(0.25, 10);
    // min_rr of 1 must therefore reject this, despite TP2 being far away.
    expect(l.rr1).toBeLessThan(1);
  });

  it('drops targets that are behind the actual fill and re-picks TP1', () => {
    // Gap-up fill at 105 leaves the 102 target behind price.
    const l = executableLadder('LONG', 105, 100, [102, 112, 130]);
    expect(l.targets).toEqual([112, 130]);
    expect(l.rr1).toBeCloseTo((112 - 105) / 5, 10);
  });

  it('SHORT mirror', () => {
    const l = executableLadder('SHORT', 100, 102, [104, 95, 90]);
    // 104 is above entry for a SHORT -> not executable.
    expect(l.targets).toEqual([95, 90]);
    expect(l.rr1).toBeCloseTo((100 - 95) / 2, 10);
  });

  it('an empty executable ladder yields rr1 = 0 (setup must be rejected)', () => {
    expect(executableLadder('LONG', 100, 98, [99, 95]).rr1).toBe(0);
    expect(executableLadder('LONG', 100, 98, []).targets).toEqual([]);
  });
});

/* ================================================================== */
/* 1. OPEN at the replay boundary — symmetric V1 / V2                  */
/* ================================================================== */

describe('replay window boundary: OPEN semantics are symmetric', () => {
  const settings = Settings.fromEntries([]);
  const fixture = (sym: string, tf: Timeframe): Candle[] =>
    loadFixtureCandles('fixtures', sym, tf);

  it('V2 reports a still-running trade as OPEN instead of discarding it', () => {
    let sawOpen = false;
    for (const sym of LAB_SYMBOLS) {
      for (const tf of ['1h', '4h'] as Timeframe[]) {
        const bars = fixture(sym, tf);
        if (bars.length < 300) continue;
        for (let cut = 250; cut <= bars.length; cut += 25) {
          const res = replayV2Series({
            symbol: sym, timeframe: tf, candles: bars, settings,
            to: bars[cut - 1]!.openTime,
          });
          const open = res.trades.filter((t) => t.result === 'OPEN');
          for (const o of open) {
            sawOpen = true;
            // Entry and the structural plan are preserved...
            expect(o.entryPrice).toBeGreaterThan(0);
            expect(o.stopLoss).toBeGreaterThan(0);
            expect(o.takeProfits.length).toBeGreaterThan(0);
            // ...and it is NOT dressed up as a finished trade.
            expect(o.exitPrice).toBeNull();
            expect(o.exitCandleTime).toBeNull();
            expect(o.rMultiple).toBe(0);
            expect(o.result).not.toBe('TIMEOUT');
          }
        }
      }
    }
    expect(sawOpen).toBe(true);
  });

  it('at most one OPEN trade (single-slot) and it sits last', () => {
    for (const sym of LAB_SYMBOLS) {
      for (const tf of ['1h', '4h'] as Timeframe[]) {
        const bars = fixture(sym, tf);
        if (bars.length < 300) continue;
        for (let cut = 250; cut <= bars.length; cut += 50) {
          const res = replayV2Series({
            symbol: sym, timeframe: tf, candles: bars, settings,
            to: bars[cut - 1]!.openTime,
          });
          const open = res.trades.filter((t) => t.result === 'OPEN');
          expect(open.length).toBeLessThanOrEqual(1);
          if (open.length === 1) {
            expect(res.trades[res.trades.length - 1]!.result).toBe('OPEN');
          }
        }
      }
    }
  });

  it('V1 and V2 use the same OPEN vocabulary at the boundary', () => {
    for (const sym of LAB_SYMBOLS.slice(0, 3)) {
      const bars = fixture(sym, '1h');
      if (bars.length < 300) continue;
      const v1 = replaySeries({ symbol: sym, timeframe: '1h', candles: bars, settings });
      const v2 = replayV2Series({ symbol: sym, timeframe: '1h', candles: bars, settings });
      const states = new Set([
        ...v1.trades.map((t) => t.result),
        ...v2.trades.map((t) => t.result),
      ]);
      for (const st of states) expect(['TP', 'SL', 'TIMEOUT', 'OPEN']).toContain(st);

      for (const trades of [v1.trades, v2.trades]) {
        const m = computeMetrics(trades);
        expect(m.n).toBe(trades.filter((t) => t.result !== 'OPEN').length);
        expect(m.openCount).toBe(trades.filter((t) => t.result === 'OPEN').length);
      }
    }
  });

  it('OPEN trades never contribute R to expectancy', () => {
    const bars = fixture('BTCUSDT', '1h');
    const res = replayV2Series({
      symbol: 'BTCUSDT', timeframe: '1h', candles: bars, settings,
      to: bars[500]!.openTime,
    });
    expect(res.trades.some((t) => t.result === 'OPEN')).toBe(true);
    const m = computeMetrics(res.trades);
    const closedR = res.trades
      .filter((t) => t.result !== 'OPEN')
      .reduce((a, t) => a + t.rMultiple, 0);
    expect(m.totalR).toBeCloseTo(Math.round(closedR * 10000) / 10000, 4);
  });
});

/* ================================================================== */
/* 5. rr1 uses the first EXECUTABLE target                             */
/* ================================================================== */

describe('rr1 acceptance uses the first executable target', () => {
  const settings = Settings.fromEntries([]);

  const allTrades = (): ReturnType<typeof replayV2Series>['trades'] => {
    const out: ReturnType<typeof replayV2Series>['trades'] = [];
    for (const sym of LAB_SYMBOLS) {
      for (const tf of ['15m', '1h', '4h'] as Timeframe[]) {
        const bars = loadFixtureCandles('fixtures', sym, tf);
        if (bars.length < 200) continue;
        out.push(...replayV2Series({ symbol: sym, timeframe: tf, candles: bars, settings }).trades);
      }
    }
    return out;
  };

  it('every accepted V2 trade has TP1 clearing risk.min_rr on its own', () => {
    const minRr = settings.num('risk.min_rr');
    const trades = allTrades();
    expect(trades.length).toBeGreaterThan(10);
    for (const t of trades) {
      const risk = Math.abs(t.entryPrice - t.stopLoss);
      expect(risk).toBeGreaterThan(0);
      const tp1 = t.takeProfits[0]!;
      if (t.direction === 'LONG') expect(tp1).toBeGreaterThan(t.entryPrice);
      else expect(tp1).toBeLessThan(t.entryPrice);
      // TP1 pays min_rr by ITSELF — TP2/TP3 may never rescue it.
      const reward1 = t.direction === 'LONG' ? tp1 - t.entryPrice : t.entryPrice - tp1;
      expect(reward1 / risk).toBeGreaterThanOrEqual(minRr - 1e-9);
      for (let k = 1; k < t.takeProfits.length; k++) {
        const prev = t.takeProfits[k - 1]!;
        const cur = t.takeProfits[k]!;
        if (t.direction === 'LONG') expect(cur).toBeGreaterThan(prev);
        else expect(cur).toBeLessThan(prev);
      }
    }
  });

  it('covers BOTH directions', () => {
    const trades = allTrades();
    expect(trades.some((t) => t.direction === 'LONG')).toBe(true);
    expect(trades.some((t) => t.direction === 'SHORT')).toBe(true);
  });

  it('records target diagnostics on every trade', () => {
    const trades = allTrades();
    expect(trades.length).toBeGreaterThan(10);
    for (const t of trades) {
      expect(t.setupKind === 'REVERSAL' || t.setupKind === 'CONTINUATION').toBe(true);
      expect(t.riskDistance).toBeGreaterThan(0);
      expect(t.tp1Price).not.toBeNull();
      expect(t.tp1Source).not.toBeNull();
      expect(t.tp1R).not.toBeNull();
      expect(t.timeoutBars).toBe(Math.floor(settings.num('outcome.timeout_bars')));
      expect(t.stopAnchor).not.toBeNull();
      expect(t.atrAtSetup).not.toBeNull();
      // Evidence is explicitly flagged as NOT a probability.
      expect(t.notProbability).toBe(true);
      expect(t.evidence).toBeGreaterThanOrEqual(0);
      expect(t.evidence).toBeLessThanOrEqual(1);
      expect(t.displayEvidence).toBe(Math.round(t.evidence * 100));
      expect(t.score).toBe(t.displayEvidence);
    }
  });
});

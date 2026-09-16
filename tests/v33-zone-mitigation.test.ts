/**
 * Tests for the V3.3 HTF Zone Mitigation & LTF Squeeze simulator.
 *
 * Research tooling only; the frozen strategy surface is untouched. These tests
 * pin (a) the preregistered constants, (b) that the zone definitions and the FVG
 * fill tracker agree with the FROZEN `src/` primitives, (c) the mitigation
 * tracker, (d) the trade-management rules, (e) the module hash and (f) all eight
 * published TRAIN artifacts — including the fragility that must not be lost.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findFvg, findSwingsV2 } from '../src/strategy/v2/structure';
import { closedHtfCandles } from '../src/strategy/v2/htf';
import { confirmedLevels } from '../research/v30_htf_trap';
import {
  CLOSE_BOTTOM_FRAC, CLOSE_TOP_FRAC, CORRIDOR_ATR_FRAC, CORRIDOR_EXPIRY_BARS,
  FVG_FILL_MIN, MAKER_BPS, MIN_RVOL, RECLAIM_BODY_MIN, STOP_BUFFER_ATR,
  TAKER_BPS, TIMEOUT_BARS, WICK_FRAC_MIN,
  absorption, advanceFill, bodyRatio, closePosition, confirmedSwingLevels,
  intersects, legFeeR, manageTrade, rejectionWick, trackZone,
} from '../research/v33_zone_mitigation';
import type { Candle, Timeframe } from '../src/core/types';

const H = 3_600_000;
const H4 = 4 * H;
const bar = (i: number, o: number, h: number, l: number, c: number, span = H): Candle => ({
  openTime: i * span, closeTime: i * span + span - 1, open: o, high: h, low: l, close: c,
  volume: 1000, isClosed: true,
} as Candle);

describe('preregistered constants', () => {
  it('match the specification exactly', () => {
    expect(MIN_RVOL).toBe(1.25);              // inclusive, and lower than V3.2's 2.2
    expect(WICK_FRAC_MIN).toBe(0.35);         // NOT V3.2's 0.40
    expect(RECLAIM_BODY_MIN).toBe(0.40);
    expect(CLOSE_TOP_FRAC).toBe(0.70);
    expect(CLOSE_BOTTOM_FRAC).toBe(0.30);
    expect(FVG_FILL_MIN).toBe(0.50);
    expect(CORRIDOR_ATR_FRAC).toBe(0.10);
    expect(CORRIDOR_EXPIRY_BARS).toBe(3);     // inherited convention (spec silent)
    expect(STOP_BUFFER_ATR).toBe(0.15);
    expect(TIMEOUT_BARS).toBe(48);
    expect(MAKER_BPS).toBe(2);
    expect(TAKER_BPS).toBe(5);
  });
});

describe('candle geometry', () => {
  const c = bar(1, 100, 110, 90, 105);
  it('bodyRatio, closePosition and rejectionWick', () => {
    expect(bodyRatio(c)).toBeCloseTo(0.25, 9);
    expect(closePosition(c)).toBeCloseTo(0.75, 9);
    expect(rejectionWick(c, 'LONG')).toBeCloseTo(0.5, 9);     // (100-90)/20
    expect(rejectionWick(c, 'SHORT')).toBeCloseTo(0.25, 9);   // (110-105)/20
  });
  it('returns 0 for a zero-range bar', () => {
    const flat = bar(1, 100, 100, 100, 100);
    expect(bodyRatio(flat)).toBe(0);
    expect(closePosition(flat)).toBe(0);
    expect(rejectionWick(flat, 'LONG')).toBe(0);
  });
  it('intersects is an INCLUSIVE range test (touching a boundary is an entry)', () => {
    const c = bar(1, 100, 101, 99, 100);
    expect(intersects(c, 99.5, 100.5)).toBe(true);   // inside
    expect(intersects(c, 99, 101)).toBe(true);       // exactly covered
    expect(intersects(c, 101, 102)).toBe(true);      // touching the high
    expect(intersects(c, 101.5, 102)).toBe(false);   // clearly above
    expect(intersects(c, 96, 98.5)).toBe(false);     // clearly below
  });
});

/* ---------------- FVG fill tracker vs the frozen implementation ---------------- */

describe('advanceFill reproduces the frozen findFvg fill fraction', () => {
  // 4H bars: flat, then a bullish 3-bar imbalance, then bars trading back into it.
  const h4: Candle[] = [
    bar(0, 100, 101, 99, 100, H4), bar(1, 100, 101, 99, 100, H4),
    bar(2, 100, 101, 99, 100, H4), bar(3, 103, 110, 102, 109, H4),
    bar(4, 109, 115, 108, 114, H4),                       // gap (101, 108)
    bar(5, 114, 116, 113, 115, H4), bar(6, 115, 117, 112, 114, H4),
    bar(7, 114, 115, 102, 104, H4),                       // trades deep into the gap
    bar(8, 104, 106, 99, 101, H4),                        // closes through it
    bar(9, 101, 103, 100, 102, H4),
  ];
  const atr = 2;
  const minSize = 0.15;
  const INDEX = 3;
  const gap = findFvg(h4, INDEX, atr, h4.length - 1, '4h' as Timeframe, minSize)!;

  it('finds the gap where the frozen implementation does', () => {
    expect(gap).toBeDefined();
    expect(gap.direction).toBe('LONG');
    expect(gap.bottom).toBeCloseTo(101, 9);
    expect(gap.top).toBeCloseTo(108, 9);
    expect(gap.knownAtIndex).toBe(INDEX + 1);
  });

  it('agrees bar by bar with the frozen filledFraction', () => {
    let mine = 0;
    // The frozen walk starts at index+2; feed my tracker the same bars.
    for (let e = INDEX + 2; e < h4.length; e++) {
      mine = advanceFill(h4[e]!, 'LONG', gap.bottom, gap.top, mine);
      const frozen = findFvg(h4, INDEX, atr, e, '4h' as Timeframe, minSize)!;
      expect(mine, `bar ${e}`).toBeCloseTo(frozen.filledFraction, 9);
      expect(mine >= 1 ? 'FILLED' : mine > 0.05 ? 'PARTIAL' : 'FRESH')
        .toBe(frozen.state);
    }
    expect(mine).toBe(1);
  });

  it('is causal: the fill never depends on bars after evalIndex', () => {
    let mine = 0;
    mine = advanceFill(h4[INDEX + 2]!, 'LONG', gap.bottom, gap.top, mine);
    const early = findFvg(h4.slice(0, INDEX + 3), INDEX, atr, INDEX + 2, '4h' as Timeframe, minSize)!;
    expect(mine).toBeCloseTo(early.filledFraction, 9);
  });
});

/* ---------------- mitigation tracking ---------------- */

describe('trackZone', () => {
  const zone = {
    id: 0, type: 'OB' as const, dir: 'LONG' as const,
    zoneLow: 99, zoneHigh: 101, knownAt4h: 0,
    legLow: 99, legHigh: 110, swingLegLow: null, swingLegHigh: null,
    strength: 0.5, origin: 'TEST',
  };
  const h1: Candle[] = [
    bar(0, 105, 106, 104, 105),      // above the zone
    bar(1, 105, 105.5, 100.5, 101),  // first touch -> mitigation
    bar(2, 101, 102, 100, 101),
    bar(3, 101, 101.5, 98.5, 99),    // closes inside, still alive
    bar(4, 99, 100, 96, 97),         // closes BELOW the far edge -> dead
    bar(5, 97, 98, 96, 97),
  ];
  const closed4hAt = new Int32Array(h1.length).fill(1);   // zone known from bar 0

  it('mitigates on the first touch and dies on the first close beyond the edge', () => {
    const w = trackZone(h1, zone, closed4hAt)!;
    expect(w.mitigationIndex).toBe(1);
    expect(w.deathIndex).toBe(4);
    expect(w.startIndex).toBe(0);
  });

  it('is not usable before its revealing 4H bar has closed', () => {
    const late = new Int32Array(h1.length).fill(0);
    late[3] = 1; late[4] = 1; late[5] = 1;
    const w = trackZone(h1, zone, late)!;
    expect(w.startIndex).toBe(3);
    expect(w.mitigationIndex).toBe(3);
    expect(w.deathIndex).toBe(4);
  });

  it('a zone that dies before it is ever touched yields no window', () => {
    const killed: Candle[] = [bar(0, 98, 99, 96, 97), bar(1, 97, 98, 96, 97)];
    expect(trackZone(killed, zone, new Int32Array(killed.length).fill(1))).toBeNull();
  });

  it('the bar that both mitigates and invalidates kills the zone (no window)', () => {
    const slice = [bar(130, 99.5, 100, 94, 95)];      // touches 99..101, closes 95
    slice[0]!.openTime = 130 * H; slice[0]!.closeTime = 130 * H + H - 1;
    expect(trackZone(slice, zone, new Int32Array(1).fill(1))).toBeNull();
  });

  it('FVG mitigation needs a 50 % fill, not just a touch', () => {
    const gap = { ...zone, type: 'FVG' as const, zoneLow: 100, zoneHigh: 110 };
    const slice = [
      bar(0, 112, 113, 111, 112),
      bar(1, 112, 112, 106, 107),   // overlap 106..110 of 100..110 = 40 % -> not yet
      bar(2, 107, 107, 104, 105),   // max overlap 40 % still
      bar(3, 105, 105, 103, 104),   // overlap 103..105 = 20 %? -> max stays 40 %
    ];
    const closed = new Int32Array(slice.length).fill(1);
    expect(trackZone(slice, gap, closed, FVG_FILL_MIN)).toBeNull();
    const deeper = [...slice, bar(4, 104, 104, 99, 100)];   // overlap 99..104 clipped to 100..104 = 40 %
    expect(deeper.length).toBe(5);
  });
});

/* ---------------- exhaustion trigger ---------------- */

describe('absorption', () => {
  it('accepts a 35 % lower wick for a LONG even on a down candle (literal reading)', () => {
    // range 10, lower wick = min(60,57)-54 = 3 -> 0.3 (too short)
    expect(absorption(bar(1, 60, 64, 54, 57), 'LONG')).toBeNull();
    // lower wick = min(60,58)-51 = 7 -> 0.7
    expect(absorption(bar(1, 60, 64, 51, 58), 'LONG')).toBe('WICK');
  });

  it('accepts a body reclaim closing in the outer 30 %', () => {
    // body 5.2/8 = 0.65, close position (63.2-56)/8 = 0.9
    expect(absorption(bar(1, 58, 64, 56, 63.2), 'LONG')).toBe('RECLAIM');
    // same body but closing mid-range -> neither branch (wick 2/8 = 0.25 < 0.35)
    expect(absorption(bar(1, 58, 64, 56, 60), 'LONG')).toBeNull();
  });

  it('a reclaim in the outer 30 % with body >= 0.40 is necessarily directional', () => {
    // A down candle cannot satisfy both: close >= low + 0.7R and body >= 0.4R
    // would require open > high.
    const c = bar(1, 70, 72, 60, 71);     // up candle, close 0.917, body 0.083
    expect(absorption(c, 'LONG')).toBe('WICK');   // wick only, body too small
  });

  it('mirrors for SHORT', () => {
    expect(absorption(bar(1, 60, 69, 56, 62), 'SHORT')).toBe('WICK');
    expect(absorption(bar(1, 62, 64, 56, 56.8), 'SHORT')).toBe('RECLAIM');
  });

  it('rejects a degenerate range', () => {
    expect(absorption(bar(1, 60, 60, 60, 60), 'LONG')).toBeNull();
  });
});

/* ---------------- trade management ---------------- */

describe('manageTrade — R1..R5', () => {
  const longAt = (bars: Candle[], tp1 = 101, tp2 = 104) =>
    manageTrade('LONG', 100, 99, tp1, tp2, bars);

  it('books a full -1R stop before TP1', () => {
    const r = longAt([bar(0, 100, 100.5, 97, 98)])!;
    expect(r.exit).toBe('SL');
    expect(r.grossR).toBeCloseTo(-1, 9);
  });

  it('R1: a bar hitting BOTH stop and TP1 books the stop', () => {
    expect(longAt([bar(0, 100, 102, 97, 100)])!.exit).toBe('SL');
  });

  it('TP1 books half at +1R, then TP2 the rest at +4R', () => {
    const r = longAt([bar(0, 100, 101.5, 100.2, 101), bar(1, 101, 104.5, 100.8, 104)])!;
    expect(r.exit).toBe('TP2');
    expect(r.grossR).toBeCloseTo(2.5, 9);
  });

  it('R2: TP1 and TP2 on one bar book in order', () => {
    expect(longAt([bar(0, 100, 105, 100.2, 104)])!.grossR).toBeCloseTo(2.5, 9);
  });

  it('R3: breakeven arms only AFTER the TP1 bar', () => {
    const r = longAt([bar(0, 100, 101.5, 100.2, 101), bar(1, 101, 101.2, 100, 100.4)])!;
    expect(r.exit).toBe('TP1_THEN_BE');
    expect(r.grossR).toBeCloseTo(0.5, 9);
  });

  it('R5: plain timeout at bar 48', () => {
    const bars: Candle[] = [];
    for (let i = 0; i < TIMEOUT_BARS + 3; i++) bars.push(bar(i, 100, 100.2, 99.8, 100));
    const r = longAt(bars)!;
    expect(r.exit).toBe('TIMEOUT');
    expect(r.barsHeld).toBe(TIMEOUT_BARS);
  });

  it('returns null on zero risk or no bars', () => {
    expect(manageTrade('LONG', 100, 100, 101, 104, [bar(0, 100, 101.5, 99.5, 101)])).toBeNull();
    expect(manageTrade('LONG', 100, 99, 101, 104, [])).toBeNull();
  });
});

describe('fee model', () => {
  it('charges three legs per leg notional', () => {
    const r = manageTrade('LONG', 100, 99, 101, 104,
      [bar(0, 100, 101.5, 100.2, 101), bar(1, 101, 104.5, 100.8, 104)])!;
    expect(r.feeR(MAKER_BPS, TAKER_BPS)).toBeCloseTo(
      legFeeR(100, 1, 2, 1) + legFeeR(101, 0.5, 5, 1) + legFeeR(104, 0.5, 5, 1), 9);
    expect(r.feeR(0, 0)).toBe(0);
  });
});

/* ---------------- TP2 levels vs the V3.0 helper ---------------- */

describe('confirmedSwingLevels equals V3.0 confirmedLevels', () => {
  // A zigzag 4H series so swings actually form.
  const h4: Candle[] = [];
  {
    let p = 100;
    for (let i = 0; i < 90; i++) {
      const up = i % 10 < 5;
      p += (up ? 1.5 : -1.2) + 0.25;
      h4.push(bar(i, p - 0.4, p + 0.6, p - 0.6, p, H4));
    }
  }
  const strength = 3;
  const swings = findSwingsV2(h4, strength);
  const levels = confirmedSwingLevels(h4, swings, strength);

  it('returns the same last confirmed high/low for every cutoff', () => {
    for (const k of [20, 35, 50, 61, 74, 90]) {
      const asOf = h4[k - 1]!.openTime + H4;      // the moment bar k-1 closed
      const ref = confirmedLevels(h4, asOf, strength);
      expect(levels.high[k], `high@${k}`).toBe(ref.swingHigh);
      expect(levels.low[k], `low@${k}`).toBe(ref.swingLow);
      // ...and the cutoff really does select exactly k closed bars.
      expect(closedHtfCandles(h4, '4h' as Timeframe, asOf).length).toBe(k);
    }
  });

  it('exposes an ordered swing leg only when the last two swings alternate', () => {
    for (let k = 0; k <= h4.length; k++) {
      const bull = levels.bullLeg[k];
      const bear = levels.bearLeg[k];
      if (bull) expect(bull.legHigh).toBeGreaterThan(bull.legLow);
      if (bear) expect(bear.legHigh).toBeGreaterThan(bear.legLow);
      expect(bull !== null && bear !== null).toBe(false);   // never both
    }
  });
});

/* ---------------- published artifacts ---------------- */

const DIR = 'artifacts/research/v33';
const load = (f: string): Record<string, any> =>
  JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8'));
const primary = load('v33-train-metrics-while-protective-displacement.json');
const all: [string, Record<string, any>][] = [
  ['while-protective-displacement', primary],
  ['while-protective-swing', load('v33-train-metrics-while-protective-swing.json')],
  ['while-climax-displacement', load('v33-train-metrics-while-climax-displacement.json')],
  ['while-climax-swing', load('v33-train-metrics-while-climax-swing.json')],
  ['first-protective-displacement', load('v33-train-metrics-first-protective-displacement.json')],
  ['first-protective-swing', load('v33-train-metrics-first-protective-swing.json')],
  ['first-climax-displacement', load('v33-train-metrics-first-climax-displacement.json')],
  ['first-climax-swing', load('v33-train-metrics-first-climax-swing.json')],
];

describe('TRAIN artifacts', () => {
  it('the primary is the preregistered while + protective + displacement cell', () => {
    expect(primary.strategy).toContain('V3.3');
    expect(primary.preregistration).toBe('docs/V3_3_HTF_ZONE_MITIGATION_PREREGISTRATION.md');
    expect(primary.amendment).toBe(
      'docs/V3_3_HTF_ZONE_MITIGATION_PREREGISTRATION_AMENDMENT_1.md');
    expect(primary.isPrimary).toBe(true);
    expect([primary.windowMode, primary.stopMode, primary.legMode])
      .toEqual(['while', 'protective', 'displacement']);
    expect(primary.slice).toBe('train');
    expect(primary.n).toBe(6957);
    expect(primary.tp1HitRatePct).toBe(65.24);
    expect(primary.tp2HitRatePct).toBe(12.43);
    expect(primary.feeDragR.FUT_4).toBe(0.0511);
    expect(primary.grossRPerTrade).toBe(0.0778);
    expect(primary.netRPerTrade.FUT_4).toBe(0.0267);
    expect(primary.profitFactor).toBe(1.2341);
    expect(primary.maxDrawdownR).toBe(-43.67);
    expect(primary.stopDistancePct.median).toBe(1.6953);
  });

  it('the primary passes all three preregistered criteria', () => {
    expect(primary.criterion.F1_netPositive.passed).toBe(true);
    expect(primary.criterion.F2_feeDrag.passed).toBe(true);
    expect(primary.criterion.F3_tp1Rate.passed).toBe(true);
    expect(primary.underpowered).toBe(false);
    // ...and nets out exactly as gross minus fee drag.
    expect(primary.netRPerTrade.FUT_4 - primary.grossRPerTrade)
      .toBeCloseTo(-primary.feeDragR.FUT_4, 4);
  });

  it('pins the fragility: without its best 1 % the primary is net-NEGATIVE', () => {
    // This is the single most important caveat of the whole result and must not
    // be lost when the report is read months later.
    expect(primary.outlierDependence.exTop1Pct).toBe(0.0264);
    expect(primary.outlierDependence.exTop1Pct)
      .toBeLessThan(primary.feeDragR.FUT_4);      // 0.0264 < 0.0511
    expect(primary.outlierDependence.removedForTop1Pct).toBe(70);
    expect(primary.outlierDependence.exTop1Pct - primary.feeDragR.FUT_4)
      .toBeLessThan(0);
  });

  it('is not concentrated: every symbol and both directions are positive gross', () => {
    const syms = Object.values(primary.bySymbol) as { n: number; grossExpectancy: number }[];
    expect(syms).toHaveLength(6);
    for (const s of syms) {
      expect(s.n).toBeGreaterThan(1000);
      expect(s.grossExpectancy).toBeGreaterThan(0);
    }
    expect(primary.byDirection.LONG.grossExpectancy).toBeGreaterThan(0);
    expect(primary.byDirection.SHORT.grossExpectancy).toBeGreaterThan(0);
  });

  it('records the funnel honestly, geometry rejections included', () => {
    expect(primary.funnel.zonesTotal).toBe(10665);
    expect(primary.funnel.triggersInZone).toBe(15957);
    expect(primary.funnel.filled).toBe(6957);
    // More than half the triggers never become trades: the corridor sits at or
    // beyond TP1 for them.
    expect(primary.funnel.rejected).toBe(8140);
    expect(primary.funnel.triggersWithTp1BehindClose).toBe(7762);
    expect(primary.funnel.multiZoneBars).toBe(8756);
    expect(primary.funnel.zonesSkippedByWarmup).toBe(0);
    expect(primary.zonesByType.OB).toBeGreaterThan(primary.zonesByType.FVG);
  });

  it('pins all eight cells: two of them FAIL F1 and they are both `first`+`protective`', () => {
    const table: Record<string, number> = {};
    for (const [name, a] of all) table[name] = a.netRPerTrade.FUT_4;
    expect(table['while-protective-displacement']).toBe(0.0267);
    expect(table['while-protective-swing']).toBe(0.0233);
    expect(table['while-climax-displacement']).toBe(0.1058);
    expect(table['while-climax-swing']).toBe(0.092);
    expect(table['first-protective-displacement']).toBe(-0.0253);
    expect(table['first-protective-swing']).toBe(-0.0343);
    expect(table['first-climax-displacement']).toBe(0.0612);
    expect(table['first-climax-swing']).toBe(0.1456);

    const failing = all.filter(([, a]) => !a.criterion.F1_netPositive.passed)
      .map(([name]) => name);
    expect(failing.sort()).toEqual(['first-protective-displacement', 'first-protective-swing']);
    // Seven of eight are powered; the strictest cell is tiny.
    expect(all.filter(([, a]) => a.underpowered).map(([n]) => n)).toEqual(['first-climax-swing']);
    expect(all.every(([, a]) => a.criterion.F2_feeDrag.passed)).toBe(true);
  });

  it('all eight runs stayed inside TRAIN and read no other timeframe', () => {
    for (const [name, a] of all) {
      expect(a.guards.candlesBeyondTrainRead, name).toBe(0);
      expect(a.guards.candles2026Read, name).toBe(0);
      expect(a.guards.hardTruncation, name).toContain('trainToMs');
      expect(a.guards.candlesIgnoredBeyondTrain, name).toBeGreaterThan(0);
      expect(a.guards.htfSeriesLoaded, name).toHaveLength(6);
      expect(a.guards.htfSeriesLoaded.every((s: string) => s.endsWith('-4h')), name).toBe(true);
      expect(a.frozenSurface.srcModified, name).toBe(false);
      expect(a.frozenSurface.displacementMinBodyAtr, name).toBe(0.6);
      expect(a.frozenSurface.fvgMinSizeAtr, name).toBe(0.15);
      expect(a.constants.MIN_RVOL, name).toBe(1.25);
      expect(a.constants.WICK_FRAC_MIN, name).toBe(0.35);
      expect(a.constants.TIMEOUT_BARS, name).toBe(48);
    }
  });

  it('was produced by this exact module version', () => {
    const sha = createHash('sha256')
      .update(readFileSync('research/v33_zone_mitigation.ts'))
      .digest('hex');
    expect(sha).toBe(V33_MODULE_SHA256);
  });
});

/**
 * sha256 of `research/v33_zone_mitigation.ts` at the time the artifacts were
 * produced. Any edit to the module invalidates both this pin and the numbers
 * above — the published figures must not outlive their code.
 */
export const V33_MODULE_SHA256 =
  '3f5b1478a1b0c240a85b28a0280d61761246091ca0ed122fab2e03113fe2b1c6';

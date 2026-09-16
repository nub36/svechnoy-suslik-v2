/**
 * Tests for the V3.2 HTF Volume Climax & Absorption simulator.
 *
 * Research tooling only; the frozen strategy surface is untouched. These tests
 * pin (a) the preregistered constants, (b) the cascade and absorption rules,
 * (c) the trade-management rules, (d) the module hash and (e) all four
 * published TRAIN artifacts — so a re-run that changes any of them cannot be
 * left stale in the repository.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLOSE_BOTTOM_FRAC, CLOSE_TOP_FRAC, CORRIDOR_ATR_FRAC, CORRIDOR_EXPIRY_BARS,
  EMA_TP1_PERIOD, ENGULF_BODY_MIN, EXPANSION_ATR_MULT, MAKER_BPS, MIN_RVOL,
  STOP_BUFFER_ATR, TAKER_BPS, TIMEOUT_BARS, WICK_FRAC_MIN,
  absorption, bodyRatio, closePosition, detectCascade, legFeeR, manageTrade,
} from '../research/v32_volume_climax';
import type { Candle } from '../src/core/types';

const H = 3_600_000;
const bar = (i: number, o: number, h: number, l: number, c: number, v = 100): Candle => ({
  openTime: i * H, closeTime: i * H + H - 1, open: o, high: h, low: l, close: c,
  volume: v, isClosed: true,
} as Candle);

describe('preregistered constants', () => {
  it('match the specification exactly', () => {
    expect(EXPANSION_ATR_MULT).toBe(2.0);
    expect(MIN_RVOL).toBe(2.2);            // inclusive, unlike V3.0/V3.1's strict >
    expect(WICK_FRAC_MIN).toBe(0.40);
    expect(ENGULF_BODY_MIN).toBe(0.40);
    expect(CLOSE_TOP_FRAC).toBe(0.70);
    expect(CLOSE_BOTTOM_FRAC).toBe(0.30);
    expect(EMA_TP1_PERIOD).toBe(50);
    expect(CORRIDOR_ATR_FRAC).toBe(0.10);
    expect(CORRIDOR_EXPIRY_BARS).toBe(3);  // inherited convention (spec silent)
    expect(STOP_BUFFER_ATR).toBe(0.15);
    expect(TIMEOUT_BARS).toBe(48);         // NOT V3.0's 50, NOT V3.1's 60
    expect(MAKER_BPS).toBe(2);
    expect(TAKER_BPS).toBe(5);
  });
});

describe('bodyRatio / closePosition', () => {
  it('are |close-open|/range and (close-low)/range', () => {
    const c = bar(1, 100, 110, 90, 105);
    expect(bodyRatio(c)).toBeCloseTo(0.25, 9);
    expect(closePosition(c)).toBeCloseTo(0.75, 9);
  });
  it('return 0 for a zero-range bar', () => {
    const flat = bar(1, 100, 100, 100, 100);
    expect(bodyRatio(flat)).toBe(0);
    expect(closePosition(flat)).toBe(0);
  });
});

/* ---------------- cascade detection ---------------- */

describe('detectCascade', () => {
  // 10 bars flat at 100, then a sharp fall to 90 over the last 3 bars.
  const build = (): Candle[] => {
    const out: Candle[] = [];
    for (let i = 0; i < 7; i++) out.push(bar(i, 100, 100.5, 99.5, 100));
    out.push(bar(7, 100, 100.2, 96, 96.5));
    out.push(bar(8, 96.5, 96.8, 92, 92.5));
    out.push(bar(9, 92.5, 93, 89.5, 90));
    return out;
  };
  const ATR = 2;   // 2 ATR = 4; the 3-bar drop is 10 (100 -> 90)

  it('reads a sharp fall as a DOWN cascade and invites a LONG fade', () => {
    const c = detectCascade(build(), 9, ATR, 'union')!;
    expect(c).toBeDefined();
    expect(c.dir).toBe('LONG');
    expect(c.terminal).toBeCloseTo(89.5, 9);      // lowest low of the window
    expect(c.origin).toBeCloseTo(100.5, 9);       // highest high of the window
    expect(c.moveAtr).toBeGreaterThanOrEqual(EXPANSION_ATR_MULT);
  });

  it('union takes the LARGEST qualifying k; fast3 only ever takes k = 3', () => {
    expect(detectCascade(build(), 9, ATR, 'union')!.k).toBe(6);
    expect(detectCascade(build(), 9, ATR, 'fast3')!.k).toBe(3);
  });

  it('measures expansion close-to-close against the ATR threshold (inclusive)', () => {
    const atEdge = detectCascade(build(), 9, 5, 'fast3');   // 10 / 5 = 2.0 exactly
    expect(atEdge, '2.0 x ATR must qualify').not.toBeNull();
    expect(detectCascade(build(), 9, 5.2, 'fast3')).toBeNull();
  });

  it('mirrors for an up cascade', () => {
    const up = build().map((c) => ({ ...c, open: 200 - c.open, close: 200 - c.close,
      high: 200 - c.low, low: 200 - c.high }));
    const c = detectCascade(up, 9, ATR, 'fast3')!;
    expect(c.dir).toBe('SHORT');
  });

  it('returns null when there is not enough history or the ATR is degenerate', () => {
    const bars = build();
    expect(detectCascade(bars, 2, ATR, 'union')).toBeNull();
    expect(detectCascade(bars, 9, 0, 'union')).toBeNull();
  });
});

/* ---------------- absorption signature ---------------- */

describe('absorption', () => {
  it('accepts a long lower wick on a bullish close', () => {
    // range 10, lower wick = 55-52 = 3... use: open 60 close 63 low 55 high 65
    // lower wick = 60-55 = 5, range 10 -> 0.5 >= 0.40
    expect(absorption(bar(1, 60, 65, 55, 63), undefined, 'LONG')).toBe('WICK');
  });

  it('rejects a long lower wick on a BEARISH close (direction requirement)', () => {
    // lower wick 5/10 = 0.5 but the candle closes down
    expect(absorption(bar(1, 63, 65, 55, 60), undefined, 'LONG')).toBeNull();
  });

  it('mirrors the wick branch for a SHORT fade', () => {
    expect(absorption(bar(1, 60, 65, 58, 59), undefined, 'SHORT')).toBe('WICK');
    expect(absorption(bar(1, 59, 65, 58, 64), undefined, 'SHORT')).toBeNull();
  });

  it('accepts a bullish body engulfing closing in the upper 30 %', () => {
    const prev = bar(0, 62, 62.5, 58, 59);      // bearish
    const cur = bar(1, 58.5, 64, 58.2, 63.5);   // bullish, engulfs 59..62, closes high
    expect(absorption(cur, prev, 'LONG')).toBe('ENGULF');
  });

  it('rejects an engulfing body that closes in the middle of the range', () => {
    const prev = bar(0, 62, 62.5, 58, 59);
    const cur = bar(1, 58.5, 66, 58.2, 59.5);   // engulfs, but closes low in range
    expect(absorption(cur, prev, 'LONG')).toBeNull();
  });

  it('rejects a degenerate zero-range bar', () => {
    expect(absorption(bar(1, 60, 60, 60, 60), undefined, 'LONG')).toBeNull();
  });
});

/* ---------------- trade management ---------------- */

describe('manageTrade — R1..R5', () => {
  // entry 100, stop 99 (risk = 1 R), TP1 101 (+1 R), TP2 104 (+4 R)
  const longAt = (bars: Candle[], tp1 = 101, tp2 = 104) =>
    manageTrade('LONG', 100, 99, tp1, tp2, bars);

  it('books a full -1R stop before TP1', () => {
    const r = longAt([bar(0, 100, 100.5, 97, 98)])!;
    expect(r.exit).toBe('SL');
    expect(r.grossR).toBeCloseTo(-1, 9);
  });

  it('R1: a bar hitting BOTH stop and TP1 books the stop', () => {
    const r = longAt([bar(0, 100, 102, 97, 100)])!;
    expect(r.exit).toBe('SL');
    expect(r.grossR).toBeCloseTo(-1, 9);
  });

  it('TP1 books half at +1R, then TP2 the rest at +4R', () => {
    const r = longAt([bar(0, 100, 101.5, 100.2, 101), bar(1, 101, 104.5, 100.8, 104)])!;
    expect(r.exit).toBe('TP2');
    expect(r.grossR).toBeCloseTo(2.5, 9);        // 0.5*1 + 0.5*4
    expect(r.hitTp1 && r.hitTp2).toBe(true);
  });

  it('R2: TP1 and TP2 on one bar book in order', () => {
    const r = longAt([bar(0, 100, 105, 100.2, 104)])!;
    expect(r.exit).toBe('TP2');
    expect(r.grossR).toBeCloseTo(2.5, 9);
  });

  it('R3: breakeven arms only AFTER the TP1 bar', () => {
    const r = longAt([bar(0, 100, 101.5, 100.2, 101), bar(1, 101, 101.2, 100, 100.4)])!;
    expect(r.exit).toBe('TP1_THEN_BE');
    expect(r.grossR).toBeCloseTo(0.5, 9);        // the TP1 half only
  });

  it('an unresolved trade at the dataset boundary returns null', () => {
    // TP1 on the last available bar: no bar left to resolve the remainder.
    expect(longAt([bar(0, 100, 101.5, 100.2, 101)])).toBeNull();
  });

  it('R5: plain timeout at bar 48 closes at market', () => {
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
  it('charges three legs for a TP1+TP2 trade, per leg on its own notional', () => {
    const r = manageTrade('LONG', 100, 99, 101, 104,
      [bar(0, 100, 101.5, 100.2, 101), bar(1, 101, 104.5, 100.8, 104)])!;
    expect(r.feeR(MAKER_BPS, TAKER_BPS)).toBeCloseTo(
      legFeeR(100, 1, 2, 1) + legFeeR(101, 0.5, 5, 1) + legFeeR(104, 0.5, 5, 1), 9);
  });
  it('is zero when the bps are zero', () => {
    const r = manageTrade('LONG', 100, 99, 101, 104,
      [bar(0, 100, 101.5, 100.2, 101), bar(1, 101, 104.5, 100.8, 104)])!;
    expect(r.feeR(0, 0)).toBe(0);
  });
});

/* ---------------- published artifacts ---------------- */

const art = JSON.parse(readFileSync(
  'artifacts/research/v32/v32-train-metrics.json', 'utf8')) as Record<string, any>;
const fast3 = JSON.parse(readFileSync(
  'artifacts/research/v32/v32-train-metrics-fast3.json', 'utf8')) as Record<string, any>;
const ema = JSON.parse(readFileSync(
  'artifacts/research/v32/v32-train-metrics-union-ema50.json', 'utf8')) as Record<string, any>;
const emaFast = JSON.parse(readFileSync(
  'artifacts/research/v32/v32-train-metrics-fast3-ema50.json', 'utf8')) as Record<string, any>;

describe('TRAIN artifacts', () => {
  it('the primary run is the preregistered union + 50 %-retracement variant', () => {
    expect(art.strategy).toContain('V3.2');
    expect(art.preregistration).toBe('docs/V3_2_VOLUME_CLIMAX_PREREGISTRATION.md');
    expect(art.isPrimary).toBe(true);
    expect(art.cascadeMode).toBe('union');
    expect(art.tp1Mode).toBe('cascade');
    expect(art.slice).toBe('train');
    expect(art.n).toBe(307);
    expect(art.tp1HitRatePct).toBe(60.59);       // the highest hit rate in the programme
    expect(art.tp2HitRatePct).toBe(15.64);
    expect(art.feeDragR.FUT_4).toBe(0.0538);
    expect(art.grossRPerTrade).toBe(-0.0082);    // break-even BEFORE fees
    expect(art.netRPerTrade.FUT_4).toBe(-0.062);
    expect(art.profitFactor).toBe(0.9791);
    expect(art.maxDrawdownR).toBe(-19.97);
    expect(art.stopDistancePct.median).toBe(1.5854);
  });

  it('the primary fails F1 and passes F2/F3 — a break-even edge that pays fees', () => {
    expect(art.criterion.F1_netPositive.passed).toBe(false);   // F1 FALSIFIED
    expect(art.criterion.F2_feeDrag.passed).toBe(true);
    expect(art.criterion.F3_tp1Rate.passed).toBe(true);        // premise confirmed
    expect(art.underpowered).toBe(false);
    // The whole story in one assertion: expectancy before costs is ~zero, so the
    // fee drag (-0.0538) is the entire loss.
    expect(Math.abs(art.grossRPerTrade)).toBeLessThan(0.02);
    expect(art.netRPerTrade.FUT_4 - art.grossRPerTrade).toBeCloseTo(
      -art.feeDragR.FUT_4, 4);
  });

  it('publishes the three sensitivity runs too', () => {
    expect(fast3).toMatchObject({ cascadeMode: 'fast3', tp1Mode: 'cascade', isPrimary: false, n: 158 });
    expect(fast3.netRPerTrade.FUT_4).toBe(-0.1126);
    expect(fast3.criterion.F1_netPositive.passed).toBe(false);

    expect(ema).toMatchObject({ cascadeMode: 'union', tp1Mode: 'ema50', n: 213 });
    expect(ema.grossRPerTrade).toBe(0.1104);
    expect(ema.netRPerTrade.FUT_4).toBe(0.053);              // F1 passes
    expect(ema.criterion.F1_netPositive.passed).toBe(true);
    expect(ema.criterion.F3_tp1Rate.passed).toBe(false);     // but the premise fails
    expect(ema.profitFactor).toBe(1.2061);

    expect(emaFast).toMatchObject({ cascadeMode: 'fast3', tp1Mode: 'ema50', n: 97 });
    expect(emaFast.underpowered).toBe(true);                 // n < 100
    expect(emaFast.netRPerTrade.FUT_4).toBe(0.0108);
    expect(emaFast.criterion.F3_tp1Rate.passed).toBe(false);
  });

  it('all four runs reject nothing outside TRAIN and load no other timeframe', () => {
    for (const a of [art, fast3, ema, emaFast]) {
      expect(a.guards.candlesBeyondTrainRead).toBe(0);
      expect(a.guards.candles2026Read).toBe(0);
      expect(a.guards.hardTruncation).toContain('trainToMs');
      expect(a.guards.candlesIgnoredBeyondTrain).toBeGreaterThan(0);
      expect(a.guards.htfSeriesLoaded).toEqual([]);
      expect(a.frozenSurface.srcModified).toBe(false);
      expect(a.constants).toMatchObject({
        EXPANSION_ATR_MULT: 2.0, MIN_RVOL: 2.2, WICK_FRAC_MIN: 0.4,
        TIMEOUT_BARS: 48, STOP_BUFFER_ATR: 0.15, MAKER_BPS: 2, TAKER_BPS: 5,
      });
    }
  });

  it('records which cascade window and which absorption branch actually fired', () => {
    expect(art.cascadeWindowUsed).toMatchObject({ '3': 3, '4': 14, '5': 20, '6': 317 });
    expect(art.absorption).toMatchObject({ WICK: 340, ENGULF: 11, 'WICK+ENGULF': 3 });
    expect(fast3.cascadeWindowUsed).toEqual({ '3': 189 });
    // The absorption filter, not the volume filter, does the selectivity work.
    expect(art.funnel.cascadesFailingAbsorption).toBeGreaterThan(
      art.funnel.cascadesWithVolume * 10);
  });

  it('was produced by this exact module version', () => {
    const sha = createHash('sha256')
      .update(readFileSync('research/v32_volume_climax.ts'))
      .digest('hex');
    expect(sha).toBe(V32_MODULE_SHA256);
  });
});

/**
 * sha256 of `research/v32_volume_climax.ts` at the time the artifacts were
 * produced. Any edit to the module invalidates both this pin and the numbers
 * above — which is the point: the published figures must not outlive their code.
 */
export const V32_MODULE_SHA256 =
  'c209b8d7ecf38940b910cc8de49608a0d8a849b75c9083f4492f691c08075bb6';

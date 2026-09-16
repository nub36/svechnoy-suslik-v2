/**
 * Tests for the V3.1 HTF Trend Pullback & Mitigation simulator.
 *
 * Research tooling only; the frozen strategy surface is untouched. These tests
 * pin (a) the preregistered constants, (b) the causality of the 4H context,
 * (c) the trade-management rules, (d) the module hash and (e) the published
 * TRAIN artifact — so a re-run that changes any of them cannot be left stale.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { closedHtfCandles } from '../src/strategy/v2/htf';
import { emaSeries } from '../src/strategy/v2/indicators';
import { findSwingsV2, structureBias } from '../src/strategy/v2/structure';
import {
  CORRIDOR_ATR_FRAC, CORRIDOR_EXPIRY_BARS, EMA_FAST, EMA_SLOW, MAKER_BPS,
  MIN_BODY_RATIO, MIN_RVOL, STOP_BUFFER_ATR, TAKER_BPS, TIMEOUT_BARS,
  TP2_FIB_EXT, bodyRatio, buildHtfContext, legFeeR, liveGaps, manageTrade,
  pullbackHit,
} from '../research/v31_trend_pullback';
import type { Candle, Timeframe } from '../src/core/types';

const H = 3_600_000;
const H4 = 4 * H;
const bar = (i: number, o: number, h: number, l: number, c: number, span = H): Candle => ({
  openTime: i * span, closeTime: i * span + span - 1, open: o, high: h, low: l,
  close: c, volume: 100, isClosed: true,
} as Candle);

const STRENGTH = 3;

/** Rising zigzag: peaks and troughs both strictly ascending, legs 6 bars long. */
function risingZigzag(n: number): { closes: number[]; highs: number[]; lows: number[] } {
  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const phase = i % 12;
    const dir = phase < 6 ? 1 : -1;          // up leg, then pullback leg
    p += dir * 1.2 + 0.35;                   // ...on a rising drift
    closes.push(p);
    highs.push(p + 0.3);
    lows.push(p - 0.3);
  }
  return { closes, highs, lows };
}

function series4h(n: number): Candle[] {
  const z = risingZigzag(n);
  return z.closes.map((c, i) => ({
    openTime: i * H4, closeTime: i * H4 + H4 - 1,
    open: z.closes[i - 1] ?? c, high: z.highs[i]!, low: z.lows[i]!, close: c,
    volume: 1000, isClosed: true,
  } as Candle));
}

function ctxOf(h4: Candle[]) {
  return buildHtfContext({
    h4,
    emaFast: emaSeries(h4.map((c) => c.close), EMA_FAST),
    emaSlow: emaSeries(h4.map((c) => c.close), EMA_SLOW),
    swings: findSwingsV2(h4, STRENGTH),
  });
}

describe('preregistered constants', () => {
  it('match the specification exactly', () => {
    expect(EMA_FAST).toBe(50);
    expect(EMA_SLOW).toBe(200);
    expect(MIN_BODY_RATIO).toBe(0.35);
    expect(MIN_RVOL).toBe(1.25);            // strictly greater, as in V3.0
    expect(CORRIDOR_ATR_FRAC).toBe(0.10);
    expect(CORRIDOR_EXPIRY_BARS).toBe(3);   // inherited convention (spec silent)
    expect(STOP_BUFFER_ATR).toBe(0.15);
    expect(TP2_FIB_EXT).toBe(1.5);
    expect(TIMEOUT_BARS).toBe(60);          // NOT V3.0's 50
    expect(MAKER_BPS).toBe(2);
    expect(TAKER_BPS).toBe(5);
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

/* ---------------- 4H trend gate ---------------- */

describe('buildHtfContext — trend gate and causality', () => {
  const h4 = series4h(260);
  const ctx = ctxOf(h4);

  it('produces no trend before EMA200 exists', () => {
    for (let k = 0; k < EMA_SLOW; k++) expect(ctx.trendByClosed[k]).toBeNull();
  });

  it('reads a rising zigzag as a LONG trend with an active up-leg', () => {
    const last = ctx.trendByClosed.filter(Boolean).at(-1)!;
    expect(last.dir).toBe('LONG');
    expect(last.legHigh).toBeGreaterThan(last.legLow);
  });

  it('agrees with the frozen structureBias on every closed-bar count', () => {
    // The incremental last-two-swing bookkeeping must equal the frozen helper.
    const swings = findSwingsV2(h4, STRENGTH);
    let worst = 0;
    for (let k = EMA_SLOW; k <= h4.length; k++) {
      const state = ctx.trendByClosed[k];
      const bias = structureBias(swings, k - 1);
      if (state) expect(bias).toBe(state.dir === 'LONG' ? 'BULLISH' : 'BEARISH');
      worst++;
    }
    expect(worst).toBeGreaterThan(50);
  });

  it('never uses a 4H bar that has not closed by the cutoff', () => {
    // Half-way through the series the context must be identical whether or not
    // the later bars exist at all — that is what "causal" means here.
    const cut = 210;
    const full = ctxOf(series4h(260)).trendByClosed[cut];
    const short = ctxOf(series4h(cut)).trendByClosed[cut];
    expect(short).toEqual(full);
  });

  it('counts closed 4H bars exactly as closedHtfCandles filters them', () => {
    const h4s = series4h(120);
    for (const t of [0, 5, 37, 61, 119]) {
      const closeTime = h4s[t]!.closeTime;
      const byFilter = closedHtfCandles(h4s, '4h' as Timeframe, closeTime).length;
      const byCount = h4s.filter((c) => c.openTime + H4 <= closeTime).length;
      expect(byCount).toBe(byFilter);
    }
  });
});

/* ---------------- fresh FVGs ---------------- */

describe('4H fair-value gaps', () => {
  it('is born only once its third candle has closed and dies on a later touch', () => {
    // bars: 0..2 flat, 3 = strong up (a=2, b=3, c=4) -> bullish gap above a.high
    // then bar 7 trades back into it, killing it from closed-count 8.
    const bars = [
      bar(0, 100, 101, 99, 100, H4), bar(1, 100, 101, 99, 100, H4),
      bar(2, 100, 101, 99, 100, H4), bar(3, 103, 110, 102, 109, H4),
      bar(4, 109, 115, 108, 114, H4),                       // c: gap (101, 108)
      bar(5, 114, 120, 113, 119, H4), bar(6, 119, 121, 117, 120, H4),
      bar(7, 118, 119, 100, 101, H4),                       // trades through the gap
      bar(8, 101, 106, 100, 105, H4),
    ];
    const ctx = buildHtfContext({
      h4: bars,
      emaFast: emaSeries(bars.map((c) => c.close), 2),
      emaSlow: emaSeries(bars.map((c) => c.close), 3),
      swings: findSwingsV2(bars, 1),
    });
    const gap = ctx.gaps.find((g) => g.dir === 'LONG' && g.top > 105)!;
    expect(gap).toBeDefined();
    expect(gap.bottom).toBeCloseTo(101, 9);
    expect(gap.top).toBeCloseTo(108, 9);
    expect(gap.knownAt).toBe(5);           // third candle index 4 has closed
    expect(liveGaps(ctx, 4, 'LONG').some((g) => g.top === gap.top)).toBe(false); // not yet known
    expect(liveGaps(ctx, 5, 'LONG').some((g) => g.top === gap.top)).toBe(true);  // known, fresh
    expect(liveGaps(ctx, 7, 'LONG').some((g) => g.top === gap.top)).toBe(true);  // bar 7 unclosed
    expect(liveGaps(ctx, 8, 'LONG').some((g) => g.top === gap.top)).toBe(false); // killed
  });
});

/* ---------------- pullback condition ---------------- */

describe('pullbackHit (same-bar variant)', () => {
  const trend = { dir: 'LONG' as const, legLow: 100, legHigh: 120 };   // eq = 110

  it('accepts a bar whose low reaches the equilibrium', () => {
    const hit = pullbackHit(bar(1, 113, 115, 109, 114), trend, []);
    expect(hit?.source).toBe('EQ');
  });

  it('rejects a bar that stays above the equilibrium', () => {
    expect(pullbackHit(bar(1, 113, 115, 111, 114), trend, [])).toBeNull();
  });

  it('accepts a bar touching a fresh gap even without reaching the equilibrium', () => {
    const gap = { dir: 'LONG' as const, top: 113, bottom: 112, knownAt: 0, killAt: 99 };
    const hit = pullbackHit(bar(1, 114, 115, 112.5, 114.5), trend, [gap]);
    expect(hit?.source).toBe('FVG');
  });

  it('rejects a pullback that invalidated the leg (close below the leg low)', () => {
    expect(pullbackHit(bar(1, 105, 106, 99, 99.5), trend, [])).toBeNull();
  });
});

/* ---------------- trade management ---------------- */

describe('manageTrade — R1..R5', () => {
  const longAt = (bars: Candle[], tp1 = 105, tp2 = 110) =>
    manageTrade('LONG', 100, 95, tp1, tp2, bars);

  it('books a full -1R stop before TP1', () => {
    const r = longAt([bar(0, 100, 101, 94, 95)])!;
    expect(r.exit).toBe('SL');
    expect(r.grossR).toBeCloseTo(-1, 9);
    expect(r.barsHeld).toBe(1);
  });

  it('R1: a bar hitting BOTH stop and TP1 books the stop', () => {
    const r = longAt([bar(0, 100, 106, 94, 100)])!;
    expect(r.exit).toBe('SL');
    expect(r.grossR).toBeCloseTo(-1, 9);
  });

  it('TP1 books half at +1R, then TP2 the rest at +2R', () => {
    const r = longAt([bar(0, 100, 106, 99, 105), bar(1, 105, 111, 104, 110)])!;
    expect(r.exit).toBe('TP2');
    expect(r.grossR).toBeCloseTo(1.5, 9);       // 0.5*1 + 0.5*2
    expect(r.hitTp1 && r.hitTp2).toBe(true);
  });

  it('R2: TP1 and TP2 on one bar book in order', () => {
    const r = longAt([bar(0, 100, 111, 99, 110)])!;
    expect(r.exit).toBe('TP2');
    expect(r.grossR).toBeCloseTo(1.5, 9);
  });

  it('R3: breakeven arms only AFTER the TP1 bar', () => {
    // TP1 at bar 0 (high 106 >= 105); bar 1 dips to the entry -> BE, not -1R.
    const r = longAt([bar(0, 100, 106, 99, 105), bar(1, 104, 104.5, 100, 101)])!;
    expect(r.exit).toBe('TP1_THEN_BE');
    expect(r.grossR).toBeCloseTo(0.5, 9);       // the TP1 half only
  });

  it('a stop on the TP1 bar itself is NOT yet breakeven', () => {
    const r = longAt([bar(0, 100, 106, 94, 95)])!;
    expect(r.exit).toBe('SL');                  // R1 wins on that bar
    expect(r.grossR).toBeCloseTo(-1, 9);
  });

  it('after TP1, a timeout closes the remainder at market', () => {
    const bars = [bar(0, 100, 106, 99, 105)];
    for (let i = 1; i < TIMEOUT_BARS; i++) bars.push(bar(i, 105, 105.2, 104.8, 105));
    const r = longAt(bars)!;
    expect(r.exit).toBe('TP1_THEN_TIMEOUT');
    expect(r.grossR).toBeCloseTo(1, 1);         // TP1 half at +1R, remainder at ~105
  });

  it('R5: plain timeout at bar 60 when nothing is hit', () => {
    const bars: Candle[] = [];
    for (let i = 0; i < TIMEOUT_BARS + 5; i++) bars.push(bar(i, 100, 100.2, 99.8, 100));
    const r = longAt(bars)!;
    expect(r.exit).toBe('TIMEOUT');
    expect(r.barsHeld).toBe(TIMEOUT_BARS);
    expect(r.grossR).toBeCloseTo(0, 9);
  });

  it('SHORT mirrors correctly', () => {
    const r = manageTrade('SHORT', 100, 105, 95, 90,
      [bar(0, 100, 101, 94, 95), bar(1, 95, 95.5, 89, 90)])!;
    expect(r.exit).toBe('TP2');
    expect(r.grossR).toBeCloseTo(1.5, 9);       // 0.5*1 + 0.5*2
  });

  it('returns null on zero risk or no bars', () => {
    expect(manageTrade('LONG', 100, 100, 105, 110, [bar(0, 100, 101, 99, 100)])).toBeNull();
    expect(manageTrade('LONG', 100, 95, 105, 110, [])).toBeNull();
  });
});

describe('fee model', () => {
  it('charges per leg on that leg notional', () => {
    // 2 bps on a 100-price notional with risk 10 = 0.002 R per unit weight.
    expect(legFeeR(100, 1, MAKER_BPS, 10)).toBeCloseTo(0.002, 9);
    expect(legFeeR(100, 0.5, TAKER_BPS, 10)).toBeCloseTo(0.0025, 9);
    expect(legFeeR(100, 1, 0, 10)).toBe(0);
  });

  it('charges three legs for a TP1+TP2 trade', () => {
    const r = manageTrade('LONG', 100, 95, 105, 110,
      [bar(0, 100, 106, 99, 105), bar(1, 105, 111, 104, 110)])!;
    // entry maker 2 bps (100), TP1 taker 5 bps (105, half), TP2 taker 5 bps (110, half)
    expect(r.feeR(MAKER_BPS, TAKER_BPS)).toBeCloseTo(
      legFeeR(100, 1, 2, 5) + legFeeR(105, 0.5, 5, 5) + legFeeR(110, 0.5, 5, 5), 9);
  });
});

/* ---------------- published artifact ---------------- */

describe('TRAIN artifact', () => {
  const art = JSON.parse(readFileSync(
    'artifacts/research/v31/v31-train-metrics.json', 'utf8')) as Record<string, any>;
  const sb = JSON.parse(readFileSync(
    'artifacts/research/v31/v31-train-metrics-samebar.json', 'utf8')) as Record<string, any>;

  it('is the primary `leg` variant and publishes the preregistered figures', () => {
    expect(art.strategy).toContain('V3.1');
    expect(art.preregistration).toBe('docs/V3_1_HTF_TREND_PULLBACK_PREREGISTRATION.md');
    expect(art.pullbackMode).toBe('leg');
    expect(art.slice).toBe('train');
    expect(art.n).toBe(158);
    expect(art.funnel).toMatchObject({ signals: 242, filled: 158, rejected: 84 });
    expect(art.tp1HitRatePct).toBe(48.1);
    expect(art.tp2HitRatePct).toBe(15.19);
    expect(art.grossRPerTrade).toBe(-0.0838);
    expect(art.netRPerTrade.FUT_4).toBe(-0.1097);
    expect(art.feeDragR.FUT_4).toBe(0.0258);
    expect(art.profitFactor).toBe(0.7873);
    expect(art.maxDrawdownR).toBe(-20.42);
    expect(art.stopDistancePct.median).toBe(3.4561);
  });

  it('records the falsification verdicts honestly', () => {
    expect(art.criterion.F1_netPositive.passed).toBe(false);   // F1 falsified
    expect(art.criterion.F2_feeDrag.passed).toBe(true);        // mechanism held
    expect(art.criterion.F3_tp1Rate.passed).toBe(true);
    expect(art.underpowered).toBe(false);
    expect(art.profitFactor).toBeLessThan(1);
    expect(art.grossRPerTrade).toBeLessThan(0);                // loses BEFORE fees
  });

  it('publishes the secondary same-bar variant too', () => {
    expect(sb.pullbackMode).toBe('same-bar');
    expect(sb.n).toBe(82);
    expect(sb.grossRPerTrade).toBe(-0.254);
    expect(sb.netRPerTrade.FUT_4).toBe(-0.2819);
    expect(sb.criterion.F1_netPositive.passed).toBe(false);
    expect(sb.criterion.F3_tp1Rate.passed).toBe(false);        // 31.71 % < 40 %
  });

  it('proves no VALIDATION or TEST candle was read', () => {
    for (const a of [art, sb]) {
      expect(a.guards.candlesBeyondTrainRead).toBe(0);
      expect(a.guards.candles2026Read).toBe(0);
      expect(a.guards.hardTruncation).toContain('trainToMs');
      expect(a.guards.candlesIgnoredBeyondTrain).toBeGreaterThan(0);
      expect(a.constants).toMatchObject({
        EMA_FAST: 50, EMA_SLOW: 200, MIN_RVOL: 1.25, TIMEOUT_BARS: 60,
        TP2_FIB_EXT: 1.5, MAKER_BPS: 2, TAKER_BPS: 5,
      });
      expect(a.frozenSurface.srcModified).toBe(false);
    }
  });

  it('was produced by this exact module version', () => {
    // The artifact is only meaningful for the file that produced it.
    const sha = createHash('sha256')
      .update(readFileSync('research/v31_trend_pullback.ts'))
      .digest('hex');
    expect(sha).toBe(V31_MODULE_SHA256);
  });
});

/**
 * sha256 of `research/v31_trend_pullback.ts` at the time the artifacts were
 * produced. Any edit to the module invalidates both this pin and the numbers
 * above — which is the point: the published figures must not outlive their code.
 */
export const V31_MODULE_SHA256 =
  '1f18bb3ce45bbc94d79f48181fde7ad9550731e5c031ac0bd54662b6804a3bc7';

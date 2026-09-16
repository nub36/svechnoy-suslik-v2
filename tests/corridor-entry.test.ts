/**
 * Tests required by docs/V2_1_CONFIRMED_EXTREME_CORRIDOR_PREREGISTRATION.md §9.
 *
 * Research tooling only — frozen strategy code is untouched.
 */

import { describe, it, expect } from 'vitest';
import {
  CONFLUENCE_MIN, CORRIDOR_MAX_PCT, EXPIRY_BARS, FEE_GUARD_ATR, FEE_GUARD_PCT,
  TICK_SIZE, buildCorridor, confirmedExtreme, confluence, feeGuardPasses,
} from '../scripts/real-data/corridor-entry';
import { replayCorridor, FULL_GATES, BASELINE_GATES } from '../scripts/real-data/corridor-replay';
import { Settings } from '../src/core/settings';
import type { V2Setup } from '../src/strategy/v2/types';
import type { Candle, Timeframe } from '../src/core/types';

const H = 3_600_000;
const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  openTime: i * H, closeTime: i * H + H - 1, open: o, high: h, low: l,
  close: c, volume: 100, isClosed: true,
} as Candle);

/* ---------------- confirmed extreme ---------------- */

const revBase = {
  direction: 'LONG' as const, kind: 'REVERSAL' as const,
  sweep: {
    direction: 'LONG', reclaimed: true, reclaimBars: 1,
    penetrationAtr: 0.2, wickRatio: 0.4, level: 100,
  },
  displacement: { direction: 'LONG', bodyAtr: 0.8 },
} as unknown as V2Setup;

describe('confirmed extreme — REVERSAL (sweep + reclaim + displacement)', () => {
  it('accepts a fully confirmed reversal', () => {
    expect(confirmedExtreme(revBase).confirmed).toBe(true);
  });
  it('rejects when the sweep was never reclaimed', () => {
    const s = { ...revBase, sweep: { ...(revBase as any).sweep, reclaimed: false } } as unknown as V2Setup;
    expect(confirmedExtreme(s)).toMatchObject({ confirmed: false, reason: 'not_reclaimed' });
  });
  it('rejects a slow reclaim (> 3 bars)', () => {
    const s = { ...revBase, sweep: { ...(revBase as any).sweep, reclaimBars: 4 } } as unknown as V2Setup;
    expect(confirmedExtreme(s)).toMatchObject({ confirmed: false, reason: 'reclaim_too_slow' });
  });
  it('rejects weak displacement', () => {
    const s = { ...revBase, displacement: { direction: 'LONG', bodyAtr: 0.3 } } as unknown as V2Setup;
    expect(confirmedExtreme(s)).toMatchObject({ confirmed: false, reason: 'weak_displacement' });
  });
  it('rejects a shallow penetration and a weak wick', () => {
    const shallow = { ...revBase, sweep: { ...(revBase as any).sweep, penetrationAtr: 0.01 } } as unknown as V2Setup;
    expect(confirmedExtreme(shallow).reason).toBe('shallow_penetration');
    const weak = { ...revBase, sweep: { ...(revBase as any).sweep, wickRatio: 0.05 } } as unknown as V2Setup;
    expect(confirmedExtreme(weak).reason).toBe('weak_rejection_wick');
  });
});

const contBase = {
  direction: 'SHORT' as const, kind: 'CONTINUATION' as const,
  breakout: {
    direction: 'SHORT', closeBeyondAtr: 0.4, bodyRatio: 0.7,
    held: true, holdBars: 2, immediateReclaim: false, level: 100,
  },
} as unknown as V2Setup;

describe('confirmed extreme — CONTINUATION (body close + hold)', () => {
  it('accepts a held body breakout', () => {
    expect(confirmedExtreme(contBase).confirmed).toBe(true);
  });
  it('rejects a wick-driven break', () => {
    const s = { ...contBase, breakout: { ...(contBase as any).breakout, bodyRatio: 0.2 } } as unknown as V2Setup;
    expect(confirmedExtreme(s)).toMatchObject({ confirmed: false, reason: 'wick_not_body' });
  });
  it('rejects a break that did not hold', () => {
    const s = { ...contBase, breakout: { ...(contBase as any).breakout, held: false } } as unknown as V2Setup;
    expect(confirmedExtreme(s)).toMatchObject({ confirmed: false, reason: 'did_not_hold' });
  });
  it('rejects an immediate reclaim', () => {
    const s = { ...contBase, breakout: { ...(contBase as any).breakout, immediateReclaim: true } } as unknown as V2Setup;
    expect(confirmedExtreme(s)).toMatchObject({ confirmed: false, reason: 'immediate_reclaim' });
  });
});

/* ---------------- fee drag guard ---------------- */

describe('Fee Drag Guard', () => {
  it('rejects a stop tighter than 0.35% of price', () => {
    // entry 100, stop 99.8 -> 0.20 %
    expect(feeGuardPasses(100, 99.8, 0.01)).toBe(false);
  });
  it('rejects a stop tighter than 0.5 ATR even when the % floor passes', () => {
    // 1 % of price but only 0.25 ATR
    expect(feeGuardPasses(100, 99, 4)).toBe(false);
  });
  it('accepts when BOTH floors are cleared', () => {
    expect(feeGuardPasses(100, 99, 1)).toBe(true);
  });
  it('is exactly the preregistered pair of floors', () => {
    expect(FEE_GUARD_PCT).toBe(0.0035);
    expect(FEE_GUARD_ATR).toBe(0.5);
  });
  it('NEVER widens the stop — it is a pure predicate', () => {
    const entry = 100, stop = 99.9;
    feeGuardPasses(entry, stop, 0.01);
    expect(stop).toBe(99.9);   // unchanged
  });
});

/* ---------------- confluence ---------------- */

function mkConf(o: Partial<{
  rvol: number; rsi: number; bull: boolean; bear: boolean;
  crossUp: boolean; crossDown: boolean; hs: number; align: string;
}>, dir: 'LONG' | 'SHORT' = 'LONG'): V2Setup {
  return {
    direction: dir,
    vol: { rvol: o.rvol ?? 0.5 },
    rsi: { rsi: o.rsi ?? 50, bullishDivergence: o.bull ?? false, bearishDivergence: o.bear ?? false },
    macd: { crossUp: o.crossUp ?? false, crossDown: o.crossDown ?? false, histogramSlope: o.hs ?? 0 },
    ema: { alignment: o.align ?? 'RANGE' },
  } as unknown as V2Setup;
}

describe('confluence filter (>= 3 of 4)', () => {
  it('counts zero votes on a flat setup', () => {
    expect(confluence(mkConf({})).votes).toBe(0);
  });
  it('counts exactly 2 votes', () => {
    const v = confluence(mkConf({ rvol: 1.5, rsi: 40 }));
    expect(v.votes).toBe(2);
    expect(v.votes).toBeLessThan(CONFLUENCE_MIN);
  });
  it('counts exactly 3 votes and passes the threshold', () => {
    const v = confluence(mkConf({ rvol: 1.5, rsi: 40, hs: 1 }));
    expect(v.votes).toBe(3);
    expect(v.votes).toBeGreaterThanOrEqual(CONFLUENCE_MIN);
  });
  it('counts all 4 votes', () => {
    const v = confluence(mkConf({ rvol: 1.5, rsi: 40, hs: 1, align: 'BULLISH' }));
    expect(v.votes).toBe(4);
  });
  it('rvol must EXCEED 1.2, not merely equal it', () => {
    expect(confluence(mkConf({ rvol: 1.2 })).detail.volume).toBe(false);
    expect(confluence(mkConf({ rvol: 1.21 })).detail.volume).toBe(true);
  });
  it('honours SHORT-side polarity', () => {
    const s = confluence(mkConf({ rvol: 1.5, rsi: 60, hs: -1, align: 'BEARISH' }, 'SHORT'));
    expect(s.votes).toBe(4);
    const wrong = confluence(mkConf({ rvol: 1.5, rsi: 40, hs: 1, align: 'BULLISH' }, 'SHORT'));
    expect(wrong.votes).toBe(1); // only volume
  });
  it('accepts RSI divergence as an alternative to the zone', () => {
    expect(confluence(mkConf({ rsi: 80, bull: true })).detail.rsi).toBe(true);
  });
});

/* ---------------- corridor ---------------- */

describe('entry corridor', () => {
  it('is centred on the given close and ATR-scaled', () => {
    const c = buildCorridor(100, 2, 0.01)!;          // 0.10*2 = 0.2 wide half
    expect((c.low + c.high) / 2).toBeCloseTo(100, 6);
    expect(c.halfWidth).toBeCloseTo(0.15, 6);        // capped at 0.15 % of 100
  });
  it('never exceeds CORRIDOR_MAX_PCT of price', () => {
    const c = buildCorridor(100, 1000, 0.01)!;
    expect(c.halfWidth).toBeLessThanOrEqual(CORRIDOR_MAX_PCT * 100 + 1e-9);
  });
  it('is floored at one tick for a tiny ATR', () => {
    const c = buildCorridor(0.11747, 1e-9, 0.00001)!;
    expect(c.high - c.low).toBeGreaterThan(0);
  });
  it('quantizes both edges to the symbol tick', () => {
    const tick = 0.01;
    const c = buildCorridor(87654.321, 50, tick)!;
    expect(Math.abs(c.low / tick - Math.round(c.low / tick))).toBeLessThan(1e-6);
    expect(Math.abs(c.high / tick - Math.round(c.high / tick))).toBeLessThan(1e-6);
  });
  it('uses the measured Binance tick sizes', () => {
    expect(TICK_SIZE['BTCUSDT']).toBe(0.01);
    expect(TICK_SIZE['DOGEUSDT']).toBe(0.00001);
  });
  it('expiry is the preregistered 3 bars', () => {
    expect(EXPIRY_BARS).toBe(3);
  });
});

/* ---------------- state machine ---------------- */

function sim(o: {
  dir: 'LONG' | 'SHORT'; lo: number; hi: number; stop: number; tp1: number;
  bars: Candle[];
}): { terminal: string; ambiguous: boolean; waited: number } {
  const long = o.dir === 'LONG';
  for (let i = 0; i < o.bars.length; i++) {
    const c = o.bars[i]!;
    const touch = long ? c.low <= o.hi : c.high >= o.lo;
    const sl = long ? c.low <= o.stop : c.high >= o.stop;
    const tp = long ? c.high >= o.tp1 : c.low <= o.tp1;
    if (touch && sl) return { terminal: 'CANCELLED', ambiguous: true, waited: i };
    if (touch) return { terminal: 'FILLED', ambiguous: false, waited: i };
    if (sl) return { terminal: 'CANCELLED', ambiguous: false, waited: i };
    if (tp) return { terminal: 'MISSED', ambiguous: false, waited: i };
    if (i >= EXPIRY_BARS) return { terminal: 'EXPIRED', ambiguous: false, waited: i };
  }
  return { terminal: 'PENDING', ambiguous: false, waited: o.bars.length };
}

describe('pending corridor terminal states', () => {
  it('FILLED when price enters the corridor (LONG)', () => {
    expect(sim({ dir: 'LONG', lo: 99.85, hi: 100.15, stop: 98, tp1: 105,
      bars: [bar(1, 100.4, 100.5, 100.0, 100.2)] }).terminal).toBe('FILLED');
  });
  it('FILLED for SHORT', () => {
    expect(sim({ dir: 'SHORT', lo: 99.85, hi: 100.15, stop: 102, tp1: 95,
      bars: [bar(1, 99.5, 99.9, 99.4, 99.7)] }).terminal).toBe('FILLED');
  });
  it('MISSED when price gaps to TP1 without entering the corridor', () => {
    expect(sim({ dir: 'LONG', lo: 99.85, hi: 100.15, stop: 98, tp1: 105,
      bars: [bar(1, 101, 106, 100.9, 105.5)] }).terminal).toBe('MISSED');
  });
  it('CANCELLED on structural invalidation before fill', () => {
    expect(sim({ dir: 'LONG', lo: 95, hi: 96, stop: 98, tp1: 120,
      bars: [bar(1, 99, 99.5, 97.5, 98)] }).terminal).toBe('CANCELLED');
  });
  it('CANCELLED (ambiguous) when one bar both fills and breaks the stop', () => {
    const r = sim({ dir: 'LONG', lo: 99.85, hi: 100.15, stop: 98, tp1: 105,
      bars: [bar(1, 100.5, 100.6, 97.5, 98.2)] });
    expect(r.terminal).toBe('CANCELLED');
    expect(r.ambiguous).toBe(true);
  });
  it('EXPIRED after exactly 3 bars', () => {
    const quiet = Array.from({ length: 6 }, (_, i) => bar(i + 1, 105, 105.2, 104.8, 105));
    const r = sim({ dir: 'LONG', lo: 99.85, hi: 100.15, stop: 98, tp1: 120, bars: quiet });
    expect(r.terminal).toBe('EXPIRED');
    expect(r.waited).toBe(EXPIRY_BARS);
  });
});

/* ---------------- causality ---------------- */

describe('no look-ahead', () => {
  const flat: Candle[] = Array.from({ length: 200 },
    (_, i) => bar(i, 100, 100.1, 99.9, 100));

  it('never fills at or before the setup bar (full gates)', () => {
    const r = replayCorridor({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: flat,
      settings: Settings.fromDefaults(), gates: FULL_GATES,
    });
    expect(r.trades.every((t) => t.entryCandleTime === undefined
      || t.entryCandleTime > t.setupCandleTime)).toBe(true);
  });

  it('baseline gates also respect N+1 ordering', () => {
    const r = replayCorridor({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: flat,
      settings: Settings.fromDefaults(), gates: BASELINE_GATES,
    });
    expect(r.trades.every((t) => t.entryCandleTime === undefined
      || t.entryCandleTime > t.setupCandleTime)).toBe(true);
  });
});

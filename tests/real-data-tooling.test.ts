/**
 * Guards for the real-data research tooling.
 *
 * Two things must never silently break:
 *
 *  1. The WINDOWED replay must stay bit-identical to the frozen
 *     `replayV2Series`. It exists purely for speed; the moment it diverges,
 *     every statistic built on it is worthless.
 *
 *  2. Timestamp-unit detection must keep distinguishing Binance's millisecond
 *     archives from its microsecond ones. Getting this wrong shifts candles by
 *     a factor of 1000 and is the single most destructive parsing bug available
 *     in this dataset.
 *
 * These use SYNTHETIC candles: they test the tooling, not the market.
 */

import { describe, expect, it } from 'vitest';
import { Settings } from '../src/core/settings';
import type { Candle, Timeframe } from '../src/core/types';
import { TF_MS } from '../src/core/types';
import { replayV2Series } from '../src/replay/v2-runner';
import { replayV2Windowed, classifyWait } from '../scripts/real-data/windowed-replay';
import { detectTimeUnit, toMs } from '../scripts/real-data/ingest';
import { buildTargets } from '../src/strategy/v2/engine';

/** Deterministic pseudo-random walk with structure the V2 engine can read. */
function makeSeries(n: number, tf: Timeframe, seed = 12345): Candle[] {
  let s = seed;
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  const span = TF_MS[tf];
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    // Cyclical drift creates ranges, sweeps and breakouts rather than noise.
    const drift = Math.sin(i / 40) * 0.6 + Math.sin(i / 11) * 0.2;
    const open = price;
    const close = open + drift + (rnd() - 0.5) * 1.2;
    const high = Math.max(open, close) + rnd() * 0.8;
    const low = Math.min(open, close) - rnd() * 0.8;
    const openTime = 1_640_995_200_000 + i * span;
    out.push({
      openTime, open, high, low, close,
      volume: 100 + rnd() * 900,
      closeTime: openTime + span - 1,
      quoteVolume: 0, trades: 0, isClosed: true,
    });
    price = close;
  }
  return out;
}

describe('timestamp unit detection (Binance archive ms vs us)', () => {
  it('classifies a 13-digit millisecond timestamp as ms', () => {
    expect(detectTimeUnit(1_640_995_200_000)).toBe('ms');
    expect(detectTimeUnit(1_767_222_000_000)).toBe('ms');
  });

  it('classifies a 16-digit microsecond timestamp as us', () => {
    expect(detectTimeUnit(1_764_547_200_000_000)).toBe('us');
    expect(detectTimeUnit(1_735_689_600_000_000)).toBe('us');
  });

  it('normalises both units to the same instant', () => {
    const ms = 1_764_547_200_000;
    expect(toMs(ms, 'ms')).toBe(ms);
    expect(toMs(ms * 1000, 'us')).toBe(ms);
    expect(new Date(toMs(ms * 1000, 'us')).toISOString()).toBe('2025-12-01T00:00:00.000Z');
  });

  it('refuses to guess an unclassifiable magnitude', () => {
    // Seconds (10 digits) must NOT be silently treated as milliseconds.
    expect(() => detectTimeUnit(1_640_995_200)).toThrow();
    expect(() => detectTimeUnit(0)).toThrow();
  });
});

describe('WAIT reason classification', () => {
  it('maps each engine reason to its fixed category', () => {
    expect(classifyWait('Совокупные доказательства 0.30 ниже порога 0.45.'))
      .toBe('insufficient_evidence');
    expect(classifyWait('Конфликт сторон: LONG 0.50 против SHORT 0.45 — нет перевеса.'))
      .toBe('insufficient_net_evidence');
    expect(classifyWait('Не удалось построить структурный стоп.'))
      .toBe('no_structural_stop');
    expect(classifyWait('Структурный стоп оказался по неверную сторону от входа.'))
      .toBe('no_structural_stop');
    expect(classifyWait('Цена в середине диапазона — нет точки наблюдения у границы.'))
      .toBe('no_liquidity_event');
    expect(classifyWait('Нет подтверждённого диапазона: недостаточно структурных свингов.'))
      .toBe('invalid_or_stale_range');
    expect(classifyWait('Диапазон слишком слабый (confidence 0.10 < 0.25).'))
      .toBe('invalid_or_stale_range');
  });
});

describe('windowed replay == frozen replayV2Series', () => {
  const settings = Settings.fromDefaults();

  for (const tf of ['5m', '1h'] as Timeframe[]) {
    it(`produces identical trades on ${tf}`, () => {
      const candles = makeSeries(1500, tf);
      const ref = replayV2Series({ symbol: 'TESTUSDT', timeframe: tf, candles, settings });
      const win = replayV2Windowed({ symbol: 'TESTUSDT', timeframe: tf, candles, settings });

      expect(win.evaluations).toBe(ref.evaluations);
      expect(win.waits).toBe(ref.waits);
      expect(win.trades.length).toBe(ref.trades.length);
      // A harness that produces no trades would pass vacuously.
      expect(ref.trades.length).toBeGreaterThan(0);

      for (let i = 0; i < ref.trades.length; i++) {
        const a = ref.trades[i]!, b = win.trades[i]!;
        expect(b.direction).toBe(a.direction);
        expect(b.setupCandleTime).toBe(a.setupCandleTime);
        expect(b.entryCandleTime).toBe(a.entryCandleTime);
        expect(b.entryPrice).toBeCloseTo(a.entryPrice, 10);
        expect(b.stopLoss).toBeCloseTo(a.stopLoss, 10);
        expect(b.takeProfits.length).toBe(a.takeProfits.length);
        expect(b.result).toBe(a.result);
        expect(b.rMultiple).toBeCloseTo(a.rMultiple, 10);
        expect(b.barsHeld).toBe(a.barsHeld);
        expect(b.evidence).toBeCloseTo(a.evidence, 12);
        expect(b.setupKind).toBe(a.setupKind);
        expect(b.htfAlignment).toBe(a.htfAlignment);
      }
    });
  }

  it('is identical with higher-timeframe context supplied', () => {
    const tf: Timeframe = '15m';
    const candles = makeSeries(1200, tf, 777);
    const htf = { '1h': makeSeries(400, '1h', 99), '4h': makeSeries(200, '4h', 55) };
    const ref = replayV2Series({
      symbol: 'TESTUSDT', timeframe: tf, candles, settings, htfCandles: htf,
    });
    const win = replayV2Windowed({
      symbol: 'TESTUSDT', timeframe: tf, candles, settings, htfCandles: htf,
    });
    expect(win.trades.length).toBe(ref.trades.length);
    expect(win.evaluations).toBe(ref.evaluations);
    for (let i = 0; i < ref.trades.length; i++) {
      expect(win.trades[i]!.htfAlignment).toBe(ref.trades[i]!.htfAlignment);
      expect(win.trades[i]!.rMultiple).toBeCloseTo(ref.trades[i]!.rMultiple, 10);
    }
  });
});

describe('liquidity lifecycle invariant audit', () => {
  /**
   * The corrected audit must be able to FAIL. An audit that only ever returns
   * "clean" proves nothing, and the first version of this one returned 312,866
   * false positives, so both directions are pinned here.
   */
  it('buildTargets excludes non-resting pools from the ladder', () => {
    const entry = 100;
    const stop = 99;
    // Three pools ahead of a LONG entry; the nearest two are already taken.
    const pools = [
      { side: 'BUY_SIDE' as const, price: 101, resting: false, clusterId: 'A' },
      { side: 'BUY_SIDE' as const, price: 102, resting: false, clusterId: 'B' },
      { side: 'BUY_SIDE' as const, price: 103, resting: true, clusterId: 'C' },
    ];
    const targets = buildTargets('LONG', entry, stop, null, pools, 1, {
      clusterTolAtr: 0.25,
    });
    const prices = targets
      .filter((t) => t.basis === 'INTERNAL_LIQUIDITY')
      .map((t) => t.price);
    // The swept/consumed levels must not appear; the resting one may.
    expect(prices).not.toContain(101);
    expect(prices).not.toContain(102);
    expect(prices).toContain(103);
  });

  it('a resting pool IS eligible as a target', () => {
    const targets = buildTargets('LONG', 100, 99, null,
      [{ side: 'BUY_SIDE' as const, price: 105, resting: true, clusterId: 'X' }],
      1, { clusterTolAtr: 0.25 });
    expect(targets.some((t) => t.basis === 'INTERNAL_LIQUIDITY' && t.price === 105))
      .toBe(true);
  });

  it('SHORT side: non-resting sell-side pools are excluded', () => {
    const targets = buildTargets('SHORT', 100, 101, null, [
      { side: 'SELL_SIDE' as const, price: 99, resting: false, clusterId: 'A' },
      { side: 'SELL_SIDE' as const, price: 97, resting: true, clusterId: 'B' },
    ], 1, { clusterTolAtr: 0.25 });
    const prices = targets
      .filter((t) => t.basis === 'INTERNAL_LIQUIDITY').map((t) => t.price);
    expect(prices).not.toContain(99);
    expect(prices).toContain(97);
  });
});

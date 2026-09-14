/**
 * Replay must use THE SAME engine as live, and must be leak-free.
 */

import { describe, expect, it } from 'vitest';
import { replaySeries } from '../src/replay/runner';
import { evaluate } from '../src/strategy/smart-money';
import { Settings } from '../src/core/settings';
import { loadFixtureCandles } from './helpers';
import { TIMEFRAMES, tfMs, type Timeframe } from '../src/core/types';

// Loosened thresholds so the fixture data actually produces trades.
const settings = Settings.fromEntries([
  ['engine.score_threshold', 45],
  ['engine.min_components', 2],
  ['outcome.timeout_bars', 24],
  ['outcome.fee_pct', 0.1],
]);

describe('replay uses the same Smart Money engine', () => {
  it('replay decisions match a direct evaluate() call at the same index', () => {
    const candles = loadFixtureCandles('BTCUSDT', '1h');
    const res = replaySeries({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings });

    // Re-derive each trade's setup decision using the LIVE entry point.
    for (const t of res.trades.slice(0, 10)) {
      const idx = candles.findIndex((c) => c.openTime === t.setupCandleTime);
      expect(idx).toBeGreaterThan(0);
      const lookback = Math.floor(settings.num('engine.lookback_candles'));
      const window = candles.slice(Math.max(0, idx + 1 - (lookback + 5)), idx + 1);
      const ev = evaluate({
        symbol: 'BTCUSDT', timeframe: '1h', candles: window, settings,
        atIndex: window.length - 1,
      });
      expect(ev, `no evaluation at ${t.setupCandleTime}`).not.toBeNull();
      expect(ev!.decision!.passed).toBe(true);
      expect(ev!.decision!.direction).toBe(t.direction);
      expect(ev!.decision!.score).toBeCloseTo(t.score, 6);
    }
  });

  it('produces trades on fixture data', () => {
    const candles = loadFixtureCandles('ETHUSDT', '1h');
    const res = replaySeries({ symbol: 'ETHUSDT', timeframe: '1h', candles, settings });
    expect(res.evaluations).toBeGreaterThan(50);
    expect(res.trades.length).toBeGreaterThan(0);
  });

  it('every entry is the OPEN of the candle AFTER the setup candle', () => {
    const candles = loadFixtureCandles('SOLUSDT', '1h');
    const res = replaySeries({ symbol: 'SOLUSDT', timeframe: '1h', candles, settings });
    expect(res.trades.length).toBeGreaterThan(0);
    const byTime = new Map(candles.map((c) => [c.openTime, c]));

    for (const t of res.trades) {
      expect(t.entryCandleTime).toBe(t.setupCandleTime + tfMs('1h'));
      const entryCandle = byTime.get(t.entryCandleTime)!;
      expect(entryCandle).toBeTruthy();
      expect(t.entryPrice).toBe(entryCandle.open);
      // and NEVER the setup candle's close
      const setupCandle = byTime.get(t.setupCandleTime)!;
      if (setupCandle.close !== entryCandle.open) {
        expect(t.entryPrice).not.toBe(setupCandle.close);
      }
    }
  });

  it('exit always occurs at or after the entry candle', () => {
    const candles = loadFixtureCandles('BNBUSDT', '1h');
    const res = replaySeries({ symbol: 'BNBUSDT', timeframe: '1h', candles, settings });
    for (const t of res.trades) {
      if (t.exitCandleTime === null) continue;
      expect(t.exitCandleTime).toBeGreaterThanOrEqual(t.entryCandleTime);
    }
  });

  it('is deterministic — identical input gives identical output', () => {
    const candles = loadFixtureCandles('XRPUSDT', '1h');
    const a = replaySeries({ symbol: 'XRPUSDT', timeframe: '1h', candles, settings });
    const b = replaySeries({ symbol: 'XRPUSDT', timeframe: '1h', candles, settings });
    expect(JSON.stringify(a.trades)).toBe(JSON.stringify(b.trades));
    expect(a.stats).toEqual(b.stats);
  });

  it('appending future candles does not change already-closed trades', () => {
    const full = loadFixtureCandles('ADAUSDT', '1h');
    const short = full.slice(0, 450);
    const a = replaySeries({ symbol: 'ADAUSDT', timeframe: '1h', candles: short, settings });
    const b = replaySeries({ symbol: 'ADAUSDT', timeframe: '1h', candles: full, settings });

    const aClosed = a.trades.filter((t) => t.result !== 'OPEN');
    for (const t of aClosed) {
      const match = b.trades.find((x) => x.setupCandleTime === t.setupCandleTime);
      expect(match, `trade at ${t.setupCandleTime} vanished when more data was added`).toBeTruthy();
      expect(match!.entryPrice).toBe(t.entryPrice);
      expect(match!.direction).toBe(t.direction);
      expect(match!.score).toBeCloseTo(t.score, 9);
      expect(match!.result).toBe(t.result);
      expect(match!.rMultiple).toBeCloseTo(t.rMultiple, 9);
    }
  });

  it('positions never overlap (single slot per symbol/timeframe)', () => {
    const candles = loadFixtureCandles('BTCUSDT', '1h');
    const res = replaySeries({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings });
    const sorted = [...res.trades].sort((a, b) => a.entryCandleTime - b.entryCandleTime);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (prev.exitCandleTime === null) continue;
      expect(cur.entryCandleTime).toBeGreaterThan(prev.exitCandleTime);
    }
  });

  it('statistics are internally consistent', () => {
    const candles = loadFixtureCandles('DOGEUSDT', '1h');
    const res = replaySeries({ symbol: 'DOGEUSDT', timeframe: '1h', candles, settings });
    const closed = res.trades.filter((t) => t.result !== 'OPEN');
    expect(res.stats.total).toBe(closed.length);
    expect(res.stats.wins + res.stats.losses + res.stats.timeouts).toBe(closed.length);
    if (closed.length > 0) {
      expect(res.stats.winRate).toBeCloseTo((res.stats.wins / closed.length) * 100, 4);
      const sumR = closed.reduce((s, t) => s + t.rMultiple, 0);
      expect(res.stats.totalR).toBeCloseTo(sumR, 4);
      expect(res.stats.avgR).toBeCloseTo(sumR / closed.length, 4);
    }
  });

  it('runs across every timeframe without error', () => {
    for (const tf of TIMEFRAMES) {
      const candles = loadFixtureCandles('BTCUSDT', tf as Timeframe);
      const res = replaySeries({ symbol: 'BTCUSDT', timeframe: tf as Timeframe, candles, settings });
      expect(res.candlesSeen, `timeframe ${tf}`).toBeGreaterThan(0);
      expect(res.evaluations).toBeGreaterThanOrEqual(0);
      for (const t of res.trades) {
        expect(t.entryCandleTime).toBe(t.setupCandleTime + tfMs(tf as Timeframe));
      }
    }
  });

  it('a stricter threshold produces no more trades than a looser one', () => {
    const candles = loadFixtureCandles('BTCUSDT', '1h');
    const loose = replaySeries({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['engine.score_threshold', 40], ['engine.min_components', 1]]) });
    const strict = replaySeries({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['engine.score_threshold', 95], ['engine.min_components', 5]]) });
    expect(strict.trades.length).toBeLessThanOrEqual(loose.trades.length);
  });

  it('respects SL/TP geometry for every closed trade', () => {
    const candles = loadFixtureCandles('BTCUSDT', '1h');
    const res = replaySeries({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings });
    for (const t of res.trades) {
      if (t.direction === 'LONG') {
        expect(t.stopLoss).toBeLessThan(t.entryPrice);
        for (const tp of t.takeProfits) expect(tp).toBeGreaterThan(t.entryPrice);
      } else {
        expect(t.stopLoss).toBeGreaterThan(t.entryPrice);
        for (const tp of t.takeProfits) expect(tp).toBeLessThan(t.entryPrice);
      }
    }
  });
});

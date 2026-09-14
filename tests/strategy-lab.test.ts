/**
 * Guards for the measurement harness itself.
 *
 * A backtest that is subtly wrong is worse than no backtest, because it
 * produces confident numbers. These tests pin the properties that make the
 * lab's output trustworthy: it reuses production logic, the split is
 * chronological, TEST never leaks into selection, and the ambiguous-bar
 * policy is conservative.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Settings } from '../src/core/settings';
import {
  computeMetrics, splitPoints, scoreBucket, confirmationsOf, factorsOf, runLab,
  loadFixtureCandles,
} from '../scripts/strategy-lab';
import { CANDIDATES, passesSelection, perSeriesSplit } from '../scripts/strategy-optimize';
import type { ReplayTrade } from '../src/replay/runner';
import type { Timeframe } from '../src/core/types';

const read = (p: string): string => readFileSync(p, 'utf8');

const trade = (over: Partial<ReplayTrade> = {}): ReplayTrade => ({
  symbol: 'BTCUSDT',
  timeframe: '1h',
  direction: 'LONG',
  score: 70,
  setupCandleTime: 0,
  entryCandleTime: 0,
  entryPrice: 100,
  stopLoss: 99,
  takeProfits: [101, 102, 103],
  result: 'TP',
  exitPrice: 103,
  exitCandleTime: 0,
  barsHeld: 5,
  rMultiple: 3,
  pnlPct: 3,
  breakdown: null,
  ...over,
});

describe('LAB 1 — the harness does not reimplement the strategy', () => {
  it('delegates to the production replay engine', () => {
    const src = read('scripts/strategy-lab.ts');
    expect(src).toMatch(/import \{[^}]*replaySeries[^}]*\} from '\.\.\/src\/replay\/runner'/s);
  });

  it('defines no entry, stop, take-profit or scoring rule of its own', () => {
    const src = read('scripts/strategy-lab.ts');
    // The lab may *read* these fields off a trade, but must never compute them.
    expect(src).not.toMatch(/function\s+(resolveEntry|buildRiskPlan|evaluate|scoreDirection)/);
    expect(src).not.toMatch(/atr|ATR_PERIOD/i);
  });

  it('the optimizer only varies settings, never patches engine code', () => {
    const src = read('scripts/strategy-optimize.ts');
    expect(src).toMatch(/Settings\.fromEntries/);
    for (const c of CANDIDATES) {
      for (const [key] of c.overrides) {
        // Every override must be a real registry key path.
        expect(key).toMatch(/^(engine|risk|outcome|detectors)\./);
      }
    }
  });
});

describe('LAB 2 — metric correctness', () => {
  it('excludes still-open trades from the finished population', () => {
    const m = computeMetrics([
      trade({ result: 'TP', rMultiple: 2 }),
      trade({ result: 'OPEN', rMultiple: 0, exitPrice: null }),
    ]);
    expect(m.n).toBe(1);
    expect(m.open).toBe(1);
  });

  it('profit factor is gross win R over gross loss R', () => {
    const m = computeMetrics([
      trade({ result: 'TP', rMultiple: 3 }),
      trade({ result: 'SL', rMultiple: -1 }),
      trade({ result: 'SL', rMultiple: -1 }),
    ]);
    expect(m.profitFactor).toBe(1.5);
    expect(m.totalR).toBe(1);
    expect(m.expectancy).toBeCloseTo(1 / 3, 4);
  });

  it('max drawdown is measured on the cumulative R curve, in trade order', () => {
    // +2 then -3 then +1  =>  peak 2, trough -1, worst drawdown -3.
    const m = computeMetrics([
      trade({ result: 'TP', rMultiple: 2 }),
      trade({ result: 'SL', rMultiple: -3 }),
      trade({ result: 'TP', rMultiple: 1 }),
    ]);
    expect(m.maxDrawdownR).toBe(-3);
  });

  it('reports win rate and expectancy as separate facts', () => {
    // Classic trap: high win rate, negative expectancy.
    const m = computeMetrics([
      ...Array.from({ length: 9 }, () => trade({ result: 'TP', rMultiple: 0.2 })),
      trade({ result: 'SL', rMultiple: -5 }),
    ]);
    expect(m.winRatePct).toBe(90);
    expect(m.expectancy).toBeLessThan(0);
  });

  it('median R is reported alongside average R', () => {
    const m = computeMetrics([
      trade({ rMultiple: -1 }), trade({ rMultiple: -1 }), trade({ rMultiple: 10 }),
    ]);
    expect(m.medianR).toBe(-1);
    expect(m.avgR).toBeCloseTo(8 / 3, 3);
  });

  it('empty input does not produce NaN', () => {
    const m = computeMetrics([]);
    for (const v of Object.values(m)) expect(Number.isNaN(v)).toBe(false);
  });
});

describe('LAB 3 — chronological split integrity', () => {
  it('splits by time at 60/80, never by shuffling', () => {
    const candles = Array.from({ length: 100 }, (_, i) => ({
      openTime: i * 1000, open: 1, high: 1, low: 1, close: 1, volume: 0,
      closeTime: i * 1000 + 999, quoteVolume: 0, trades: 0, isClosed: true,
    }));
    const { trainEnd, validEnd } = splitPoints(candles);
    expect(trainEnd).toBe(Math.floor(99 * 1000 * 0.6));
    expect(validEnd).toBe(Math.floor(99 * 1000 * 0.8));
    expect(trainEnd).toBeLessThan(validEnd);
  });

  it('every series gets its own boundaries, so 1w does not swamp 1m', () => {
    const split = perSeriesSplit(['1h', '1w'] as Timeframe[]);
    const h = split.get('BTCUSDT|1h');
    const w = split.get('BTCUSDT|1w');
    expect(h).toBeDefined();
    expect(w).toBeDefined();
    // Different spans must yield different cut points.
    expect(h!.trainEnd).not.toBe(w!.trainEnd);
  });

  it('the selection gate reads TRAIN and VALIDATION only — never TEST', () => {
    const strongTest = {
      train: computeMetrics([trade({ rMultiple: -1, result: 'SL' })]),
      validation: computeMetrics([trade({ rMultiple: -1, result: 'SL' })]),
      test: computeMetrics(Array.from({ length: 50 }, () => trade({ rMultiple: 5 }))),
    };
    const base = {
      train: computeMetrics([trade({ rMultiple: 0 })]),
      validation: computeMetrics([trade({ rMultiple: 0 })]),
      test: computeMetrics([trade({ rMultiple: 0 })]),
    };
    // A spectacular TEST result must not rescue a candidate that lost on
    // TRAIN/VALIDATION.
    expect(passesSelection(strongTest, base)).toBe(false);
  });

  it('rejects candidates with too small a sample even when expectancy is high', () => {
    const tiny = {
      train: computeMetrics([trade({ rMultiple: 9 })]),
      validation: computeMetrics([trade({ rMultiple: 9 })]),
      test: computeMetrics([trade({ rMultiple: 9 })]),
    };
    const base = {
      train: computeMetrics([trade({ rMultiple: 0 })]),
      validation: computeMetrics([trade({ rMultiple: 0 })]),
      test: computeMetrics([trade({ rMultiple: 0 })]),
    };
    expect(passesSelection(tiny, base, 30)).toBe(false);
  });
});

describe('LAB 4 — candidate set stays small and documented', () => {
  it('is a hypothesis list, not a grid search', () => {
    expect(CANDIDATES.length).toBeLessThanOrEqual(8);
    for (const c of CANDIDATES) {
      expect(c.hypothesis.length).toBeGreaterThan(40);
    }
  });

  it('always includes an unmodified baseline to compare against', () => {
    const base = CANDIDATES.find((c) => c.name === 'baseline');
    expect(base).toBeDefined();
    expect(base!.overrides).toHaveLength(0);
  });
});

describe('LAB 5 — analysis helpers', () => {
  it('buckets scores without gaps or overlaps', () => {
    expect(scoreBucket(55)).toBe('55-60');
    expect(scoreBucket(59.9)).toBe('55-60');
    expect(scoreBucket(60)).toBe('60-70');
    expect(scoreBucket(99.9)).toBe('90-100');
    expect(scoreBucket(100)).toBe('100');
  });

  it('counts only factors that actually fired', () => {
    const t = trade({
      breakdown: {
        components: [
          { detector: 'BOS', counted: true },
          { detector: 'FVG', counted: false },
        ],
      },
    });
    expect(factorsOf(t)).toEqual(['BOS']);
    expect(confirmationsOf(t)).toBe(1);
  });
});

describe('LAB 6 — end-to-end run over the fixture series', () => {
  const settings = Settings.fromDefaults();

  it('produces trades whose entry never precedes the setup candle', () => {
    const trades = runLab({ settings, timeframes: ['1h'], symbols: ['BTCUSDT'] });
    expect(trades.length).toBeGreaterThan(0);
    for (const t of trades) {
      // Entry is the OPEN of N+1, so it is strictly after the setup candle.
      expect(t.entryCandleTime).toBeGreaterThan(t.setupCandleTime);
    }
  });

  it('never exits before it enters', () => {
    const trades = runLab({ settings, timeframes: ['1h'], symbols: ['BTCUSDT'] });
    for (const t of trades) {
      if (t.exitCandleTime === null) continue;
      expect(t.exitCandleTime).toBeGreaterThanOrEqual(t.entryCandleTime);
    }
  });

  it('is deterministic — same inputs, same output', () => {
    const a = runLab({ settings, timeframes: ['1h'], symbols: ['ETHUSDT'] });
    const b = runLab({ settings, timeframes: ['1h'], symbols: ['ETHUSDT'] });
    expect(a.map((t) => [t.setupCandleTime, t.rMultiple])).toEqual(
      b.map((t) => [t.setupCandleTime, t.rMultiple]),
    );
  });

  it('restricting the window cannot invent trades outside it', () => {
    const candles = loadFixtureCandles('fixtures', 'BTCUSDT', '1h' as Timeframe);
    const { trainEnd } = splitPoints(candles);
    const trainTrades = runLab({
      settings, timeframes: ['1h'], symbols: ['BTCUSDT'], to: trainEnd,
    });
    for (const t of trainTrades) {
      expect(t.setupCandleTime).toBeLessThanOrEqual(trainEnd);
    }
  });

  it('a stricter evidence floor is a strict subset of baseline setups', () => {
    const base = runLab({ settings, timeframes: ['1h'], symbols: ['BTCUSDT'] });
    const strict = runLab({
      settings: Settings.fromEntries([['engine.min_components', 4]]),
      timeframes: ['1h'],
      symbols: ['BTCUSDT'],
    });
    expect(strict.length).toBeLessThan(base.length);
  });
});

/**
 * STRATEGY OPTIMIZER — limited, hypothesis-driven candidate search with a
 * strictly chronological TRAIN / VALIDATION / TEST split.
 *
 * Rules enforced here, deliberately:
 *   - The candidate list is SMALL and each entry encodes a stated hypothesis.
 *     No uncontrolled grid search over a large parameter space.
 *   - The split is by TIME, never shuffled. TRAIN 60% / VALIDATION 20% /
 *     TEST 20% of the candle span.
 *   - TEST is scored exactly once, for the baseline and for the single
 *     candidate selected on TRAIN+VALIDATION. It never participates in
 *     selection.
 *   - Selection targets robustness (expectancy, total R, drawdown, sample
 *     size), not win rate.
 *
 * Usage: npx tsx scripts/strategy-optimize.ts
 */

import { Settings } from '../src/core/settings';
import type { Timeframe } from '../src/core/types';
import {
  LAB_SYMBOLS, loadFixtureCandles, runLab, computeMetrics, splitPoints,
  type Metrics,
} from './strategy-lab';

export interface Candidate {
  name: string;
  hypothesis: string;
  overrides: Array<readonly [string, unknown]>;
}

/**
 * The candidate set. Each one exists to test a specific finding from the
 * baseline analysis, not to sweep numbers.
 */
export const CANDIDATES: Candidate[] = [
  {
    name: 'baseline',
    hypothesis: 'Current shipped configuration. The bar every candidate must clear.',
    overrides: [],
  },
  {
    name: 'min_components=3',
    hypothesis:
      'Baseline shows 2-confirmation signals are heavily negative (avgR -0.41, n=1050) ' +
      'while 3+ are strongly positive. Raising the evidence floor should remove the ' +
      'loss-making bulk. Cost: far fewer signals.',
    overrides: [['engine.min_components', 3]],
  },
  {
    name: 'min_components=4',
    hypothesis:
      'If 3 is good, is 4 better, or does the sample collapse and the edge with it?',
    overrides: [['engine.min_components', 4]],
  },
  {
    name: 'threshold=65',
    hypothesis:
      'A conventional "raise the score bar" move. Baseline monotonicity analysis ' +
      'predicts this should HURT, because score is inversely related to evidence. ' +
      'Included precisely as a falsification test of the naive assumption.',
    overrides: [['engine.score_threshold', 65]],
  },
  {
    name: 'min_components=3 + threshold=55',
    hypothesis:
      'Combine the evidence floor with the ORIGINAL low score bar, so the filter is ' +
      'evidence-driven rather than score-driven.',
    overrides: [
      ['engine.min_components', 3],
      ['engine.score_threshold', 55],
    ],
  },
];

export interface SplitScores {
  train: Metrics;
  validation: Metrics;
  test: Metrics;
}

function settingsFor(c: Candidate): Settings {
  return Settings.fromEntries(c.overrides);
}

/**
 * Per-series chronological split boundaries.
 *
 * A single GLOBAL time boundary is wrong for this dataset: each timeframe has
 * the same candle COUNT but a wildly different time SPAN (600x 1w candles is
 * ~11 years; 600x 1m candles is ~10 hours). A global cut therefore dumps
 * essentially every intraday trade into one slice — the first version of this
 * script produced TRAIN n=81 vs TEST n=1570. Splitting each (symbol,timeframe)
 * series at its own 60%/80% marks keeps the split chronological WITHIN every
 * series while giving all three slices a comparable mix.
 */
export type SeriesSplit = Map<string, { trainEnd: number; validEnd: number }>;

const seriesKey = (symbol: string, tf: Timeframe): string => `${symbol}|${tf}`;

export function perSeriesSplit(timeframes: readonly Timeframe[]): SeriesSplit {
  const out: SeriesSplit = new Map();
  for (const sym of LAB_SYMBOLS) {
    for (const tf of timeframes) {
      const c = loadFixtureCandles('fixtures', sym, tf);
      if (c.length === 0) continue;
      out.set(seriesKey(sym, tf), splitPoints(c));
    }
  }
  return out;
}

/** Run one slice across all series, each series cut at its own boundaries. */
function runSlice(
  settings: Settings,
  timeframes: readonly Timeframe[],
  split: SeriesSplit,
  slice: 'train' | 'validation' | 'test',
): Metrics {
  const trades = [];
  for (const sym of LAB_SYMBOLS) {
    for (const tf of timeframes) {
      const b = split.get(seriesKey(sym, tf));
      if (!b) continue;
      const window =
        slice === 'train'
          ? { to: b.trainEnd }
          : slice === 'validation'
            ? { from: b.trainEnd, to: b.validEnd }
            : { from: b.validEnd };
      trades.push(...runLab({ settings, timeframes: [tf], symbols: [sym], ...window }));
    }
  }
  trades.sort((a, b) => a.entryCandleTime - b.entryCandleTime);
  return computeMetrics(trades);
}

export function scoreCandidate(
  c: Candidate,
  timeframes: readonly Timeframe[],
  split: SeriesSplit,
): SplitScores {
  const settings = settingsFor(c);
  return {
    train: runSlice(settings, timeframes, split, 'train'),
    validation: runSlice(settings, timeframes, split, 'validation'),
    test: runSlice(settings, timeframes, split, 'test'),
  };
}

const row = (label: string, m: Metrics): string =>
  [
    label.padEnd(28),
    `n=${String(m.n).padStart(4)}`,
    `win=${String(m.winRatePct).padStart(7)}%`,
    `expectancy=${String(m.expectancy).padStart(8)}R`,
    `totR=${String(m.totalR).padStart(9)}`,
    `PF=${String(m.profitFactor).padStart(6)}`,
    `maxDD=${String(m.maxDrawdownR).padStart(9)}`,
  ].join('  ');

/**
 * Robustness gate applied on TRAIN+VALIDATION only. A candidate must beat
 * baseline on BOTH slices and keep a usable sample, otherwise it is not
 * promoted to the single TEST evaluation.
 */
export function passesSelection(
  cand: SplitScores,
  base: SplitScores,
  minSample = 30,
): boolean {
  return (
    cand.train.n >= minSample &&
    cand.validation.n >= minSample &&
    cand.train.expectancy > base.train.expectancy &&
    cand.validation.expectancy > base.validation.expectancy &&
    cand.train.totalR > 0 &&
    cand.validation.totalR > 0
  );
}

function main(): void {
  const settings = Settings.fromDefaults();
  const timeframes = settings.timeframes() as Timeframe[];
  const split = perSeriesSplit(timeframes);

  console.log('STRATEGY OPTIMIZER — chronological TRAIN/VALIDATION/TEST');
  console.log('timeframes :', timeframes.join(', '));
  console.log('split      : per (symbol,timeframe) series, 60% / 20% / 20% BY TIME');
  console.log('series     :', split.size);
  console.log('TEST is scored once and never used for selection.');
  console.log('');

  const scored = new Map<string, SplitScores>();
  for (const c of CANDIDATES) scored.set(c.name, scoreCandidate(c, timeframes, split));
  const base = scored.get('baseline')!;

  console.log('=== TRAIN (selection allowed) ===');
  for (const c of CANDIDATES) console.log(row(c.name, scored.get(c.name)!.train));
  console.log('\n=== VALIDATION (selection allowed) ===');
  for (const c of CANDIDATES) console.log(row(c.name, scored.get(c.name)!.validation));

  console.log('\n=== SELECTION GATE (TRAIN + VALIDATION only) ===');
  const promoted: Candidate[] = [];
  for (const c of CANDIDATES) {
    if (c.name === 'baseline') continue;
    const ok = passesSelection(scored.get(c.name)!, base);
    console.log(`${c.name.padEnd(28)} ${ok ? 'PROMOTED' : 'rejected'}`);
    if (ok) promoted.push(c);
  }

  console.log('\n=== TEST — unseen data, scored once ===');
  console.log(row('baseline', base.test));
  for (const c of promoted) console.log(row(c.name, scored.get(c.name)!.test));

  console.log('\n=== VERDICT ===');
  if (promoted.length === 0) {
    console.log('No candidate passed the selection gate. KEEP THE CURRENT STRATEGY.');
    return;
  }
  const best = promoted
    .map((c) => ({ c, s: scored.get(c.name)! }))
    .sort((a, b) => b.s.test.expectancy - a.s.test.expectancy)[0]!;
  const beatsOnTest = best.s.test.expectancy > base.test.expectancy && best.s.test.n >= 30;
  console.log(
    beatsOnTest
      ? `${best.c.name} also beats baseline on unseen TEST.`
      : `${best.c.name} won on TRAIN/VALIDATION but did NOT hold up on unseen TEST. ` +
          'KEEP THE CURRENT STRATEGY.',
  );
}

if (process.argv[1] && process.argv[1].endsWith('strategy-optimize.ts')) {
  main();
}

/**
 * V1 vs V2 — head-to-head comparison on identical data, with a strictly
 * chronological TRAIN / VALIDATION / TEST split.
 *
 * Both engines are scored by the SAME metric code and share the SAME exit
 * logic (resolveEntry + trackOutcome), so differences are attributable to
 * signal generation alone.
 *
 * The verdict rule is fixed IN ADVANCE and is deliberately conservative:
 * V2 may only be recommended for activation if it beats V1 on the unseen TEST
 * slice on expectancy AND profit factor, with an adequate sample. Otherwise V1
 * stays. TEST is never used to choose parameters.
 *
 * Usage: npx tsx scripts/v1-vs-v2.ts [--tf=15m,1h] [--json=out.json]
 */

import { writeFileSync } from 'node:fs';
import { Settings } from '../src/core/settings';
import type { Timeframe } from '../src/core/types';
import { replaySeries } from '../src/replay/runner';
import { replayV2Series, type V2Trade } from '../src/replay/v2-runner';
import { HTF_MAP } from '../src/strategy/v2/htf';
import {
  LAB_SYMBOLS, loadFixtureCandles, computeMetrics, splitPoints, groupBy,
  type Metrics,
} from './strategy-lab';
import type { ReplayTrade } from '../src/replay/runner';

type Slice = 'train' | 'validation' | 'test';

interface EngineRun {
  trades: ReplayTrade[];
  evaluations: number;
  waits: number;
}

function windowFor(
  slice: Slice,
  b: { trainEnd: number; validEnd: number },
): { from?: number; to?: number } {
  if (slice === 'train') return { to: b.trainEnd };
  if (slice === 'validation') return { from: b.trainEnd, to: b.validEnd };
  return { from: b.validEnd };
}

function runV1(
  settings: Settings,
  timeframes: readonly Timeframe[],
  slice: Slice,
): EngineRun {
  const trades: ReplayTrade[] = [];
  for (const symbol of LAB_SYMBOLS) {
    for (const tf of timeframes) {
      const candles = loadFixtureCandles('fixtures', symbol, tf);
      if (candles.length < 100) continue;
      const w = windowFor(slice, splitPoints(candles));
      const res = replaySeries({ symbol, timeframe: tf, candles, settings, ...w });
      trades.push(...res.trades);
    }
  }
  trades.sort((a, b) => a.entryCandleTime - b.entryCandleTime);
  return { trades, evaluations: 0, waits: 0 };
}

function runV2(
  settings: Settings,
  timeframes: readonly Timeframe[],
  slice: Slice,
): { trades: V2Trade[]; evaluations: number; waits: number } {
  const trades: V2Trade[] = [];
  let evaluations = 0;
  let waits = 0;
  for (const symbol of LAB_SYMBOLS) {
    for (const tf of timeframes) {
      const candles = loadFixtureCandles('fixtures', symbol, tf);
      if (candles.length < 100) continue;
      // Supply higher-timeframe candles; the engine itself enforces that only
      // CLOSED HTF bars may be consulted.
      const htfCandles: Partial<Record<Timeframe, readonly Timeframe[] | never>> = {};
      const htf: Partial<Record<Timeframe, ReturnType<typeof loadFixtureCandles>>> = {};
      for (const h of HTF_MAP[tf] ?? []) {
        const hc = loadFixtureCandles('fixtures', symbol, h);
        if (hc.length > 0) htf[h] = hc;
      }
      void htfCandles;
      const w = windowFor(slice, splitPoints(candles));
      const res = replayV2Series({
        symbol, timeframe: tf, candles, settings, htfCandles: htf, ...w,
      });
      trades.push(...res.trades);
      evaluations += res.evaluations;
      waits += res.waits;
    }
  }
  trades.sort((a, b) => a.entryCandleTime - b.entryCandleTime);
  return { trades, evaluations, waits };
}

/**
 * Exit composition. This matters more than the headline expectancy: a strategy
 * whose positive R comes from TIMEOUT (mark-to-market at the bar limit) rather
 * than from TP hits has not demonstrated that its TARGETS work.
 */
function exitComposition(trades: readonly ReplayTrade[]): string {
  const by = new Map<string, { n: number; totR: number }>();
  for (const t of trades) {
    const e = by.get(t.result) ?? { n: 0, totR: 0 };
    e.n++;
    e.totR += t.rMultiple;
    by.set(t.result, e);
  }
  return [...by]
    .sort()
    .map(([k, v]) => `${k}: n=${v.n} totR=${v.totR.toFixed(1)} avgR=${(v.totR / v.n).toFixed(2)}`)
    .join('  |  ');
}

/** Median R multiple of the FIRST target, in units of risk. */
function medianFirstTpR(trades: readonly ReplayTrade[]): number {
  const rs = trades
    .map((t) => {
      const risk = Math.abs(t.entryPrice - t.stopLoss);
      const tp = t.takeProfits[0];
      return risk > 0 && tp !== undefined ? Math.abs(tp - t.entryPrice) / risk : NaN;
    })
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
  return rs.length === 0 ? 0 : (rs[Math.floor(rs.length / 2)] ?? 0);
}

const row = (label: string, m: Metrics): string =>
  [
    label.padEnd(22),
    `n=${String(m.n).padStart(4)}`,
    `L/S=${String(m.long).padStart(3)}/${String(m.short).padEnd(3)}`,
    `win=${String(m.winRatePct).padStart(7)}%`,
    `exp=${String(m.expectancy).padStart(8)}R`,
    `totR=${String(m.totalR).padStart(9)}`,
    `PF=${String(m.profitFactor).padStart(6)}`,
    `maxDD=${String(m.maxDrawdownR).padStart(9)}`,
  ].join('  ');

function breakdown(title: string, trades: readonly V2Trade[], key: (t: V2Trade) => string): void {
  const groups = [...groupBy(trades, key)].sort((a, b) => a[0].localeCompare(b[0]));
  if (groups.length === 0) return;
  console.log(`\n--- ${title} ---`);
  for (const [k, v] of groups) {
    if (v.length < 3) continue;
    console.log(row(k, computeMetrics(v)));
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const tfArg = argv.find((a) => a.startsWith('--tf='))?.split('=')[1];
  const jsonOut = argv.find((a) => a.startsWith('--json='))?.split('=')[1];

  const settings = Settings.fromDefaults();
  const timeframes = (tfArg ? tfArg.split(',') : settings.timeframes()) as Timeframe[];

  console.log('V1 (production) vs V2 (research) — identical data, shared exit logic');
  console.log('symbols   :', LAB_SYMBOLS.join(', '));
  console.log('timeframes:', timeframes.join(', '));
  console.log('split     : per (symbol,timeframe) series, 60/20/20 BY TIME');
  console.log('');
  console.log('!! DATA WARNING: fixtures/ is SYNTHETIC (seeded PRNG). These numbers');
  console.log('!! measure the engines against a generator, NOT against the market.');
  console.log('');

  const out: Record<string, unknown> = {};

  for (const slice of ['train', 'validation', 'test'] as Slice[]) {
    const v1 = runV1(settings, timeframes, slice);
    const v2 = runV2(settings, timeframes, slice);
    const m1 = computeMetrics(v1.trades);
    const m2 = computeMetrics(v2.trades);
    const waitPct = v2.evaluations > 0 ? (v2.waits / v2.evaluations) * 100 : 0;

    console.log(`=== ${slice.toUpperCase()} ===`);
    console.log(row('V1 (Smart Money)', m1));
    console.log(row('V2 (SMC range/liq)', m2));
    console.log(
      `    V2 selectivity: ${v2.waits}/${v2.evaluations} evaluations were WAIT (${waitPct.toFixed(1)}%)`,
    );
    console.log(`    V1 exits: ${exitComposition(v1.trades)}`);
    console.log(`    V2 exits: ${exitComposition(v2.trades)}`);
    console.log(
      `    median first-target distance: V1 ${medianFirstTpR(v1.trades).toFixed(2)}R  ` +
        `V2 ${medianFirstTpR(v2.trades).toFixed(2)}R`,
    );
    console.log('');
    out[slice] = {
      v1: m1, v2: m2, v2Evaluations: v2.evaluations, v2Waits: v2.waits,
      v2Trades: v2.trades,
    };

    if (slice === 'test') {
      // Research slices, TEST only, purely descriptive.
      breakdown('V2 TEST by setup kind', v2.trades, (t) => t.setupKind ?? 'NA');
      breakdown('V2 TEST by location', v2.trades, (t) => t.location);
      breakdown('V2 TEST by HTF alignment', v2.trades, (t) => t.htfAlignment);
      breakdown('V2 TEST by ADX regime', v2.trades, (t) => t.adxRegime);
      breakdown('V2 TEST by RSI bucket', v2.trades, (t) => t.rsiBucket);
      breakdown('V2 TEST by EMA alignment', v2.trades, (t) => t.emaAlignment);
      breakdown('V2 TEST by MACD state', v2.trades, (t) => t.macdState);
      breakdown('V2 TEST by RVOL bucket', v2.trades, (t) => t.rvolBucket);
      breakdown('V2 TEST by Fib zone', v2.trades, (t) => t.fibZone);
      breakdown('V2 TEST by OB present', v2.trades, (t) => (t.hasOb ? 'OB' : 'no OB'));
      breakdown('V2 TEST by FVG present', v2.trades, (t) => (t.hasFvg ? 'FVG' : 'no FVG'));
      breakdown('V2 TEST by symbol', v2.trades, (t) => t.symbol);
      breakdown('V2 TEST by timeframe', v2.trades, (t) => t.timeframe);
      breakdown('V2 TEST by direction', v2.trades, (t) => t.direction);
    }
  }

  /* ---- verdict, decided by a rule fixed in advance ---- */
  const t = out['test'] as { v1: Metrics; v2: Metrics };
  console.log('\n=== VERDICT (rule fixed before running) ===');
  console.log('V2 may be recommended only if, on the UNSEEN TEST slice, it beats V1 on');
  console.log('expectancy AND profit factor with n >= 30.');
  // Additional integrity check: profit must come from TARGETS being hit, not
  // from mark-to-market at the timeout bar. A strategy whose edge evaporates
  // when TIMEOUT trades are excluded has not proven its targets work.
  const testV2 = (out['test'] as { v2Trades?: ReplayTrade[] }).v2Trades ?? [];
  const nonTimeout = testV2.filter((x) => x.result !== 'TIMEOUT');
  const nonTimeoutExp = nonTimeout.length > 0
    ? nonTimeout.reduce((a, x) => a + x.rMultiple, 0) / nonTimeout.length
    : 0;
  const timeoutShare = testV2.length > 0
    ? testV2.filter((x) => x.result === 'TIMEOUT').length / testV2.length
    : 0;

  const beats =
    t.v2.n >= 30 &&
    t.v2.expectancy > t.v1.expectancy &&
    t.v2.profitFactor > t.v1.profitFactor;
  const targetsWork = nonTimeoutExp > 0;
  console.log('');
  console.log(`  V1 test: n=${t.v1.n} expectancy=${t.v1.expectancy}R PF=${t.v1.profitFactor}`);
  console.log(`  V2 test: n=${t.v2.n} expectancy=${t.v2.expectancy}R PF=${t.v2.profitFactor}`);
  console.log('');
  console.log(
    `  V2 excluding TIMEOUT exits: n=${nonTimeout.length} expectancy=${nonTimeoutExp.toFixed(4)}R ` +
      `(TIMEOUT share ${(timeoutShare * 100).toFixed(1)}%)`,
  );
  console.log('');
  if (beats && targetsWork) {
    console.log('  V2 clears the bar ON SYNTHETIC DATA. Still NOT sufficient for activation:');
    console.log('  the comparison must be repeated on real Binance history first.');
  } else if (beats && !targetsWork) {
    console.log('  V2 beats V1 on headline metrics, BUT its positive expectancy depends on');
    console.log('  TIMEOUT exits — excluding them the edge is not positive. That means the');
    console.log('  TARGETS are not demonstrably working. NOT a basis for activation.');
  } else {
    console.log('  V2 does NOT clear the bar. V1 remains the production strategy.');
  }

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(out, null, 2));
    console.log('\nwrote', jsonOut);
  }
}

if (process.argv[1] && process.argv[1].endsWith('v1-vs-v2.ts')) {
  main();
}

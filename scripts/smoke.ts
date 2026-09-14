/**
 * Local smoke test: a TIME-STEPPED simulation of the live pipeline.
 *
 * Instead of waiting hours for real candles, we hide the tail of the candle
 * history and reveal it one bar at a time, running the real market/strategy/
 * outcome logic at each step. This exercises exactly the production code paths:
 *
 *   closed candle N -> evaluate -> EDGE -> WAITING_ENTRY
 *   candle N+1 appears -> entry = OPEN(N+1) -> ACTIVE
 *   later bars -> TP / SL / TIMEOUT -> outcome row -> slot released
 *
 *   npm run smoke
 */

import { closeDb, getDb, migrate } from '../src/db';
import { seedAdmin, seedSettings } from '../src/db/seed';
import { loadSettings } from '../src/core/settings';
import { createLogger } from '../src/core/logger';
import { runEngineOnce } from '../src/strategy/engine-runner';
import { processOutcomes } from '../src/workers/outcome.worker';
import { BinanceClient } from '../src/market/binance';
import { selectTopSymbols } from '../src/market/top-symbols';
import { upsertCandles, upsertSymbols, getCandles } from '../src/db/repo';
import { explain } from '../src/strategy/scoring';
import { sql } from 'kysely';
import type { Timeframe } from '../src/core/types';

const TF: Timeframe = '1h';
const WARMUP = 420; // candles visible at the start
const STEPS = 160; // candles revealed one at a time

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1] as string;
  return fallback;
}

async function main(): Promise<void> {
  const db = getDb();
  const log = createLogger('smoke', db);

  console.log('=== SMOKE TEST: time-stepped live simulation ===\n');

  await migrate(db);
  await seedSettings(db);
  await seedAdmin(db);

  // Clean slate for the simulation.
  await sql`TRUNCATE outcomes, signals, strategy_state, candles, symbols RESTART IDENTITY CASCADE`.execute(db);

  // --- settings tuned so the run produces a meaningful number of trades ---
  for (const [k, v] of [
    ['engine.timeframes', JSON.stringify([TF])],
    ['engine.score_threshold', '50'],
    ['engine.min_components', '2'],
    ['engine.trading_mode', JSON.stringify('FORWARD_TEST')],
    ['risk.max_concurrent', '20'],
    ['outcome.timeout_bars', '24'],
  ] as Array<[string, string]>) {
    await db.updateTable('settings').set({ value: v }).where('key', '=', k).execute();
  }
  const settings = await loadSettings(db);
  console.log(`mode=${settings.tradingMode()} threshold=${settings.num('engine.score_threshold')} tf=${TF}`);

  // --- TOP-N ---
  const client = new BinanceClient();
  const [tickers, info] = await Promise.all([client.ticker24h(), client.exchangeInfo()]);
  const ranked = selectTopSymbols(tickers, info, settings);
  const symbols = ranked.slice(0, Number(arg('symbols', '6'))).map((r) => r.symbol);
  await upsertSymbols(db, ranked.filter((r) => symbols.includes(r.symbol)));
  console.log(`symbols: ${symbols.join(', ')}\n`);

  // --- pull the full series, then reveal it progressively ---
  const series = new Map<string, Awaited<ReturnType<typeof client.klines>>>();
  for (const s of symbols) {
    series.set(s, await client.klines(s, TF, 1000));
  }

  // warmup
  for (const s of symbols) {
    const all = series.get(s)!;
    await upsertCandles(db, s, TF, all.slice(0, WARMUP).map((c) => ({ ...c, isClosed: true })));
  }
  console.log(`warmup: ${WARMUP} candles per symbol loaded\n`);

  let created = 0;
  let filled = 0;
  let closed = 0;

  for (let step = 0; step < STEPS; step++) {
    const idx = WARMUP + step;
    let advanced = false;
    for (const s of symbols) {
      const all = series.get(s)!;
      const c = all[idx];
      if (!c) continue;
      await upsertCandles(db, s, TF, [{ ...c, isClosed: true }]);
      advanced = true;
    }
    if (!advanced) break;

    const r = await runEngineOnce(db, settings, log);
    created += r.signalsCreated;
    filled += r.entriesFilled;

    const o = await processOutcomes(db, settings, log);
    closed += o.closed;
  }

  console.log(`\n=== simulation complete: ${STEPS} steps ===`);
  console.log(`signals created : ${created}`);
  console.log(`entries filled  : ${filled}`);
  console.log(`outcomes closed : ${closed}\n`);

  // ---------------- verification ----------------
  const rows = await db
    .selectFrom('signals')
    .leftJoin('outcomes', 'outcomes.signal_id', 'signals.id')
    .select([
      'signals.id as id', 'signals.symbol as symbol', 'signals.timeframe as tf',
      'signals.direction as direction', 'signals.state as state', 'signals.mode as mode',
      'signals.score as score', 'signals.setup_candle_time as setup_t',
      'signals.setup_close as setup_close', 'signals.entry_candle_time as entry_t',
      'signals.entry_price as entry', 'signals.stop_loss as sl',
      'signals.take_profits as tps', 'signals.breakdown as breakdown',
      'outcomes.result as result', 'outcomes.exit_price as exit_price',
      'outcomes.r_multiple as r', 'outcomes.bars_held as bars',
    ])
    .orderBy('signals.id')
    .execute();

  const TF_MS = 3_600_000;
  let entryErrors = 0;
  let entryChecked = 0;
  for (const r of rows) {
    if (r.entry_t === null) continue;
    entryChecked++;
    if (Number(r.entry_t) !== Number(r.setup_t) + TF_MS) {
      console.error(`  !! signal ${r.id}: entry candle is not N+1`);
      entryErrors++;
    }
    const cs = await getCandles(db, r.symbol, r.tf as Timeframe, {
      from: Number(r.entry_t), to: Number(r.entry_t), limit: 1,
    });
    const entryCandle = cs[0];
    if (entryCandle && Math.abs(entryCandle.open - (r.entry ?? 0)) > 1e-9) {
      console.error(`  !! signal ${r.id}: entry ${r.entry} != OPEN of N+1 ${entryCandle.open}`);
      entryErrors++;
    }
  }
  console.log(`N+1 entry verification: ${entryChecked} filled signals checked, ${entryErrors} error(s)`);

  // score arithmetic re-check straight from persisted breakdowns
  let mathErrors = 0;
  for (const r of rows) {
    const bd = r.breakdown as unknown as {
      rawScore: number; totalWeight: number; score: number;
      components: Array<{ detector: string; strength: number; weight: number; contribution: number; counted: boolean }>;
    };
    if (!bd?.components) continue;
    const counted = bd.components.filter((c) => c.counted);
    const raw = counted.reduce((s, c) => s + c.contribution, 0);
    const wt = counted.reduce((s, c) => s + c.weight, 0);
    const score = wt > 0 ? (100 * raw) / wt : 0;
    if (Math.abs(score - bd.score) > 0.01) { console.error(`  !! signal ${r.id}: score mismatch`); mathErrors++; }
    for (const c of counted) {
      if (Math.abs(c.contribution - c.strength * c.weight) > 1e-6) {
        console.error(`  !! signal ${r.id}: ${c.detector} contribution != strength*weight`); mathErrors++;
      }
    }
    const names = counted.map((c) => c.detector);
    if (new Set(names).size !== names.length) {
      console.error(`  !! signal ${r.id}: detector counted twice (double counting!)`); mathErrors++;
    }
  }
  console.log(`Score arithmetic + anti-double-counting: ${rows.length} signals checked, ${mathErrors} error(s)`);

  const modes = new Set(rows.map((r) => r.mode));
  console.log(`Modes present: ${[...modes].join(', ')} (LIVE present: ${modes.has('LIVE')})`);

  const byState = rows.reduce<Record<string, number>>((a, r) => {
    a[r.state] = (a[r.state] ?? 0) + 1;
    return a;
  }, {});
  console.log(`Signal states: ${JSON.stringify(byState)}`);

  const done = rows.filter((r) => r.result !== null);
  const wins = done.filter((r) => r.result === 'TP').length;
  const losses = done.filter((r) => r.result === 'SL').length;
  const tos = done.filter((r) => r.result === 'TIMEOUT').length;
  const totalR = done.reduce((s, r) => s + Number(r.r ?? 0), 0);
  console.log(
    `\nOutcomes: ${done.length} closed | ${wins} TP / ${losses} SL / ${tos} TIMEOUT | ` +
      `win rate ${done.length > 0 ? ((wins / done.length) * 100).toFixed(1) : '0'}% | totalR ${totalR.toFixed(3)}`,
  );

  // ---------------- sample evidence ----------------
  const sample = rows.find((r) => r.result !== null) ?? rows[0];
  if (sample) {
    console.log('\n=== SAMPLE SIGNAL (full audit trail) ===');
    console.log(`  #${sample.id} ${sample.symbol} ${sample.tf} ${sample.direction} [${sample.state}] mode=${sample.mode}`);
    console.log(`  setup candle N   : ${new Date(Number(sample.setup_t)).toISOString()} close=${sample.setup_close}`);
    console.log(`  entry candle N+1 : ${sample.entry_t ? new Date(Number(sample.entry_t)).toISOString() : 'pending'}`);
    console.log(`  entry price      : ${sample.entry} (OPEN of N+1)`);
    console.log(`  stop loss        : ${sample.sl}`);
    console.log(`  take profits     : ${JSON.stringify(sample.tps)}`);
    if (sample.result) {
      console.log(`  outcome          : ${sample.result} @ ${sample.exit_price} after ${sample.bars} bars, R=${Number(sample.r).toFixed(3)}`);
    }
    console.log('  --- score breakdown ---');
    for (const line of explain(sample.breakdown as never)) console.log(`  ${line}`);
  }

  const problems = entryErrors + mathErrors + (modes.has('LIVE') ? 1 : 0);
  console.log(`\n=== SMOKE TEST ${problems === 0 ? 'PASSED' : 'FAILED'} (${problems} problem(s)) ===`);

  await closeDb();
  if (problems > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[smoke] failed:', err);
  process.exit(1);
});

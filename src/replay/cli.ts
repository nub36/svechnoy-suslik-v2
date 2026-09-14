/**
 * Historical replay CLI.
 *
 *   npm run replay -- --symbols BTCUSDT,ETHUSDT --timeframes 1h,4h [--save]
 *
 * Uses the SAME Smart Money engine as the live workers.
 */

import { closeDb, getDb, migrate } from '../db';
import { loadSettings, Settings, SETTINGS_BY_KEY, coerceSettingValue } from '../core/settings';
import { replayFromDb, saveReplayRun, type ReplayResult } from './runner';
import { aggregate } from '../outcome/tracker';
import { isTimeframe, type Timeframe } from '../core/types';
import { explain } from '../strategy/scoring';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1] as string;
  return fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const db = getDb();
  await migrate(db);

  let settings = await loadSettings(db);

  // --set key=value (repeatable) for ad-hoc parameter sweeps
  const overrides: Array<[string, unknown]> = [];
  process.argv.forEach((a, i) => {
    if (a === '--set') {
      const kv = process.argv[i + 1];
      if (!kv) return;
      const eq = kv.indexOf('=');
      if (eq < 0) return;
      const key = kv.slice(0, eq);
      const raw = kv.slice(eq + 1);
      const def = SETTINGS_BY_KEY.get(key);
      if (!def) throw new Error(`Unknown setting: ${key}`);
      overrides.push([key, coerceSettingValue(def, raw)]);
    }
  });
  if (overrides.length > 0) {
    settings = Settings.fromEntries([...settings.raw().entries(), ...overrides]);
    console.log(`[replay] overrides: ${overrides.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`);
  }

  const symbolsArg = arg('symbols');
  const symbols =
    symbolsArg.length > 0
      ? symbolsArg.split(',').map((s) => s.trim().toUpperCase())
      : (
          await db
            .selectFrom('symbols')
            .select('symbol')
            .where('enabled', '=', true)
            .orderBy('rank')
            .execute()
        ).map((r) => r.symbol);

  const tfArg = arg('timeframes');
  const timeframes: Timeframe[] = (tfArg.length > 0 ? tfArg.split(',') : settings.timeframes())
    .map((t) => t.trim())
    .filter((t): t is Timeframe => isTimeframe(t));

  if (symbols.length === 0) {
    console.error('[replay] no symbols. Populate the symbols table first.');
    await closeDb();
    process.exit(1);
  }

  console.log(`[replay] engine=SMART_MONEY (identical to live)`);
  console.log(`[replay] symbols: ${symbols.join(', ')}`);
  console.log(`[replay] timeframes: ${timeframes.join(', ')}`);
  console.log(
    `[replay] threshold=${settings.num('engine.score_threshold')} minComponents=${settings.num('engine.min_components')} slAtr=${settings.num('risk.sl_atr_mult')} tp=${JSON.stringify(settings.arr('risk.tp_r_multiples'))}`,
  );

  const results: ReplayResult[] = [];
  for (const symbol of symbols) {
    for (const tf of timeframes) {
      const r = await replayFromDb(db, symbol, tf, settings);
      results.push(r);
      console.log(
        `  ${symbol.padEnd(10)} ${tf.padEnd(4)} candles=${String(r.candlesSeen).padStart(5)} evals=${String(r.evaluations).padStart(5)} trades=${String(r.trades.length).padStart(3)} win=${r.stats.winRate.toFixed(1).padStart(5)}% totalR=${r.stats.totalR.toFixed(2).padStart(7)} avgR=${r.stats.avgR.toFixed(3).padStart(6)} PF=${Number.isFinite(r.stats.profitFactor) ? r.stats.profitFactor.toFixed(2) : 'inf'}`,
      );
    }
  }

  const allClosed = results.flatMap((r) => r.trades.filter((t) => t.result !== 'OPEN'));
  const overall = aggregate(allClosed.map((t) => ({ result: t.result, r_multiple: t.rMultiple })));

  console.log('\n[replay] ---- AGGREGATE ----');
  console.log(`  candles replayed : ${results.reduce((s, r) => s + r.candlesSeen, 0)}`);
  console.log(`  evaluations      : ${results.reduce((s, r) => s + r.evaluations, 0)}`);
  console.log(`  closed trades    : ${overall.total}`);
  console.log(`  wins/losses/TO   : ${overall.wins}/${overall.losses}/${overall.timeouts}`);
  console.log(`  win rate         : ${overall.winRate.toFixed(2)}%`);
  console.log(`  total R          : ${overall.totalR.toFixed(3)}`);
  console.log(`  avg R            : ${overall.avgR.toFixed(4)}`);
  console.log(
    `  profit factor    : ${Number.isFinite(overall.profitFactor) ? overall.profitFactor.toFixed(3) : 'inf'}`,
  );
  console.log(`  max drawdown (R) : ${overall.maxDrawdownR.toFixed(3)}`);

  // Show one full score breakdown as evidence of transparent scoring.
  const sample = allClosed[0];
  if (sample && sample.breakdown) {
    console.log('\n[replay] ---- SAMPLE SCORE BREAKDOWN ----');
    console.log(
      `  ${sample.symbol} ${sample.timeframe} ${sample.direction} setupN=${new Date(sample.setupCandleTime).toISOString()}`,
    );
    console.log(
      `  entry(N+1 open)=${sample.entryPrice} SL=${sample.stopLoss} TP=${sample.takeProfits.join(',')} -> ${sample.result} R=${sample.rMultiple.toFixed(3)}`,
    );
    for (const line of explain(sample.breakdown as never)) console.log(`  ${line}`);
  }

  if (flag('save')) {
    const times = allClosed.map((t) => t.setupCandleTime);
    const id = await saveReplayRun(
      db,
      arg('label', `cli replay ${new Date().toISOString()}`),
      results,
      settings,
      times.length > 0 ? Math.min(...times) : 0,
      times.length > 0 ? Math.max(...times) : 0,
    );
    console.log(`\n[replay] saved as run #${id}`);
  }

  await closeDb();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[replay] failed:', err);
    process.exit(1);
  });
}

/**
 * Populate the live tables with a realistic signal/outcome history WITHOUT
 * touching the candle data, so the UI has something to show immediately after
 * a fresh bootstrap.
 *
 * It walks the stored candles forward one bar at a time and runs the real
 * engine + outcome tracker at each step, exactly like the workers would over
 * time. Candles are never modified or deleted.
 *
 *   npm run seed:history -- --timeframe 1h --steps 200
 */

import { sql } from 'kysely';
import { closeDb, getDb } from '../src/db';
import { loadSettings } from '../src/core/settings';
import { createLogger } from '../src/core/logger';
import { runEngineOnce } from '../src/strategy/engine-runner';
import { processOutcomes } from '../src/workers/outcome.worker';
import { getCandles } from '../src/db/repo';
import { tfMs, type Timeframe } from '../src/core/types';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : fallback;
}

async function main(): Promise<void> {
  const db = getDb();
  const log = createLogger('seed-history', db);
  const tf = arg('timeframe', '1h') as Timeframe;
  const steps = Number(arg('steps', '200'));

  // SINGLE WRITER: this script writes the same tables as the strategy/outcome
  // workers. Running both at once deadlocks Postgres, so refuse to start while
  // a worker heartbeat is fresh.
  const live = await db
    .selectFrom('worker_heartbeats')
    .select(['worker', 'last_beat'])
    .where('worker', 'in', ['strategy', 'outcome'])
    .execute();
  const stale = 90_000;
  const busy = live.filter((w) => Date.now() - new Date(w.last_beat).getTime() < stale);
  if (busy.length > 0 && !process.argv.includes('--force')) {
    console.error(
      `[seed-history] refusing to run: ${busy.map((w) => w.worker).join(', ')} worker(s) are live.\n` +
        `  Stop them first (pm2 stop svechnoy-suslik-v2-strategy svechnoy-suslik-v2-outcome), or pass --force.`,
    );
    await closeDb();
    process.exit(1);
  }

  // Clear only the derived tables; candles and symbols stay untouched.
  await sql`TRUNCATE outcomes, signals, strategy_state RESTART IDENTITY CASCADE`.execute(db);

  const settings = await loadSettings(db);
  const symbols = (await db.selectFrom('symbols').select('symbol').where('enabled', '=', true).execute())
    .map((r) => r.symbol);

  // Determine the time window to walk.
  const anchor = symbols[0];
  if (anchor === undefined) throw new Error('no symbols; run npm run bootstrap first');
  const all = await getCandles(db, anchor, tf, { limit: 5000 });
  if (all.length === 0) throw new Error(`no ${tf} candles; run npm run bootstrap first`);

  const start = Math.max(0, all.length - steps);
  console.log(`[seed-history] ${symbols.length} symbols, ${tf}, stepping ${all.length - start} bars`);

  let created = 0;
  let filled = 0;
  let closed = 0;

  for (let i = start; i < all.length; i++) {
    const asOf = all[i]!.openTime;
    // Only let the engine see candles up to `asOf`. Both directions must be
    // written: as the clock advances, previously-hidden candles have to become
    // closed again, otherwise the outcome tracker never sees any exit bars.
    await db.updateTable('candles').set({ is_closed: true })
      .where('timeframe', '=', tf).where('open_time', '<=', asOf).execute();
    await db.updateTable('candles').set({ is_closed: false })
      .where('timeframe', '=', tf).where('open_time', '>', asOf).execute();

    const r = await runEngineOnce(db, settings, log);
    created += r.signalsCreated;
    filled += r.entriesFilled;
    const o = await processOutcomes(db, settings, log);
    closed += o.closed;
  }

  // Restore every candle to CLOSED (the market worker's own view of history).
  await db.updateTable('candles').set({ is_closed: true }).where('timeframe', '=', tf).execute();

  console.log(`[seed-history] created=${created} filled=${filled} closed=${closed}`);
  await closeDb();
}

main().catch((e) => {
  console.error('[seed-history] failed:', e);
  process.exit(1);
});

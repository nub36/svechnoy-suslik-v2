/**
 * Bootstrap: migrate, seed settings/admin, populate the TOP-N symbol list and
 * backfill candles for every configured timeframe.
 *
 * Works online (real Binance) or offline (BINANCE_OFFLINE=true + fixtures).
 *
 *   npm run bootstrap
 *   npm run bootstrap -- --timeframes 1m,5m,15m,30m,1h,4h,1d,1w
 */

import { closeDb, getDb, migrate } from '../src/db';
import { seedAdmin, seedSettings } from '../src/db/seed';
import { loadSettings } from '../src/core/settings';
import { BinanceClient } from '../src/market/binance';
import { selectTopSymbols } from '../src/market/top-symbols';
import { upsertCandles, upsertSymbols } from '../src/db/repo';
import { isTimeframe, tfMs, type Timeframe } from '../src/core/types';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1] as string;
  return fallback;
}

async function main(): Promise<void> {
  const db = getDb();
  console.log('[bootstrap] applying schema…');
  await migrate(db);

  console.log('[bootstrap] seeding settings + admin…');
  await seedSettings(db);
  await seedAdmin(db);

  const settings = await loadSettings(db);
  const client = new BinanceClient();
  const online = await client.ping();
  console.log(`[bootstrap] binance reachable: ${online} (${client.usingFixtures || !online ? 'using fixtures' : 'live'})`);

  const [tickers, info] = await Promise.all([client.ticker24h(), client.exchangeInfo()]);
  const ranked = selectTopSymbols(tickers, info, settings);
  await upsertSymbols(db, ranked);
  console.log(
    `[bootstrap] TOP-${ranked.length}: ${ranked.map((r) => `${r.rank}.${r.symbol}`).join(' ')}`,
  );

  const tfArg = arg('timeframes');
  const timeframes: Timeframe[] = (tfArg ? tfArg.split(',') : settings.timeframes())
    .map((t) => t.trim())
    .filter((t): t is Timeframe => isTimeframe(t));

  const limit = Math.floor(settings.num('market.candle_limit'));
  let total = 0;
  for (const r of ranked) {
    for (const tf of timeframes) {
      try {
        const raw = await client.klines(r.symbol, tf, limit);
        const stamped = raw.map((c) => ({ ...c, isClosed: c.openTime + tfMs(tf) <= Date.now() }));
        const n = await upsertCandles(db, r.symbol, tf, stamped);
        total += n;
        const closed = stamped.filter((c) => c.isClosed).length;
        console.log(`  ${r.symbol.padEnd(10)} ${tf.padEnd(4)} ${String(n).padStart(4)} candles (${closed} closed)`);
      } catch (err) {
        console.warn(`  ${r.symbol} ${tf} FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  console.log(`[bootstrap] done: ${total} candles across ${timeframes.length} timeframe(s)`);
  await closeDb();
}

main().catch((err) => {
  console.error('[bootstrap] failed:', err);
  process.exit(1);
});

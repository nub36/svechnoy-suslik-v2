/**
 * MARKET worker — the ONLY writer of `symbols` and `candles`.
 *
 * Responsibilities:
 *  - refresh the Binance Spot USDT TOP-N by 24h quote volume
 *  - poll klines for every active symbol x active timeframe
 *  - store candles (marking the forming bar is_closed=false)
 *  - trim history to the configured retention
 */

import { getDb, closeDb, migrate } from '../db';
import { loadSettings } from '../core/settings';
import { createLogger } from '../core/logger';
import { getBinance } from '../market/binance';
import { selectTopSymbols } from '../market/top-symbols';
import { heartbeat, trimCandles, upsertCandles, upsertSymbols, getActiveSymbols } from '../db/repo';
import { config } from '../core/config';
import { tfMs, type Timeframe } from '../core/types';

const WORKER = 'market';

async function tick(state: { loops: number; errors: number; lastTopRefresh: number }): Promise<void> {
  const db = getDb();
  const log = createLogger(WORKER, db);
  const settings = await loadSettings(db);
  const binance = getBinance();

  const refreshMs = settings.num('market.refresh_top_minutes') * 60_000;
  const now = Date.now();

  if (now - state.lastTopRefresh >= refreshMs) {
    try {
      const [tickers, info] = await Promise.all([binance.ticker24h(), binance.exchangeInfo()]);
      const ranked = selectTopSymbols(tickers, info, settings);
      if (ranked.length > 0) {
        await upsertSymbols(db, ranked);
        state.lastTopRefresh = now;
        log.info(`TOP-${ranked.length} refreshed`, {
          symbols: ranked.map((r) => `${r.rank}:${r.symbol}`).join(','),
          source: binance.usingFixtures ? 'fixtures' : 'binance-live',
        });
      }
    } catch (err) {
      state.errors++;
      log.error('TOP-N refresh failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const symbols = await getActiveSymbols(db);
  const timeframes = settings.timeframes();
  const limit = Math.floor(settings.num('market.candle_limit'));
  const retention = Math.floor(settings.num('system.candle_retention_per_series'));

  for (const s of symbols) {
    for (const tf of timeframes) {
      try {
        const candles = await binance.klines(s.symbol, tf, limit);
        if (candles.length === 0) continue;
        // Recompute isClosed against our own clock for determinism.
        const stamped = candles.map((c) => ({
          ...c,
          isClosed: c.openTime + tfMs(tf) <= Date.now(),
        }));
        await upsertCandles(db, s.symbol, tf, stamped);
        await trimCandles(db, s.symbol, tf, retention);
      } catch (err) {
        state.errors++;
        log.warn(`klines ${s.symbol} ${tf} failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  state.loops++;
  await heartbeat(
    db,
    WORKER,
    state.errors > 0 ? 'DEGRADED' : 'OK',
    `${symbols.length} symbols x ${timeframes.length} tf${binance.usingFixtures ? ' (fixtures)' : ''}`,
    state.loops,
    state.errors,
  );
}

async function main(): Promise<void> {
  const log = createLogger(WORKER);
  log.info('market worker starting', { mode: config.tradingMode, loopMs: config.marketLoopMs });
  await migrate();

  const state = { loops: 0, errors: 0, lastTopRefresh: 0 };
  let running = true;
  const stop = async (): Promise<void> => {
    running = false;
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  while (running) {
    try {
      await tick(state);
    } catch (err) {
      state.errors++;
      log.error('market loop error', { error: err instanceof Error ? err.message : String(err) });
    }
    await new Promise((r) => setTimeout(r, config.marketLoopMs));
  }
}

if (require.main === module) {
  void main();
}

export { tick as marketTick };
export type { Timeframe };

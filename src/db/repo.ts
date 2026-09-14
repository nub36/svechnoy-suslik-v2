/**
 * Data access helpers shared by workers, web APIs and replay.
 */

import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from './types';
import type { Candle, Direction, SignalState, StrategyState, Timeframe } from '../core/types';
import type { MachineState } from '../strategy/state-machine';
import { initialState } from '../strategy/state-machine';
import type { RankedSymbol } from '../market/top-symbols';

/* ---------------------------- symbols ---------------------------- */

export async function upsertSymbols(
  db: Kysely<Database>,
  ranked: readonly RankedSymbol[],
): Promise<void> {
  if (ranked.length === 0) return;
  await db.transaction().execute(async (trx) => {
    // Demote everything first so stale members leave the TOP-N.
    await trx.updateTable('symbols').set({ enabled: false, rank: 0 }).execute();
    for (const r of ranked) {
      await trx
        .insertInto('symbols')
        .values({
          symbol: r.symbol,
          base_asset: r.baseAsset,
          quote_asset: r.quoteAsset,
          enabled: true,
          rank: r.rank,
          quote_volume_24h: r.quoteVolume24h,
          last_price: r.lastPrice,
          price_change_pct: r.priceChangePct,
          tick_size: r.tickSize,
          step_size: r.stepSize,
          min_notional: r.minNotional,
          updated_at: new Date(),
        })
        .onConflict((oc) =>
          oc.column('symbol').doUpdateSet({
            base_asset: r.baseAsset,
            quote_asset: r.quoteAsset,
            enabled: true,
            rank: r.rank,
            quote_volume_24h: r.quoteVolume24h,
            last_price: r.lastPrice,
            price_change_pct: r.priceChangePct,
            tick_size: r.tickSize,
            step_size: r.stepSize,
            min_notional: r.minNotional,
            updated_at: new Date(),
          }),
        )
        .execute();
    }
  });
}

export async function getActiveSymbols(db: Kysely<Database>): Promise<
  Array<{
    symbol: string;
    rank: number;
    baseAsset: string;
    lastPrice: number;
    quoteVolume24h: number;
    priceChangePct: number;
    /** Binance PRICE_FILTER tickSize — drives display precision in the UI. */
    tickSize: number;
  }>
> {
  const rows = await db
    .selectFrom('symbols')
    .selectAll()
    .where('enabled', '=', true)
    .orderBy('rank', 'asc')
    .execute();
  return rows.map((r) => ({
    symbol: r.symbol,
    rank: r.rank,
    baseAsset: r.base_asset,
    lastPrice: r.last_price,
    quoteVolume24h: r.quote_volume_24h,
    priceChangePct: r.price_change_pct,
    tickSize: r.tick_size,
  }));
}

/* ---------------------------- candles ---------------------------- */

export async function upsertCandles(
  db: Kysely<Database>,
  symbol: string,
  timeframe: Timeframe,
  candles: readonly Candle[],
): Promise<number> {
  if (candles.length === 0) return 0;
  let n = 0;
  const CHUNK = 200;
  for (let i = 0; i < candles.length; i += CHUNK) {
    const slice = candles.slice(i, i + CHUNK);
    await db
      .insertInto('candles')
      .values(
        slice.map((c) => ({
          symbol,
          timeframe,
          open_time: c.openTime,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          close_time: c.closeTime,
          quote_volume: c.quoteVolume,
          trades: c.trades,
          is_closed: c.isClosed,
        })),
      )
      .onConflict((oc) =>
        oc.columns(['symbol', 'timeframe', 'open_time']).doUpdateSet((eb) => ({
          open: eb.ref('excluded.open'),
          high: eb.ref('excluded.high'),
          low: eb.ref('excluded.low'),
          close: eb.ref('excluded.close'),
          volume: eb.ref('excluded.volume'),
          close_time: eb.ref('excluded.close_time'),
          quote_volume: eb.ref('excluded.quote_volume'),
          trades: eb.ref('excluded.trades'),
          is_closed: eb.ref('excluded.is_closed'),
        })),
      )
      .execute();
    n += slice.length;
  }
  return n;
}

export interface GetCandlesOpts {
  closedOnly?: boolean;
  limit?: number;
  from?: number;
  to?: number;
  order?: 'asc' | 'desc';
}

export async function getCandles(
  db: Kysely<Database>,
  symbol: string,
  timeframe: Timeframe,
  opts: GetCandlesOpts = {},
): Promise<Candle[]> {
  let q = db
    .selectFrom('candles')
    .selectAll()
    .where('symbol', '=', symbol)
    .where('timeframe', '=', timeframe);

  if (opts.closedOnly) q = q.where('is_closed', '=', true);
  if (opts.from !== undefined) q = q.where('open_time', '>=', opts.from);
  if (opts.to !== undefined) q = q.where('open_time', '<=', opts.to);

  // Take the most recent N, then return ascending.
  q = q.orderBy('open_time', 'desc');
  if (opts.limit !== undefined) q = q.limit(opts.limit);

  const rows = await q.execute();
  const mapped: Candle[] = rows.map((r) => ({
    openTime: Number(r.open_time),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    closeTime: Number(r.close_time),
    quoteVolume: r.quote_volume,
    trades: r.trades,
    isClosed: r.is_closed,
  }));
  mapped.sort((a, b) => a.openTime - b.openTime);
  if (opts.order === 'desc') mapped.reverse();
  return mapped;
}

export async function trimCandles(
  db: Kysely<Database>,
  symbol: string,
  timeframe: Timeframe,
  keep: number,
): Promise<void> {
  await sql`
    DELETE FROM candles
    WHERE symbol = ${symbol} AND timeframe = ${timeframe}
      AND open_time < (
        SELECT COALESCE(MIN(open_time), 0) FROM (
          SELECT open_time FROM candles
          WHERE symbol = ${symbol} AND timeframe = ${timeframe}
          ORDER BY open_time DESC LIMIT ${keep}
        ) t
      )
  `.execute(db);
}

/* ------------------------- strategy state ------------------------- */

export async function loadState(
  db: Kysely<Database>,
  symbol: string,
  timeframe: Timeframe,
): Promise<MachineState> {
  const row = await db
    .selectFrom('strategy_state')
    .selectAll()
    .where('symbol', '=', symbol)
    .where('timeframe', '=', timeframe)
    .executeTakeFirst();
  if (!row) return initialState(symbol, timeframe);
  return {
    symbol: row.symbol,
    timeframe: row.timeframe as Timeframe,
    state: row.state as StrategyState,
    direction: (row.direction as Direction | null) ?? null,
    initialised: row.initialised !== false,
    lastCandleTime: Number(row.last_candle_time),
    setupCandleTime: row.setup_candle_time === null ? null : Number(row.setup_candle_time),
    setupScore: row.setup_score,
    activeSignalId: row.active_signal_id === null ? null : Number(row.active_signal_id),
  };
}

export async function saveState(db: Kysely<Database>, s: MachineState): Promise<void> {
  await db
    .insertInto('strategy_state')
    .values({
      symbol: s.symbol,
      timeframe: s.timeframe,
      state: s.state,
      direction: s.direction,
      last_candle_time: s.lastCandleTime,
      setup_candle_time: s.setupCandleTime,
      setup_score: s.setupScore,
      active_signal_id: s.activeSignalId,
      initialised: s.initialised,
      payload: JSON.stringify({}),
      updated_at: new Date(),
    })
    .onConflict((oc) =>
      oc.columns(['symbol', 'timeframe']).doUpdateSet({
        state: s.state,
        direction: s.direction,
        last_candle_time: s.lastCandleTime,
        setup_candle_time: s.setupCandleTime,
        setup_score: s.setupScore,
        active_signal_id: s.activeSignalId,
        initialised: s.initialised,
        updated_at: new Date(),
      }),
    )
    .execute();
}

export async function listStates(db: Kysely<Database>): Promise<
  Array<{ symbol: string; timeframe: string; state: string; direction: string | null; lastCandleTime: number; activeSignalId: number | null }>
> {
  const rows = await db.selectFrom('strategy_state').selectAll().orderBy('symbol').execute();
  return rows.map((r) => ({
    symbol: r.symbol,
    timeframe: r.timeframe,
    state: r.state,
    direction: r.direction,
    lastCandleTime: Number(r.last_candle_time),
    activeSignalId: r.active_signal_id === null ? null : Number(r.active_signal_id),
  }));
}

/* ---------------------------- heartbeats ---------------------------- */

export async function heartbeat(
  db: Kysely<Database>,
  worker: string,
  status: string,
  detail: string,
  loops: number,
  errors: number,
): Promise<void> {
  await db
    .insertInto('worker_heartbeats')
    .values({
      worker,
      status,
      detail,
      loops,
      errors,
      last_beat: new Date(),
      started_at: new Date(),
    })
    .onConflict((oc) =>
      oc.column('worker').doUpdateSet({ status, detail, loops, errors, last_beat: new Date() }),
    )
    .execute();
}

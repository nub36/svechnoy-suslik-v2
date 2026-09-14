/**
 * Real-PostgreSQL integration tests for the persistence layer.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { getTestPg, resetDb } from './pg';
import type { Database } from '../src/db/types';
import {
  getActiveSymbols,
  getCandles,
  loadState,
  saveState,
  trimCandles,
  upsertCandles,
  upsertSymbols,
  heartbeat,
  listStates,
} from '../src/db/repo';
import { seedSettings, seedAdmin } from '../src/db/seed';
import { loadSettings, SETTINGS_REGISTRY } from '../src/core/settings';
import { candle } from './helpers';
import type { RankedSymbol } from '../src/market/top-symbols';

let db: Kysely<Database>;
const T0 = 1_700_000_000_000;
const H = 3_600_000;

beforeAll(async () => {
  const pg = await getTestPg();
  db = pg.db;
}, 120_000);

afterAll(async () => {
  const pg = await getTestPg();
  await pg.stop();
});

beforeEach(async () => {
  await resetDb(db);
});

function ranked(symbol: string, rank: number, vol: number): RankedSymbol {
  return {
    symbol,
    baseAsset: symbol.replace('USDT', ''),
    quoteAsset: 'USDT',
    rank,
    quoteVolume24h: vol,
    lastPrice: 100,
    priceChangePct: 1.5,
    tickSize: 0.01,
    stepSize: 0.001,
    minNotional: 5,
  };
}

describe('schema', () => {
  it('creates every expected table', async () => {
    const rows = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `.execute(db);
    const names = rows.rows.map((r) => r.table_name).sort();
    for (const t of [
      'symbols', 'candles', 'strategy_state', 'signals', 'outcomes',
      'settings', 'admin_users', 'admin_sessions', 'worker_heartbeats',
      'engine_log', 'replay_runs',
    ]) {
      expect(names, `missing table ${t}`).toContain(t);
    }
  });

  it('is idempotent (migrate runs twice safely)', async () => {
    const { migrate } = await import('../src/db');
    await expect(migrate(db)).resolves.not.toThrow();
  });
});

describe('symbols / TOP-N persistence', () => {
  it('stores the ranked TOP-N and demotes dropouts', async () => {
    await upsertSymbols(db, [ranked('BTCUSDT', 1, 9e9), ranked('ETHUSDT', 2, 5e9)]);
    let active = await getActiveSymbols(db);
    expect(active.map((a) => a.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);

    // ETH drops out, SOL enters
    await upsertSymbols(db, [ranked('BTCUSDT', 1, 9e9), ranked('SOLUSDT', 2, 6e9)]);
    active = await getActiveSymbols(db);
    expect(active.map((a) => a.symbol)).toEqual(['BTCUSDT', 'SOLUSDT']);

    const eth = await db
      .selectFrom('symbols').select(['enabled', 'rank'])
      .where('symbol', '=', 'ETHUSDT').executeTakeFirst();
    expect(eth!.enabled).toBe(false);
  });

  it('returns symbols ordered by rank', async () => {
    await upsertSymbols(db, [
      ranked('CUSDT', 3, 1e9), ranked('AUSDT', 1, 3e9), ranked('BUSDT', 2, 2e9),
    ]);
    const active = await getActiveSymbols(db);
    expect(active.map((a) => a.rank)).toEqual([1, 2, 3]);
    expect(active[0]!.symbol).toBe('AUSDT');
  });
});

describe('candles', () => {
  it('upserts and reads back candles in ascending time order', async () => {
    const cs = Array.from({ length: 5 }, (_, i) => candle(T0 + i * H, 100 + i, 101 + i, 99 + i, 100.5 + i));
    await upsertCandles(db, 'BTCUSDT', '1h', cs);
    const back = await getCandles(db, 'BTCUSDT', '1h', {});
    expect(back).toHaveLength(5);
    expect(back[0]!.openTime).toBe(T0);
    expect(back[4]!.openTime).toBe(T0 + 4 * H);
    expect(back[2]!.close).toBeCloseTo(102.5, 9);
  });

  it('upsert is idempotent and updates values in place', async () => {
    await upsertCandles(db, 'BTCUSDT', '1h', [candle(T0, 100, 101, 99, 100)]);
    await upsertCandles(db, 'BTCUSDT', '1h', [candle(T0, 100, 105, 95, 104)]);
    const back = await getCandles(db, 'BTCUSDT', '1h', {});
    expect(back).toHaveLength(1);
    expect(back[0]!.high).toBe(105);
    expect(back[0]!.close).toBe(104);
  });

  it('filters to closed candles only', async () => {
    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(T0, 100, 101, 99, 100, 1000, true),
      candle(T0 + H, 100, 101, 99, 100, 1000, false),
    ]);
    expect(await getCandles(db, 'BTCUSDT', '1h', {})).toHaveLength(2);
    expect(await getCandles(db, 'BTCUSDT', '1h', { closedOnly: true })).toHaveLength(1);
  });

  it('limit returns the MOST RECENT candles, still ascending', async () => {
    const cs = Array.from({ length: 20 }, (_, i) => candle(T0 + i * H, 100, 101, 99, 100 + i));
    await upsertCandles(db, 'BTCUSDT', '1h', cs);
    const back = await getCandles(db, 'BTCUSDT', '1h', { limit: 5 });
    expect(back).toHaveLength(5);
    expect(back[0]!.openTime).toBe(T0 + 15 * H);
    expect(back[4]!.openTime).toBe(T0 + 19 * H);
  });

  it('separates series by symbol and timeframe', async () => {
    await upsertCandles(db, 'BTCUSDT', '1h', [candle(T0, 1, 1, 1, 1)]);
    await upsertCandles(db, 'BTCUSDT', '4h', [candle(T0, 2, 2, 2, 2)]);
    await upsertCandles(db, 'ETHUSDT', '1h', [candle(T0, 3, 3, 3, 3)]);
    expect((await getCandles(db, 'BTCUSDT', '1h', {}))[0]!.close).toBe(1);
    expect((await getCandles(db, 'BTCUSDT', '4h', {}))[0]!.close).toBe(2);
    expect((await getCandles(db, 'ETHUSDT', '1h', {}))[0]!.close).toBe(3);
  });

  it('trims history to the retention limit', async () => {
    const cs = Array.from({ length: 50 }, (_, i) => candle(T0 + i * H, 100, 101, 99, 100));
    await upsertCandles(db, 'BTCUSDT', '1h', cs);
    await trimCandles(db, 'BTCUSDT', '1h', 10);
    const back = await getCandles(db, 'BTCUSDT', '1h', {});
    expect(back).toHaveLength(10);
    expect(back[0]!.openTime).toBe(T0 + 40 * H);
  });
});

describe('strategy state persistence', () => {
  it('returns a fresh IDLE state when nothing is stored', async () => {
    const st = await loadState(db, 'BTCUSDT', '1h');
    expect(st.state).toBe('IDLE');
    expect(st.lastCandleTime).toBe(0);
  });

  it('round-trips the machine state', async () => {
    await saveState(db, {
      symbol: 'BTCUSDT', timeframe: '1h', state: 'WAITING_ENTRY', direction: 'LONG',
      lastCandleTime: T0, setupCandleTime: T0, setupScore: 72.5, activeSignalId: null,
    });
    const st = await loadState(db, 'BTCUSDT', '1h');
    expect(st.state).toBe('WAITING_ENTRY');
    expect(st.direction).toBe('LONG');
    expect(st.lastCandleTime).toBe(T0);
    expect(st.setupScore).toBeCloseTo(72.5, 6);
  });

  it('survives a simulated restart (state is durable, not in-memory)', async () => {
    await saveState(db, {
      symbol: 'ETHUSDT', timeframe: '4h', state: 'ACTIVE', direction: 'SHORT',
      lastCandleTime: T0 + 5 * H, setupCandleTime: T0, setupScore: 66, activeSignalId: 42,
    });
    // A brand-new load (as a restarted worker would do)
    const st = await loadState(db, 'ETHUSDT', '4h');
    expect(st.state).toBe('ACTIVE');
    expect(st.activeSignalId).toBe(42);
    expect(st.lastCandleTime).toBe(T0 + 5 * H);
  });

  it('lists all states', async () => {
    await saveState(db, {
      symbol: 'A', timeframe: '1h', state: 'IDLE', direction: null,
      lastCandleTime: 1, setupCandleTime: null, setupScore: null, activeSignalId: null,
    });
    await saveState(db, {
      symbol: 'B', timeframe: '1h', state: 'ACTIVE', direction: 'LONG',
      lastCandleTime: 2, setupCandleTime: 1, setupScore: 60, activeSignalId: 7,
    });
    expect(await listStates(db)).toHaveLength(2);
  });
});

describe('signals table constraints', () => {
  async function insertSignal(setupTime: number) {
    return db.insertInto('signals').values({
      symbol: 'BTCUSDT', timeframe: '1h', direction: 'LONG', state: 'WAITING_ENTRY',
      mode: 'DRY_RUN', source: 'LIVE_ENGINE', replay_run_id: null,
      score: 70, threshold: 55, breakdown: JSON.stringify({}), events: JSON.stringify([]),
      setup_candle_time: setupTime, setup_close: 100,
      take_profits: JSON.stringify([]),
    }).onConflict((oc) => oc.doNothing()).returning('id').executeTakeFirst();
  }

  it('enforces one signal per (symbol,timeframe,setup candle) — EDGE only', async () => {
    const a = await insertSignal(T0);
    expect(a).toBeTruthy();
    const b = await insertSignal(T0); // duplicate edge
    expect(b).toBeUndefined();
    const rows = await db.selectFrom('signals').selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  it('allows a new signal on a different setup candle', async () => {
    await insertSignal(T0);
    const b = await insertSignal(T0 + H);
    expect(b).toBeTruthy();
  });

  it('entry fields are NULL until N+1 is resolved', async () => {
    await insertSignal(T0);
    const row = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    expect(row.entry_price).toBeNull();
    expect(row.entry_candle_time).toBeNull();
    expect(row.state).toBe('WAITING_ENTRY');
  });

  it('cascades outcome deletion with its signal', async () => {
    const s = await insertSignal(T0);
    await db.insertInto('outcomes').values({
      signal_id: Number(s!.id), result: 'TP', exit_price: 110, exit_candle_time: T0 + H,
      bars_held: 1, pnl_pct: 10, pnl_quote: 5, r_multiple: 2,
      max_favorable_pct: 10, max_adverse_pct: 0, tp_hit_index: 0,
    }).execute();
    await db.deleteFrom('signals').where('id', '=', Number(s!.id)).execute();
    expect(await db.selectFrom('outcomes').selectAll().execute()).toHaveLength(0);
  });

  it('one outcome per signal', async () => {
    const s = await insertSignal(T0);
    const vals = {
      signal_id: Number(s!.id), result: 'TP', exit_price: 110, exit_candle_time: T0 + H,
      bars_held: 1, pnl_pct: 10, pnl_quote: 5, r_multiple: 2,
      max_favorable_pct: 10, max_adverse_pct: 0, tp_hit_index: 0,
    };
    await db.insertInto('outcomes').values(vals).execute();
    await expect(db.insertInto('outcomes').values(vals).execute()).rejects.toThrow();
  });
});

describe('settings persistence', () => {
  it('seeds every registry key with correct JSON types', async () => {
    await seedSettings(db);
    const s = await loadSettings(db);
    expect(s.num('engine.score_threshold')).toBe(55);
    expect(s.bool('engine.enabled')).toBe(true);
    expect(s.str('market.quote_asset')).toBe('USDT');
    expect(s.arr<string>('engine.timeframes')).toEqual(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']);
    expect(s.tpMultiples()).toEqual([1, 2, 3]);

    const rows = await db.selectFrom('settings').selectAll().execute();
    expect(rows).toHaveLength(SETTINGS_REGISTRY.length);
  });

  it('re-seeding preserves admin-modified values', async () => {
    await seedSettings(db);
    await db.updateTable('settings')
      .set({ value: JSON.stringify(88) })
      .where('key', '=', 'engine.score_threshold').execute();

    await seedSettings(db); // simulate a redeploy
    const s = await loadSettings(db);
    expect(s.num('engine.score_threshold')).toBe(88);
  });

  it('changed settings reach the engine via loadSettings', async () => {
    await seedSettings(db);
    await db.updateTable('settings')
      .set({ value: JSON.stringify(['1m', '1d']) })
      .where('key', '=', 'engine.timeframes').execute();
    const s = await loadSettings(db);
    expect(s.timeframes()).toEqual(['1m', '1d']);
  });
});

describe('admin + heartbeats', () => {
  it('creates an admin user once with a bcrypt hash', async () => {
    await seedAdmin(db, 'admin', 'secret123');
    await seedAdmin(db, 'admin', 'secret123');
    const rows = await db.selectFrom('admin_users').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.password_hash).toMatch(/^\$2[aby]\$/);
    expect(rows[0]!.password_hash).not.toContain('secret123');
  });

  it('upserts worker heartbeats', async () => {
    await heartbeat(db, 'market', 'OK', 'first', 1, 0);
    await heartbeat(db, 'market', 'DEGRADED', 'second', 5, 2);
    const rows = await db.selectFrom('worker_heartbeats').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('DEGRADED');
    expect(Number(rows[0]!.loops)).toBe(5);
  });
});

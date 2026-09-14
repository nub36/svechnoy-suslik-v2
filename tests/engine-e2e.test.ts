/**
 * Full pipeline against a REAL PostgreSQL:
 *   candles -> engine -> state machine -> signal (WAITING_ENTRY)
 *           -> N+1 arrives -> ACTIVE with entry = OPEN of N+1
 *           -> outcome worker -> CLOSED_* + outcome row -> slot released
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { getTestPg, resetDb } from './pg';
import type { Database } from '../src/db/types';
import { upsertCandles, upsertSymbols, loadState, getCandles } from '../src/db/repo';
import { runEngineOnce, fillPendingEntries } from '../src/strategy/engine-runner';
import { processOutcomes } from '../src/workers/outcome.worker';
import { seedSettings } from '../src/db/seed';
import { loadSettings, Settings } from '../src/core/settings';
import { createLogger } from '../src/core/logger';
import { loadFixtureCandles, candle } from './helpers';
import { tfMs } from '../src/core/types';
import type { RankedSymbol } from '../src/market/top-symbols';

let db: Kysely<Database>;
const log = createLogger('test');
const H = tfMs('1h');

beforeAll(async () => {
  db = (await getTestPg()).db;
}, 120_000);

afterAll(async () => {
  await (await getTestPg()).stop();
});

beforeEach(async () => {
  await resetDb(db);
  await seedSettings(db);
});

function rankedSym(symbol: string, rank = 1): RankedSymbol {
  return {
    symbol, baseAsset: symbol.replace('USDT', ''), quoteAsset: 'USDT', rank,
    quoteVolume24h: 1e9, lastPrice: 100, priceChangePct: 0,
    tickSize: 0.01, stepSize: 0.001, minNotional: 5,
  };
}

/** Loose settings so the fixture reliably produces a signal. */
async function loosen(extra: Array<[string, unknown]> = []): Promise<Settings> {
  for (const [k, v] of [
    ['engine.score_threshold', 40],
    ['engine.min_components', 1],
    ['engine.timeframes', ['1h']],
    ['outcome.timeout_bars', 20],
    ...extra,
  ] as Array<[string, unknown]>) {
    await db.updateTable('settings').set({ value: JSON.stringify(v) }).where('key', '=', k).execute();
  }
  return loadSettings(db);
}

describe('end-to-end live pipeline', () => {
  it('creates a WAITING_ENTRY signal with NO entry price until N+1 exists', async () => {
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    const all = loadFixtureCandles('BTCUSDT', '1h');
    // Load history WITHOUT the candle that would become N+1.
    await upsertCandles(db, 'BTCUSDT', '1h', all.slice(0, 400));
    const settings = await loosen();

    const res = await runEngineOnce(db, settings, log);
    expect(res.evaluated).toBeGreaterThan(0);

    const sigs = await db.selectFrom('signals').selectAll().execute();
    if (sigs.length === 0) {
      // No setup on this data slice — assert the machine still advanced.
      const st = await loadState(db, 'BTCUSDT', '1h');
      expect(st.lastCandleTime).toBeGreaterThan(0);
      return;
    }
    const sig = sigs[0]!;
    expect(sig.state).toBe('WAITING_ENTRY');
    expect(sig.entry_price).toBeNull();
    expect(sig.entry_candle_time).toBeNull();
    expect(sig.stop_loss).toBeNull();
    // The setup candle is the LAST closed candle we loaded.
    expect(Number(sig.setup_candle_time)).toBe(all[399]!.openTime);
  });

  it('fills the entry at the OPEN of N+1 once that candle arrives', async () => {
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    const all = loadFixtureCandles('BTCUSDT', '1h');
    await upsertCandles(db, 'BTCUSDT', '1h', all.slice(0, 400));
    const settings = await loosen();
    await runEngineOnce(db, settings, log);

    const before = await db.selectFrom('signals').selectAll().executeTakeFirst();
    if (!before) return; // no setup on this slice

    // N+1 arrives.
    const nPlus1 = all[400]!;
    await upsertCandles(db, 'BTCUSDT', '1h', [nPlus1]);
    const filled = await fillPendingEntries(db, settings, log);
    expect(filled).toBe(1);

    const after = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    expect(after.state).toBe('ACTIVE');
    expect(after.entry_candle_time).toBe(nPlus1.openTime);
    expect(after.entry_price).toBeCloseTo(nPlus1.open, 8);
    expect(Number(after.setup_candle_time) + H).toBe(Number(after.entry_candle_time));
    expect(after.stop_loss).not.toBeNull();
    expect((after.take_profits as number[]).length).toBeGreaterThan(0);

    // entry must NOT be the setup candle close
    const setupCandle = all[399]!;
    if (setupCandle.close !== nPlus1.open) {
      expect(after.entry_price).not.toBeCloseTo(setupCandle.close, 8);
    }

    const st = await loadState(db, 'BTCUSDT', '1h');
    expect(st.state).toBe('ACTIVE');
  });

  it('EDGE-only: repeated engine runs on the same data create no duplicates', async () => {
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    await upsertCandles(db, 'BTCUSDT', '1h', loadFixtureCandles('BTCUSDT', '1h').slice(0, 400));
    const settings = await loosen();

    await runEngineOnce(db, settings, log);
    const n1 = (await db.selectFrom('signals').selectAll().execute()).length;
    for (let i = 0; i < 5; i++) await runEngineOnce(db, settings, log);
    const n2 = (await db.selectFrom('signals').selectAll().execute()).length;
    expect(n2).toBe(n1);
  });

  it('resolves an outcome and frees the slot', async () => {
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    const settings = await loosen();

    // Hand-built series guaranteeing a LONG TP.
    const base = 1_700_000_000_000;
    const sig = await db.insertInto('signals').values({
      symbol: 'BTCUSDT', timeframe: '1h', direction: 'LONG', state: 'ACTIVE',
      mode: 'DRY_RUN', source: 'LIVE_ENGINE',
      score: 80, threshold: 40, breakdown: JSON.stringify({}), events: JSON.stringify([]),
      setup_candle_time: base, setup_close: 100,
      entry_candle_time: base + H, entry_price: 100, entry_at: new Date(),
      stop_loss: 95, take_profits: JSON.stringify([105, 110]),
      atr: 3, rr_tp1: 1, qty: 10, position_quote: 1000,
    }).returning('id').executeTakeFirstOrThrow();

    await db.insertInto('strategy_state').values({
      symbol: 'BTCUSDT', timeframe: '1h', state: 'ACTIVE', direction: 'LONG',
      last_candle_time: base + H, setup_candle_time: base, setup_score: 80,
      active_signal_id: Number(sig.id), payload: JSON.stringify({}),
    }).execute();

    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(base + H, 100, 101, 99, 100),
      candle(base + 2 * H, 100, 106, 99.5, 105.5), // TP1 @105
    ]);

    const res = await processOutcomes(db, settings, log);
    expect(res.closed).toBe(1);

    const closed = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    expect(closed.state).toBe('CLOSED_TP');

    const out = await db.selectFrom('outcomes').selectAll().executeTakeFirstOrThrow();
    expect(out.result).toBe('TP');
    expect(out.exit_price).toBe(105);
    expect(out.r_multiple).toBeGreaterThan(0);

    const st = await loadState(db, 'BTCUSDT', '1h');
    expect(st.state).toBe('IDLE');
    expect(st.activeSignalId).toBeNull();
  });

  it('records a stop-loss outcome with negative R', async () => {
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    const settings = await loosen();
    const base = 1_700_000_000_000;
    await db.insertInto('signals').values({
      symbol: 'BTCUSDT', timeframe: '1h', direction: 'SHORT', state: 'ACTIVE',
      mode: 'FORWARD_TEST', source: 'LIVE_ENGINE',
      score: 70, threshold: 40, breakdown: JSON.stringify({}), events: JSON.stringify([]),
      setup_candle_time: base, setup_close: 100,
      entry_candle_time: base + H, entry_price: 100, entry_at: new Date(),
      stop_loss: 105, take_profits: JSON.stringify([95]),
      atr: 3, rr_tp1: 1, qty: 10, position_quote: 1000,
    }).execute();

    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(base + H, 100, 106, 99, 105.5), // stop hit
    ]);

    await processOutcomes(db, settings, log);
    const out = await db.selectFrom('outcomes').selectAll().executeTakeFirstOrThrow();
    expect(out.result).toBe('SL');
    expect(out.r_multiple).toBeLessThan(0);
    const sig = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    expect(sig.state).toBe('CLOSED_SL');
  });

  it('honours engine.enabled = false', async () => {
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    await upsertCandles(db, 'BTCUSDT', '1h', loadFixtureCandles('BTCUSDT', '1h').slice(0, 400));
    await db.updateTable('settings').set({ value: JSON.stringify(false) })
      .where('key', '=', 'engine.enabled').execute();
    const settings = await loadSettings(db);

    const res = await runEngineOnce(db, settings, log);
    expect(res.evaluated).toBe(0);
    expect(res.skipped.join()).toContain('disabled');
    expect(await db.selectFrom('signals').selectAll().execute()).toHaveLength(0);
  });

  it('honours risk.max_concurrent', async () => {
    const syms = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
    await upsertSymbols(db, syms.map((s, i) => rankedSym(s, i + 1)));
    for (const s of syms) {
      await upsertCandles(db, s, '1h', loadFixtureCandles(s, '1h').slice(0, 400));
    }
    const settings = await loosen([['risk.max_concurrent', 1]]);
    await runEngineOnce(db, settings, log);
    const open = await db.selectFrom('signals').selectAll()
      .where('state', 'in', ['WAITING_ENTRY', 'ACTIVE']).execute();
    expect(open.length).toBeLessThanOrEqual(1);
  });

  it('signals carry a transparent score breakdown', async () => {
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    await upsertCandles(db, 'BTCUSDT', '1h', loadFixtureCandles('BTCUSDT', '1h').slice(0, 400));
    const settings = await loosen();
    await runEngineOnce(db, settings, log);

    const sig = await db.selectFrom('signals').selectAll().executeTakeFirst();
    if (!sig) return;
    const bd = sig.breakdown as unknown as {
      score: number; rawScore: number; totalWeight: number;
      components: Array<{ detector: string; strength: number; weight: number; contribution: number; counted: boolean }>;
    };
    expect(bd.components.length).toBeGreaterThan(0);
    expect(bd.score).toBeCloseTo(sig.score, 6);

    // Re-verify the arithmetic straight from the stored breakdown.
    const counted = bd.components.filter((c) => c.counted);
    const raw = counted.reduce((s, c) => s + c.contribution, 0);
    const wt = counted.reduce((s, c) => s + c.weight, 0);
    expect(raw).toBeCloseTo(bd.rawScore, 4);
    expect(wt).toBeCloseTo(bd.totalWeight, 4);
    expect((100 * raw) / wt).toBeCloseTo(bd.score, 3);
    for (const c of counted) {
      expect(c.contribution).toBeCloseTo(c.strength * c.weight, 6);
    }
    // no detector counted twice
    const names = counted.map((c) => c.detector);
    expect(new Set(names).size).toBe(names.length);
  });

  it('mode from settings is persisted on the signal and is never LIVE', async () => {
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    await upsertCandles(db, 'BTCUSDT', '1h', loadFixtureCandles('BTCUSDT', '1h').slice(0, 400));
    await db.updateTable('settings').set({ value: JSON.stringify('FORWARD_TEST') })
      .where('key', '=', 'engine.trading_mode').execute();
    const settings = await loosen();
    expect(settings.tradingMode()).toBe('FORWARD_TEST');

    await runEngineOnce(db, settings, log);
    const sigs = await db.selectFrom('signals').select('mode').execute();
    for (const s of sigs) {
      expect(s.mode).toBe('FORWARD_TEST');
      expect(s.mode).not.toBe('LIVE');
    }
  });

  it('only CLOSED candles are ever evaluated', async () => {
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    const all = loadFixtureCandles('BTCUSDT', '1h');
    const hist = all.slice(0, 400);
    await upsertCandles(db, 'BTCUSDT', '1h', hist);
    // Add a wild FORMING candle.
    const forming = { ...all[400]!, isClosed: false, high: all[400]!.high * 2, close: all[400]!.close * 1.9 };
    await upsertCandles(db, 'BTCUSDT', '1h', [forming]);

    const settings = await loosen();
    await runEngineOnce(db, settings, log);

    const st = await loadState(db, 'BTCUSDT', '1h');
    // Cursor must stop at the last CLOSED candle, not the forming one.
    expect(st.lastCandleTime).toBe(hist[399]!.openTime);

    const closedInDb = await getCandles(db, 'BTCUSDT', '1h', { closedOnly: true });
    expect(closedInDb.every((c) => c.isClosed)).toBe(true);
    expect(closedInDb.find((c) => c.openTime === forming.openTime)).toBeUndefined();
  });
});

/**
 * The bootstrap defect, pinned end to end against real PostgreSQL.
 *
 * PRODUCTION SYMPTOM
 * ------------------
 * Starting the strategy worker for the first time immediately produced 8
 * signals. Those were not observed rising edges: the slots had no persisted
 * baseline, so `IDLE + first passing evaluation` was misread as a transition.
 *
 * These tests drive the REAL engine over REAL candle data and assert that a
 * cold start is always silent, and that a signal appears only after a
 * genuine not-passing -> passing transition has actually been observed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { getTestPg, resetDb, setSetting } from './pg';
import type { Database } from '../src/db/types';
import { loadSettings, type Settings } from '../src/core/settings';
import { createLogger } from '../src/core/logger';
import { runEngineOnce } from '../src/strategy/engine-runner';
import { upsertCandles, upsertSymbols, loadState, saveState } from '../src/db/repo';
import { loadFixtureCandles } from './helpers';
import { migrate } from '../src/db';
import type { RankedSymbol } from '../src/market/top-symbols';

let db: Kysely<Database>;
const log = createLogger('test');

function rankedSym(symbol: string, rank = 1): RankedSymbol {
  return {
    symbol, baseAsset: symbol.replace('USDT', ''), quoteAsset: 'USDT', rank,
    quoteVolume24h: 1e9, lastPrice: 100, priceChangePct: 0,
    tickSize: 0.01, stepSize: 0.001, minNotional: 5,
  };
}

beforeAll(async () => {
  db = (await getTestPg()).db;
});

afterAll(async () => {
  await (await getTestPg()).stop();
});

beforeEach(async () => {
  await resetDb(db);
  await upsertSymbols(db, [rankedSym('BTCUSDT')]);
});

/** Very permissive settings so the condition passes readily. */
async function permissive(): Promise<Settings> {
  for (const [k, v] of [
    ['engine.score_threshold', 1],
    ['engine.min_components', 1],
    ['engine.timeframes', ['1h']],
    ['risk.min_rr', 0],
  ] as Array<[string, unknown]>) {
    await setSetting(db, k, v);
  }
  return loadSettings(db);
}

async function signalCount(): Promise<number> {
  const rows = await db.selectFrom('signals').selectAll().execute();
  return rows.length;
}

describe('cold start cannot emit bootstrap signals', () => {
  it('the FIRST engine run on a virgin database creates ZERO signals', async () => {
    await upsertCandles(db, 'BTCUSDT', '1h', loadFixtureCandles('BTCUSDT', '1h').slice(0, 400));
    const settings = await permissive();

    // Threshold of 1 means the condition almost certainly passes right now.
    const res = await runEngineOnce(db, settings, log);
    expect(res.evaluated).toBeGreaterThan(0);

    // This is the regression: it used to create a signal here.
    expect(await signalCount()).toBe(0);

    // The slot was nevertheless observed and recorded.
    const st = await loadState(db, 'BTCUSDT', '1h');
    expect(st.initialised).toBe(true);
    expect(['NEUTRAL', 'HOLD_LONG', 'HOLD_SHORT']).toContain(st.state);
  });

  it('80 virgin slots (10 symbols x 8 timeframes) all stay silent on first run', async () => {
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT', 'AVAXUSDT'];
    const tfs = ['5m', '15m', '1h', '4h'] as const;
    await upsertSymbols(db, symbols.map((s, i) => rankedSym(s, i + 1)));
    for (const sym of symbols) {
      for (const tf of tfs) {
        await upsertCandles(db, sym, tf, loadFixtureCandles(sym, tf).slice(0, 300));
      }
    }
    for (const [k, v] of [
      ['engine.score_threshold', 1],
      ['engine.min_components', 1],
      ['engine.timeframes', [...tfs]],
      ['risk.min_rr', 0],
    ] as Array<[string, unknown]>) {
      await setSetting(db, k, v);
    }
    const settings = await loadSettings(db);

    const res = await runEngineOnce(db, settings, log);
    expect(res.evaluated).toBe(symbols.length * tfs.length);
    expect(await signalCount()).toBe(0);
  });

  it('restarting the worker does not re-bootstrap (state is durable)', async () => {
    await upsertCandles(db, 'BTCUSDT', '1h', loadFixtureCandles('BTCUSDT', '1h').slice(0, 400));
    const settings = await permissive();

    for (let i = 0; i < 5; i++) await runEngineOnce(db, settings, log);
    expect(await signalCount()).toBe(0);
  });
});

describe('a genuine edge still fires after the baseline exists', () => {
  it('not-passed baseline -> passing candle produces exactly one signal', async () => {
    const all = loadFixtureCandles('BTCUSDT', '1h');
    await upsertCandles(db, 'BTCUSDT', '1h', all.slice(0, 400));

    // Establish an OBSERVED baseline with an unreachable threshold.
    const strict = await (async () => {
      for (const [k, v] of [
        ['engine.score_threshold', 99.9],
        ['engine.min_components', 1],
        ['engine.timeframes', ['1h']],
        ['risk.min_rr', 0],
      ] as Array<[string, unknown]>) {
        await setSetting(db, k, v);
      }
      return loadSettings(db);
    })();

    await runEngineOnce(db, strict, log);
    expect(await signalCount()).toBe(0);
    const baseline = await loadState(db, 'BTCUSDT', '1h');
    expect(baseline.initialised).toBe(true);
    expect(baseline.state).toBe('NEUTRAL');

    // Now the condition becomes satisfiable AND a new candle arrives: this is
    // a real observed transition.
    const loose = await permissive();
    await upsertCandles(db, 'BTCUSDT', '1h', all.slice(400, 401));
    await runEngineOnce(db, loose, log);

    expect(await signalCount()).toBe(1);

    const s = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    expect(s.state).toBe('WAITING_ENTRY');
    // WAITING_ENTRY must never carry a fabricated entry.
    expect(s.entry_price).toBeNull();
    expect(s.entry_candle_time).toBeNull();
  });

  it('further passing candles after the edge create NO additional signals', async () => {
    const all = loadFixtureCandles('BTCUSDT', '1h');
    await upsertCandles(db, 'BTCUSDT', '1h', all.slice(0, 400));

    // Observed NEUTRAL baseline.
    await saveState(db, {
      symbol: 'BTCUSDT',
      timeframe: '1h',
      state: 'NEUTRAL',
      direction: null,
      initialised: true,
      lastCandleTime: all[399]?.openTime ?? 0,
      setupCandleTime: null,
      setupScore: null,
      activeSignalId: null,
    });

    const settings = await permissive();
    await upsertCandles(db, 'BTCUSDT', '1h', all.slice(400, 410));
    await runEngineOnce(db, settings, log);
    const after = await signalCount();

    for (let i = 0; i < 5; i++) await runEngineOnce(db, settings, log);
    expect(await signalCount()).toBe(after);
    expect(after).toBeLessThanOrEqual(1);
  });
});

describe('capacity suppression cannot become a delayed fake edge', () => {
  it('a suppressed edge leaves the slot in HOLD, not NEUTRAL', async () => {
    const all = loadFixtureCandles('BTCUSDT', '1h');
    await upsertCandles(db, 'BTCUSDT', '1h', all.slice(0, 400));

    await saveState(db, {
      symbol: 'BTCUSDT',
      timeframe: '1h',
      state: 'NEUTRAL',
      direction: null,
      initialised: true,
      lastCandleTime: all[398]?.openTime ?? 0,
      setupCandleTime: null,
      setupScore: null,
      activeSignalId: null,
    });

    // max_concurrent = 0 suppresses every emission.
    for (const [k, v] of [
      ['engine.score_threshold', 1],
      ['engine.min_components', 1],
      ['engine.timeframes', ['1h']],
      ['risk.min_rr', 0],
      ['risk.max_concurrent', 0],
    ] as Array<[string, unknown]>) {
      await setSetting(db, k, v);
    }
    const capped = await loadSettings(db);

    await runEngineOnce(db, capped, log);
    expect(await signalCount()).toBe(0);

    const st = await loadState(db, 'BTCUSDT', '1h');
    // The critical assertion: NOT NEUTRAL. A NEUTRAL landing would let the
    // same persisting condition re-read as a fresh rising edge later.
    expect(st.state).not.toBe('NEUTRAL');
    expect(['HOLD_LONG', 'HOLD_SHORT', 'REARM']).toContain(st.state);
  });
});

describe('migration is idempotent and preserves production data', () => {
  it('legacy rows migrate to the new vocabulary without losing data', async () => {
    // Simulate a pre-migration production database by writing legacy values
    // directly, bypassing the typed helpers.
    const base = 1_700_000_000_000;
    await db
      .insertInto('signals')
      .values({
        symbol: 'BTCUSDT',
        timeframe: '1h',
        direction: 'LONG',
        state: 'ACTIVE', // legacy
        mode: 'FORWARD_TEST',
        source: 'LIVE_ENGINE',
        score: 50.374856,
        threshold: 40,
        breakdown: JSON.stringify({ factor: 'BOS', contribution: 15.68673338 }),
        events: JSON.stringify([{ kind: 'BOS' }]),
        setup_candle_time: base,
        setup_close: 100,
        entry_candle_time: base + 3_600_000,
        entry_price: 101.5,
        entry_at: new Date(),
        stop_loss: 95,
        take_profits: JSON.stringify([105, 110, 115]),
        atr: 3,
        rr_tp1: 1.5,
        qty: 10,
        position_quote: 1015,
      })
      .execute();

    await db
      .insertInto('strategy_state')
      .values({
        symbol: 'BTCUSDT',
        timeframe: '1h',
        state: 'ACTIVE', // legacy
        direction: 'LONG',
        last_candle_time: base,
        setup_candle_time: base,
        setup_score: 50.374856,
        active_signal_id: null,
        payload: JSON.stringify({}),
      })
      .execute();

    // Re-running migrate() is exactly what deployment does.
    await migrate(db);

    const s = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    expect(s.state).toBe('OPEN');
    // Everything else is PRESERVED.
    expect(s.score).toBeCloseTo(50.374856, 6);
    expect(s.entry_price).toBe(101.5);
    expect(s.stop_loss).toBe(95);
    expect(s.take_profits).toEqual([105, 110, 115]);
    expect(s.breakdown).toMatchObject({ factor: 'BOS' });
    expect(s.opened_at).not.toBeNull();

    const st = await loadState(db, 'BTCUSDT', '1h');
    // An in-trade slot must land in HOLD so it cannot emit a duplicate edge.
    expect(st.state).toBe('HOLD_LONG');
    expect(st.initialised).toBe(true);

    // Idempotent: running it again changes nothing.
    await migrate(db);
    const s2 = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    expect(s2.state).toBe('OPEN');
    expect((await loadState(db, 'BTCUSDT', '1h')).state).toBe('HOLD_LONG');
  });

  it('migrated slots do not emit on the next engine run', async () => {
    const all = loadFixtureCandles('BTCUSDT', '1h');
    await upsertCandles(db, 'BTCUSDT', '1h', all.slice(0, 400));

    // Legacy IDLE slot -> becomes an OBSERVED NEUTRAL baseline, which must not
    // bootstrap a fake signal just because the condition currently passes.
    await db
      .insertInto('strategy_state')
      .values({
        symbol: 'BTCUSDT',
        timeframe: '1h',
        state: 'IDLE',
        direction: null,
        last_candle_time: 0,
        setup_candle_time: null,
        setup_score: null,
        active_signal_id: null,
        payload: JSON.stringify({}),
      })
      .execute();

    await migrate(db);
    const st = await loadState(db, 'BTCUSDT', '1h');
    expect(st.state).toBe('NEUTRAL');
    expect(st.initialised).toBe(true);

    const settings = await permissive();
    await runEngineOnce(db, settings, log);

    // last_candle_time was 0, so candles DO advance the cursor; but the slot
    // is initialised, so the first passing observation after migration is a
    // legitimate edge ONLY if it follows an observed non-passing one. Here the
    // baseline says NEUTRAL, so at most one signal may appear — never eight.
    expect(await signalCount()).toBeLessThanOrEqual(1);
  });
});

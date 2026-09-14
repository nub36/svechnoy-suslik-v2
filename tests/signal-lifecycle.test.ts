/**
 * Signal lifecycle v2: WAITING_ENTRY -> OPEN -> TP1 -> TP2 -> TP3 / STOPPED /
 * EXPIRED, with PERSISTENT milestone timestamps.
 *
 * The defect this pins: the outcome worker used to close the whole trade at
 * TP1 with a single terminal `CLOSED_TP`, which destroyed the information that
 * a trade had progressed through the ladder and made "hit TP1, later stopped"
 * indistinguishable from "stopped immediately".
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { getTestPg, resetDb, setSetting } from './pg';
import type { Database } from '../src/db/types';
import { loadSettings, type Settings } from '../src/core/settings';
import { createLogger } from '../src/core/logger';
import { processOutcomes } from '../src/workers/outcome.worker';
import { trackMilestones } from '../src/outcome/tracker';
import { upsertCandles, upsertSymbols, loadState } from '../src/db/repo';
import { candle } from './helpers';
import type { RankedSymbol } from '../src/market/top-symbols';

function rankedSym(symbol: string, rank = 1): RankedSymbol {
  return {
    symbol, baseAsset: symbol.replace('USDT', ''), quoteAsset: 'USDT', rank,
    quoteVolume24h: 1e9, lastPrice: 100, priceChangePct: 0,
    tickSize: 0.01, stepSize: 0.001, minNotional: 5,
  };
}
import { isTerminal, tpMilestoneLevel, type SignalState } from '../src/core/types';

const H = 3_600_000;
const BASE = 1_700_000_000_000;

let db: Kysely<Database>;
let settings: Settings;
const log = createLogger('test');

beforeAll(async () => {
  db = (await getTestPg()).db;
});

afterAll(async () => {
  await (await getTestPg()).stop();
});

beforeEach(async () => {
  await resetDb(db);
  await upsertSymbols(db, [rankedSym('BTCUSDT')]);
  settings = await loadSettings(db);
});

/** Insert a filled LONG position with a 3-rung ladder at 105 / 110 / 115. */
async function openLong(
  tps: number[] = [105, 110, 115],
  stop = 95,
): Promise<number> {
  const row = await db
    .insertInto('signals')
    .values({
      symbol: 'BTCUSDT',
      timeframe: '1h',
      direction: 'LONG',
      state: 'OPEN',
      mode: 'FORWARD_TEST',
      source: 'LIVE_ENGINE',
      score: 80,
      threshold: 40,
      breakdown: JSON.stringify({}),
      events: JSON.stringify([]),
      setup_candle_time: BASE,
      setup_close: 100,
      entry_candle_time: BASE + H,
      entry_price: 100,
      entry_at: new Date(),
      opened_at: new Date(),
      stop_loss: stop,
      take_profits: JSON.stringify(tps),
      atr: 3,
      rr_tp1: 1.5,
      qty: 10,
      position_quote: 1000,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return Number(row.id);
}

async function sig(id: number) {
  return db.selectFrom('signals').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

describe('progressive take-profit milestones', () => {
  it('OPEN -> TP1_HIT without closing the trade', async () => {
    const id = await openLong();
    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(BASE + H, 100, 101, 99, 100),
      candle(BASE + 2 * H, 100, 106, 99.5, 105.5), // touches 105 only
    ]);

    const res = await processOutcomes(db, settings, log);
    expect(res.closed).toBe(0); // still running

    const s = await sig(id);
    expect(s.state).toBe('TP1_HIT');
    expect(s.tp_level).toBe(1);
    expect(s.tp1_hit_at).not.toBeNull();
    expect(s.tp2_hit_at).toBeNull();
    expect(s.stopped_at).toBeNull();
    // No outcome row until the trade actually ends.
    expect(await db.selectFrom('outcomes').selectAll().execute()).toHaveLength(0);
  });

  it('TP1_HIT -> TP2_HIT', async () => {
    const id = await openLong();
    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(BASE + H, 100, 106, 99, 105.5),
    ]);
    await processOutcomes(db, settings, log);
    expect((await sig(id)).state).toBe('TP1_HIT');

    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(BASE + 2 * H, 105, 111, 104, 110.5),
    ]);
    await processOutcomes(db, settings, log);

    const s = await sig(id);
    expect(s.state).toBe('TP2_HIT');
    expect(s.tp_level).toBe(2);
    expect(s.tp1_hit_at).not.toBeNull();
    expect(s.tp2_hit_at).not.toBeNull();
  });

  it('TP2_HIT -> TP3_HIT terminates the trade successfully', async () => {
    const id = await openLong();
    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(BASE + H, 100, 111, 99, 110.5), // TP1 + TP2 on one bar
    ]);
    await processOutcomes(db, settings, log);
    expect((await sig(id)).state).toBe('TP2_HIT');

    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(BASE + 2 * H, 110, 116, 109, 115.5), // TP3
    ]);
    const res = await processOutcomes(db, settings, log);
    expect(res.closed).toBe(1);

    const s = await sig(id);
    expect(s.state).toBe('TP3_HIT');
    expect(s.tp_level).toBe(3);
    expect(s.tp1_hit_at).not.toBeNull();
    expect(s.tp2_hit_at).not.toBeNull();
    expect(s.tp3_hit_at).not.toBeNull();
    expect(isTerminal('TP3_HIT')).toBe(true);

    // Slot released.
    const st = await loadState(db, 'BTCUSDT', '1h');
    expect(st.activeSignalId).toBeNull();
  });
});

describe('milestones survive a later stop — the core requirement', () => {
  it('TP1_HIT -> STOPPED RETAINS tp1_hit_at', async () => {
    const id = await openLong();
    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(BASE + H, 100, 106, 99.5, 105.5), // TP1
    ]);
    await processOutcomes(db, settings, log);
    const afterTp1 = await sig(id);
    expect(afterTp1.state).toBe('TP1_HIT');
    const tp1Stamp = afterTp1.tp1_hit_at;
    expect(tp1Stamp).not.toBeNull();

    // Price collapses through the stop.
    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(BASE + 2 * H, 105, 105.5, 94, 94.5),
    ]);
    const res = await processOutcomes(db, settings, log);
    expect(res.closed).toBe(1);

    const s = await sig(id);
    expect(s.state).toBe('STOPPED');
    expect(s.stopped_at).not.toBeNull();
    // THE POINT: the TP1 milestone is permanent and unchanged.
    expect(s.tp1_hit_at).not.toBeNull();
    expect(new Date(String(s.tp1_hit_at)).getTime()).toBe(
      new Date(String(tp1Stamp)).getTime(),
    );
    expect(s.tp_level).toBe(1);
  });

  it('TP2_HIT -> STOPPED retains BOTH TP1 and TP2 timestamps', async () => {
    const id = await openLong();
    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(BASE + H, 100, 111, 99.5, 110.5), // TP1 + TP2
    ]);
    await processOutcomes(db, settings, log);
    expect((await sig(id)).state).toBe('TP2_HIT');

    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(BASE + 2 * H, 110, 110.5, 94, 94.5), // stop
    ]);
    await processOutcomes(db, settings, log);

    const s = await sig(id);
    expect(s.state).toBe('STOPPED');
    expect(s.tp1_hit_at).not.toBeNull();
    expect(s.tp2_hit_at).not.toBeNull();
    expect(s.tp3_hit_at).toBeNull();
    expect(s.stopped_at).not.toBeNull();
    expect(s.tp_level).toBe(2);
  });

  it('timeout produces EXPIRED with expired_at', async () => {
    const id = await openLong();
    // resetDb() truncates `settings`, so the row may not exist yet: upsert.
    await setSetting(db, 'outcome.timeout_bars', 3);
    const tight = await loadSettings(db);
    expect(tight.num('outcome.timeout_bars')).toBe(3);

    // Flat bars: never reaches TP or SL.
    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(BASE + H, 100, 100.5, 99.5, 100),
      candle(BASE + 2 * H, 100, 100.5, 99.5, 100),
      candle(BASE + 3 * H, 100, 100.5, 99.5, 100),
    ]);

    const res = await processOutcomes(db, tight, log);
    expect(res.closed).toBe(1);

    const s = await sig(id);
    expect(s.state).toBe('EXPIRED');
    expect(s.expired_at).not.toBeNull();
    expect(s.tp_level).toBe(0);
    expect(s.tp1_hit_at).toBeNull();
  });
});

describe('milestone processing is idempotent', () => {
  it('re-running the worker does not move a timestamp or duplicate an outcome', async () => {
    const id = await openLong();
    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(BASE + H, 100, 106, 99.5, 105.5),
    ]);
    await processOutcomes(db, settings, log);
    const first = await sig(id);
    const stamp = new Date(String(first.tp1_hit_at)).getTime();

    // Several more passes over identical data.
    for (let i = 0; i < 5; i++) await processOutcomes(db, settings, log);

    const again = await sig(id);
    expect(again.state).toBe('TP1_HIT');
    expect(new Date(String(again.tp1_hit_at)).getTime()).toBe(stamp);

    // And after termination, still exactly one outcome row.
    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(BASE + 2 * H, 105, 105.5, 94, 94.5),
    ]);
    for (let i = 0; i < 4; i++) await processOutcomes(db, settings, log);
    expect(await db.selectFrom('outcomes').selectAll().execute()).toHaveLength(1);
    expect((await sig(id)).state).toBe('STOPPED');
  });

  it('a terminal signal is never reprocessed', async () => {
    const id = await openLong();
    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(BASE + H, 100, 100.5, 94, 94.5), // straight to stop
    ]);
    await processOutcomes(db, settings, log);
    expect((await sig(id)).state).toBe('STOPPED');

    // Even a later TP-shaped bar cannot resurrect it.
    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(BASE + 2 * H, 100, 120, 99, 119),
    ]);
    const res = await processOutcomes(db, settings, log);
    expect(res.checked).toBe(0); // terminal rows are not selected at all
    expect((await sig(id)).state).toBe('STOPPED');
  });
});

describe('CLOSED candles only', () => {
  it('a FORMING candle cannot resolve a milestone', async () => {
    const id = await openLong();
    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(BASE + H, 100, 101, 99, 100),
    ]);
    await processOutcomes(db, settings, log);
    expect((await sig(id)).state).toBe('OPEN');

    // A forming bar that blows through every take-profit AND the stop.
    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(BASE + 2 * H, 100, 130, 80, 129, 50, false),
    ]);
    const res = await processOutcomes(db, settings, log);

    const s = await sig(id);
    expect(res.closed).toBe(0);
    expect(s.state).toBe('OPEN');
    expect(s.tp_level).toBe(0);
    expect(s.tp1_hit_at).toBeNull();
    expect(s.stopped_at).toBeNull();
  });

  it('the same candle resolves normally once it CLOSES', async () => {
    const id = await openLong();
    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(BASE + H, 100, 106, 99, 105.5, 50, false),
    ]);
    await processOutcomes(db, settings, log);
    expect((await sig(id)).state).toBe('OPEN');

    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(BASE + H, 100, 106, 99, 105.5, 50, true),
    ]);
    await processOutcomes(db, settings, log);
    expect((await sig(id)).state).toBe('TP1_HIT');
  });
});

describe('trackMilestones unit behaviour', () => {
  const mkSettings = (): Settings => settings;

  it('an ambiguous bar (TP and SL together) resolves to the stop, not the TP', () => {
    const t = trackMilestones({
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [105],
      entryCandleTime: BASE,
      candles: [candle(BASE, 100, 106, 94, 96)], // hits both
      settings: mkSettings(),
    });
    expect(t.state).toBe('STOPPED');
    expect(t.tpLevel).toBe(0);
  });

  it('records several rungs cleared on one bar in order', () => {
    const t = trackMilestones({
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [105, 110, 115],
      entryCandleTime: BASE,
      candles: [candle(BASE, 100, 116, 99, 115.5)],
      settings: mkSettings(),
    });
    expect(t.milestones.map((m) => m.kind)).toEqual(['TP1', 'TP2', 'TP3']);
    expect(t.state).toBe('TP3_HIT');
    expect(t.tpLevel).toBe(3);
  });

  it('works symmetrically for SHORT', () => {
    const t = trackMilestones({
      direction: 'SHORT',
      entryPrice: 100,
      stopLoss: 105,
      takeProfits: [95, 90],
      entryCandleTime: BASE,
      candles: [candle(BASE, 100, 101, 94, 94.5)],
      settings: mkSettings(),
    });
    expect(t.tpLevel).toBe(1);
    expect(t.state).toBe('TP1_HIT');
  });

  it('tpMilestoneLevel maps states to ladder depth', () => {
    const cases: Array<[SignalState, number]> = [
      ['WAITING_ENTRY', 0],
      ['OPEN', 0],
      ['TP1_HIT', 1],
      ['TP2_HIT', 2],
      ['TP3_HIT', 3],
      ['STOPPED', 0],
      ['EXPIRED', 0],
    ];
    for (const [state, lvl] of cases) expect(tpMilestoneLevel(state)).toBe(lvl);
  });
});

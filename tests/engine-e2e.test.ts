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
      symbol: 'BTCUSDT', timeframe: '1h', direction: 'LONG', state: 'OPEN',
      mode: 'DRY_RUN', source: 'LIVE_ENGINE',
      score: 80, threshold: 40, breakdown: JSON.stringify({}), events: JSON.stringify([]),
      setup_candle_time: base, setup_close: 100,
      entry_candle_time: base + H, entry_price: 100, entry_at: new Date(),
      stop_loss: 95, take_profits: JSON.stringify([105, 110]),
      atr: 3, rr_tp1: 1, qty: 10, position_quote: 1000,
    }).returning('id').executeTakeFirstOrThrow();

    await db.insertInto('strategy_state').values({
      symbol: 'BTCUSDT', timeframe: '1h', state: 'HOLD_LONG', direction: 'LONG',
      last_candle_time: base + H, setup_candle_time: base, setup_score: 80,
      active_signal_id: Number(sig.id), payload: JSON.stringify({}),
    }).execute();

    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(base + H, 100, 101, 99, 100),
      candle(base + 2 * H, 100, 106, 99.5, 105.5), // TP1 @105
    ]);

    // TP1 is a MILESTONE, not the end of the trade: the ladder still has 110
    // outstanding, so the position stays open and the slot stays busy.
    const res = await processOutcomes(db, settings, log);
    expect(res.closed).toBe(0);

    const afterTp1 = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    expect(afterTp1.state).toBe('TP1_HIT');
    expect(afterTp1.tp_level).toBe(1);
    expect(afterTp1.tp1_hit_at).not.toBeNull();
    expect(afterTp1.stopped_at).toBeNull();
    expect(await db.selectFrom('outcomes').selectAll().execute()).toHaveLength(0);

    const busy = await loadState(db, 'BTCUSDT', '1h');
    expect(busy.activeSignalId).toBe(Number(sig.id));

    // Now the final rung is taken: TP3-equivalent completion for a 2-rung
    // ladder is the LAST rung, which terminates the trade.
    await upsertCandles(db, 'BTCUSDT', '1h', [
      candle(base + 3 * H, 105, 111, 104, 110.5), // TP2 @110
    ]);
    const res2 = await processOutcomes(db, settings, log);
    expect(res2.closed).toBe(1);

    const closed = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    expect(closed.state).toBe('TP2_HIT');
    expect(closed.tp_level).toBe(2);
    // The TP1 milestone is RETAINED.
    expect(closed.tp1_hit_at).not.toBeNull();
    expect(closed.tp2_hit_at).not.toBeNull();

    const out = await db.selectFrom('outcomes').selectAll().executeTakeFirstOrThrow();
    expect(out.result).toBe('TP');
    expect(out.r_multiple).toBeGreaterThan(0);

    const st = await loadState(db, 'BTCUSDT', '1h');
    // A freed slot lands in REARM, never NEUTRAL — see releaseSlot().
    expect(st.state).toBe('REARM');
    expect(st.activeSignalId).toBeNull();
  });

  it('records a stop-loss outcome with negative R', async () => {
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    const settings = await loosen();
    const base = 1_700_000_000_000;
    await db.insertInto('signals').values({
      symbol: 'BTCUSDT', timeframe: '1h', direction: 'SHORT', state: 'OPEN',
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
    expect(sig.state).toBe('STOPPED');
    expect(sig.stopped_at).not.toBeNull();
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
  it('expires a WAITING_ENTRY signal whose N+1 candle never arrives', async () => {
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    const all = loadFixtureCandles('BTCUSDT', '1h');
    const hist = all.slice(0, 400);
    await upsertCandles(db, 'BTCUSDT', '1h', hist);

    // Expire quickly, and make sure nothing can fill in the meantime.
    const settings = await loosen([['risk.signal_expiry_bars', 2]]);
    await runEngineOnce(db, settings, log);

    const created = await db.selectFrom('signals').selectAll().execute();
    if (created.length === 0) return; // fixture produced no setup; nothing to assert
    const sig = created[0]!;
    expect(sig.state).toBe('WAITING_ENTRY');
    expect(sig.entry_price).toBeNull();

    // Advance the CLOSED history well past the expiry window WITHOUT ever
    // supplying the N+1 candle for this setup.
    const setupTime = Number(sig.setup_candle_time);
    const far = all
      .slice(400, 410)
      .map((c, i) => ({ ...c, openTime: setupTime + (i + 6) * H, isClosed: true }));
    await upsertCandles(db, 'BTCUSDT', '1h', far);

    await runEngineOnce(db, settings, log);

    const after = await db
      .selectFrom('signals').selectAll().where('id', '=', sig.id).executeTakeFirst();
    expect(after!.state).toBe('CANCELLED');
    // CRITICAL: expiring must never fabricate an entry.
    expect(after!.entry_price).toBeNull();
    expect(after!.entry_candle_time).toBeNull();
  });

  it('signal_expiry_bars = 0 means a signal waits indefinitely', async () => {
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    const all = loadFixtureCandles('BTCUSDT', '1h');
    await upsertCandles(db, 'BTCUSDT', '1h', all.slice(0, 400));

    const settings = await loosen([['risk.signal_expiry_bars', 0]]);
    await runEngineOnce(db, settings, log);
    const created = await db.selectFrom('signals').selectAll().execute();
    if (created.length === 0) return;

    const sig = created[0]!;
    const setupTime = Number(sig.setup_candle_time);
    const far = all
      .slice(400, 410)
      .map((c, i) => ({ ...c, openTime: setupTime + (i + 20) * H, isClosed: true }));
    await upsertCandles(db, 'BTCUSDT', '1h', far);

    await runEngineOnce(db, settings, log);
    const after = await db
      .selectFrom('signals').selectAll().where('id', '=', sig.id).executeTakeFirst();
    expect(after!.state).toBe('WAITING_ENTRY');
  });

  it('market.enabled_symbols restricts which TOP-N symbols the engine trades', async () => {
    await upsertSymbols(db, [rankedSym('BTCUSDT', 1), rankedSym('ETHUSDT', 2)]);
    for (const sym of ['BTCUSDT', 'ETHUSDT']) {
      await upsertCandles(db, sym, '1h', loadFixtureCandles(sym, '1h').slice(0, 400));
    }

    const settings = await loosen([['market.enabled_symbols', ['ETHUSDT']]]);
    const r = await runEngineOnce(db, settings, log);
    expect(r.evaluated).toBeGreaterThan(0);

    const rows = await db.selectFrom('signals').select('symbol').distinct().execute();
    for (const row of rows) expect(row.symbol).toBe('ETHUSDT');

    const states = await db.selectFrom('strategy_state').select('symbol').distinct().execute();
    for (const st of states) expect(st.symbol).toBe('ETHUSDT');
  });

  it('persists longScore, shortScore and confirmations on the signal', async () => {
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    await upsertCandles(db, 'BTCUSDT', '1h', loadFixtureCandles('BTCUSDT', '1h').slice(0, 400));

    const settings = await loosen();
    await runEngineOnce(db, settings, log);

    const sig = await db.selectFrom('signals').selectAll().executeTakeFirst();
    if (!sig) return;
    const bd = sig.breakdown as unknown as {
      longScore: number; shortScore: number; confirmations: number;
      chosen: { direction: string; score: number };
    };
    expect(typeof bd.longScore).toBe('number');
    expect(typeof bd.shortScore).toBe('number');
    expect(typeof bd.confirmations).toBe('number');
    expect(bd.longScore).toBeGreaterThanOrEqual(0);
    expect(bd.longScore).toBeLessThanOrEqual(100);
    expect(bd.shortScore).toBeGreaterThanOrEqual(0);
    expect(bd.shortScore).toBeLessThanOrEqual(100);
    expect(bd.confirmations).toBeGreaterThanOrEqual(1);
    expect(Number(sig.score)).toBeCloseTo(Math.max(bd.longScore, bd.shortScore), 6);

    // ...and as first-class, queryable columns (not only inside the JSON blob).
    expect(Number(sig.long_score)).toBeCloseTo(bd.longScore, 6);
    expect(Number(sig.short_score)).toBeCloseTo(bd.shortScore, 6);
    expect(Number(sig.confirmations)).toBe(bd.confirmations);
    expect(Number(sig.score)).toBeCloseTo(
      Math.max(Number(sig.long_score), Number(sig.short_score)), 6,
    );
  });

  it('the persisted breakdown is arithmetically auditable', async () => {
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    await upsertCandles(db, 'BTCUSDT', '1h', loadFixtureCandles('BTCUSDT', '1h').slice(0, 400));

    const settings = await loosen();
    await runEngineOnce(db, settings, log);
    const sig = await db.selectFrom('signals').selectAll().executeTakeFirst();
    if (!sig) return;

    const bd = sig.breakdown as unknown as {
      components: Array<{
        detector: string; strength: number; weight: number;
        contribution: number; counted: boolean; skippedReason?: string;
      }>;
      rawScore: number; totalWeight: number; score: number; confirmations: number;
    };

    expect(bd.components.length).toBeGreaterThan(0);

    // Every component is self-explaining: contribution === strength * weight,
    // and anything NOT counted contributes exactly 0 with a stated reason.
    for (const c of bd.components) {
      if (c.counted) {
        expect(c.contribution).toBeCloseTo(c.strength * c.weight, 9);
        expect(c.contribution).toBeGreaterThan(0);
      } else {
        expect(c.contribution).toBe(0);
        expect(c.skippedReason).toBeTruthy();
      }
    }

    const counted = bd.components.filter((c) => c.counted);
    // Each factor is counted AT MOST ONCE — no double counting.
    const factors = counted.map((c) => c.detector);
    expect(new Set(factors).size).toBe(factors.length);
    expect(counted.length).toBe(bd.confirmations);

    // rawScore is the sum of counted contributions; score normalises by weight.
    const sum = counted.reduce((a, c) => a + c.contribution, 0);
    expect(bd.rawScore).toBeCloseTo(sum, 5);
    expect(bd.totalWeight).toBeCloseTo(counted.reduce((a, c) => a + c.weight, 0), 5);
    expect(bd.score).toBeCloseTo((bd.rawScore / bd.totalWeight) * 100, 3);
    expect(bd.score).toBeGreaterThanOrEqual(0);
    expect(bd.score).toBeLessThanOrEqual(100);
    expect(Number(sig.score)).toBeCloseTo(bd.score, 6);
  });
});

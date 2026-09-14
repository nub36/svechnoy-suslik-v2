/**
 * `engine.timeframes` as the SINGLE source of truth for strategy scanning.
 *
 * Covers: selection semantics (one / several / all), validation (empty,
 * invalid, duplicates), that the worker honours a change without a restart,
 * that a disabled timeframe produces nothing while keeping its state, that
 * re-enabling catches up sequentially instead of fabricating an edge, and the
 * one-active-signal-per-symbol policy across timeframes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { getTestPg, resetDb, setSetting } from './pg';
import type { Database } from '../src/db/types';
import {
  DEFAULT_TIMEFRAMES,
  SETTINGS_REGISTRY,
  Settings,
  coerceSettingValue,
  loadSettings,
} from '../src/core/settings';
import { createLogger } from '../src/core/logger';
import { runEngineOnce, symbolsWithLiveSignal } from '../src/strategy/engine-runner';
import { upsertCandles, upsertSymbols, loadState, saveState, listStates } from '../src/db/repo';
import { loadFixtureCandles } from './helpers';
import { TIMEFRAMES, type Timeframe } from '../src/core/types';
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

const tfDef = SETTINGS_REGISTRY.find((d) => d.key === 'engine.timeframes')!;

beforeAll(async () => {
  db = (await getTestPg()).db;
});

afterAll(async () => {
  await (await getTestPg()).stop();
});

beforeEach(async () => {
  await resetDb(db);
});

/** Seed N symbols with candle history on the given timeframes. */
async function seedMarket(symbols: string[], tfs: readonly Timeframe[]): Promise<void> {
  await upsertSymbols(db, symbols.map((s, i) => rankedSym(s, i + 1)));
  for (const sym of symbols) {
    for (const tf of tfs) {
      await upsertCandles(db, sym, tf, loadFixtureCandles(sym, tf).slice(0, 300));
    }
  }
}

async function permissive(tfs: string[]): Promise<Settings> {
  await setSetting(db, 'engine.score_threshold', 1);
  await setSetting(db, 'engine.min_components', 1);
  await setSetting(db, 'engine.timeframes', tfs);
  await setSetting(db, 'risk.min_rr', 0);
  await setSetting(db, 'risk.max_concurrent', 100);
  return loadSettings(db);
}

/* ================================================================
 * 1. Selection semantics
 * ================================================================ */

describe('engine.timeframes selection', () => {
  it('exactly one selected timeframe is scanned', async () => {
    await seedMarket(['BTCUSDT', 'ETHUSDT'], ['15m', '1h']);
    const settings = await permissive(['15m']);

    const res = await runEngineOnce(db, settings, log);
    expect(res.timeframesScanned).toEqual(['15m']);
    expect(res.scanSlots).toBe(2 * 1); // 2 symbols x 1 tf

    const scanned = new Set((await listStates(db)).map((r) => r.timeframe));
    expect([...scanned]).toEqual(['15m']);
  });

  it('two selected timeframes scan exactly those two', async () => {
    await seedMarket(['BTCUSDT', 'ETHUSDT'], ['15m', '1h', '4h']);
    const settings = await permissive(['15m', '1h']);

    const res = await runEngineOnce(db, settings, log);
    expect(res.timeframesScanned).toEqual(['15m', '1h']);
    expect(res.scanSlots).toBe(2 * 2);

    const scanned = new Set((await listStates(db)).map((r) => r.timeframe));
    expect([...scanned].sort()).toEqual(['15m', '1h']);
    expect(scanned.has('4h')).toBe(false);
  });

  it('all 8 timeframes are scanned when all are selected', async () => {
    await seedMarket(['BTCUSDT'], TIMEFRAMES);
    const settings = await permissive([...TIMEFRAMES]);

    const res = await runEngineOnce(db, settings, log);
    expect(res.timeframesScanned).toEqual([...TIMEFRAMES]);
    expect(res.scanSlots).toBe(1 * 8);

    const scanned = new Set((await listStates(db)).map((r) => r.timeframe));
    expect(scanned.size).toBe(8);
  });

  it('scan slots scale as symbols x selected timeframes', async () => {
    const syms = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT', 'AVAXUSDT'];
    await seedMarket(syms, ['5m', '15m', '1h']);

    for (const [tfs, expected] of [
      [['15m'], 5],
      [['15m', '1h'], 10],
      [['5m', '15m', '1h'], 15],
    ] as Array<[string[], number]>) {
      await resetDb(db);
      await seedMarket(syms, ['5m', '15m', '1h']);
      const settings = await permissive(tfs);
      const res = await runEngineOnce(db, settings, log);
      expect(res.scanSlots, tfs.join('+')).toBe(expected);
    }
  });
});

/* ================================================================
 * 2. Validation
 * ================================================================ */

describe('engine.timeframes validation', () => {
  it('rejects an empty selection with a Russian message', () => {
    expect(() => coerceSettingValue(tfDef, [])).toThrow(/хотя бы один таймфрейм/);
    expect(() => coerceSettingValue(tfDef, '[]')).toThrow(/хотя бы один таймфрейм/);
  });

  it('rejects an unsupported timeframe', () => {
    expect(() => coerceSettingValue(tfDef, ['3h'])).toThrow(/unsupported timeframe/);
    expect(() => coerceSettingValue(tfDef, ['15m', '2d'])).toThrow(/unsupported timeframe/);
  });

  it('rejects a non-array', () => {
    expect(() => coerceSettingValue(tfDef, '"15m"')).toThrow(/expected an array/);
    expect(() => coerceSettingValue(tfDef, 15)).toThrow(/expected an array/);
  });

  it('collapses duplicates and stores canonical chronological order', () => {
    expect(coerceSettingValue(tfDef, ['1h', '15m', '1h'])).toEqual(['15m', '1h']);
    expect(coerceSettingValue(tfDef, ['1w', '1m'])).toEqual(['1m', '1w']);
    expect(coerceSettingValue(tfDef, ['15m', '15m', '15m'])).toEqual(['15m']);
  });

  it('accepts every supported value individually', () => {
    for (const tf of TIMEFRAMES) {
      expect(coerceSettingValue(tfDef, [tf])).toEqual([tf]);
    }
  });

  it('a duplicated stored value never double-scans', async () => {
    await seedMarket(['BTCUSDT'], ['15m', '1h']);
    // Write a duplicate directly, bypassing coercion, to prove the accessor
    // is defensive too.
    await setSetting(db, 'engine.timeframes', ['1h', '15m', '1h', '15m']);
    const settings = await loadSettings(db);
    expect(settings.timeframes()).toEqual(['15m', '1h']);

    const res = await runEngineOnce(db, settings, log);
    expect(res.scanSlots).toBe(2);
  });

  it('falls back to the full set only when nothing valid remains', () => {
    expect(Settings.fromEntries([['engine.timeframes', ['nope']]]).timeframes()).toEqual([
      ...DEFAULT_TIMEFRAMES,
    ]);
    // A partially-valid list keeps ONLY the valid entries — no silent widening.
    expect(
      Settings.fromEntries([['engine.timeframes', ['15m', 'bogus']]]).timeframes(),
    ).toEqual(['15m']);
  });

  it('there is no second timeframe setting in the registry', () => {
    const keys = SETTINGS_REGISTRY.map((d) => d.key);
    expect(keys).toContain('engine.timeframes');
    for (const forbidden of [
      'strategy.timeframes',
      'scan.timeframes',
      'market.strategy_timeframes',
      'market.timeframes',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    // Only ONE registry key mentions timeframes as its own selection.
    expect(keys.filter((k) => k.endsWith('.timeframes'))).toEqual(['engine.timeframes']);
  });
});

/* ================================================================
 * 3. Admin persistence + worker pickup (no restart)
 * ================================================================ */

describe('admin changes reach the worker without a restart', () => {
  it('persists the selection and the next loop honours it', async () => {
    const syms = ['BTCUSDT', 'ETHUSDT'];
    await seedMarket(syms, ['5m', '15m', '1h']);

    // Step 1: only 15m.
    let settings = await permissive(['15m']);
    let res = await runEngineOnce(db, settings, log);
    expect(res.timeframesScanned).toEqual(['15m']);
    expect(res.scanSlots).toBe(2);

    // Step 2: admin adds 1h. Same process, settings simply reloaded.
    await setSetting(db, 'engine.timeframes', ['15m', '1h']);
    settings = await loadSettings(db);
    res = await runEngineOnce(db, settings, log);
    expect(res.timeframesScanned).toEqual(['15m', '1h']);
    expect(res.scanSlots).toBe(4);

    // Step 3: narrow back down.
    await setSetting(db, 'engine.timeframes', ['5m']);
    settings = await loadSettings(db);
    res = await runEngineOnce(db, settings, log);
    expect(res.timeframesScanned).toEqual(['5m']);
    expect(res.scanSlots).toBe(2);
  });

  it('the stored value survives a fresh settings load', async () => {
    await setSetting(db, 'engine.timeframes', ['15m', '1h', '4h']);
    const reloaded = await loadSettings(db);
    expect(reloaded.timeframes()).toEqual(['15m', '1h', '4h']);
  });
});

/* ================================================================
 * 4. Disable / re-enable semantics
 * ================================================================ */

describe('disabling a timeframe', () => {
  it('creates no signals on the disabled timeframe and keeps its state', async () => {
    await seedMarket(['BTCUSDT'], ['15m', '1h']);

    // Give 1h an observed baseline while it is enabled.
    let settings = await permissive(['15m', '1h']);
    await runEngineOnce(db, settings, log);
    const before = await loadState(db, 'BTCUSDT', '1h');
    expect(before.initialised).toBe(true);

    // Disable 1h.
    await setSetting(db, 'engine.timeframes', ['15m']);
    settings = await loadSettings(db);

    const sigBefore = (await db.selectFrom('signals').selectAll().execute()).filter(
      (r) => r.timeframe === '1h',
    ).length;

    await upsertCandles(db, 'BTCUSDT', '1h', loadFixtureCandles('BTCUSDT', '1h').slice(300, 340));
    const res = await runEngineOnce(db, settings, log);

    expect(res.timeframesScanned).toEqual(['15m']);
    const sigAfter = (await db.selectFrom('signals').selectAll().execute()).filter(
      (r) => r.timeframe === '1h',
    ).length;
    expect(sigAfter).toBe(sigBefore);

    // State row is PRESERVED, not deleted, and its cursor did not move.
    const after = await loadState(db, 'BTCUSDT', '1h');
    expect(after.initialised).toBe(true);
    expect(after.lastCandleTime).toBe(before.lastCandleTime);
  });

  it('retained rows for unscanned timeframes are not counted as scan slots', async () => {
    await seedMarket(['BTCUSDT'], ['5m', '15m', '1h']);
    let settings = await permissive(['5m', '15m', '1h']);
    await runEngineOnce(db, settings, log);
    expect((await listStates(db)).length).toBe(3);

    await setSetting(db, 'engine.timeframes', ['15m']);
    settings = await loadSettings(db);
    const res = await runEngineOnce(db, settings, log);

    // Three historical rows still exist, but only one is a live scan slot.
    expect((await listStates(db)).length).toBe(3);
    expect(res.scanSlots).toBe(1);
    expect(res.timeframesScanned).toEqual(['15m']);
  });
});

describe('re-enabling a timeframe', () => {
  it('does NOT fabricate an edge by jumping to the newest candle', async () => {
    const all = loadFixtureCandles('BTCUSDT', '1h');
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    await upsertCandles(db, 'BTCUSDT', '1h', all.slice(0, 200));

    // Baseline recorded while enabled.
    let settings = await permissive(['1h']);
    await runEngineOnce(db, settings, log);
    const baseline = await loadState(db, 'BTCUSDT', '1h');
    const sigBefore = (await db.selectFrom('signals').selectAll().execute()).length;

    // Disabled for a long stretch; lots of candles accumulate meanwhile.
    await setSetting(db, 'engine.timeframes', ['15m']);
    settings = await loadSettings(db);
    await upsertCandles(db, 'BTCUSDT', '1h', all.slice(200, 400));
    await runEngineOnce(db, settings, log);
    expect((await loadState(db, 'BTCUSDT', '1h')).lastCandleTime).toBe(baseline.lastCandleTime);

    // Re-enable: the gap must be walked, not skipped.
    await setSetting(db, 'engine.timeframes', ['1h']);
    settings = await loadSettings(db);
    const res = await runEngineOnce(db, settings, log);

    // The cursor advanced to the newest closed candle...
    const after = await loadState(db, 'BTCUSDT', '1h');
    expect(after.lastCandleTime).toBeGreaterThan(baseline.lastCandleTime);
    // ...and intermediate candles were genuinely replayed.
    expect(res.caughtUp).toBeGreaterThan(0);

    // At most ONE signal may come out of a gap, and only from a real observed
    // transition — never one per skipped candle.
    const sigAfter = (await db.selectFrom('signals').selectAll().execute()).length;
    expect(sigAfter - sigBefore).toBeLessThanOrEqual(1);
  });

  it('a gap larger than max_catchup_candles re-baselines silently', async () => {
    const all = loadFixtureCandles('BTCUSDT', '1h');
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    await upsertCandles(db, 'BTCUSDT', '1h', all.slice(0, 150));

    let settings = await permissive(['1h']);
    await runEngineOnce(db, settings, log);
    const sigBefore = (await db.selectFrom('signals').selectAll().execute()).length;
    const baseline = await loadState(db, 'BTCUSDT', '1h');

    // Huge gap, tiny catch-up budget.
    await setSetting(db, 'engine.max_catchup_candles', 5);
    await upsertCandles(db, 'BTCUSDT', '1h', all.slice(150, 500));
    settings = await loadSettings(db);

    const res = await runEngineOnce(db, settings, log);

    // Re-baselined, emitted nothing, and parked somewhere that cannot fire.
    const after = await loadState(db, 'BTCUSDT', '1h');
    expect(after.lastCandleTime).toBeGreaterThan(baseline.lastCandleTime);
    expect(after.state).toBe('REARM');
    expect((await db.selectFrom('signals').selectAll().execute()).length).toBe(sigBefore);
    expect(res.skipped.join(' ')).toMatch(/re-baselined/);
  });

  it('catch-up replays candles IN ORDER (cursor never moves backwards)', async () => {
    const all = loadFixtureCandles('BTCUSDT', '1h');
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    await upsertCandles(db, 'BTCUSDT', '1h', all.slice(0, 120));

    const settings = await permissive(['1h']);
    await runEngineOnce(db, settings, log);

    let prev = (await loadState(db, 'BTCUSDT', '1h')).lastCandleTime;
    for (let chunk = 120; chunk < 260; chunk += 35) {
      await upsertCandles(db, 'BTCUSDT', '1h', all.slice(chunk, chunk + 35));
      await runEngineOnce(db, settings, log);
      const now = (await loadState(db, 'BTCUSDT', '1h')).lastCandleTime;
      expect(now).toBeGreaterThanOrEqual(prev);
      prev = now;
    }
  });
});

/* ================================================================
 * 5. One active signal per symbol, across timeframes
 * ================================================================ */

describe('one active signal per symbol', () => {
  it('a second timeframe cannot open a parallel signal on the same symbol', async () => {
    await seedMarket(['BTCUSDT', 'ETHUSDT'], ['15m', '1h']);
    const settings = await permissive(['15m', '1h']);

    // Drive several loops with fresh candles so edges can occur.
    for (let i = 0; i < 3; i++) {
      await upsertCandles(
        db, 'BTCUSDT', '15m',
        loadFixtureCandles('BTCUSDT', '15m').slice(300 + i * 20, 320 + i * 20),
      );
      await upsertCandles(
        db, 'BTCUSDT', '1h',
        loadFixtureCandles('BTCUSDT', '1h').slice(300 + i * 20, 320 + i * 20),
      );
      await runEngineOnce(db, settings, log);
    }

    const rows = await db.selectFrom('signals').selectAll().execute();
    const liveBtc = rows.filter(
      (r) =>
        r.symbol === 'BTCUSDT' &&
        ['WAITING_ENTRY', 'OPEN', 'TP1_HIT', 'TP2_HIT'].includes(r.state),
    );
    expect(liveBtc.length).toBeLessThanOrEqual(1);
  });

  it('a busy symbol does not block a different symbol', async () => {
    await seedMarket(['BTCUSDT', 'ETHUSDT'], ['15m']);
    const settings = await permissive(['15m']);

    // BTCUSDT holds a live signal.
    await db
      .insertInto('signals')
      .values({
        symbol: 'BTCUSDT', timeframe: '15m', direction: 'LONG', state: 'OPEN',
        mode: 'FORWARD_TEST', source: 'LIVE_ENGINE', score: 80, threshold: 40,
        breakdown: JSON.stringify({}), events: JSON.stringify([]),
        setup_candle_time: 1, setup_close: 100,
        entry_candle_time: 2, entry_price: 100, stop_loss: 95,
        take_profits: JSON.stringify([105]), atr: 3, rr_tp1: 1.5,
      })
      .execute();

    const busy = await symbolsWithLiveSignal(db);
    expect(busy.has('BTCUSDT')).toBe(true);
    expect(busy.has('ETHUSDT')).toBe(false);
  });

  it('a terminal signal releases the symbol', async () => {
    const base = {
      symbol: 'BTCUSDT', timeframe: '15m', direction: 'LONG' as const,
      mode: 'FORWARD_TEST', source: 'LIVE_ENGINE', score: 80, threshold: 40,
      breakdown: JSON.stringify({}), events: JSON.stringify([]),
      setup_close: 100, entry_price: 100, stop_loss: 95,
      take_profits: JSON.stringify([105]), atr: 3, rr_tp1: 1.5,
    };

    for (const [state, stillBusy] of [
      ['WAITING_ENTRY', true],
      ['OPEN', true],
      ['TP1_HIT', true],
      ['TP2_HIT', true],
      ['TP3_HIT', false],
      ['STOPPED', false],
      ['EXPIRED', false],
    ] as Array<[string, boolean]>) {
      await db.deleteFrom('signals').execute();
      await db
        .insertInto('signals')
        .values({ ...base, state, setup_candle_time: 1, entry_candle_time: 2 })
        .execute();
      const busy = await symbolsWithLiveSignal(db);
      expect(busy.has('BTCUSDT'), `state ${state}`).toBe(stillBusy);
    }
  });

  it('suppression by the symbol policy settles the edge (no delayed re-fire)', async () => {
    await seedMarket(['BTCUSDT'], ['15m', '1h']);
    const settings = await permissive(['15m', '1h']);

    // Pre-existing live signal on 15m blocks every other BTCUSDT timeframe.
    await db
      .insertInto('signals')
      .values({
        symbol: 'BTCUSDT', timeframe: '15m', direction: 'LONG', state: 'OPEN',
        mode: 'FORWARD_TEST', source: 'LIVE_ENGINE', score: 80, threshold: 40,
        breakdown: JSON.stringify({}), events: JSON.stringify([]),
        setup_candle_time: 1, setup_close: 100,
        entry_candle_time: 2, entry_price: 100, stop_loss: 95,
        take_profits: JSON.stringify([105]), atr: 3, rr_tp1: 1.5,
      })
      .execute();

    // Give 1h an observed NEUTRAL baseline so the next pass is a real edge.
    const hist = loadFixtureCandles('BTCUSDT', '1h');
    await saveState(db, {
      symbol: 'BTCUSDT', timeframe: '1h', state: 'NEUTRAL', direction: null,
      initialised: true, lastCandleTime: hist[250]?.openTime ?? 0,
      setupCandleTime: null, setupScore: null, activeSignalId: null,
    });

    const res = await runEngineOnce(db, settings, log);

    const extra = (await db.selectFrom('signals').selectAll().execute()).filter(
      (r) => r.timeframe === '1h',
    );
    expect(extra).toHaveLength(0);

    if (res.suppressedBySymbolPolicy > 0) {
      // A suppressed edge must land in HOLD/REARM, never NEUTRAL — otherwise
      // the same persisting condition re-reads as a fresh edge next loop.
      const st = await loadState(db, 'BTCUSDT', '1h');
      expect(st.state).not.toBe('NEUTRAL');
    }
  });
});

/* ================================================================
 * 6. Safety invariants
 * ================================================================ */

describe('safety', () => {
  it('LIVE remains rejected regardless of timeframe selection', async () => {
    await setSetting(db, 'engine.timeframes', ['15m']);
    const modeDef = SETTINGS_REGISTRY.find((d) => d.key === 'engine.trading_mode')!;
    expect(() => coerceSettingValue(modeDef, 'LIVE')).toThrow();
    const settings = await loadSettings(db);
    expect(settings.tradingMode()).not.toBe('LIVE');
  });

  it('the Admin UI renders a checkbox per supported timeframe', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/admin/page.tsx', 'utf8');
    // The Russian section label lives in the translation table.
    expect(readFileSync('app/lib/settings-ru.ts', 'utf8')).toContain('Таймфреймы стратегии');
    expect(src).toContain('timeframe-picker');
    for (const label of ['1м', '5м', '15м', '30м', '1ч', '4ч', '1д', '1н']) {
      expect(src).toContain(`label: '${label}'`);
    }
    expect(src).toContain('Выбрать все');
    expect(src).toContain('Сбросить');
    // Must distinguish scanning from chart availability.
    expect(src).toContain('Сканируется стратегией');
    expect(src).toContain('Доступно для графика');
  });

  it('the UI persists the canonical key, not a new one', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/admin/page.tsx', 'utf8');
    expect(src).toContain("s.key === 'engine.timeframes'");
    for (const forbidden of ['strategy.timeframes', 'scan.timeframes', 'market.strategy_timeframes']) {
      expect(src).not.toContain(forbidden);
    }
  });
});

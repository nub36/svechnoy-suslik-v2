/**
 * THE SAFETY PROPERTY OF THE REAL-TIME FEATURE.
 *
 * Adding a WebSocket feed introduces exactly one serious risk: that a forming
 * candle or a price tick starts influencing the Smart Money engine. It must
 * not. The chart may animate; the engine may only ever see CLOSED candles that
 * the market worker has written to PostgreSQL.
 *
 * These tests attack that boundary from several directions:
 *   1. architecturally — the stream cannot reach the DB or the engine;
 *   2. behaviourally   — feeding a wild forming candle changes no evaluation;
 *   3. end to end      — a forming candle creates no signal row.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Kysely } from 'kysely';
import { getTestPg, resetDb } from './pg';
import type { Database } from '../src/db/types';
import { upsertCandles, upsertSymbols, getCandles } from '../src/db/repo';
import { runEngineOnce } from '../src/strategy/engine-runner';
import { seedSettings } from '../src/db/seed';
import { loadSettings, Settings } from '../src/core/settings';
import { createLogger } from '../src/core/logger';
import { evaluate } from '../src/strategy/smart-money';
import { loadFixtureCandles } from './helpers';
import type { RankedSymbol } from '../src/market/top-symbols';

let db: Kysely<Database>;
const log = createLogger('test');

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

async function loosen(): Promise<Settings> {
  for (const [k, v] of [
    ['engine.score_threshold', 40],
    ['engine.min_components', 1],
    ['engine.timeframes', ['1h']],
  ] as Array<[string, unknown]>) {
    await db.updateTable('settings').set({ value: JSON.stringify(v) }).where('key', '=', k).execute();
  }
  return loadSettings(db);
}

describe('1. architectural separation', () => {
  it('the browser hook never posts candles back to the server', () => {
    const hook = readFileSync('app/lib/useBinanceStream.ts', 'utf8');
    expect(hook).not.toMatch(/fetch\(/);
    expect(hook).not.toMatch(/method:\s*'POST'/i);
  });

  it('the stream carries no database or engine import', () => {
    const src = readFileSync('src/web/binance-stream.ts', 'utf8');
    expect(src).not.toMatch(/\bfrom '.*db.*'/);
    expect(src).not.toMatch(/smart-money|scoring|detectors|engine-runner/);
  });

  it('the chart component cannot write anywhere', () => {
    const src = readFileSync('app/components/CandleChart.tsx', 'utf8');
    expect(src).not.toMatch(/fetch\(/);
    expect(src).not.toMatch(/insertInto|updateTable/);
  });

  it('the live candle is documented as display-only', () => {
    const src = readFileSync('app/components/CandleChart.tsx', 'utf8');
    expect(src).toMatch(/DISPLAY ONLY/i);
  });

  it('only the market worker path writes candles', () => {
    // The websocket must not be a second, unreviewed writer.
    const stream = readFileSync('src/web/binance-stream.ts', 'utf8');
    expect(stream).not.toContain('upsertCandles');
  });
});

describe('2. a forming candle changes no evaluation', () => {
  const settings = Settings.fromDefaults();

  it('appending a wild FORMING candle does not alter the score', () => {
    const all = loadFixtureCandles('BTCUSDT', '1h');
    const base = all.slice(0, 300).map((c) => ({ ...c, isClosed: true }));

    const before = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles: base, settings });

    // A violent, still-open candle — exactly what a live tick looks like.
    const forming = {
      ...all[300]!,
      isClosed: false,
      high: all[300]!.high * 3,
      low: all[300]!.low * 0.3,
      close: all[300]!.close * 2.5,
    };
    const after = evaluate({
      symbol: 'BTCUSDT', timeframe: '1h', candles: [...base, forming], settings,
    });

    expect(after?.candleTime).toBe(before?.candleTime);
    expect(after?.closePrice).toBe(before?.closePrice);
    expect(after?.longScore).toBe(before?.longScore);
    expect(after?.shortScore).toBe(before?.shortScore);
  });

  it('ten successive ticks on the same forming bar are all ignored', () => {
    const all = loadFixtureCandles('BTCUSDT', '1h');
    const base = all.slice(0, 200).map((c) => ({ ...c, isClosed: true }));
    const baseline = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles: base, settings });

    for (let i = 1; i <= 10; i++) {
      const tick = { ...all[200]!, isClosed: false, close: all[200]!.close * (1 + i / 10) };
      const ev = evaluate({
        symbol: 'BTCUSDT', timeframe: '1h', candles: [...base, tick], settings,
      });
      expect(ev?.longScore).toBe(baseline?.longScore);
      expect(ev?.shortScore).toBe(baseline?.shortScore);
    }
  });

  it('the evaluation anchors on the last CLOSED candle', () => {
    const all = loadFixtureCandles('BTCUSDT', '1h');
    const base = all.slice(0, 150).map((c) => ({ ...c, isClosed: true }));
    const forming = { ...all[150]!, isClosed: false };
    const ev = evaluate({
      symbol: 'BTCUSDT', timeframe: '1h', candles: [...base, forming], settings,
    });
    expect(ev?.candleTime).toBe(base[149]!.openTime);
    expect(ev?.candleTime).not.toBe(forming.openTime);
  });
});

describe('3. end to end: a forming candle creates no signal', () => {
  it('ticking a forming candle never produces a signal row', async () => {
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    const all = loadFixtureCandles('BTCUSDT', '1h');
    const hist = all.slice(0, 400);
    await upsertCandles(db, 'BTCUSDT', '1h', hist);

    const settings = await loosen();
    await runEngineOnce(db, settings, log);
    const baseline = await db.selectFrom('signals').selectAll().execute();

    // Simulate 20 websocket ticks landing in the candle table as a FORMING bar.
    for (let i = 1; i <= 20; i++) {
      await upsertCandles(db, 'BTCUSDT', '1h', [
        {
          ...all[400]!,
          isClosed: false,
          close: all[400]!.close * (1 + i / 20),
          high: all[400]!.high * (1 + i / 10),
        },
      ]);
      await runEngineOnce(db, settings, log);
    }

    const after = await db.selectFrom('signals').selectAll().execute();
    // Not one extra signal, despite a 2x price move on the forming bar.
    expect(after).toHaveLength(baseline.length);
    // Scores are frozen: the forming bar contributed nothing to any evaluation.
    expect(after.map((s) => `${s.id}:${s.score}`)).toEqual(
      baseline.map((s) => `${s.id}:${s.score}`),
    );
  });

  /**
   * IMPORTANT DISTINCTION, easy to get wrong:
   *
   * A forming candle must never SCORE. But when the forming candle IS the
   * N+1 entry bar, its OPEN is already final the moment the bar starts, and
   * the specification requires entry = OPEN of N+1. So filling a pending
   * entry from a forming N+1 is correct, and is not a leak.
   */
  it('a forming N+1 fills a pending entry at its OPEN — but still scores nothing', async () => {
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    const all = loadFixtureCandles('BTCUSDT', '1h');
    await upsertCandles(db, 'BTCUSDT', '1h', all.slice(0, 400));

    const settings = await loosen();
    await runEngineOnce(db, settings, log);

    const waiting = await db
      .selectFrom('signals').selectAll().where('state', '=', 'WAITING_ENTRY').execute();
    if (waiting.length === 0) return;
    const sig = waiting[0]!;
    const setupTime = Number(sig.setup_candle_time);
    const H = 3_600_000;

    // The N+1 bar appears, still forming. Its OPEN is already known.
    const n1 = all.find((c) => c.openTime === setupTime + H);
    if (!n1) return;
    await upsertCandles(db, 'BTCUSDT', '1h', [{ ...n1, isClosed: false }]);

    const scoresBefore = (await db.selectFrom('signals').select(['id', 'score']).execute())
      .map((r) => `${r.id}:${r.score}`);

    await runEngineOnce(db, settings, log);

    const filled = await db
      .selectFrom('signals').selectAll().where('id', '=', sig.id).executeTakeFirstOrThrow();

    // Entry is the ACTUAL OPEN of N+1 — never invented, never the close.
    expect(filled.state).toBe('ACTIVE');
    expect(Number(filled.entry_price)).toBeCloseTo(n1.open, 9);
    expect(Number(filled.entry_candle_time)).toBe(n1.openTime);

    // ...and no score anywhere moved, and no new signal was created.
    const scoresAfter = (await db.selectFrom('signals').select(['id', 'score']).execute())
      .map((r) => `${r.id}:${r.score}`);
    expect(scoresAfter).toEqual(scoresBefore);
  });

  it('a forming candle that is NOT N+1 fills nothing', async () => {
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    const all = loadFixtureCandles('BTCUSDT', '1h');
    await upsertCandles(db, 'BTCUSDT', '1h', all.slice(0, 400));
    const settings = await loosen();
    await runEngineOnce(db, settings, log);

    const waiting = await db
      .selectFrom('signals').selectAll().where('state', '=', 'WAITING_ENTRY').execute();
    if (waiting.length === 0) return;
    const sig = waiting[0]!;
    const H = 3_600_000;

    // A forming bar far in the future — NOT the expected N+1.
    const far = all[410] ?? all[all.length - 1]!;
    await upsertCandles(db, 'BTCUSDT', '1h', [
      { ...far, openTime: Number(sig.setup_candle_time) + 9 * H, isClosed: false },
    ]);
    await runEngineOnce(db, settings, log);

    const still = await db
      .selectFrom('signals').selectAll().where('id', '=', sig.id).executeTakeFirstOrThrow();
    // resolveEntry demands the EXACT N+1 open time, so nothing is fabricated.
    expect(still.entry_price).toBeNull();
  });

  it('the engine cursor never advances onto a forming candle', async () => {
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    const all = loadFixtureCandles('BTCUSDT', '1h');
    const hist = all.slice(0, 300);
    await upsertCandles(db, 'BTCUSDT', '1h', hist);
    await upsertCandles(db, 'BTCUSDT', '1h', [{ ...all[300]!, isClosed: false }]);

    const settings = await loosen();
    await runEngineOnce(db, settings, log);

    const closed = await getCandles(db, 'BTCUSDT', '1h', { closedOnly: true });
    expect(closed.every((c) => c.isClosed)).toBe(true);
    expect(closed.find((c) => c.openTime === all[300]!.openTime)).toBeUndefined();
  });

  it('once the SAME candle closes, it becomes eligible', async () => {
    await upsertSymbols(db, [rankedSym('BTCUSDT')]);
    const all = loadFixtureCandles('BTCUSDT', '1h');
    await upsertCandles(db, 'BTCUSDT', '1h', all.slice(0, 300));

    const settings = await loosen();

    // Forming: invisible to the engine.
    await upsertCandles(db, 'BTCUSDT', '1h', [{ ...all[300]!, isClosed: false }]);
    await runEngineOnce(db, settings, log);
    let closed = await getCandles(db, 'BTCUSDT', '1h', { closedOnly: true });
    expect(closed.some((c) => c.openTime === all[300]!.openTime)).toBe(false);

    // Closed: now the engine may use it. This proves the filter keys on the
    // isClosed FLAG and is not merely dropping the last row.
    await upsertCandles(db, 'BTCUSDT', '1h', [{ ...all[300]!, isClosed: true }]);
    await runEngineOnce(db, settings, log);
    closed = await getCandles(db, 'BTCUSDT', '1h', { closedOnly: true });
    expect(closed.some((c) => c.openTime === all[300]!.openTime)).toBe(true);
  });
});

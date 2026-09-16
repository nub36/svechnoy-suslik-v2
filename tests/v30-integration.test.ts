/**
 * V3.0 END-TO-END against a REAL PostgreSQL.
 *
 * Drives the actual production path, not mocks:
 *
 *   candles -> runV30Once -> signal (WAITING_ENTRY, NO entry price)
 *           -> next bar fills the corridor -> OPEN with the fill price
 *           -> processOutcomes -> TP1_HIT milestone (trade still open)
 *           -> processOutcomes -> outcome row + terminal state + slot released
 *
 * The candles are SYNTHETIC and built inside the test: the trap bar sweeps a
 * deliberate 4H swing, so the assertions are about the plumbing, never about
 * market performance. No 2026 data is involved and nothing here can tune the
 * strategy — every figure is read back from the database and compared with the
 * pure modules.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { getTestPg, resetDb } from './pg';
import type { Database } from '../src/db/types';
import { upsertCandles, getCandles, loadState, saveState } from '../src/db/repo';
import { seedSettings } from '../src/db/seed';
import { loadSettings, type Settings } from '../src/core/settings';
import { createLogger } from '../src/core/logger';
import { tfMs, type Candle } from '../src/core/types';
import { runV30Once } from '../src/strategy/v30/runner';
import { symbolsWithLiveSignal } from '../src/strategy/engine-runner';
import { readPlan } from '../src/strategy/v30/runner';
import { resolveV30Outcome, v30Milestones } from '../src/strategy/v30/outcome';
import { processOutcomes } from '../src/workers/outcome.worker';
import { readV30Overlay, signalLabel } from '../src/web/overlays';

let db: Kysely<Database>;
const log = createLogger('test');
const H = tfMs('1h');
const H4 = tfMs('4h');

/** A 4H series with ONE strict trough (100 at index 10) and ONE strict peak (140 at index 20). */
const T0 = Date.UTC(2023, 0, 1);
const H4_TROUGH = 100;
const H4_PEAK = 140;
const H4_EQUILIBRIUM = (H4_TROUGH + H4_PEAK) / 2;

function h4Series(): Candle[] {
  return Array.from({ length: 40 }, (_, i) => {
    const openTime = T0 + i * H4;
    const high = H4_PEAK - Math.abs(i - 20) * 0.5;
    const low = H4_TROUGH + Math.abs(i - 10) * 0.4;
    const close = (high + low) / 2;
    return mk(openTime, close, high, low, close, H4, 100);
  });
}

function mk(
  openTime: number,
  open: number,
  high: number,
  low: number,
  close: number,
  span = H,
  volume = 100,
): Candle {
  return {
    openTime,
    closeTime: openTime + span - 1,
    open,
    high,
    low,
    close,
    volume,
    quoteVolume: volume * close,
    trades: 10,
    isClosed: true,
  };
}

/** Calm 1H history: ATR ≈ 1, no structure of its own. */
const CALM_BARS = 120;
const CALM_PRICE = 110;
const H1_START = T0 + 40 * H4;

function calmBars(n: number, from: number): Candle[] {
  return Array.from({ length: n }, (_, k) =>
    mk(from + k * H, CALM_PRICE, CALM_PRICE + 0.5, CALM_PRICE - 0.5, CALM_PRICE),
  );
}

let settings: Settings;

async function setSetting(key: string, value: unknown): Promise<void> {
  await db
    .updateTable('settings')
    .set({ value: JSON.stringify(value) })
    .where('key', '=', key)
    .execute();
}

beforeAll(async () => {
  db = (await getTestPg()).db;
}, 120_000);

afterAll(async () => {
  await (await getTestPg()).stop();
});

beforeEach(async () => {
  await resetDb(db);
  await seedSettings(db);
  // Keep the universe to one symbol: the strategy reads `v30.symbols`, and this
  // also proves the setting is honoured rather than decorative.
  await setSetting('v30.symbols', ['BTCUSDT']);
  await setSetting('strategy.active', 'V3_0');
  settings = await loadSettings(db);
});

describe('V3.0 live pipeline', () => {
  it('detects a trap, publishes a corridor with NO entry price, then fills it', async () => {
    await upsertCandles(db, 'BTCUSDT', '4h', h4Series());

    // Calm history plus ONE reclaim bar that sweeps the 4H trough and closes
    // back above it: open 104.5, high 105.5, low 99, close 101.2 -> body ratio
    // 3.3/6.5 = 0.51, volume 5x the average.
    const history = calmBars(CALM_BARS, H1_START);
    const trap = mk(H1_START + CALM_BARS * H, 104.5, 105.5, 99, 101.2, H, 500);
    await upsertCandles(db, 'BTCUSDT', '1h', [...history, trap]);

    // A leftover V1 slot on this symbol/timeframe. V3.0 does not use the state
    // machine, but it MUST free whatever slot the switch left behind.
    await saveState(db, {
      symbol: 'BTCUSDT',
      timeframe: '1h',
      state: 'HOLD_LONG',
      direction: 'LONG',
      initialised: true,
      lastCandleTime: 0,
      setupCandleTime: null,
      setupScore: null,
      activeSignalId: null,
    });

    const first = await runV30Once(db, settings, log);
    expect(first.strategy).toBe('V3_0');
    expect(first.dataReady).toEqual([
      {
        symbol: 'BTCUSDT',
        executionBars: CALM_BARS + 1,
        structureBars: 40,
        tradeable: true,
        note: 'ready',
      },
    ]);
    expect(first.signalsCreated).toBe(1);

    const sig = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    expect(sig.state).toBe('WAITING_ENTRY');
    // LIVE is rejected everywhere; the two paper modes are the only ones.
    expect(['DRY_RUN', 'FORWARD_TEST']).toContain(sig.mode);
    expect(sig.source).toBe('LIVE_ENGINE');
    // The setup candle is the trap bar, and NOTHING is filled yet.
    expect(Number(sig.setup_candle_time)).toBe(trap.openTime);
    expect(sig.entry_price).toBeNull();
    expect(sig.entry_candle_time).toBeNull();
    expect(sig.entry_at).toBeNull();
    // V3.0 has no score model: zero, not a fabricated number.
    expect(Number(sig.score)).toBe(0);
    expect(Number(sig.threshold)).toBe(0);

    const plan = readPlan(sig.breakdown);
    expect(plan).not.toBeNull();
    expect(plan!.strategy).toBe('V3_0');
    expect(plan!.plan.direction).toBe('LONG');
    expect(plan!.plan.level).toBe(H4_TROUGH);
    expect(plan!.plan.tp1).toBe(H4_EQUILIBRIUM); // 4H equilibrium
    expect(plan!.plan.tp2).toBe(H4_PEAK); // the opposing 4H swing
    expect(plan!.plan.stop).toBeLessThan(H4_TROUGH);
    expect(plan!.plan.zoneLow).toBeLessThan(plan!.plan.zoneHigh);
    expect(plan!.params.corridorExpiryBars).toBe(3);

    // The chart reads the SAME payload and never invents an entry.
    const overlay = readV30Overlay(sig.breakdown);
    expect(overlay!.zoneHigh).toBe(plan!.plan.zoneHigh);
    expect(overlay!.hitTp1).toBe(false);
    expect(signalLabel({ direction: sig.direction, score: sig.score, breakdown: sig.breakdown })).toBe(
      'V3.0 LONG',
    );

    // A second tick cannot create a second signal on the same symbol.
    const again = await runV30Once(db, settings, log);
    expect(again.signalsCreated).toBe(0);
    expect(await db.selectFrom('signals').select(db.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).toMatchObject(
      { n: 1 },
    );

    // ---- the corridor fills on the NEXT bar, at the zone edge -------------
    const zoneHigh = plan!.plan.zoneHigh;
    const zoneLow = plan!.plan.zoneLow;
    const fillBar = mk(trap.openTime + H, (zoneLow + zoneHigh) / 2, zoneHigh + 0.2, zoneLow - 0.5, zoneHigh - 0.1);
    await upsertCandles(db, 'BTCUSDT', '1h', [fillBar]);

    const filled = await runV30Once(db, settings, log);
    expect(filled.entriesFilled).toBe(1);

    const open = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    expect(open.state).toBe('OPEN');
    expect(Number(open.entry_candle_time)).toBe(fillBar.openTime);
    // min(open, zoneHigh) — the open is inside the zone, so it is the open.
    expect(Number(open.entry_price)).toBeCloseTo((zoneLow + zoneHigh) / 2, 8);
    expect(Number(open.stop_loss)).toBeCloseTo(plan!.plan.stop, 8);
    expect(open.take_profits).toEqual([plan!.plan.tp1, plan!.plan.tp2]);
    expect(Number(open.qty)).toBeGreaterThan(0);
    expect(Number(open.entry_price)).toBeGreaterThan(Number(open.stop_loss));

    // ---- TP1: a milestone, NOT a close ------------------------------------
    const entry = Number(open.entry_price);
    const tp1Bar = mk(fillBar.openTime + H, entry + 0.2, plan!.plan.tp1 + 0.5, entry, plan!.plan.tp1 - 0.5);
    await upsertCandles(db, 'BTCUSDT', '1h', [tp1Bar]);

    const mid = await processOutcomes(db, settings, log);
    expect(mid.v30Closed).toBe(0);
    expect(
      await db.selectFrom('outcomes').select(db.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    ).toMatchObject({ n: 0 });

    const afterTp1 = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    expect(afterTp1.state).toBe('TP1_HIT');
    expect(afterTp1.tp1_hit_at).not.toBeNull();
    expect(Number(afterTp1.tp_level)).toBe(1);
    // Still occupying the symbol.
    const held = await runV30Once(db, settings, log);
    expect(held.signalsCreated).toBe(0);

    // ---- TP2 closes the trade ---------------------------------------------
    const tp2Bar = mk(tp1Bar.openTime + H, entry + 5, plan!.plan.tp2 + 1, entry + 4, plan!.plan.tp2 + 0.5);
    await upsertCandles(db, 'BTCUSDT', '1h', [tp2Bar]);

    const done = await processOutcomes(db, settings, log);
    expect(done.v30Closed).toBe(1);

    const closed = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    expect(closed.state).toBe('TP2_HIT'); // V3.0's FINAL target
    expect(closed.tp2_hit_at).not.toBeNull();
    expect(Number(closed.tp_level)).toBe(2);

    const outcome = await db.selectFrom('outcomes').selectAll().executeTakeFirstOrThrow();
    expect(outcome.result).toBe('TP');
    expect(Number(outcome.r_multiple)).toBeGreaterThan(0);
    expect(Number(outcome.tp_hit_index)).toBe(2);
    // entry bar = 1, TP1 bar = 2, TP2 bar = 3 (R5: the entry bar counts).
    expect(Number(outcome.bars_held)).toBe(3);

    // The database figure must equal what the pure walker computes on the same
    // candles — the live record and the validated simulator share one engine.
    const candles = await getCandles(db, 'BTCUSDT', '1h', {
      closedOnly: true,
      from: Number(open.entry_candle_time),
      limit: 5000,
    });
    const pure = resolveV30Outcome({
      plan: plan!,
      direction: 'LONG',
      entryPrice: entry,
      stopLoss: Number(open.stop_loss),
      entryCandleTime: Number(open.entry_candle_time),
      candles,
      settings,
    });
    expect(pure).not.toBeNull();
    expect(Number(outcome.r_multiple)).toBeCloseTo(pure!.netR, 8);
    // NET of fees is the headline: gross must be strictly larger.
    expect(pure!.grossR).toBeGreaterThan(pure!.netR);
    expect(pure!.feeR).toBeGreaterThan(0);
    // Three fee legs: maker entry + TP1 half + TP2 remaining half.
    expect(pure!.legs.length).toBe(3);

    // Slots are released for both strategies' vocabularies.
    const slot = await loadState(db, 'BTCUSDT', '1h');
    expect(slot.state).toBe('REARM');
    expect(slot.activeSignalId).toBeNull();

    // ...and the symbol is free again for the OTHER engine too. V3.0's final
    // target maps onto TP2_HIT, which the site vocabulary treats as live; the
    // anti-join on `outcomes` is what stops a closed trade from blocking the
    // symbol forever.
    expect(await symbolsWithLiveSignal(db)).not.toContain('BTCUSDT');

    // A replay of the outcome worker must NOT produce a second outcome row.
    const replay = await processOutcomes(db, settings, log);
    expect(replay.v30Closed).toBe(0);
    expect(
      await db.selectFrom('outcomes').select(db.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    ).toMatchObject({ n: 1 });
  });

  it('the two engines cannot open parallel positions on one symbol', async () => {
    await upsertCandles(db, 'BTCUSDT', '4h', h4Series());
    const history = calmBars(CALM_BARS, H1_START);
    const trap = mk(H1_START + CALM_BARS * H, 104.5, 105.5, 99, 101.2, H, 500);
    await upsertCandles(db, 'BTCUSDT', '1h', [...history, trap]);
    await runV30Once(db, settings, log);

    // While V3.0 holds the symbol, the V1 engine's busy-symbol guard sees it.
    expect(await symbolsWithLiveSignal(db)).toContain('BTCUSDT');

    // And a V3.0 runner that finds a foreign (V1) live signal on the symbol
    // leaves it completely alone: no new signal, no state written to it.
    const sig = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    await db
      .updateTable('signals')
      .set({ breakdown: JSON.stringify({ components: [], score: 61 }) })
      .where('id', '=', sig.id)
      .execute();
    const res = await runV30Once(db, settings, log);
    expect(res.signalsCreated).toBe(0);
    expect(res.skippedHeld).toBe(1);
    const after = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    expect(after.state).toBe('WAITING_ENTRY');
    expect(after.entry_price).toBeNull();
  });

  it('a SHORT trap that hits the stop closes as STOPPED with a negative R', async () => {
    await upsertCandles(db, 'BTCUSDT', '4h', h4Series());

    const history = calmBars(CALM_BARS, H1_START);
    // Sweeps the 4H PEAK and closes back below it.
    const trap = mk(H1_START + CALM_BARS * H, 139.5, H4_PEAK + 1.5, 135.5, 137.2, H, 500);
    await upsertCandles(db, 'BTCUSDT', '1h', [...history, trap]);

    await runV30Once(db, settings, log);
    const sig = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    const plan = readPlan(sig.breakdown)!;
    expect(plan.plan.direction).toBe('SHORT');
    expect(plan.plan.tp1).toBe(H4_EQUILIBRIUM);
    expect(plan.plan.tp2).toBe(H4_TROUGH);
    expect(plan.plan.stop).toBeGreaterThan(H4_PEAK);

    const fillBar = mk(
      trap.openTime + H,
      (plan.plan.zoneLow + plan.plan.zoneHigh) / 2,
      plan.plan.zoneHigh + 0.5,
      plan.plan.zoneLow - 0.2,
      plan.plan.zoneLow + 0.1,
    );
    await upsertCandles(db, 'BTCUSDT', '1h', [fillBar]);
    const filled = await runV30Once(db, settings, log);
    expect(filled.entriesFilled).toBe(1);

    const open = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    const entry = Number(open.entry_price);
    expect(entry).toBeLessThan(Number(open.stop_loss));

    // Straight to the stop on the next bar; TP1 (much lower) is never reached.
    const stopBar = mk(fillBar.openTime + H, entry, Number(open.stop_loss) + 1, entry - 1, Number(open.stop_loss) - 0.1);
    await upsertCandles(db, 'BTCUSDT', '1h', [stopBar]);

    const res = await processOutcomes(db, settings, log);
    expect(res.v30Closed).toBe(1);

    const closed = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    expect(closed.state).toBe('STOPPED');
    expect(closed.stopped_at).not.toBeNull();

    const outcome = await db.selectFrom('outcomes').selectAll().executeTakeFirstOrThrow();
    expect(outcome.result).toBe('SL');
    expect(Number(outcome.r_multiple)).toBeLessThan(0);
    // A clean stop is -1 R GROSS; fees make it slightly worse, never better.
    expect(Number(outcome.r_multiple)).toBeLessThan(-1);
    expect(Number(outcome.r_multiple)).toBeGreaterThan(-1.1);

    // The milestone walk agrees the trade never reached TP1.
    const candles = await getCandles(db, 'BTCUSDT', '1h', {
      closedOnly: true,
      from: Number(open.entry_candle_time),
      limit: 5000,
    });
    const milestone = v30Milestones({
      plan,
      direction: 'SHORT',
      entryPrice: entry,
      stopLoss: Number(open.stop_loss),
      entryCandleTime: Number(open.entry_candle_time),
      candles,
      settings,
    });
    expect(milestone.tp1Hit).toBe(false);
    expect(closed.tp1_hit_at).toBeNull();
  });

  it('expires an unfilled corridor after the frozen 3 bars', async () => {
    await upsertCandles(db, 'BTCUSDT', '4h', h4Series());
    const history = calmBars(CALM_BARS, H1_START);
    const trap = mk(H1_START + CALM_BARS * H, 104.5, 105.5, 99, 101.2, H, 500);
    await upsertCandles(db, 'BTCUSDT', '1h', [...history, trap]);
    await runV30Once(db, settings, log);

    const sig = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    const plan = readPlan(sig.breakdown)!;
    // Three bars that stay well above the corridor and never touch the stop.
    const away = plan.plan.zoneHigh + 10;
    const drift: Candle[] = [1, 2, 3].map((k) =>
      mk(trap.openTime + k * H, away, away + 1, away - 1, away),
    );
    await upsertCandles(db, 'BTCUSDT', '1h', drift);

    const res = await runV30Once(db, settings, log);
    expect(res.expired).toBe(1);
    expect(res.entriesFilled).toBe(0);

    const after = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    expect(after.state).toBe('EXPIRED');
    expect(after.expired_at).not.toBeNull();
    // No outcome row: an unfilled order was never a trade.
    expect(
      await db.selectFrom('outcomes').select(db.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    ).toMatchObject({ n: 0 });
    // ...and the symbol is free again, so a new setup may be detected.
    const next = await runV30Once(db, settings, log);
    expect(next.skippedHeld).toBe(0);
  });

  it('cancels a corridor whose stop is breached before it fills', async () => {
    await upsertCandles(db, 'BTCUSDT', '4h', h4Series());
    const history = calmBars(CALM_BARS, H1_START);
    const trap = mk(H1_START + CALM_BARS * H, 104.5, 105.5, 99, 101.2, H, 500);
    await upsertCandles(db, 'BTCUSDT', '1h', [...history, trap]);
    await runV30Once(db, settings, log);

    const sig = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    const plan = readPlan(sig.breakdown)!;
    // A bar that dives straight through the stop without filling the limit.
    const crash = mk(trap.openTime + H, plan.plan.stop + 2, plan.plan.stop + 2.5, plan.plan.stop - 2, plan.plan.stop - 1.5);
    await upsertCandles(db, 'BTCUSDT', '1h', [crash]);

    const res = await runV30Once(db, settings, log);
    expect(res.cancelled).toBe(1);
    const after = await db.selectFrom('signals').selectAll().executeTakeFirstOrThrow();
    expect(after.state).toBe('EXPIRED');
    expect(after.direction).toBe('LONG');
  });
});

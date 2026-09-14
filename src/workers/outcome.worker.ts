/**
 * OUTCOME worker — the ONLY writer of `outcomes` and of signal milestones.
 *
 * Walks CLOSED candles after each in-position signal's entry candle and
 * records the take-profit ladder PROGRESSIVELY:
 *
 *     OPEN -> TP1_HIT -> TP2_HIT -> TP3_HIT
 *                \         \
 *                 +---------+--> STOPPED     (TP milestones are RETAINED)
 *
 * Reaching TP1 no longer closes the trade. Each milestone writes its own
 * timestamp exactly once and those timestamps are never cleared, so a trade
 * that hit TP1 and was later stopped still proves it reached TP1.
 *
 * Only TP3_HIT, STOPPED and EXPIRED are terminal; only then is the `outcomes`
 * row written and the state-machine slot released.
 *
 * CLOSED CANDLES ONLY — a forming bar must never resolve a milestone.
 */

import type { Kysely } from 'kysely';
import { getDb, closeDb, migrate } from '../db';
import type { Database } from '../db/types';
import { loadSettings, type Settings } from '../core/settings';
import { createLogger, type Logger } from '../core/logger';
import { trackMilestones, trackOutcome, type MilestoneKind } from '../outcome/tracker';
import { getCandles, heartbeat } from '../db/repo';
import { releaseSlot } from '../strategy/engine-runner';
import { config } from '../core/config';
import { IN_POSITION_STATES, type Direction, type SignalState, type Timeframe } from '../core/types';

const WORKER = 'outcome';

/**
 * The outcome `result` implied by each TERMINAL signal state. Used to assert
 * that the milestone walk and the P&L walk cannot disagree on new data.
 * Non-terminal states are absent because they never write an outcome row.
 */
const EXPECTED_RESULT_FOR: Partial<Record<SignalState, 'TP' | 'SL' | 'TIMEOUT'>> = {
  TP3_HIT: 'TP',
  STOPPED: 'SL',
  EXPIRED: 'TIMEOUT',
};

export async function processOutcomes(
  db: Kysely<Database>,
  settings: Settings,
  log: Logger,
): Promise<{ checked: number; closed: number }> {
  const active = await db
    .selectFrom('signals')
    .selectAll()
    .where('state', 'in', [...IN_POSITION_STATES])
    .where('source', '=', 'LIVE_ENGINE')
    .execute();

  let closed = 0;
  for (const sig of active) {
    const entryTime = sig.entry_candle_time === null ? null : Number(sig.entry_candle_time);
    const entryPrice = sig.entry_price;
    const stopLoss = sig.stop_loss;
    if (entryTime === null || entryPrice === null || stopLoss === null) continue;

    const tf = sig.timeframe as Timeframe;
    const candles = await getCandles(db, sig.symbol, tf, {
      closedOnly: true,
      from: entryTime,
      limit: 5000,
    });
    if (candles.length === 0) continue;

    const takeProfits = Array.isArray(sig.take_profits) ? (sig.take_profits as number[]) : [];

    const track = trackMilestones({
      direction: sig.direction as Direction,
      entryPrice,
      stopLoss,
      takeProfits,
      entryCandleTime: entryTime,
      candles,
      settings,
    });

    const prevLevel = Number(sig.tp_level ?? 0);
    const prevState = sig.state as SignalState;

    // Build the milestone timestamp patch. Each column is written ONCE: the
    // `IS NULL` guard in SQL plus these checks make reprocessing idempotent.
    const now = new Date();
    const patch: Record<string, unknown> = {};
    const reached = (k: MilestoneKind): boolean =>
      track.milestones.some((m) => m.kind === k);

    if (reached('TP1') && sig.tp1_hit_at === null) patch['tp1_hit_at'] = now;
    if (reached('TP2') && sig.tp2_hit_at === null) patch['tp2_hit_at'] = now;
    if (reached('TP3') && sig.tp3_hit_at === null) patch['tp3_hit_at'] = now;
    if (track.terminal?.kind === 'SL' && sig.stopped_at === null) patch['stopped_at'] = now;
    if (track.terminal?.kind === 'TIMEOUT' && sig.expired_at === null) patch['expired_at'] = now;
    if (track.tpLevel > prevLevel) patch['tp_level'] = track.tpLevel;
    if (track.state !== prevState) patch['state'] = track.state;

    const isTerminalNow = track.terminal !== null || track.state === 'TP3_HIT';

    if (Object.keys(patch).length === 0 && !isTerminalNow) continue; // nothing new

    if (!isTerminalNow) {
      // Progressive milestone only — the trade stays open.
      patch['updated_at'] = now;
      await db.updateTable('signals').set(patch).where('id', '=', sig.id).execute();
      if (track.state !== prevState) {
        log.info(
          `MILESTONE ${track.state} ${sig.symbol} ${tf} ${sig.direction} (trade still open)`,
          { signalId: Number(sig.id), tpLevel: track.tpLevel },
        );
      }
      continue;
    }

    // --- terminal: write the outcome row and release the slot -----------
    // trackOutcome() stays the single source of truth for the P&L figures so
    // live statistics and replay cannot drift apart.
    const out = trackOutcome({
      direction: sig.direction as Direction,
      entryPrice,
      stopLoss,
      takeProfits,
      entryCandleTime: entryTime,
      candles,
      settings,
      qty: sig.qty ?? 0,
    });
    if (!out) continue;

    // CONSISTENCY GUARD (see FIX 12).
    // Production contains a legacy row where signal.state=EXPIRED sits next to
    // outcome.result=TP, created by the pre-progressive logic. That historical
    // data is left alone, but NEW rows must never be self-contradictory.
    // trackMilestones() and trackOutcome() walk the same bars under the same
    // rules, so a disagreement means a real bug — skip the write and shout,
    // rather than persisting a STOPPED signal carrying a winning outcome.
    const expected = EXPECTED_RESULT_FOR[track.state];
    if (expected !== undefined && expected !== out.result) {
      log.error(
        `outcome/state mismatch for signal ${sig.id}: state=${track.state} ` +
          `implies result=${expected} but tracker returned ${out.result}; skipping write`,
        { signalId: Number(sig.id), symbol: sig.symbol, timeframe: tf },
      );
      continue;
    }
    if (out.result === 'SL' && out.rMultiple > 0) {
      log.error(
        `refusing to write a STOPPED outcome with positive R for signal ${sig.id}`,
        { signalId: Number(sig.id), rMultiple: out.rMultiple },
      );
      continue;
    }

    patch['updated_at'] = now;

    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('outcomes')
        .values({
          signal_id: sig.id,
          result: out.result,
          exit_price: out.exitPrice,
          exit_candle_time: out.exitCandleTime,
          bars_held: out.barsHeld,
          pnl_pct: out.pnlPct,
          pnl_quote: out.pnlQuote,
          r_multiple: out.rMultiple,
          max_favorable_pct: out.maxFavorablePct,
          max_adverse_pct: out.maxAdversePct,
          tp_hit_index: out.tpHitIndex,
          created_at: new Date(),
        })
        .onConflict((oc) => oc.column('signal_id').doNothing())
        .execute();

      await trx.updateTable('signals').set(patch).where('id', '=', sig.id).execute();
    });

    await releaseSlot(db, sig.symbol, tf);
    closed++;
    log.info(
      `OUTCOME ${track.state} (${out.result}) ${sig.symbol} ${tf} ${sig.direction} ` +
        `R=${out.rMultiple.toFixed(3)} pnl=${out.pnlPct.toFixed(3)}% tpLevel=${track.tpLevel}`,
      { signalId: Number(sig.id), barsHeld: out.barsHeld, exitPrice: out.exitPrice },
    );
  }

  return { checked: active.length, closed };
}

async function tick(state: { loops: number; errors: number }): Promise<void> {
  const db = getDb();
  const log = createLogger(WORKER, db);
  const settings = await loadSettings(db);
  const res = await processOutcomes(db, settings, log);
  state.loops++;
  await heartbeat(
    db,
    WORKER,
    state.errors > 0 ? 'DEGRADED' : 'OK',
    `active=${res.checked} closed=${res.closed}`,
    state.loops,
    state.errors,
  );
}

async function main(): Promise<void> {
  const log = createLogger(WORKER);
  log.info('outcome worker starting', { loopMs: config.outcomeLoopMs });
  await migrate();

  const state = { loops: 0, errors: 0 };
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
      log.error('outcome loop error', { error: err instanceof Error ? err.message : String(err) });
    }
    await new Promise((r) => setTimeout(r, config.outcomeLoopMs));
  }
}

if (require.main === module) {
  void main();
}

export { tick as outcomeTick };

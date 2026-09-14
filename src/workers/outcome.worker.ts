/**
 * OUTCOME worker — the ONLY writer of `outcomes` and of terminal signal states.
 *
 * Walks CLOSED candles after each ACTIVE signal's entry candle and resolves
 * TP / SL / TIMEOUT, then frees the state-machine slot.
 */

import type { Kysely } from 'kysely';
import { getDb, closeDb, migrate } from '../db';
import type { Database } from '../db/types';
import { loadSettings, type Settings } from '../core/settings';
import { createLogger, type Logger } from '../core/logger';
import { trackOutcome } from '../outcome/tracker';
import { getCandles, heartbeat } from '../db/repo';
import { releaseSlot } from '../strategy/engine-runner';
import { config } from '../core/config';
import type { Direction, SignalState, Timeframe } from '../core/types';

const WORKER = 'outcome';

export async function processOutcomes(
  db: Kysely<Database>,
  settings: Settings,
  log: Logger,
): Promise<{ checked: number; closed: number }> {
  const active = await db
    .selectFrom('signals')
    .selectAll()
    .where('state', '=', 'ACTIVE')
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
    if (!out) continue; // still open

    const newState: SignalState =
      out.result === 'TP' ? 'CLOSED_TP' : out.result === 'SL' ? 'CLOSED_SL' : 'CLOSED_TIMEOUT';

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

      await trx
        .updateTable('signals')
        .set({ state: newState, updated_at: new Date() })
        .where('id', '=', sig.id)
        .execute();
    });

    await releaseSlot(db, sig.symbol, tf);
    closed++;
    log.info(
      `OUTCOME ${out.result} ${sig.symbol} ${tf} ${sig.direction} R=${out.rMultiple.toFixed(3)} pnl=${out.pnlPct.toFixed(3)}%`,
      { signalId: sig.id, barsHeld: out.barsHeld, exitPrice: out.exitPrice },
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

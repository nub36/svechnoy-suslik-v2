/**
 * Live engine runner: for each active symbol/timeframe
 *   1. load CLOSED candles
 *   2. evaluate with THE Smart Money engine
 *   3. feed the persistent state machine (EDGE-only)
 *   4. persist a signal on the rising edge (entry left NULL until N+1 exists)
 *   5. promote WAITING_ENTRY -> ACTIVE once candle N+1 is available
 */

import type { Kysely } from 'kysely';
import type { Database } from '../db/types';
import type { Evaluation, Timeframe } from '../core/types';
import { tfMs } from '../core/types';
import type { Settings } from '../core/settings';
import { evaluate } from './smart-money';
import { resolveEntry, step } from './state-machine';
import { buildRiskPlan } from './risk';
import { getActiveSymbols, getCandles, loadState, saveState } from '../db/repo';
import type { Logger } from '../core/logger';

export interface RunnerResult {
  evaluated: number;
  signalsCreated: number;
  entriesFilled: number;
  skipped: string[];
}

export async function runEngineOnce(
  db: Kysely<Database>,
  settings: Settings,
  log: Logger,
): Promise<RunnerResult> {
  const result: RunnerResult = { evaluated: 0, signalsCreated: 0, entriesFilled: 0, skipped: [] };

  if (!settings.bool('engine.enabled')) {
    result.skipped.push('engine disabled by settings');
    return result;
  }

  const mode = settings.tradingMode(); // never LIVE
  const timeframes = settings.timeframes();
  const lookback = Math.floor(settings.num('engine.lookback_candles'));
  const maxConcurrent = Math.floor(settings.num('risk.max_concurrent'));
  const minRr = settings.num('risk.min_rr');

  const symbols = await getActiveSymbols(db);

  // ---- 1. promote existing WAITING_ENTRY signals (N+1 arrival) ----
  result.entriesFilled = await fillPendingEntries(db, settings, log);

  // ---- 2. capacity check ----
  const openCount = await countOpen(db);

  for (const s of symbols) {
    for (const tf of timeframes) {
      const candles = await getCandles(db, s.symbol, tf, {
        closedOnly: true,
        limit: lookback + 5,
      });
      if (candles.length < 40) {
        result.skipped.push(`${s.symbol} ${tf}: only ${candles.length} closed candles`);
        continue;
      }

      let ev: Evaluation | null;
      try {
        ev = evaluate({ symbol: s.symbol, timeframe: tf, candles, settings });
      } catch (err) {
        log.error(`evaluate failed for ${s.symbol} ${tf}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (!ev) continue;
      result.evaluated++;

      const state = await loadState(db, s.symbol, tf);
      const { next, action } = step(state, ev);

      if (action.kind === 'EMIT_SIGNAL') {
        if (openCount + result.signalsCreated >= maxConcurrent) {
          log.info(`max_concurrent reached, suppressing ${s.symbol} ${tf}`, { maxConcurrent });
          // Advance the cursor but stay IDLE so we do not lose the edge forever.
          await saveState(db, { ...next, state: 'IDLE', direction: null, setupCandleTime: null, setupScore: null });
          continue;
        }

        // ATR is required for the RISK plan only.
        if (ev.atr === null || !(ev.atr > 0)) {
          log.warn(`no ATR for ${s.symbol} ${tf}, cannot size risk`, {});
          await saveState(db, { ...next, state: 'IDLE', direction: null, setupCandleTime: null, setupScore: null });
          continue;
        }

        // Provisional plan is computed on the setup close purely to validate
        // R:R. The REAL plan is recomputed from the N+1 open at fill time.
        const provisional = buildRiskPlan({
          direction: action.direction,
          entry: ev.closePrice,
          atr: ev.atr,
          settings,
        });
        if (!provisional || provisional.rrTp1 < minRr) {
          // 6 decimals: a 2-decimal round can print the confusing "1.00 < 1".
          log.info(
            `rejected ${s.symbol} ${tf}: R:R ${provisional?.rrTp1?.toFixed(6) ?? 'n/a'} < min_rr ${minRr}`,
          );
          await saveState(db, { ...next, state: 'IDLE', direction: null, setupCandleTime: null, setupScore: null });
          continue;
        }

        const inserted = await db
          .insertInto('signals')
          .values({
            symbol: s.symbol,
            timeframe: tf,
            direction: action.direction,
            state: 'WAITING_ENTRY',
            mode,
            source: 'LIVE_ENGINE',
            replay_run_id: null,
            score: action.score,
            threshold: action.threshold,
            breakdown: JSON.stringify(action.direction === 'LONG' ? ev.long : ev.short),
            events: JSON.stringify(ev.events),
            setup_candle_time: action.setupCandleTime,
            setup_close: action.setupClose,
            entry_candle_time: null,
            entry_price: null,
            entry_at: null,
            stop_loss: null,
            take_profits: JSON.stringify([]),
            atr: ev.atr,
            rr_tp1: provisional.rrTp1,
            qty: null,
            position_quote: null,
            created_at: new Date(),
            updated_at: new Date(),
          })
          .onConflict((oc) => oc.doNothing())
          .returning('id')
          .executeTakeFirst();

        if (!inserted) {
          // Unique constraint hit => this edge was already recorded.
          await saveState(db, next);
          continue;
        }

        result.signalsCreated++;
        await saveState(db, { ...next, activeSignalId: Number(inserted.id) });
        log.info(
          `SIGNAL ${action.direction} ${s.symbol} ${tf} score=${action.score.toFixed(2)} (entry pending N+1)`,
          { signalId: Number(inserted.id), setupCandleTime: action.setupCandleTime },
        );
      } else {
        await saveState(db, next);
      }
    }
  }

  // Try once more so a signal created this tick can fill if N+1 already exists.
  result.entriesFilled += await fillPendingEntries(db, settings, log);

  return result;
}

async function countOpen(db: Kysely<Database>): Promise<number> {
  const row = await db
    .selectFrom('signals')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('state', 'in', ['WAITING_ENTRY', 'ACTIVE'])
    .where('source', '=', 'LIVE_ENGINE')
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/**
 * Promote WAITING_ENTRY -> ACTIVE using the OPEN of candle N+1.
 * Never invents an entry: if N+1 does not exist, the signal waits.
 */
export async function fillPendingEntries(
  db: Kysely<Database>,
  settings: Settings,
  log: Logger,
): Promise<number> {
  const pending = await db
    .selectFrom('signals')
    .selectAll()
    .where('state', '=', 'WAITING_ENTRY')
    .where('source', '=', 'LIVE_ENGINE')
    .execute();

  let filled = 0;
  for (const sig of pending) {
    const tf = sig.timeframe as Timeframe;
    const setupTime = Number(sig.setup_candle_time);
    const nextOpenTime = setupTime + tfMs(tf);

    const rows = await getCandles(db, sig.symbol, tf, {
      from: nextOpenTime,
      to: nextOpenTime,
      limit: 1,
    });
    const nextCandle = rows[0] ?? null;

    const entry = resolveEntry(setupTime, tfMs(tf), nextCandle);
    if (!entry) continue; // N+1 not available yet — keep waiting

    const atr = sig.atr;
    if (atr === null || !(atr > 0)) continue;

    const plan = buildRiskPlan({
      direction: sig.direction as 'LONG' | 'SHORT',
      entry: entry.entryPrice,
      atr,
      settings,
    });
    if (!plan) {
      await db
        .updateTable('signals')
        .set({ state: 'CANCELLED', updated_at: new Date() })
        .where('id', '=', sig.id)
        .execute();
      await releaseSlot(db, sig.symbol, tf);
      continue;
    }

    await db
      .updateTable('signals')
      .set({
        state: 'ACTIVE',
        entry_candle_time: entry.entryCandleTime,
        entry_price: entry.entryPrice,
        entry_at: new Date(),
        stop_loss: plan.stopLoss,
        take_profits: JSON.stringify(plan.takeProfits),
        rr_tp1: plan.rrTp1,
        qty: plan.qty,
        position_quote: plan.positionSizeQuote,
        updated_at: new Date(),
      })
      .where('id', '=', sig.id)
      .execute();

    await db
      .updateTable('strategy_state')
      .set({ state: 'ACTIVE', updated_at: new Date() })
      .where('symbol', '=', sig.symbol)
      .where('timeframe', '=', tf)
      .where('active_signal_id', '=', sig.id)
      .execute();

    filled++;
    log.info(
      `ENTRY ${sig.direction} ${sig.symbol} ${tf} @ ${entry.entryPrice} (open of N+1 ${new Date(entry.entryCandleTime).toISOString()})`,
      { signalId: sig.id, stopLoss: plan.stopLoss, takeProfits: plan.takeProfits },
    );
  }
  return filled;
}

export async function releaseSlot(
  db: Kysely<Database>,
  symbol: string,
  timeframe: Timeframe,
): Promise<void> {
  await db
    .updateTable('strategy_state')
    .set({
      state: 'IDLE',
      direction: null,
      setup_candle_time: null,
      setup_score: null,
      active_signal_id: null,
      updated_at: new Date(),
    })
    .where('symbol', '=', symbol)
    .where('timeframe', '=', timeframe)
    .execute();
}

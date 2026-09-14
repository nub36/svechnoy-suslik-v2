/**
 * Live engine runner: for each active symbol/timeframe
 *   1. load CLOSED candles
 *   2. evaluate with THE Smart Money engine
 *   3. feed the persistent state machine (EDGE-only)
 *   4. persist a signal on the rising edge (entry left NULL until N+1 exists)
 *   5. promote WAITING_ENTRY -> ACTIVE once candle N+1 is available
 *
 * WHICH TIMEFRAMES ARE SCANNED
 * ----------------------------
 * Exclusively `engine.timeframes` (via settings.timeframes()). It is the
 * single source of truth; there is deliberately no second timeframe setting.
 * Settings are reloaded by the worker each loop, so an admin change takes
 * effect on the next loop with no restart. Scan slots are therefore
 * `active TOP-N symbols x selected timeframes`.
 *
 * Disabling a timeframe stops evaluation but never deletes its
 * `strategy_state` rows or its signals — the cursor is preserved so the
 * timeframe can resume later.
 *
 * This selection applies to SCANNING ONLY. The market worker keeps ingesting
 * candles for every supported timeframe, so charts stay live for timeframes
 * that are not currently scanned.
 *
 * SEQUENTIAL CATCH-UP
 * -------------------
 * Re-enabling a timeframe (or worker downtime) leaves a gap between the
 * persisted cursor and the newest closed candle. We must NOT jump straight to
 * the newest bar: that skips the intermediate observations and a condition
 * that has been true the whole time would look like a fresh rising edge.
 * Instead each missing CLOSED candle is replayed through the state machine in
 * order, exactly as if the worker had never stopped. Beyond
 * `engine.max_catchup_candles` the gap is treated as a cold start and the slot
 * is re-baselined (silently) rather than partially replayed.
 *
 * ONE ACTIVE SIGNAL PER SYMBOL
 * ----------------------------
 * A symbol may hold at most one non-terminal signal across ALL timeframes.
 * While BTCUSDT has a live 15m signal, a BTCUSDT 1h edge is suppressed (and
 * settled into HOLD so it cannot re-fire later as a stale edge); other symbols
 * are unaffected.
 */

import type { Kysely } from 'kysely';
import type { Database } from '../db/types';
import type { Evaluation, Timeframe } from '../core/types';
import { LIVE_SIGNAL_STATES, tfMs } from '../core/types';
import type { Settings } from '../core/settings';
import { evaluate } from './smart-money';
import { resolveEntry, settleEdge, step } from './state-machine';
import { buildRiskPlan } from './risk';
import { getActiveSymbols, getCandles, loadState, saveState } from '../db/repo';
import type { Logger } from '../core/logger';

export interface RunnerResult {
  evaluated: number;
  signalsCreated: number;
  entriesFilled: number;
  skipped: string[];
  /** Timeframes actually scanned this loop (from engine.timeframes). */
  timeframesScanned: Timeframe[];
  /** symbols x timeframes actually visited. */
  scanSlots: number;
  /** CLOSED candles replayed by the catch-up path. */
  caughtUp: number;
  /** Edges suppressed by the one-active-signal-per-symbol policy. */
  suppressedBySymbolPolicy: number;
}

export async function runEngineOnce(
  db: Kysely<Database>,
  settings: Settings,
  log: Logger,
): Promise<RunnerResult> {
  const result: RunnerResult = {
    evaluated: 0,
    signalsCreated: 0,
    entriesFilled: 0,
    skipped: [],
    timeframesScanned: [],
    scanSlots: 0,
    caughtUp: 0,
    suppressedBySymbolPolicy: 0,
  };

  if (!settings.bool('engine.enabled')) {
    result.skipped.push('engine disabled by settings');
    return result;
  }

  const mode = settings.tradingMode(); // never LIVE
  const timeframes = settings.timeframes();
  const lookback = Math.floor(settings.num('engine.lookback_candles'));
  const maxConcurrent = Math.floor(settings.num('risk.max_concurrent'));
  const minRr = settings.num('risk.min_rr');

  const allSymbols = await getActiveSymbols(db);

  // Optional admin allow-list. Empty = the whole TOP-N.
  const allowed = settings.enabledSymbols();
  const symbols =
    allowed.length > 0 ? allSymbols.filter((s) => allowed.includes(s.symbol)) : allSymbols;
  if (allowed.length > 0 && symbols.length === 0) {
    result.skipped.push('market.enabled_symbols matched none of the active TOP-N symbols');
  }

  // ---- 1. promote existing WAITING_ENTRY signals (N+1 arrival) ----
  result.entriesFilled = await fillPendingEntries(db, settings, log);

  // ---- 1b. expire stale WAITING_ENTRY signals ----
  await expireStaleSignals(db, settings, log);

  // ---- 2. capacity check ----
  const openCount = await countOpen(db);
  const maxCatchup = Math.floor(settings.num('engine.max_catchup_candles'));

  // Symbols already holding a live signal on ANY timeframe. One active signal
  // per symbol: a second timeframe must not open a parallel position on the
  // same asset.
  const busySymbols = await symbolsWithLiveSignal(db);

  // Exactly the selected timeframes are scanned — nothing else.
  result.timeframesScanned = [...timeframes];

  for (const s of symbols) {
    for (const tf of timeframes) {
      result.scanSlots++;
      const candles = await getCandles(db, s.symbol, tf, {
        closedOnly: true,
        limit: Math.max(lookback + 5, maxCatchup + lookback + 5),
      });
      if (candles.length < 40) {
        result.skipped.push(`${s.symbol} ${tf}: only ${candles.length} closed candles`);
        continue;
      }

      const state = await loadState(db, s.symbol, tf);

      // ---- sequential catch-up ------------------------------------------
      // Every CLOSED candle strictly newer than the cursor must be fed to the
      // machine IN ORDER. Jumping to the newest bar would hide the
      // intermediate observations and turn a long-standing condition into a
      // bogus rising edge the moment a timeframe is re-enabled.
      // A slot that has NEVER been observed must not replay history: every
      // replayed bar after the first would be a real transition, so a cold
      // start would emit immediately — precisely the bootstrap defect. An
      // unseen slot therefore takes its baseline from the newest candle only.
      const pending = state.initialised
        ? candles.filter((c) => c.openTime > state.lastCandleTime)
        : [];
      const newestBar = candles[candles.length - 1];
      const toProcess = pending.length > 0 ? pending : newestBar ? [newestBar] : [];

      if (state.initialised && pending.length > maxCatchup) {
        // Gap too large to replay honestly: re-baseline instead. This is the
        // same guarantee as a cold start — silent, and incapable of emitting.
        const newest = candles[candles.length - 1];
        if (newest) {
          await saveState(db, {
            ...state,
            state: 'REARM',
            direction: null,
            setupCandleTime: null,
            setupScore: null,
            lastCandleTime: newest.openTime,
            initialised: true,
          });
          log.info(
            `catch-up gap too large for ${s.symbol} ${tf} (${pending.length} > ${maxCatchup}); re-baselined to REARM without emitting`,
          );
          result.skipped.push(`${s.symbol} ${tf}: re-baselined after ${pending.length}-candle gap`);
        }
        continue;
      }

      let cursor = state;
      let emitted = false;

      for (const bar of toProcess) {
        if (!bar) continue;
        if (emitted) break;

        // Evaluate AS OF this candle so a replayed bar sees only the data that
        // existed at the time — never future candles.
        const endIdx = candles.findIndex((c) => c.openTime === bar.openTime);
        if (endIdx < 39) continue;
        const windowStart = Math.max(0, endIdx + 1 - (lookback + 5));
        const window = candles.slice(windowStart, endIdx + 1);

        let ev: Evaluation | null;
        try {
          ev = evaluate({
            symbol: s.symbol,
            timeframe: tf,
            candles: window,
            settings,
            atIndex: window.length - 1,
          });
        } catch (err) {
          log.error(`evaluate failed for ${s.symbol} ${tf}`, {
            error: err instanceof Error ? err.message : String(err),
          });
          break;
        }
        if (!ev) continue;
        result.evaluated++;
        if (bar.openTime > state.lastCandleTime && pending.length > 1) result.caughtUp++;

        const { next, action } = step(cursor, ev);
        cursor = next;

      if (action.kind === 'EMIT_SIGNAL') {
        emitted = true;

        // ---- one active signal per symbol (across ALL timeframes) ----
        if (busySymbols.has(s.symbol)) {
          log.info(
            `symbol ${s.symbol} already has a live signal; suppressing ${tf} edge (one active signal per symbol)`,
          );
          result.suppressedBySymbolPolicy++;
          cursor = settleEdge(next);
          continue;
        }
        if (openCount + result.signalsCreated >= maxConcurrent) {
          log.info(`max_concurrent reached, suppressing ${s.symbol} ${tf}`, { maxConcurrent });
          // Settle the edge into HOLD. Landing back in NEUTRAL would let the
          // SAME persisting condition read as a brand new rising edge on the
          // next loop — a delayed fake edge. The condition must actually fall
          // and return before it may emit again.
          cursor = settleEdge(next);
          continue;
        }

        // ATR is required for the RISK plan only.
        if (ev.atr === null || !(ev.atr > 0)) {
          log.warn(`no ATR for ${s.symbol} ${tf}, cannot size risk`, {});
          // Same reasoning as the capacity path: settle into HOLD.
          cursor = settleEdge(next);
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
          cursor = settleEdge(next);
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
            long_score: ev.longScore,
            short_score: ev.shortScore,
            confirmations: ev.confirmations,
            // Persist the FULL auditable picture: the chosen side's component
            // breakdown plus both scores and the confirmation count.
            breakdown: JSON.stringify({
              ...(action.direction === 'LONG' ? ev.long : ev.short),
              longScore: ev.longScore,
              shortScore: ev.shortScore,
              confirmations: ev.confirmations,
              chosen: { direction: action.direction, score: action.score },
            }),
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
          cursor = settleEdge(next);
          continue;
        }

        result.signalsCreated++;
        // The symbol now holds a live signal: block every other timeframe for
        // this symbol for the rest of the run, and on later runs via the
        // busySymbols query.
        busySymbols.add(s.symbol);
        // The edge has fired; persist it as the corresponding HOLD so a
        // still-passing condition cannot emit again on the next candle.
        cursor = settleEdge({ ...next, activeSignalId: Number(inserted.id) });
        log.info(
          `SIGNAL ${action.direction} ${s.symbol} ${tf} score=${action.score.toFixed(2)} (entry pending N+1)`,
          { signalId: Number(inserted.id), setupCandleTime: action.setupCandleTime },
        );
        }
      }

      // One durable write per slot per loop, after the whole catch-up walk.
      await saveState(db, cursor);
    }
  }

  // Try once more so a signal created this tick can fill if N+1 already exists.
  result.entriesFilled += await fillPendingEntries(db, settings, log);

  return result;
}

/**
 * Cancel WAITING_ENTRY signals whose entry candle never arrived.
 *
 * `risk.signal_expiry_bars` allows N+1 plus a grace window; beyond that the
 * setup is stale and the slot is released. This NEVER invents an entry — an
 * expired signal is CANCELLED, not filled.
 */
export async function expireStaleSignals(
  db: Kysely<Database>,
  settings: Settings,
  log: Logger,
): Promise<number> {
  const expiryBars = Math.floor(settings.num('risk.signal_expiry_bars'));
  if (expiryBars <= 0) return 0; // 0 = never expire

  const pending = await db
    .selectFrom('signals')
    .selectAll()
    .where('state', '=', 'WAITING_ENTRY')
    .where('source', '=', 'LIVE_ENGINE')
    .execute();

  let expired = 0;
  for (const sig of pending) {
    const tf = sig.timeframe as Timeframe;
    const span = tfMs(tf);
    const setupTime = Number(sig.setup_candle_time);

    // How far has this symbol/timeframe's CLOSED history advanced past N?
    const latest = await getCandles(db, sig.symbol, tf, { closedOnly: true, limit: 1 });
    const latestTime = latest[0]?.openTime;
    if (latestTime === undefined) continue;

    const barsSinceSetup = Math.floor((latestTime - setupTime) / span);
    // N+1 is bar 1; allow `expiryBars` bars beyond the setup before giving up.
    if (barsSinceSetup <= expiryBars) continue;

    await db
      .updateTable('signals')
      .set({ state: 'EXPIRED', expired_at: new Date(), updated_at: new Date() })
      .where('id', '=', sig.id)
      .where('state', '=', 'WAITING_ENTRY')
      .execute();
    await releaseSlot(db, sig.symbol, tf);
    expired++;
    log.info(
      `EXPIRED ${sig.direction} ${sig.symbol} ${tf}: entry candle N+1 never arrived ` +
        `(${barsSinceSetup} bars since setup > ${expiryBars})`,
      { signalId: Number(sig.id) },
    );
  }
  return expired;
}

/**
 * Symbols that currently hold a NON-TERMINAL signal, on any timeframe.
 *
 * Backs the one-active-signal-per-symbol rule. A symbol is busy while its
 * signal is WAITING_ENTRY, OPEN, TP1_HIT or TP2_HIT (LIVE_SIGNAL_STATES) and
 * becomes eligible again only once that signal reaches TP3_HIT / STOPPED /
 * EXPIRED — and then only on a fresh genuine edge.
 */
export async function symbolsWithLiveSignal(db: Kysely<Database>): Promise<Set<string>> {
  const rows = await db
    .selectFrom('signals')
    .select('symbol')
    .distinct()
    .where('state', 'in', [...LIVE_SIGNAL_STATES])
    .where('source', '=', 'LIVE_ENGINE')
    .execute();
  return new Set(rows.map((r) => r.symbol));
}

async function countOpen(db: Kysely<Database>): Promise<number> {
  const row = await db
    .selectFrom('signals')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('state', 'in', [...LIVE_SIGNAL_STATES])
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
        .set({ state: 'EXPIRED', expired_at: new Date(), updated_at: new Date() })
        .where('id', '=', sig.id)
        .execute();
      await releaseSlot(db, sig.symbol, tf);
      continue;
    }

    await db
      .updateTable('signals')
      .set({
        state: 'OPEN',
        entry_candle_time: entry.entryCandleTime,
        entry_price: entry.entryPrice,
        entry_at: new Date(),
        opened_at: new Date(),
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
      .set({ updated_at: new Date() })
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
      // The slot is observed and free again. It lands in REARM, not NEUTRAL:
      // if the condition that produced the closed trade is STILL true, the
      // next evaluation must not read it as a fresh rising edge.
      state: 'REARM',
      direction: null,
      setup_candle_time: null,
      setup_score: null,
      active_signal_id: null,
      initialised: true,
      updated_at: new Date(),
    })
    .where('symbol', '=', symbol)
    .where('timeframe', '=', timeframe)
    .execute();
}

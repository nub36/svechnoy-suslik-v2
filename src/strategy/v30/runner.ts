/**
 * V3.0 — LIVE RUNNER.
 *
 * Replaces `runEngineOnce` for `strategy.active = 'V3_0'`. It does three things
 * per configured symbol, in this order:
 *
 *   1. advance a resting corridor order on the newest CLOSED execution bars
 *      (fill / cancel / expire) — never on the setup bar itself;
 *   2. while the symbol has no live signal, evaluate the NEWEST closed bar for
 *      a trap and publish a corridor order (state WAITING_ENTRY, entry price
 *      NULL until it actually fills);
 *   3. report data readiness per symbol so the admin panel can show which
 *      symbols are actually tradeable.
 *
 * ONE POSITION PER SYMBOL. A symbol with a live signal is skipped entirely
 * until that trade closes, so the forward test cannot stack orders on one
 * symbol. No portfolio-wide cap is imposed: `risk.max_concurrent` belongs to
 * the V1 engine and was not part of the validated configuration.
 *
 * ⚠️ KNOWN DIVERGENCE FROM THE VALIDATED SIMULATOR, stated rather than hidden:
 * `research/v30_htf_trap.ts` resolves a trade by walking the bars AHEAD of the
 * fill and then continues its scan from the fill bar, so it can open a new
 * setup while an earlier simulated trade was still in flight — overlapping
 * trades on one symbol. Production holds one position at a time, so the
 * forward-test trade RATE will be at or below the validated 54.7 trades/month.
 * Per-trade expectancy is unaffected in expectation (each trade is normalised
 * to its own R), the trade count is not. Forward results must be read with
 * that in mind.
 *
 * NO ORDER PLACEMENT. This worker writes rows. The mode gate rejects LIVE and
 * there is no execution path in this repository.
 *
 * WHY THERE IS NO CURSOR: detection only ever looks at the newest closed bar,
 * so a restart cannot re-emit an old setup, and a gap in worker uptime simply
 * means those bars were not evaluated (they are never back-filled into the
 * present). Corridor advancement is reconstruction over the ACTUAL closed bars
 * since the setup, in order, so a downtime gap cannot skip a fill.
 */

import type { Kysely } from 'kysely';
import type { Database } from '../../db/types';
import type { Candle, Timeframe } from '../../core/types';
import type { Settings } from '../../core/settings';
import type { Logger } from '../../core/logger';
import { getCandles } from '../../db/repo';
import { buildAtrContext, buildVolumeContext } from '../v2/indicators';
import { confirmedLevels } from './levels';
import { detectTrap } from './trap';
import { buildPlan, corridorStep, type V30Plan } from './execution';
import { v30Params, type V30Params } from './params';

export interface V30SymbolStatus {
  symbol: string;
  executionBars: number;
  structureBars: number;
  tradeable: boolean;
  note: string;
}

export interface V30RunResult {
  strategy: 'V3_0';
  symbolsScanned: string[];
  dataReady: V30SymbolStatus[];
  evaluated: number;
  signalsCreated: number;
  entriesFilled: number;
  expired: number;
  cancelled: number;
  skippedHeld: number;
  skipped: string[];
}

/**
 * Signal states that mean "this V3.0 trade is still running".
 *
 * `TP2_HIT` is deliberately EXCLUDED: for V3.0 the opposing 4H swing is the
 * FINAL target, so hitting it closes the trade. The site-wide vocabulary treats
 * TP2_HIT as still-live (it awaits TP3 in the V1 ladder), but for V3.0 the
 * outcome row marks closure and the symbol must be free to trade again.
 */
export const V30_LIVE_STATES = ['WAITING_ENTRY', 'OPEN', 'TP1_HIT'] as const;

/** Structure of the V3.0 plan persisted inside `signals.breakdown`. */
export interface V30SignalPlan {
  strategy: 'V3_0';
  version: 1;
  plan: V30Plan;
  params: {
    bodyRatioMin: number;
    rvolMin: number;
    corridorAtr: number;
    corridorExpiryBars: number;
    slBufferAtr: number;
    tp1Equilibrium: number;
    breakevenTrigger: string;
    timeoutBars: number;
    positionSplitTp1: number;
    htfTimeframe: Timeframe;
    ltfTimeframe: Timeframe;
  };
}

export function planPayload(plan: V30Plan, p: V30Params): V30SignalPlan {
  return {
    strategy: 'V3_0',
    version: 1,
    plan,
    params: {
      bodyRatioMin: p.bodyRatioMin,
      rvolMin: p.rvolMin,
      corridorAtr: p.corridorAtr,
      corridorExpiryBars: p.corridorExpiryBars,
      slBufferAtr: p.slBufferAtr,
      tp1Equilibrium: p.tp1Equilibrium,
      breakevenTrigger: p.breakevenTrigger,
      timeoutBars: p.timeoutBars,
      positionSplitTp1: p.positionSplitTp1,
      htfTimeframe: p.htfTimeframe,
      ltfTimeframe: p.ltfTimeframe,
    },
  };
}

/** Read the persisted plan back out of a signal row, or null when absent. */
export function readPlan(breakdown: unknown): V30SignalPlan | null {
  let b: unknown = breakdown;
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b);
    } catch {
      return null;
    }
  }
  if (b === null || typeof b !== 'object') return null;
  const v30 = (b as Record<string, unknown>)['v30'];
  if (v30 === null || typeof v30 !== 'object') return null;
  const rec = v30 as Record<string, unknown>;
  if (rec['strategy'] !== 'V3_0') return null;
  const plan = rec['plan'] as V30Plan | undefined;
  if (!plan || typeof plan !== 'object') return null;
  return v30 as V30SignalPlan;
}

/**
 * Replay the corridor over the closed bars that FOLLOWED the setup bar, in
 * order, stopping at the first terminal decision. Deterministic: the same bars
 * always produce the same decision, so a worker restart cannot change it.
 */
export function advanceCorridor(
  plan: Pick<V30Plan, 'direction' | 'zoneLow' | 'zoneHigh' | 'stop'>,
  setupIndex: number,
  bars: readonly Candle[],
  p: V30Params,
):
  | { kind: 'WAITING' }
  | { kind: 'FILL'; fillPrice: number; candle: Candle; index: number }
  | { kind: 'CANCEL'; reason: 'STOP_BEFORE_FILL' | 'AMBIGUOUS_BAR' }
  | { kind: 'EXPIRE' } {
  for (let i = setupIndex + 1; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar) continue;
    const decision = corridorStep(plan, bar, i - setupIndex, p);
    if (decision.kind === 'FILL') return { ...decision, candle: bar, index: i };
    if (decision.kind === 'CANCEL') return { kind: 'CANCEL', reason: decision.reason };
    if (decision.kind === 'EXPIRE') return { kind: 'EXPIRE' };
  }
  return { kind: 'WAITING' };
}

/** Minimum history before a symbol is considered tradeable. */
const MIN_EXECUTION_BARS = 120;
const MIN_STRUCTURE_BARS = 30;

export async function runV30Once(
  db: Kysely<Database>,
  settings: Settings,
  log: Logger,
): Promise<V30RunResult> {
  const p = v30Params(settings);
  const result: V30RunResult = {
    strategy: 'V3_0',
    symbolsScanned: [],
    dataReady: [],
    evaluated: 0,
    signalsCreated: 0,
    entriesFilled: 0,
    expired: 0,
    cancelled: 0,
    skippedHeld: 0,
    skipped: [],
  };

  if (!settings.bool('engine.enabled')) {
    result.skipped.push('engine disabled by settings');
    return result;
  }

  const mode = settings.tradingMode(); // never LIVE
  const strength = Math.floor(settings.num('engine.swing_lookback'));
  const atrPeriod = Math.floor(settings.num('risk.atr_period'));
  const volPeriod = Math.floor(settings.num('v2.volume_period'));
  // A warm-up window large enough for every indicator V3.0 reads.
  const lookback = Math.max(
    Math.floor(settings.num('engine.lookback_candles')),
    MIN_EXECUTION_BARS + p.corridorExpiryBars + p.timeoutBars,
  );

  for (const symbol of p.symbols) {
    result.symbolsScanned.push(symbol);

    const ltf = p.ltfTimeframe;
    const htf = p.htfTimeframe;
    const execBars = await getCandles(db, symbol, ltf, {
      closedOnly: true,
      limit: lookback + 5,
    });
    const structBars = await getCandles(db, symbol, htf, {
      closedOnly: true,
      limit: 400,
    });

    const ready = execBars.length >= MIN_EXECUTION_BARS && structBars.length >= MIN_STRUCTURE_BARS;
    result.dataReady.push({
      symbol,
      executionBars: execBars.length,
      structureBars: structBars.length,
      tradeable: ready,
      note: ready
        ? 'ready'
        : `needs >= ${MIN_EXECUTION_BARS} closed ${ltf} bars and >= ${MIN_STRUCTURE_BARS} closed ${htf} bars`,
    });
    if (!ready) continue;

    // ---- the symbol's live signal (one at a time, as validated) ----
    const live = await db
      .selectFrom('signals')
      .selectAll()
      .where('symbol', '=', symbol)
      .where('source', '=', 'LIVE_ENGINE')
      .where('state', 'in', [...V30_LIVE_STATES])
      .orderBy('id', 'desc')
      .executeTakeFirst();

    if (live) {
      const persisted = readPlan(live.breakdown);
      if (!persisted) {
        // A V1 signal, or a row written before this port. Leave it alone; the
        // V1 machinery owns it.
        result.skippedHeld++;
        continue;
      }
      if (live.state !== 'WAITING_ENTRY') {
        result.skippedHeld++; // in position — no new setup on this symbol
        continue;
      }

      // ---- 1. advance the resting corridor ----
      const setupIdx = execBars.findIndex((c) => c.openTime === Number(live.setup_candle_time));
      if (setupIdx < 0) {
        result.skipped.push(
          `${symbol} ${ltf}: setup bar ${String(live.setup_candle_time)} left the candle window`,
        );
        continue;
      }
      result.evaluated++;
      const decision = advanceCorridor(persisted.plan, setupIdx, execBars, p);

      if (decision.kind === 'FILL') {
        const risk = Math.abs(decision.fillPrice - persisted.plan.stop);
        const long = persisted.plan.direction === 'LONG';
        const geometryOk =
          risk > 0 &&
          (long ? persisted.plan.stop < decision.fillPrice : persisted.plan.stop > decision.fillPrice) &&
          (long
            ? persisted.plan.tp1 > decision.fillPrice && persisted.plan.tp2 > persisted.plan.tp1
            : persisted.plan.tp1 < decision.fillPrice && persisted.plan.tp2 < persisted.plan.tp1);
        if (!geometryOk) {
          // The frozen harness reports this as REJECTED_GEOMETRY and drops the
          // setup; a fill that cannot be traded must not be recorded as one.
          await db
            .updateTable('signals')
            .set({ state: 'EXPIRED', expired_at: new Date(), updated_at: new Date() })
            .where('id', '=', live.id)
            .execute();
          result.cancelled++;
          log.info(`V3.0 geometry rejected ${symbol} ${ltf} ${persisted.plan.direction}`, {
            signalId: Number(live.id),
          });
          continue;
        }

        const qty = sizePosition(settings, decision.fillPrice, risk);
        await db
          .updateTable('signals')
          .set({
            state: 'OPEN',
            entry_candle_time: decision.candle.openTime,
            entry_price: decision.fillPrice,
            entry_at: new Date(),
            stop_loss: persisted.plan.stop,
            take_profits: JSON.stringify([persisted.plan.tp1, persisted.plan.tp2]),
            qty: qty.qty,
            position_quote: qty.quote,
            setup_close: Number(live.setup_close),
            opened_at: new Date(),
            updated_at: new Date(),
          })
          .where('id', '=', live.id)
          .execute();
        result.entriesFilled++;
        log.info(`V3.0 FILLED ${symbol} ${ltf} ${persisted.plan.direction}`, {
          signalId: Number(live.id),
          entry: decision.fillPrice,
          stop: persisted.plan.stop,
        });
        continue;
      }

      if (decision.kind === 'CANCEL') {
        await db
          .updateTable('signals')
          .set({ state: 'EXPIRED', expired_at: new Date(), updated_at: new Date() })
          .where('id', '=', live.id)
          .execute();
        result.cancelled++;
        log.info(`V3.0 corridor cancelled (${decision.reason}) ${symbol} ${ltf}`, {
          signalId: Number(live.id),
        });
        continue;
      }

      if (decision.kind === 'EXPIRE') {
        await db
          .updateTable('signals')
          .set({ state: 'EXPIRED', expired_at: new Date(), updated_at: new Date() })
          .where('id', '=', live.id)
          .execute();
        result.expired++;
        log.info(`V3.0 corridor expired unfilled ${symbol} ${ltf}`, {
          signalId: Number(live.id),
        });
        continue;
      }

      continue; // still waiting
    }

    // ---- 2. look for a trap on the newest closed bar ----
    const bar = execBars[execBars.length - 1];
    const idx = execBars.length - 1;
    if (!bar) continue;
    result.evaluated++;

    const levels = confirmedLevels(structBars, bar.closeTime, strength, htf);
    if (levels.swingHigh === null || levels.swingLow === null) continue;

    const vol = buildVolumeContext(execBars, idx, volPeriod);
    const signal = detectTrap(bar, levels, vol.rvol, p);
    if (!signal) continue;

    const atr = buildAtrContext(execBars, idx, atrPeriod).atr;
    if (atr === null) continue;

    const plan = buildPlan(signal, levels, atr, bar.close, p);
    if (!plan) continue;

    const inserted = await db
      .insertInto('signals')
      .values({
        symbol,
        timeframe: ltf,
        direction: plan.direction,
        state: 'WAITING_ENTRY',
        mode,
        source: 'LIVE_ENGINE',
        replay_run_id: null,
        // V3.0 has no scoring model; the honest value is 0 with the evidence
        // carried in `breakdown.v30`, never a fabricated score.
        score: 0,
        threshold: 0,
        long_score: 0,
        short_score: 0,
        confirmations: 2,
        breakdown: JSON.stringify({ v30: planPayload(plan, p) }),
        events: JSON.stringify([]),
        setup_candle_time: bar.openTime,
        setup_close: bar.close,
        entry_candle_time: null,
        entry_price: null,
        entry_at: null,
        stop_loss: plan.stop,
        take_profits: JSON.stringify([plan.tp1, plan.tp2]),
        atr: plan.atr,
        rr_tp1: riskReward(plan),
        qty: null,
        position_quote: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .returning('id')
      .executeTakeFirst();

    result.signalsCreated++;
    log.info(`V3.0 TRAP ${symbol} ${ltf} ${plan.direction}`, {
      signalId: inserted ? Number(inserted.id) : null,
      level: plan.level,
      zoneLow: plan.zoneLow,
      zoneHigh: plan.zoneHigh,
    });
  }

  return result;
}

/** Reward:risk of TP1 versus the initial stop — informational only. */
export function riskReward(plan: V30Plan): number {
  const risk = Math.abs(plan.zoneHigh - plan.stop);
  const reward = Math.abs(plan.tp1 - plan.zoneHigh);
  return risk > 0 ? reward / risk : 0;
}

/**
 * Position sizing, informational for the paper forward test.
 *
 * Uses the same arithmetic as the V1 path (`risk.account_quote` ×
 * `risk.risk_pct` per trade) applied to V3.0's OWN risk distance, so the risk
 * per trade is comparable across strategies. No leverage is assumed and no
 * order is created from it.
 */
export function sizePosition(
  settings: Settings,
  entry: number,
  riskPerUnit: number,
): { qty: number; quote: number } {
  const account = settings.num('risk.account_quote');
  const riskPct = settings.num('risk.risk_pct');
  const riskQuote = (account * riskPct) / 100;
  if (!(riskPerUnit > 0) || !(entry > 0) || !(riskQuote > 0)) return { qty: 0, quote: 0 };
  const qty = riskQuote / riskPerUnit;
  return { qty, quote: qty * entry };
}

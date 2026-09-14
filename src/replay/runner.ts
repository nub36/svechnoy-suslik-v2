/**
 * Historical replay — uses THE SAME Smart Money engine, state machine, risk and
 * outcome tracker as the live path. There is no separate backtest strategy.
 *
 * Walk-forward: for each closed candle index i we call evaluate({atIndex: i}),
 * which slices the series to [0..i]. Candle i+1 can therefore never influence
 * the decision at i. The entry is the OPEN of candle i+1, exactly as live.
 */

import type { Kysely } from 'kysely';
import type { Database } from '../db/types';
import type { Candle, Timeframe } from '../core/types';
import { tfMs } from '../core/types';
import type { Settings } from '../core/settings';
import { evaluate } from '../strategy/smart-money';
import { initialState, resolveEntry, step, type MachineState } from '../strategy/state-machine';
import { buildRiskPlan } from '../strategy/risk';
import { aggregate, trackOutcome } from '../outcome/tracker';
import { getCandles } from '../db/repo';

export interface ReplayTrade {
  symbol: string;
  timeframe: Timeframe;
  direction: 'LONG' | 'SHORT';
  score: number;
  setupCandleTime: number;
  entryCandleTime: number;
  entryPrice: number;
  stopLoss: number;
  takeProfits: number[];
  result: 'TP' | 'SL' | 'TIMEOUT' | 'OPEN';
  exitPrice: number | null;
  exitCandleTime: number | null;
  barsHeld: number;
  rMultiple: number;
  pnlPct: number;
  breakdown: unknown;
}

export interface ReplayResult {
  symbol: string;
  timeframe: Timeframe;
  candlesSeen: number;
  evaluations: number;
  trades: ReplayTrade[];
  stats: ReturnType<typeof aggregate>;
}

export interface ReplayArgs {
  symbol: string;
  timeframe: Timeframe;
  candles: readonly Candle[];
  settings: Settings;
  from?: number;
  to?: number;
}

/**
 * Core replay over an in-memory candle series. Pure function — no DB needed,
 * which is what makes it trivially testable and identical to live logic.
 */
export function replaySeries(args: ReplayArgs): ReplayResult {
  const { symbol, timeframe, settings } = args;
  const closed = args.candles.filter((c) => c.isClosed).sort((a, b) => a.openTime - b.openTime);

  const trades: ReplayTrade[] = [];
  let machine: MachineState = initialState(symbol, timeframe);
  let evaluations = 0;

  const lookback = Math.floor(settings.num('engine.lookback_candles'));
  const minRr = settings.num('risk.min_rr');
  const swing = Math.floor(settings.num('engine.swing_lookback'));
  const minBars = Math.max(30, swing * 6 + 5);

  // Pending setup awaiting its N+1 entry.
  let pending: { direction: 'LONG' | 'SHORT'; score: number; setupCandleTime: number; atr: number; breakdown: unknown } | null =
    null;
  // Open position being tracked bar by bar.
  let open:
    | (ReplayTrade & { riskPerUnit: number; entryIndex: number })
    | null = null;

  for (let i = minBars; i < closed.length; i++) {
    const candle = closed[i];
    if (!candle) continue;
    if (args.from !== undefined && candle.openTime < args.from) continue;
    if (args.to !== undefined && candle.openTime > args.to) break;

    /* ---------- 1. fill a pending entry at the OPEN of this candle ------- */
    if (pending && open === null) {
      const entry = resolveEntry(pending.setupCandleTime, tfMs(timeframe), candle);
      if (entry) {
        const plan = buildRiskPlan({
          direction: pending.direction,
          entry: entry.entryPrice,
          atr: pending.atr,
          settings,
        });
        if (plan && plan.rrTp1 >= minRr) {
          open = {
            symbol,
            timeframe,
            direction: pending.direction,
            score: pending.score,
            setupCandleTime: pending.setupCandleTime,
            entryCandleTime: entry.entryCandleTime,
            entryPrice: entry.entryPrice,
            stopLoss: plan.stopLoss,
            takeProfits: plan.takeProfits,
            result: 'OPEN',
            exitPrice: null,
            exitCandleTime: null,
            barsHeld: 0,
            rMultiple: 0,
            pnlPct: 0,
            breakdown: pending.breakdown,
            riskPerUnit: plan.riskPerUnit,
            entryIndex: i,
          };
          machine = { ...machine, state: 'ACTIVE' };
        } else {
          machine = { ...machine, state: 'IDLE', direction: null, setupCandleTime: null };
        }
      } else {
        machine = { ...machine, state: 'IDLE', direction: null, setupCandleTime: null };
      }
      pending = null;
    }

    /* ---------- 2. resolve an open position on closed bars -------------- */
    if (open) {
      const slice = closed.slice(open.entryIndex, i + 1);
      const out = trackOutcome({
        direction: open.direction,
        entryPrice: open.entryPrice,
        stopLoss: open.stopLoss,
        takeProfits: open.takeProfits,
        entryCandleTime: open.entryCandleTime,
        candles: slice,
        settings,
        qty: 0,
      });
      if (out) {
        trades.push({
          ...open,
          result: out.result,
          exitPrice: out.exitPrice,
          exitCandleTime: out.exitCandleTime,
          barsHeld: out.barsHeld,
          rMultiple: out.rMultiple,
          pnlPct: out.pnlPct,
        });
        open = null;
        machine = { ...machine, state: 'IDLE', direction: null, setupCandleTime: null, activeSignalId: null };
      }
    }

    /* ---------- 3. evaluate this CLOSED candle (same engine) ------------ */
    if (open !== null || pending !== null) continue;

    const windowStart = Math.max(0, i + 1 - (lookback + 5));
    const window = closed.slice(windowStart, i + 1);
    const ev = evaluate({
      symbol,
      timeframe,
      candles: window,
      settings,
      atIndex: window.length - 1,
    });
    if (!ev) continue;
    evaluations++;

    const res = step(machine, ev);
    machine = res.next;
    if (res.action.kind === 'EMIT_SIGNAL') {
      if (ev.atr !== null && ev.atr > 0) {
        pending = {
          direction: res.action.direction,
          score: res.action.score,
          setupCandleTime: res.action.setupCandleTime,
          atr: ev.atr,
          breakdown: {
            ...(res.action.direction === 'LONG' ? ev.long : ev.short),
            longScore: ev.longScore,
            shortScore: ev.shortScore,
            confirmations: ev.confirmations,
            chosen: { direction: res.action.direction, score: res.action.score },
          },
        };
      } else {
        machine = { ...machine, state: 'IDLE', direction: null, setupCandleTime: null };
      }
    }
  }

  // Any still-open position is reported but excluded from the win stats.
  if (open) {
    trades.push({ ...open });
  }

  const finished = trades.filter((t) => t.result !== 'OPEN');
  return {
    symbol,
    timeframe,
    candlesSeen: closed.length,
    evaluations,
    trades,
    stats: aggregate(finished.map((t) => ({ result: t.result, r_multiple: t.rMultiple }))),
  };
}

/** Replay straight from the DB candle store. */
export async function replayFromDb(
  db: Kysely<Database>,
  symbol: string,
  timeframe: Timeframe,
  settings: Settings,
  from?: number,
  to?: number,
): Promise<ReplayResult> {
  const candles = await getCandles(db, symbol, timeframe, {
    closedOnly: true,
    limit: 20000,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  });
  return replaySeries({ symbol, timeframe, candles, settings, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) });
}

/** Persist a replay run + its aggregate metrics. */
export async function saveReplayRun(
  db: Kysely<Database>,
  label: string,
  results: readonly ReplayResult[],
  settings: Settings,
  fromTime: number,
  toTime: number,
): Promise<number> {
  const allFinished = results.flatMap((r) => r.trades.filter((t) => t.result !== 'OPEN'));
  const stats = aggregate(allFinished.map((t) => ({ result: t.result, r_multiple: t.rMultiple })));

  const row = await db
    .insertInto('replay_runs')
    .values({
      label,
      symbols: JSON.stringify([...new Set(results.map((r) => r.symbol))]),
      timeframes: JSON.stringify([...new Set(results.map((r) => r.timeframe))]),
      from_time: fromTime,
      to_time: toTime,
      settings_used: JSON.stringify(settings.toObject()),
      status: 'DONE',
      candles_seen: results.reduce((s, r) => s + r.candlesSeen, 0),
      signals_count: allFinished.length,
      wins: stats.wins,
      losses: stats.losses,
      timeouts: stats.timeouts,
      win_rate: stats.winRate,
      avg_r: stats.avgR,
      total_r: stats.totalR,
      profit_factor: Number.isFinite(stats.profitFactor) ? stats.profitFactor : 0,
      max_drawdown_r: stats.maxDrawdownR,
      metrics: JSON.stringify({
        perSeries: results.map((r) => ({
          symbol: r.symbol,
          timeframe: r.timeframe,
          candlesSeen: r.candlesSeen,
          evaluations: r.evaluations,
          trades: r.trades.length,
          stats: r.stats,
        })),
      }),
      created_at: new Date(),
      finished_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return Number(row.id);
}

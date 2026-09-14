import { getDb } from '@/db';
import { ok, fail, parseIntParam, errorMessage } from '@/web/api-utils';

export const dynamic = 'force-dynamic';

/** Signal list with joined outcomes, filterable by state/symbol/timeframe. */
export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limit = parseIntParam(url.searchParams.get('limit'), 100, 1, 500);
    const state = url.searchParams.get('state');
    const symbol = url.searchParams.get('symbol');
    const timeframe = url.searchParams.get('timeframe');
    const source = url.searchParams.get('source') ?? 'LIVE_ENGINE';

    const db = getDb();
    let q = db
      .selectFrom('signals')
      .leftJoin('outcomes', 'outcomes.signal_id', 'signals.id')
      .select([
        'signals.id as id',
        'signals.symbol as symbol',
        'signals.timeframe as timeframe',
        'signals.direction as direction',
        'signals.state as state',
        'signals.mode as mode',
        'signals.source as source',
        'signals.score as score',
        'signals.threshold as threshold',
        'signals.breakdown as breakdown',
        'signals.setup_candle_time as setup_candle_time',
        'signals.setup_close as setup_close',
        'signals.entry_candle_time as entry_candle_time',
        'signals.entry_price as entry_price',
        'signals.stop_loss as stop_loss',
        'signals.take_profits as take_profits',
        'signals.atr as atr',
        'signals.rr_tp1 as rr_tp1',
        'signals.qty as qty',
        'signals.created_at as created_at',
        'signals.tp_level as tp_level',
        'signals.opened_at as opened_at',
        'signals.tp1_hit_at as tp1_hit_at',
        'signals.tp2_hit_at as tp2_hit_at',
        'signals.tp3_hit_at as tp3_hit_at',
        'signals.stopped_at as stopped_at',
        'signals.expired_at as expired_at',
        'outcomes.result as outcome_result',
        'outcomes.exit_price as outcome_exit_price',
        'outcomes.exit_candle_time as outcome_exit_time',
        'outcomes.bars_held as outcome_bars_held',
        'outcomes.pnl_pct as outcome_pnl_pct',
        'outcomes.r_multiple as outcome_r',
        'outcomes.max_favorable_pct as outcome_mfe',
        'outcomes.max_adverse_pct as outcome_mae',
      ])
      .where('signals.source', '=', source)
      .orderBy('signals.setup_candle_time', 'desc')
      .limit(limit);

    if (state) q = q.where('signals.state', '=', state);
    if (symbol) q = q.where('signals.symbol', '=', symbol.toUpperCase());
    if (timeframe) q = q.where('signals.timeframe', '=', timeframe);

    const rows = await q.execute();

    const inState = (...states: string[]): number =>
      rows.filter((r) => states.includes(r.state)).length;

    const summary = {
      total: rows.length,
      waiting: inState('WAITING_ENTRY'),
      // "active" = filled and still running, including trades that have
      // already banked TP1/TP2 but are not finished.
      active: inState('OPEN', 'TP1_HIT', 'TP2_HIT'),
      // "tp" counts trades that reached at least one take-profit, which is why
      // a stopped trade that first hit TP1 is still counted here.
      tp: rows.filter((r) => r.tp_level !== null && Number(r.tp_level) > 0).length,
      sl: inState('STOPPED'),
      timeout: inState('EXPIRED'),
    };

    return ok({
      summary,
      signals: rows.map((r) => ({
        id: Number(r.id),
        symbol: r.symbol,
        timeframe: r.timeframe,
        direction: r.direction,
        state: r.state,
        mode: r.mode,
        source: r.source,
        score: r.score,
        threshold: r.threshold,
        breakdown: r.breakdown,
        setupCandleTime: Number(r.setup_candle_time),
        setupClose: r.setup_close,
        entryCandleTime: r.entry_candle_time === null ? null : Number(r.entry_candle_time),
        entryPrice: r.entry_price,
        stopLoss: r.stop_loss,
        takeProfits: r.take_profits,
        atr: r.atr,
        rrTp1: r.rr_tp1,
        qty: r.qty,
        createdAt: r.created_at,
        // Persistent milestone audit trail. These survive a later STOP: a
        // trade stopped after TP1 still reports tp1HitAt.
        tpLevel: Number(r.tp_level ?? 0),
        milestones: {
          openedAt: r.opened_at,
          tp1HitAt: r.tp1_hit_at,
          tp2HitAt: r.tp2_hit_at,
          tp3HitAt: r.tp3_hit_at,
          stoppedAt: r.stopped_at,
          expiredAt: r.expired_at,
        },
        outcome:
          r.outcome_result === null
            ? null
            : {
                result: r.outcome_result,
                exitPrice: r.outcome_exit_price,
                exitCandleTime: r.outcome_exit_time === null ? null : Number(r.outcome_exit_time),
                barsHeld: r.outcome_bars_held,
                pnlPct: r.outcome_pnl_pct,
                rMultiple: r.outcome_r,
                maxFavorablePct: r.outcome_mfe,
                maxAdversePct: r.outcome_mae,
              },
      })),
    });
  } catch (err) {
    return fail(errorMessage(err), 500);
  }
}

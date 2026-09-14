import { getDb } from '@/db';
import { getCandles } from '@/db/repo';
import { loadSettings } from '@/core/settings';
import { buildChartPayload, buildSignalLevels, type SignalOverlay } from '@/web/overlays';
import { ok, fail, parseTimeframe, parseIntParam, errorMessage } from '@/web/api-utils';
import { LIVE_SIGNAL_STATES, TERMINAL_STATES } from '@/core/types';

export const dynamic = 'force-dynamic';

/**
 * Candles + Smart Money overlays for one symbol/timeframe.
 * ALL overlay geometry is computed here (backend), never in the browser.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const symbol = (url.searchParams.get('symbol') ?? '').toUpperCase();
    // Base asset is 2-16 chars, quote is always USDT (Binance Spot USDT only).
    if (!/^[A-Z0-9]{2,16}USDT$/.test(symbol)) {
      return fail('Invalid or missing symbol (Binance Spot USDT only)', 400);
    }
    const timeframe = parseTimeframe(url.searchParams.get('timeframe'));
    const limit = parseIntParam(url.searchParams.get('limit'), 300, 50, 1000);

    const db = getDb();
    const settings = await loadSettings(db);
    const candles = await getCandles(db, symbol, timeframe, { limit });

    if (candles.length === 0) {
      return ok({
        symbol,
        timeframe,
        candles: [],
        overlays: { boxes: [], lines: [], markers: [], legend: [] },
        evaluation: null,
        signal: null,
        closedCount: 0,
        empty: true,
      });
    }

    // Attach the current live signal for THIS symbol AND THIS timeframe so the
    // chart can draw ENTRY / SL / TP1-3.
    //
    // Scope: both `symbol` and `timeframe` are filtered, so a BTC 1m signal can
    // never appear on a BTC 15m chart and a BTC signal can never appear on an
    // ETH chart.
    //
    // State: only NON-TERMINAL signals describe a position that is actually
    // live. A STOPPED/EXPIRED/TP3_HIT trade is history and must not keep
    // painting an active ENTRY/SL/TP set forever. If there is no live signal we
    // fall back to the most recent terminal one, flagged `historical` so the
    // client can render it distinctly (and without active price lines).
    //
    // An entry is NEVER fabricated: while WAITING_ENTRY, entryPrice stays null.
    const sigCols = [
      'id', 'direction', 'state', 'score', 'setup_candle_time',
      'entry_candle_time', 'entry_price', 'stop_loss', 'take_profits',
    ] as const;

    const baseSigQuery = db
      .selectFrom('signals')
      .select([...sigCols])
      .where('symbol', '=', symbol)
      .where('timeframe', '=', timeframe)
      .where('source', '=', 'LIVE_ENGINE');

    let sigRow = await baseSigQuery
      .where('state', 'in', [...LIVE_SIGNAL_STATES])
      .orderBy('setup_candle_time', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();

    let historical = false;
    if (!sigRow) {
      sigRow = await baseSigQuery
        .where('state', 'in', [...TERMINAL_STATES])
        .orderBy('setup_candle_time', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      historical = sigRow !== undefined;
    }

    let signal: SignalOverlay | null = null;
    if (sigRow) {
      const waiting = sigRow.state === 'WAITING_ENTRY';
      signal = {
        id: Number(sigRow.id),
        direction: sigRow.direction as 'LONG' | 'SHORT',
        state: sigRow.state,
        score: Number(sigRow.score),
        setupCandleTime: Number(sigRow.setup_candle_time),
        entryCandleTime:
          sigRow.entry_candle_time === null ? null : Number(sigRow.entry_candle_time),
        entryPrice: sigRow.entry_price === null ? null : Number(sigRow.entry_price),
        // No active price levels for a finished trade or one still waiting for
        // its N+1 entry.
        levels: waiting || historical ? [] : buildSignalLevels(sigRow),
        waitingForEntry: waiting,
        historical,
      };
    }

    return ok(buildChartPayload(symbol, timeframe, candles, settings, signal));
  } catch (err) {
    return fail(errorMessage(err), 500);
  }
}

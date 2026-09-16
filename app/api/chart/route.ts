import { getDb } from '@/db';
import { getCandles } from '@/db/repo';
import { loadSettings } from '@/core/settings';
import {
  buildChartPayload,
  buildSignalLevels,
  readV30Overlay,
  signalLabel,
  type SignalOverlay,
} from '@/web/overlays';
import { v2Enabled } from '@/strategy/v2';
import { HTF_MAP } from '@/strategy/v2/htf';
import type { Candle, Timeframe } from '@/core/types';
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

    // Display precision follows Binance PRICE_FILTER tickSize so the chart
    // axis, crosshair and level labels match the tables exactly.
    const meta = await db
      .selectFrom('symbols')
      .select(['tick_size'])
      .where('symbol', '=', symbol)
      .executeTakeFirst();
    const tickSize = meta ? Number(meta.tick_size) : null;

    if (candles.length === 0) {
      return ok({
        symbol,
        timeframe,
        tickSize,
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
      'breakdown',
    ] as const;

    // A signal that already has an outcome row is CLOSED history, whatever its
    // state string says. This matters for V3.0: its final target maps onto
    // TP2_HIT, which the site-wide vocabulary keeps "live" because the V1
    // ladder awaits TP3.
    const baseSigQuery = db
      .selectFrom('signals')
      .leftJoin('outcomes', 'outcomes.signal_id', 'signals.id')
      .select([...sigCols])
      .select('outcomes.id as closed_outcome_id')
      // Unqualified names: `outcomes` has no symbol/timeframe column, so these
      // are unambiguous under the join (and they are the same two the engine's
      // chart-scoping test looks for).
      .where('symbol', '=', symbol)
      .where('timeframe', '=', timeframe)
      .where('signals.source', '=', 'LIVE_ENGINE');

    let sigRow = await baseSigQuery
      .where('signals.state', 'in', [...LIVE_SIGNAL_STATES])
      .where('outcomes.id', 'is', null)
      .orderBy('setup_candle_time', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();

    let historical = false;
    if (!sigRow) {
      sigRow = await baseSigQuery
        .where((eb) =>
          eb.or([
            eb('state', 'in', [...TERMINAL_STATES]),
            // V3.0 closes at TP2_HIT — terminal for this strategy.
            eb('outcomes.id', 'is not', null),
          ]),
        )
        .orderBy('setup_candle_time', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      historical = sigRow !== undefined;
    }

    let signal: SignalOverlay | null = null;
    if (sigRow) {
      const waiting = sigRow.state === 'WAITING_ENTRY';
      const v30 = readV30Overlay(sigRow.breakdown);
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
        label: signalLabel(sigRow),
        // V3.0 geometry comes from the persisted plan. A finished V3.0 trade
        // keeps it, so the chart can show what the levels were.
        ...(v30 ? { v30 } : {}),
      };
    }

    // V2 DIAGNOSTIC HTF CONTEXT.
    //
    // Market ingestion covers all supported timeframes, so the higher-timeframe
    // candles this needs are already in the database. We load them ONLY when the
    // research engine is enabled — with `v2.enabled = false` (the default) this
    // block does no work at all and the payload is byte-identical to before.
    //
    // No look-ahead is introduced here: we hand over raw closed candles and the
    // engine's `closedHtfCandles()` filter decides which of them had actually
    // closed by the evaluated bar. Missing data stays missing, and the panel
    // shows UNKNOWN rather than a fabricated bias.
    let htfCandles: Partial<Record<Timeframe, readonly Candle[]>> | undefined;
    if (v2Enabled(settings)) {
      const wanted = HTF_MAP[timeframe] ?? [];
      if (wanted.length > 0) {
        const loaded = await Promise.all(
          wanted.map(async (htf) => [
            htf,
            await getCandles(db, symbol, htf, { limit, closedOnly: true }),
          ] as const),
        );
        htfCandles = {};
        for (const [htf, rows] of loaded) {
          if (rows.length > 0) htfCandles[htf] = rows;
        }
      }
    }

    return ok(buildChartPayload(
      symbol, timeframe, candles, settings, signal, tickSize, htfCandles,
    ));
  } catch (err) {
    return fail(errorMessage(err), 500);
  }
}

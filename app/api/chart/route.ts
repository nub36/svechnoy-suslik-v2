import { getDb } from '@/db';
import { getCandles } from '@/db/repo';
import { loadSettings } from '@/core/settings';
import { buildChartPayload } from '@/web/overlays';
import { ok, fail, parseTimeframe, parseIntParam, errorMessage } from '@/web/api-utils';

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
        overlays: { boxes: [], lines: [], markers: [] },
        evaluation: null,
        closedCount: 0,
        empty: true,
      });
    }

    return ok(buildChartPayload(symbol, timeframe, candles, settings));
  } catch (err) {
    return fail(errorMessage(err), 500);
  }
}

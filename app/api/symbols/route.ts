import { getDb } from '@/db';
import { getActiveSymbols } from '@/db/repo';
import { ok, fail, errorMessage } from '@/web/api-utils';

export const dynamic = 'force-dynamic';

/** TOP-N Binance Spot USDT symbols, ranked by 24h quote volume. */
export async function GET(): Promise<Response> {
  try {
    const db = getDb();
    const symbols = await getActiveSymbols(db);
    return ok({
      count: symbols.length,
      quoteAsset: 'USDT',
      exchange: 'BINANCE_SPOT',
      symbols,
    });
  } catch (err) {
    return fail(errorMessage(err), 500);
  }
}

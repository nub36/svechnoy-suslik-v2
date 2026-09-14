/**
 * TOP-N Binance Spot USDT symbol selection.
 *
 * Selection rule: TRADING spot symbols quoted in USDT, excluding the configured
 * stablecoin/blacklist set, ranked by 24h QUOTE volume descending, take N.
 *
 * No multi-exchange logic, no quorum, no voting — single venue (Binance Spot).
 */

import type { Settings } from '../core/settings';
import type { ExchangeSymbolInfo, Ticker24h } from './binance';

export interface RankedSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  rank: number;
  quoteVolume24h: number;
  lastPrice: number;
  priceChangePct: number;
  tickSize: number;
  stepSize: number;
  minNotional: number;
}

/** Leveraged-token and obvious non-spot suffixes we never want to trade. */
const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/;

export function selectTopSymbols(
  tickers: readonly Ticker24h[],
  info: readonly ExchangeSymbolInfo[],
  settings: Settings,
): RankedSymbol[] {
  const quote = settings.str('market.quote_asset') || 'USDT';
  const topN = Math.max(1, Math.floor(settings.num('market.top_n')));
  const excluded = new Set(settings.arr<string>('market.exclude_symbols'));

  const infoBySymbol = new Map(info.map((i) => [i.symbol, i]));

  const candidates = tickers
    .filter((t) => {
      if (!t.symbol.endsWith(quote)) return false;
      if (excluded.has(t.symbol)) return false;
      if (LEVERAGED.test(t.symbol)) return false;
      const i = infoBySymbol.get(t.symbol);
      if (!i) return false;
      if (i.quoteAsset !== quote) return false;
      if (i.status !== 'TRADING') return false;
      if (!i.isSpotTradingAllowed) return false;
      if (!Number.isFinite(t.quoteVolume) || t.quoteVolume <= 0) return false;
      return true;
    })
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, topN);

  return candidates.map((t, idx) => {
    const i = infoBySymbol.get(t.symbol);
    return {
      symbol: t.symbol,
      baseAsset: i?.baseAsset ?? t.symbol.replace(new RegExp(`${quote}$`), ''),
      quoteAsset: quote,
      rank: idx + 1,
      quoteVolume24h: t.quoteVolume,
      lastPrice: t.lastPrice,
      priceChangePct: t.priceChangePercent,
      tickSize: i?.tickSize ?? 0.00000001,
      stepSize: i?.stepSize ?? 0.00000001,
      minNotional: i?.minNotional ?? 5,
    };
  });
}

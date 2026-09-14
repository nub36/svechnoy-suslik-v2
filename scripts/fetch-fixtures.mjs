/**
 * Record REAL Binance Spot fixtures. Run this on a machine WITH egress to
 * api.binance.com; it overwrites the generated fixtures with genuine data.
 *
 *   node scripts/fetch-fixtures.mjs [outDir]
 *
 * It is deliberately polite (sequential + delay) and will EXIT on the first
 * network failure rather than retry-storm a blocked host.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] || join(process.cwd(), 'fixtures');
const BASE = process.env.BINANCE_BASE_URL || 'https://api.binance.com';
const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
const TOP_N = Number(process.env.TOP_N || 10);
const LIMIT = Number(process.env.KLINE_LIMIT || 600);
const EXCLUDE = new Set(['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'BUSDUSDT', 'EURUSDT', 'DAIUSDT']);
const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/;

mkdirSync(OUT, { recursive: true });

async function get(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  console.log(`[fixtures] using ${BASE}`);

  const rawInfo = await get('/api/v3/exchangeInfo');
  const info = rawInfo.symbols
    .filter((s) => s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.isSpotTradingAllowed)
    .map((s) => {
      const pf = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
      const ls = s.filters.find((f) => f.filterType === 'LOT_SIZE');
      const no = s.filters.find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
      return {
        symbol: s.symbol,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        status: s.status,
        isSpotTradingAllowed: s.isSpotTradingAllowed,
        tickSize: Number(pf?.tickSize ?? 1e-8),
        stepSize: Number(ls?.stepSize ?? 1e-8),
        minNotional: Number(no?.minNotional ?? 5),
      };
    });
  writeFileSync(join(OUT, 'exchangeInfo.json'), JSON.stringify(info, null, 1));
  console.log(`[fixtures] exchangeInfo: ${info.length} USDT spot symbols`);

  const rawTickers = await get('/api/v3/ticker/24hr');
  const tickers = rawTickers.map((t) => ({
    symbol: t.symbol,
    lastPrice: Number(t.lastPrice),
    quoteVolume: Number(t.quoteVolume),
    priceChangePercent: Number(t.priceChangePercent),
  }));
  writeFileSync(join(OUT, 'ticker24h.json'), JSON.stringify(tickers, null, 1));
  console.log(`[fixtures] ticker24h: ${tickers.length} tickers`);

  const valid = new Set(info.map((i) => i.symbol));
  const top = tickers
    .filter((t) => valid.has(t.symbol) && !EXCLUDE.has(t.symbol) && !LEVERAGED.test(t.symbol))
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, TOP_N);
  console.log(`[fixtures] TOP-${TOP_N}: ${top.map((t) => t.symbol).join(', ')}`);

  for (const t of top) {
    for (const tf of TIMEFRAMES) {
      const k = await get('/api/v3/klines', { symbol: t.symbol, interval: tf, limit: LIMIT });
      writeFileSync(join(OUT, `klines_${t.symbol}_${tf}.json`), JSON.stringify(k));
      console.log(`[fixtures] klines ${t.symbol} ${tf}: ${k.length}`);
      await sleep(250);
    }
  }
  console.log('[fixtures] done');
} catch (err) {
  console.error(`[fixtures] FAILED: ${err.message}`);
  console.error('[fixtures] Not retrying. Use scripts/make-fixtures.mjs for offline synthetic data.');
  process.exit(1);
}

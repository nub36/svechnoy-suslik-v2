/**
 * Deterministic Binance-shaped fixture generator.
 *
 * The sandbox has NO egress to Binance, so real recorded fixtures cannot be
 * downloaded here. This generator produces Binance-API-SHAPED data (identical
 * tuple layout to /api/v3/klines, identical field names to /api/v3/ticker/24hr
 * and /api/v3/exchangeInfo) with a seeded PRNG, so the engine, replay and the
 * UI can be exercised end to end offline and reproducibly.
 *
 * On a machine WITH egress, run `node scripts/fetch-fixtures.mjs` instead to
 * replace these with genuine recorded market data.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] || join(process.cwd(), 'fixtures');
mkdirSync(OUT, { recursive: true });

// ---- seeded PRNG (mulberry32) -> fully reproducible fixtures ----
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TF_MS = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
};

const SYMBOLS = [
  { symbol: 'BTCUSDT', base: 'BTC', price: 63250.5, vol: 2.35e9, tick: 0.01, step: 0.00001, seed: 101 },
  { symbol: 'ETHUSDT', base: 'ETH', price: 3120.44, vol: 1.42e9, tick: 0.01, step: 0.0001, seed: 202 },
  { symbol: 'SOLUSDT', base: 'SOL', price: 148.72, vol: 8.9e8, tick: 0.01, step: 0.001, seed: 303 },
  { symbol: 'BNBUSDT', base: 'BNB', price: 585.13, vol: 5.1e8, tick: 0.1, step: 0.001, seed: 404 },
  { symbol: 'XRPUSDT', base: 'XRP', price: 0.5423, vol: 4.4e8, tick: 0.0001, step: 1, seed: 505 },
  { symbol: 'DOGEUSDT', base: 'DOGE', price: 0.1234, vol: 3.2e8, tick: 0.00001, step: 1, seed: 606 },
  { symbol: 'ADAUSDT', base: 'ADA', price: 0.3891, vol: 2.6e8, tick: 0.0001, step: 1, seed: 707 },
  { symbol: 'AVAXUSDT', base: 'AVAX', price: 27.85, vol: 2.1e8, tick: 0.01, step: 0.01, seed: 808 },
  { symbol: 'LINKUSDT', base: 'LINK', price: 11.42, vol: 1.8e8, tick: 0.001, step: 0.01, seed: 909 },
  { symbol: 'TONUSDT', base: 'TON', price: 5.67, vol: 1.5e8, tick: 0.001, step: 0.01, seed: 1010 },
  // a few extras so TOP-N selection actually has to rank/truncate
  { symbol: 'DOTUSDT', base: 'DOT', price: 4.21, vol: 9.8e7, tick: 0.001, step: 0.01, seed: 1111 },
  { symbol: 'MATICUSDT', base: 'MATIC', price: 0.4312, vol: 8.3e7, tick: 0.0001, step: 1, seed: 1212 },
  { symbol: 'LTCUSDT', base: 'LTC', price: 72.4, vol: 7.1e7, tick: 0.01, step: 0.001, seed: 1313 },
];

// Excluded/stable pairs must exist so we can prove they are filtered out.
const STABLES = [
  { symbol: 'USDCUSDT', base: 'USDC', price: 0.9999, vol: 5.0e9, tick: 0.0001, step: 1, seed: 1 },
  { symbol: 'FDUSDUSDT', base: 'FDUSD', price: 1.0001, vol: 3.0e9, tick: 0.0001, step: 1, seed: 2 },
  // Observed in production ranking into the TOP-10; must be excluded.
  { symbol: 'USD1USDT', base: 'USD1', price: 1.0, vol: 2.6e9, tick: 0.0001, step: 1, seed: 12 },
];
// A leveraged token to prove the regex filter works.
const LEVERAGED = [
  { symbol: 'BTCUPUSDT', base: 'BTCUP', price: 12.5, vol: 4.0e9, tick: 0.01, step: 0.01, seed: 3 },
];

/**
 * Generate a candle series with realistic microstructure: trends, ranges,
 * impulsive displacement legs, liquidity sweeps and gaps — so Smart Money
 * detectors have genuine patterns to find.
 */
function genKlines(symbol, interval, count, basePrice, seed) {
  // Distinct seed per timeframe. NOTE: using interval.length would collide
  // ('1m','5m','1h','4h','1d' all have length 2) and produce identical series.
  const tfSeed = Object.keys(TF_MS).indexOf(interval) + 1;
  const rnd = mulberry32(seed + tfSeed * 7919);
  const step = TF_MS[interval];
  // End on a CLOSED boundary in the past so every candle is closed.
  const end = Math.floor(Date.now() / step) * step - step;
  const start = end - step * (count - 1);

  let price = basePrice * (0.82 + rnd() * 0.15);
  const out = [];

  // Regime schedule: alternate trend / range / impulse.
  let regime = 'range';
  let regimeLeft = 20 + Math.floor(rnd() * 30);
  let drift = 0;

  for (let i = 0; i < count; i++) {
    if (regimeLeft-- <= 0) {
      const r = rnd();
      if (r < 0.4) {
        regime = 'trend';
        drift = (rnd() < 0.5 ? 1 : -1) * (0.0008 + rnd() * 0.0022);
        regimeLeft = 25 + Math.floor(rnd() * 45);
      } else if (r < 0.72) {
        regime = 'range';
        drift = 0;
        regimeLeft = 20 + Math.floor(rnd() * 40);
      } else {
        regime = 'impulse';
        drift = (rnd() < 0.5 ? 1 : -1) * (0.004 + rnd() * 0.008);
        regimeLeft = 3 + Math.floor(rnd() * 5);
      }
    }

    const vola = regime === 'impulse' ? 0.009 : regime === 'trend' ? 0.0045 : 0.0032;
    const open = price;
    const shock = (rnd() - 0.5) * 2 * vola;
    let close = open * (1 + drift + shock);

    let high = Math.max(open, close);
    let low = Math.min(open, close);
    const wickUp = rnd() * vola * 0.9;
    const wickDn = rnd() * vola * 0.9;
    high = high * (1 + wickUp);
    low = low * (1 - wickDn);

    // Occasional liquidity sweep: long wick that closes back inside.
    if (rnd() < 0.05 && i > 30) {
      const sweepUp = rnd() < 0.5;
      if (sweepUp) {
        high = high * (1 + vola * 2.2);
        close = open * (1 - vola * 0.35);
        low = Math.min(low, Math.min(open, close) * (1 - vola * 0.2));
      } else {
        low = low * (1 - vola * 2.2);
        close = open * (1 + vola * 0.35);
        high = Math.max(high, Math.max(open, close) * (1 + vola * 0.2));
      }
    }

    high = Math.max(high, open, close);
    low = Math.min(low, open, close);

    const baseVol = 800 + rnd() * 1600;
    const volume =
      regime === 'impulse' ? baseVol * (2.4 + rnd() * 2.2) : baseVol * (0.8 + rnd() * 0.9);

    const openTime = start + i * step;
    const closeTime = openTime + step - 1;
    const dp = basePrice < 1 ? 6 : basePrice < 100 ? 4 : 2;
    const f = (v) => v.toFixed(dp);
    const quoteVol = volume * ((high + low) / 2);

    out.push([
      openTime,
      f(open),
      f(high),
      f(low),
      f(close),
      volume.toFixed(4),
      closeTime,
      quoteVol.toFixed(4),
      Math.floor(volume / 3),
      (volume * 0.52).toFixed(4),
      (quoteVol * 0.52).toFixed(4),
      '0',
    ]);
    price = close;
  }
  return out;
}

const all = [...SYMBOLS, ...STABLES, ...LEVERAGED];

// ---------- ticker24h ----------
const tickers = all.map((s) => ({
  symbol: s.symbol,
  lastPrice: s.price,
  quoteVolume: s.vol,
  priceChangePercent: Number(((mulberry32(s.seed)() - 0.45) * 9).toFixed(3)),
}));
writeFileSync(join(OUT, 'ticker24h.json'), JSON.stringify(tickers, null, 1));

// ---------- exchangeInfo ----------
const info = all.map((s) => ({
  symbol: s.symbol,
  baseAsset: s.base,
  quoteAsset: 'USDT',
  status: 'TRADING',
  isSpotTradingAllowed: true,
  tickSize: s.tick,
  stepSize: s.step,
  minNotional: 5,
}));
writeFileSync(join(OUT, 'exchangeInfo.json'), JSON.stringify(info, null, 1));

// ---------- klines: every TOP-10 symbol x every timeframe ----------
const top10 = SYMBOLS.slice(0, 10);
const intervals = Object.keys(TF_MS);
let files = 0;
for (const s of top10) {
  for (const tf of intervals) {
    // 1w needs fewer bars to stay realistic; the rest get 600.
    const count = tf === '1w' ? 320 : 600;
    const k = genKlines(s.symbol, tf, count, s.price, s.seed);
    writeFileSync(join(OUT, `klines_${s.symbol}_${tf}.json`), JSON.stringify(k));
    files++;
  }
}

console.log(
  `fixtures written to ${OUT}: ticker24h.json, exchangeInfo.json, ${files} kline files ` +
    `(${top10.length} symbols x ${intervals.length} timeframes)`,
);

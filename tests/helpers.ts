import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Candle, Timeframe } from '../src/core/types';
import { tfMs } from '../src/core/types';
import { parseKline } from '../src/market/binance';

export const FIXTURES = join(process.cwd(), 'fixtures');

export function loadFixtureCandles(symbol: string, tf: Timeframe): Candle[] {
  const p = join(FIXTURES, `klines_${symbol}_${tf}.json`);
  if (!existsSync(p)) throw new Error(`missing fixture ${p}`);
  const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown[][];
  return raw.map((k) => {
    const c = parseKline(k);
    // Fixtures are historical: force closed except we re-derive below.
    return { ...c, isClosed: true };
  });
}

export function hasFixtures(): boolean {
  return existsSync(join(FIXTURES, 'ticker24h.json'));
}

/** Build a synthetic candle series from close prices (for precise unit tests). */
export function makeCandles(
  closes: readonly number[],
  opts: { tf?: Timeframe; start?: number; volume?: number; isClosed?: boolean } = {},
): Candle[] {
  const tf = opts.tf ?? '1h';
  const step = tfMs(tf);
  const start = opts.start ?? 1_700_000_000_000;
  return closes.map((close, i) => {
    const prev = i === 0 ? close : (closes[i - 1] as number);
    const open = prev;
    const high = Math.max(open, close) * 1.001;
    const low = Math.min(open, close) * 0.999;
    const openTime = start + i * step;
    return {
      openTime,
      open,
      high,
      low,
      close,
      volume: opts.volume ?? 1000,
      closeTime: openTime + step - 1,
      quoteVolume: (opts.volume ?? 1000) * close,
      trades: 100,
      isClosed: opts.isClosed ?? true,
    };
  });
}

export function candle(
  openTime: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v = 1000,
  isClosed = true,
  tf: Timeframe = '1h',
): Candle {
  return {
    openTime,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
    closeTime: openTime + tfMs(tf) - 1,
    quoteVolume: v * c,
    trades: 50,
    isClosed,
  };
}

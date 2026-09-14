import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectTopSymbols } from '../src/market/top-symbols';
import { Settings } from '../src/core/settings';
import type { ExchangeSymbolInfo, Ticker24h } from '../src/market/binance';
import { BinanceClient } from '../src/market/binance';
import { FIXTURES } from './helpers';
import { TIMEFRAMES } from '../src/core/types';

const tickers = JSON.parse(readFileSync(join(FIXTURES, 'ticker24h.json'), 'utf8')) as Ticker24h[];
const info = JSON.parse(readFileSync(join(FIXTURES, 'exchangeInfo.json'), 'utf8')) as ExchangeSymbolInfo[];

describe('TOP-N Binance Spot USDT selection', () => {
  const s = Settings.fromDefaults();

  it('returns exactly TOP-10 by default', () => {
    const top = selectTopSymbols(tickers, info, s);
    expect(top).toHaveLength(10);
  });

  it('ranks strictly by 24h quote volume descending', () => {
    const top = selectTopSymbols(tickers, info, s);
    for (let i = 1; i < top.length; i++) {
      expect(top[i - 1]!.quoteVolume24h).toBeGreaterThanOrEqual(top[i]!.quoteVolume24h);
    }
    expect(top.map((t) => t.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('only ever returns USDT-quoted pairs', () => {
    const top = selectTopSymbols(tickers, info, s);
    for (const t of top) {
      expect(t.symbol.endsWith('USDT')).toBe(true);
      expect(t.quoteAsset).toBe('USDT');
    }
  });

  it('excludes stablecoin pairs even though their volume is huge', () => {
    const top = selectTopSymbols(tickers, info, s).map((t) => t.symbol);
    // USDCUSDT/FDUSDUSDT have the LARGEST volume in the fixture on purpose.
    expect(top).not.toContain('USDCUSDT');
    expect(top).not.toContain('FDUSDUSDT');
  });

  it('excludes leveraged tokens', () => {
    const top = selectTopSymbols(tickers, info, s).map((t) => t.symbol);
    expect(top).not.toContain('BTCUPUSDT');
  });

  it('excludes non-TRADING and non-spot symbols', () => {
    const halted = info.map((i) =>
      i.symbol === 'BTCUSDT' ? { ...i, status: 'BREAK' } : i,
    );
    const top = selectTopSymbols(tickers, halted, s).map((t) => t.symbol);
    expect(top).not.toContain('BTCUSDT');

    const noSpot = info.map((i) =>
      i.symbol === 'ETHUSDT' ? { ...i, isSpotTradingAllowed: false } : i,
    );
    expect(selectTopSymbols(tickers, noSpot, s).map((t) => t.symbol)).not.toContain('ETHUSDT');
  });

  it('drops tickers with no matching exchangeInfo entry', () => {
    const partial = info.filter((i) => i.symbol !== 'SOLUSDT');
    expect(selectTopSymbols(tickers, partial, s).map((t) => t.symbol)).not.toContain('SOLUSDT');
  });

  it('honours market.top_n from settings (DB -> engine)', () => {
    expect(selectTopSymbols(tickers, info, Settings.fromEntries([['market.top_n', 3]]))).toHaveLength(3);
    expect(selectTopSymbols(tickers, info, Settings.fromEntries([['market.top_n', 5]]))).toHaveLength(5);
  });

  it('honours the exclusion list from settings', () => {
    const custom = Settings.fromEntries([
      ['market.exclude_symbols', ['USDCUSDT', 'FDUSDUSDT', 'BTCUSDT']],
    ]);
    expect(selectTopSymbols(tickers, info, custom).map((t) => t.symbol)).not.toContain('BTCUSDT');
  });

  it('carries exchange filters (tick/step/minNotional) through', () => {
    const top = selectTopSymbols(tickers, info, s);
    for (const t of top) {
      expect(t.tickSize).toBeGreaterThan(0);
      expect(t.stepSize).toBeGreaterThan(0);
      expect(t.minNotional).toBeGreaterThan(0);
    }
  });

  it('handles an empty ticker list gracefully', () => {
    expect(selectTopSymbols([], info, s)).toEqual([]);
  });
});

describe('Binance client offline fixture mode', () => {
  const client = new BinanceClient({ offline: true });

  it('serves ticker24h from fixtures', async () => {
    const t = await client.ticker24h();
    expect(t.length).toBeGreaterThan(10);
    expect(t[0]).toHaveProperty('quoteVolume');
  });

  it('serves exchangeInfo from fixtures', async () => {
    const i = await client.exchangeInfo();
    expect(i.length).toBeGreaterThan(10);
    expect(i.every((x) => x.quoteAsset === 'USDT')).toBe(true);
  });

  it('serves klines for every timeframe and parses the Binance tuple shape', async () => {
    for (const tf of TIMEFRAMES) {
      const k = await client.klines('BTCUSDT', tf, 500);
      expect(k.length, `timeframe ${tf}`).toBeGreaterThan(100);
      const c = k[0]!;
      expect(c.high).toBeGreaterThanOrEqual(c.low);
      expect(c.high).toBeGreaterThanOrEqual(c.open);
      expect(c.high).toBeGreaterThanOrEqual(c.close);
      expect(c.low).toBeLessThanOrEqual(c.open);
      expect(c.low).toBeLessThanOrEqual(c.close);
      expect(Number.isFinite(c.volume)).toBe(true);
      expect(c.closeTime).toBeGreaterThan(c.openTime);
    }
  });

  it('candles are time-ordered with the correct interval spacing', async () => {
    const k = await client.klines('ETHUSDT', '1h', 500);
    for (let i = 1; i < k.length; i++) {
      expect(k[i]!.openTime - k[i - 1]!.openTime).toBe(3_600_000);
    }
  });

  it('throws (does not hang or retry-storm) when a fixture is missing', async () => {
    await expect(client.klines('NOPEUSDT', '1h', 10)).rejects.toThrow(/No klines fixture/);
  });

  it('ping() is false in offline mode rather than attempting the network', async () => {
    expect(await client.ping()).toBe(false);
  });
});

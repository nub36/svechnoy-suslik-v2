/**
 * Binance Spot USDT REST client.
 *
 * SCOPE: Binance Spot only. There is no second exchange, no quorum, no voting
 * and no minExchanges anywhere in this codebase.
 *
 * Offline mode: when BINANCE_OFFLINE=true (or the network is unreachable and a
 * fixture exists) the client serves recorded fixtures from FIXTURES_DIR so the
 * engine, replay and tests can run in a sandbox without egress.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Candle, Timeframe } from '../core/types';
import { config } from '../core/config';

export interface Ticker24h {
  symbol: string;
  lastPrice: number;
  quoteVolume: number;
  priceChangePercent: number;
}

export interface ExchangeSymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  isSpotTradingAllowed: boolean;
  tickSize: number;
  stepSize: number;
  minNotional: number;
}

export class BinanceError extends Error {
  constructor(
    msg: string,
    readonly status?: number,
  ) {
    super(msg);
    this.name = 'BinanceError';
  }
}

function fixturesDir(): string {
  return config.fixturesDir || join(process.cwd(), 'fixtures');
}

function readFixture<T>(name: string): T | null {
  const p = join(fixturesDir(), name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

export interface BinanceClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  offline?: boolean;
}

export class BinanceClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  readonly offline: boolean;
  /** Set to true after a network failure so we stop hammering a blocked host. */
  private networkDead = false;

  constructor(opts: BinanceClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? config.binanceBaseUrl).replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? config.binanceTimeoutMs;
    this.offline = opts.offline ?? config.binanceOffline;
  }

  get usingFixtures(): boolean {
    return this.offline || this.networkDead;
  }

  private async get<T>(path: string, params: Record<string, string | number>): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new BinanceError(`Binance ${path} -> HTTP ${res.status} ${body.slice(0, 200)}`, res.status);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof BinanceError) throw err;
      this.networkDead = true;
      throw new BinanceError(
        `Binance ${path} unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async ping(): Promise<boolean> {
    if (this.offline) return false;
    try {
      await this.get<unknown>('/api/v3/ping', {});
      return true;
    } catch {
      return false;
    }
  }

  /** 24h tickers for every symbol. Falls back to fixtures. */
  async ticker24h(): Promise<Ticker24h[]> {
    if (!this.usingFixtures) {
      try {
        const raw = await this.get<
          Array<{ symbol: string; lastPrice: string; quoteVolume: string; priceChangePercent: string }>
        >('/api/v3/ticker/24hr', {});
        return raw.map((r) => ({
          symbol: r.symbol,
          lastPrice: Number(r.lastPrice),
          quoteVolume: Number(r.quoteVolume),
          priceChangePercent: Number(r.priceChangePercent),
        }));
      } catch (err) {
        if (!this.hasFixture('ticker24h.json')) throw err;
      }
    }
    const fx = readFixture<Ticker24h[]>('ticker24h.json');
    if (!fx) throw new BinanceError('No ticker24h fixture available (offline)');
    return fx;
  }

  async exchangeInfo(): Promise<ExchangeSymbolInfo[]> {
    if (!this.usingFixtures) {
      try {
        const raw = await this.get<{
          symbols: Array<{
            symbol: string;
            baseAsset: string;
            quoteAsset: string;
            status: string;
            isSpotTradingAllowed: boolean;
            filters: Array<Record<string, string>>;
          }>;
        }>('/api/v3/exchangeInfo', {});
        return raw.symbols.map((s) => {
          const price = s.filters.find((f) => f['filterType'] === 'PRICE_FILTER');
          const lot = s.filters.find((f) => f['filterType'] === 'LOT_SIZE');
          const notional = s.filters.find(
            (f) => f['filterType'] === 'NOTIONAL' || f['filterType'] === 'MIN_NOTIONAL',
          );
          return {
            symbol: s.symbol,
            baseAsset: s.baseAsset,
            quoteAsset: s.quoteAsset,
            status: s.status,
            isSpotTradingAllowed: s.isSpotTradingAllowed,
            tickSize: Number(price?.['tickSize'] ?? '0.00000001'),
            stepSize: Number(lot?.['stepSize'] ?? '0.00000001'),
            minNotional: Number(notional?.['minNotional'] ?? '5'),
          };
        });
      } catch (err) {
        if (!this.hasFixture('exchangeInfo.json')) throw err;
      }
    }
    const fx = readFixture<ExchangeSymbolInfo[]>('exchangeInfo.json');
    if (!fx) throw new BinanceError('No exchangeInfo fixture available (offline)');
    return fx;
  }

  private hasFixture(name: string): boolean {
    return existsSync(join(fixturesDir(), name));
  }

  /**
   * Klines. The LAST kline returned by Binance is the still-forming candle;
   * we mark it isClosed=false using the server/system clock so the engine can
   * filter it out. Everything else is closed by definition.
   */
  async klines(symbol: string, interval: Timeframe, limit = 500): Promise<Candle[]> {
    const fixtureName = `klines_${symbol}_${interval}.json`;
    if (!this.usingFixtures) {
      try {
        const raw = await this.get<unknown[][]>('/api/v3/klines', {
          symbol,
          interval,
          limit: Math.min(1000, Math.max(1, limit)),
        });
        return raw.map((k) => parseKline(k));
      } catch (err) {
        if (!this.hasFixture(fixtureName)) throw err;
      }
    }
    const fx = readFixture<unknown[][] | Candle[]>(fixtureName);
    if (!fx) {
      throw new BinanceError(`No klines fixture for ${symbol} ${interval} (offline)`);
    }
    const first = fx[0];
    if (Array.isArray(first)) {
      return (fx as unknown[][]).map((k) => parseKline(k));
    }
    return (fx as Candle[]).slice();
  }
}

/** Binance raw kline tuple -> Candle. */
export function parseKline(k: readonly unknown[]): Candle {
  const openTime = Number(k[0]);
  const closeTime = Number(k[6]);
  return {
    openTime,
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime,
    quoteVolume: Number(k[7] ?? 0),
    trades: Number(k[8] ?? 0),
    // A kline is closed once its closeTime is in the past.
    isClosed: closeTime < Date.now(),
  };
}

let shared: BinanceClient | null = null;
export function getBinance(): BinanceClient {
  if (!shared) shared = new BinanceClient();
  return shared;
}

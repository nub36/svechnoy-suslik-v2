/**
 * Binance public WebSocket client for LIVE DISPLAY ONLY.
 *
 * ============================ CRITICAL ============================
 * Everything this module produces is DISPLAY DATA.
 *
 * A forming (unclosed) candle and every price tick exist solely to make the
 * chart feel live. They are never written to the database, never handed to the
 * Smart Money engine and can never create or modify a signal. The engine reads
 * CLOSED candles from PostgreSQL, written by the market worker. This file has
 * no database access and no engine import, which is what makes that guarantee
 * structural rather than a convention.
 * ==================================================================
 *
 * Transport is injected so the whole subscription lifecycle (switching symbol,
 * switching timeframe, reconnect backoff, cleanup) is testable in Node without
 * a browser or a network.
 */

export const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/ws';

/** The subset of the WebSocket API we rely on. */
export interface StreamSocket {
  close(code?: number, reason?: string): void;
  onopen: ((this: unknown, ev: unknown) => unknown) | null;
  onclose: ((this: unknown, ev: unknown) => unknown) | null;
  onerror: ((this: unknown, ev: unknown) => unknown) | null;
  onmessage: ((this: unknown, ev: { data: unknown }) => unknown) | null;
  readyState?: number;
}

export type SocketFactory = (url: string) => StreamSocket;

/** A live candle update pushed from Binance. Display data. */
export interface LiveCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  /**
   * Binance's `k.x` flag. TRUE means Binance considers the candle final.
   * Even then we only use it to redraw — the authoritative closed candle
   * still arrives through the market worker and the REST/DB path.
   */
  isClosed: boolean;
}

/** A 24h ticker update for one symbol. Display data. */
export interface LiveTicker {
  symbol: string;
  lastPrice: number;
  priceChangePct: number;
  quoteVolume: number;
}

export type ConnectionStatus = 'connecting' | 'online' | 'offline' | 'stale';

/**
 * Build the kline stream name. Lowercase symbol is required by Binance.
 * e.g. btcusdt@kline_15m
 */
export function klineStreamName(symbol: string, timeframe: string): string {
  return `${symbol.toLowerCase()}@kline_${timeframe}`;
}

/** Combined mini-ticker stream for the TOP-10 table. */
export function tickerStreamName(symbols: readonly string[]): string {
  return symbols.map((s) => `${s.toLowerCase()}@miniTicker`).join('/');
}

/** Parse a Binance kline payload into our display candle. Returns null if it is not a kline. */
export function parseKlineMessage(raw: unknown): LiveCandle | null {
  let msg: Record<string, unknown>;
  try {
    msg = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  // Combined-stream envelopes wrap the payload under `data`.
  const body = (msg['data'] as Record<string, unknown> | undefined) ?? msg;
  const k = body['k'] as Record<string, unknown> | undefined;
  if (!k || typeof k !== 'object') return null;

  const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
    return Number.isFinite(n) ? n : Number.NaN;
  };

  const candle: LiveCandle = {
    openTime: num(k['t']),
    open: num(k['o']),
    high: num(k['h']),
    low: num(k['l']),
    close: num(k['c']),
    volume: num(k['v']),
    closeTime: num(k['T']),
    isClosed: k['x'] === true,
  };
  if (!Number.isFinite(candle.openTime) || !Number.isFinite(candle.close)) return null;
  return candle;
}

/** Parse a miniTicker payload (single or combined). */
export function parseTickerMessage(raw: unknown): LiveTicker | null {
  let msg: Record<string, unknown>;
  try {
    msg = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const body = (msg['data'] as Record<string, unknown> | undefined) ?? msg;
  const symbol = body['s'];
  if (typeof symbol !== 'string') return null;

  const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
    return Number.isFinite(n) ? n : Number.NaN;
  };

  const last = num(body['c']);
  const open = num(body['o']);
  if (!Number.isFinite(last)) return null;

  return {
    symbol,
    lastPrice: last,
    // miniTicker has no percent field; derive it from the rolling open.
    priceChangePct: Number.isFinite(open) && open > 0 ? ((last - open) / open) * 100 : 0,
    quoteVolume: num(body['q']),
  };
}

export interface StreamHandlers {
  onCandle?: (c: LiveCandle) => void;
  onTicker?: (t: LiveTicker) => void;
  onStatus?: (s: ConnectionStatus) => void;
}

export interface StreamOptions extends StreamHandlers {
  socketFactory?: SocketFactory;
  baseUrl?: string;
  /** Backoff schedule in ms. The last value repeats. */
  backoffMs?: readonly number[];
  /** No message for this long => report 'stale'. */
  staleAfterMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

const DEFAULT_BACKOFF = [500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;

/**
 * A single-subscription Binance stream.
 *
 * Invariant: AT MOST ONE socket is open at any time. `subscribe()` always
 * tears the previous socket down before opening the next one, so switching
 * symbol or timeframe can never leave the old stream running or produce a
 * duplicate subscription. `close()` is terminal for the current attempt and
 * cancels any pending reconnect.
 */
export class BinanceStream {
  private socket: StreamSocket | null = null;
  private streamName: string | null = null;
  private attempt = 0;
  private reconnectHandle: unknown = null;
  private staleHandle: unknown = null;
  private closed = false;
  private status: ConnectionStatus = 'offline';

  /** Incremented on every subscribe/close so stale callbacks can be ignored. */
  private generation = 0;

  private readonly factory: SocketFactory;
  private readonly baseUrl: string;
  private readonly backoff: readonly number[];
  private readonly staleAfterMs: number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (h: unknown) => void;

  constructor(private readonly opts: StreamOptions = {}) {
    const defaultFactory: SocketFactory = (url) => {
      const WS = (globalThis as { WebSocket?: new (u: string) => StreamSocket }).WebSocket;
      if (!WS) throw new Error('WebSocket is not available in this environment');
      return new WS(url);
    };
    this.factory = opts.socketFactory ?? defaultFactory;
    this.baseUrl = opts.baseUrl ?? BINANCE_WS_BASE;
    this.backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
    this.staleAfterMs = opts.staleAfterMs ?? 20_000;
    this.setT = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  /** The stream currently subscribed, or null. Exposed for tests/diagnostics. */
  currentStream(): string | null {
    return this.streamName;
  }

  /** True when exactly one socket is live. */
  isOpen(): boolean {
    return this.socket !== null;
  }

  /**
   * Join the base URL and stream name. A base that already ends in `/` or `=`
   * (the combined-stream form `/stream?streams=`) is concatenated directly;
   * otherwise a path separator is inserted.
   */
  buildUrl(name: string): string {
    const b = this.baseUrl;
    return /[/=]$/.test(b) ? `${b}${name}` : `${b}/${name}`;
  }

  private setStatus(s: ConnectionStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }

  /**
   * Point the stream at `name`, replacing whatever was subscribed before.
   * Re-subscribing to the identical stream is a no-op so React re-renders
   * cannot churn the socket.
   */
  subscribe(name: string): void {
    if (this.streamName === name && this.socket !== null && !this.closed) return;
    this.teardown();
    this.closed = false;
    this.streamName = name;
    this.attempt = 0;
    this.open();
  }

  private open(): void {
    if (this.closed || this.streamName === null) return;
    const gen = ++this.generation;
    this.setStatus('connecting');

    let sock: StreamSocket;
    try {
      sock = this.factory(this.buildUrl(this.streamName));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = sock;

    sock.onopen = (): void => {
      if (gen !== this.generation) return;
      this.attempt = 0;
      this.setStatus('online');
      this.armStale();
    };

    sock.onmessage = (ev: { data: unknown }): void => {
      if (gen !== this.generation) return;
      this.setStatus('online');
      this.armStale();

      if (this.opts.onCandle) {
        const c = parseKlineMessage(ev.data);
        if (c) {
          this.opts.onCandle(c);
          return;
        }
      }
      if (this.opts.onTicker) {
        const t = parseTickerMessage(ev.data);
        if (t) this.opts.onTicker(t);
      }
    };

    sock.onerror = (): void => {
      if (gen !== this.generation) return;
      // A browser WebSocket always fires onclose after onerror, so reconnect
      // is scheduled there. Doing it here too would double-schedule.
    };

    sock.onclose = (): void => {
      if (gen !== this.generation) return;
      this.socket = null;
      if (this.closed) return;
      this.setStatus('offline');
      this.scheduleReconnect();
    };
  }

  private armStale(): void {
    if (this.staleHandle !== null) this.clearT(this.staleHandle);
    this.staleHandle = this.setT(() => {
      if (!this.closed) this.setStatus('stale');
    }, this.staleAfterMs);
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectHandle !== null) this.clearT(this.reconnectHandle);
    const idx = Math.min(this.attempt, this.backoff.length - 1);
    const delay = this.backoff[idx] ?? 30_000;
    this.attempt++;
    this.reconnectHandle = this.setT(() => {
      this.reconnectHandle = null;
      // Guard again: the component may have unmounted during the wait.
      if (!this.closed) this.open();
    }, delay);
  }

  /** Drop the socket and cancel timers without marking the stream closed. */
  private teardown(): void {
    this.generation++;
    if (this.reconnectHandle !== null) {
      this.clearT(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    if (this.staleHandle !== null) {
      this.clearT(this.staleHandle);
      this.staleHandle = null;
    }
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = null;
      s.onmessage = null;
      s.onerror = null;
      s.onclose = null;
      try {
        s.close();
      } catch {
        /* already closing */
      }
    }
  }

  /** Permanently stop this stream. Safe to call repeatedly. */
  close(): void {
    this.closed = true;
    this.teardown();
    this.streamName = null;
    this.setStatus('offline');
  }
}

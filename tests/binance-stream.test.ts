/**
 * Binance live-display stream.
 *
 * The whole point of these tests is the SUBSCRIPTION LIFECYCLE: a chart that
 * leaks sockets when the user clicks through symbols will quietly melt the
 * browser and double-count ticks. A fake socket factory lets us assert the
 * exact open/close sequence without any network.
 */

import { describe, expect, it } from 'vitest';
import {
  BinanceStream,
  klineStreamName,
  parseKlineMessage,
  parseTickerMessage,
  tickerStreamName,
  type StreamSocket,
} from '../src/web/binance-stream';

/** A controllable stand-in for a browser WebSocket. */
class FakeSocket implements StreamSocket {
  static opened: FakeSocket[] = [];
  closed = false;
  closeCount = 0;
  onopen: ((ev: unknown) => unknown) | null = null;
  onclose: ((ev: unknown) => unknown) | null = null;
  onerror: ((ev: unknown) => unknown) | null = null;
  onmessage: ((ev: { data: unknown }) => unknown) | null = null;

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }

  close(): void {
    this.closed = true;
    this.closeCount++;
  }

  /* -- test helpers -- */
  open(): void {
    this.onopen?.({});
  }
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
  serverClose(): void {
    this.closed = true;
    this.onclose?.({});
  }

  static reset(): void {
    FakeSocket.opened = [];
  }
  static get live(): FakeSocket[] {
    return FakeSocket.opened.filter((s) => !s.closed);
  }
}

function makeStream(
  over: Partial<ConstructorParameters<typeof BinanceStream>[0]> = {},
): { stream: BinanceStream; timers: Array<() => void> } {
  // Collect scheduled callbacks so we can fire reconnects deterministically.
  const timers: Array<() => void> = [];
  const stream = new BinanceStream({
    socketFactory: (url) => new FakeSocket(url),
    setTimeoutFn: (fn) => {
      timers.push(fn);
      return timers.length - 1;
    },
    clearTimeoutFn: () => {
      /* deterministic tests: nothing to cancel */
    },
    ...over,
  });
  return { stream, timers };
}

describe('stream naming', () => {
  it('builds a lowercase kline stream name', () => {
    expect(klineStreamName('BTCUSDT', '15m')).toBe('btcusdt@kline_15m');
    expect(klineStreamName('ETHUSDT', '1h')).toBe('ethusdt@kline_1h');
  });

  it('builds a combined miniTicker stream', () => {
    expect(tickerStreamName(['BTCUSDT', 'ETHUSDT'])).toBe(
      'btcusdt@miniTicker/ethusdt@miniTicker',
    );
  });
});

describe('message parsing', () => {
  const kline = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      e: 'kline',
      k: { t: 1700000000000, T: 1700000899999, o: '100.5', h: '101', l: '99.5', c: '100.75', v: '12.5', x: false, ...over },
    });

  it('parses a forming kline', () => {
    const c = parseKlineMessage(kline())!;
    expect(c.openTime).toBe(1700000000000);
    expect(c.open).toBeCloseTo(100.5, 9);
    expect(c.close).toBeCloseTo(100.75, 9);
    expect(c.isClosed).toBe(false);
  });

  it('flags a closed kline via x=true', () => {
    expect(parseKlineMessage(kline({ x: true }))!.isClosed).toBe(true);
  });

  it('unwraps a combined-stream envelope', () => {
    const wrapped = JSON.stringify({ stream: 'btcusdt@kline_1m', data: JSON.parse(kline()) });
    expect(parseKlineMessage(wrapped)!.close).toBeCloseTo(100.75, 9);
  });

  it('rejects junk instead of throwing', () => {
    expect(parseKlineMessage('not json')).toBeNull();
    expect(parseKlineMessage('{}')).toBeNull();
    expect(parseKlineMessage(JSON.stringify({ k: {} }))).toBeNull();
    expect(parseTickerMessage('{')).toBeNull();
  });

  it('parses a miniTicker and derives the 24h percent', () => {
    const t = parseTickerMessage(
      JSON.stringify({ e: '24hrMiniTicker', s: 'BTCUSDT', c: '110', o: '100', q: '5000' }),
    )!;
    expect(t.symbol).toBe('BTCUSDT');
    expect(t.lastPrice).toBe(110);
    expect(t.priceChangePct).toBeCloseTo(10, 9);
  });

  it('does not divide by zero when the rolling open is 0', () => {
    const t = parseTickerMessage(JSON.stringify({ s: 'X', c: '5', o: '0' }))!;
    expect(t.priceChangePct).toBe(0);
  });
});

describe('subscription lifecycle', () => {
  it('opens exactly one socket on subscribe', () => {
    FakeSocket.reset();
    const { stream } = makeStream();
    stream.subscribe('btcusdt@kline_15m');
    expect(FakeSocket.opened).toHaveLength(1);
    expect(FakeSocket.live).toHaveLength(1);
    expect(FakeSocket.opened[0]!.url).toContain('btcusdt@kline_15m');
    stream.close();
  });

  it('closes the OLD socket when the symbol changes', () => {
    FakeSocket.reset();
    const { stream } = makeStream();
    stream.subscribe('btcusdt@kline_15m');
    const first = FakeSocket.opened[0]!;

    stream.subscribe('ethusdt@kline_15m');

    expect(first.closed).toBe(true);
    expect(FakeSocket.opened).toHaveLength(2);
    // THE INVARIANT: never more than one live socket.
    expect(FakeSocket.live).toHaveLength(1);
    expect(FakeSocket.live[0]!.url).toContain('ethusdt');
    stream.close();
  });

  it('closes the OLD socket when the timeframe changes', () => {
    FakeSocket.reset();
    const { stream } = makeStream();
    stream.subscribe('btcusdt@kline_15m');
    stream.subscribe('btcusdt@kline_1h');
    expect(FakeSocket.live).toHaveLength(1);
    expect(FakeSocket.live[0]!.url).toContain('kline_1h');
    stream.close();
  });

  it('re-subscribing to the SAME stream does not churn the socket', () => {
    FakeSocket.reset();
    const { stream } = makeStream();
    stream.subscribe('btcusdt@kline_15m');
    stream.subscribe('btcusdt@kline_15m');
    stream.subscribe('btcusdt@kline_15m');
    expect(FakeSocket.opened).toHaveLength(1);
    stream.close();
  });

  it('stops delivering candles from a superseded subscription', () => {
    FakeSocket.reset();
    const seen: number[] = [];
    const { stream } = makeStream({ onCandle: (c) => seen.push(c.close) });

    stream.subscribe('btcusdt@kline_15m');
    const btc = FakeSocket.opened[0]!;
    btc.open();
    btc.emit(JSON.stringify({ k: { t: 1, o: '1', h: '1', l: '1', c: '111', v: '1', T: 2, x: false } }));

    stream.subscribe('ethusdt@kline_15m');
    // A late tick from the BTC socket must be ignored entirely.
    btc.emit(JSON.stringify({ k: { t: 1, o: '1', h: '1', l: '1', c: '999', v: '1', T: 2, x: false } }));

    expect(seen).toEqual([111]);
    stream.close();
  });

  it('cleans up on close and reports offline', () => {
    FakeSocket.reset();
    const statuses: string[] = [];
    const { stream } = makeStream({ onStatus: (s) => statuses.push(s) });
    stream.subscribe('btcusdt@kline_15m');
    FakeSocket.opened[0]!.open();
    stream.close();

    expect(FakeSocket.live).toHaveLength(0);
    expect(stream.isOpen()).toBe(false);
    expect(stream.currentStream()).toBeNull();
    expect(statuses[statuses.length - 1]).toBe('offline');
  });

  it('close() is idempotent', () => {
    FakeSocket.reset();
    const { stream } = makeStream();
    stream.subscribe('btcusdt@kline_15m');
    expect(() => {
      stream.close();
      stream.close();
      stream.close();
    }).not.toThrow();
    expect(FakeSocket.live).toHaveLength(0);
  });
});

describe('reconnect', () => {
  it('reconnects after an unexpected close without duplicating sockets', () => {
    FakeSocket.reset();
    const { stream, timers } = makeStream();
    stream.subscribe('btcusdt@kline_15m');
    const first = FakeSocket.opened[0]!;
    first.open();

    first.serverClose();
    expect(FakeSocket.live).toHaveLength(0);

    // Fire the scheduled reconnect.
    timers.forEach((fn) => fn());
    expect(FakeSocket.opened.length).toBeGreaterThan(1);
    expect(FakeSocket.live).toHaveLength(1);
    stream.close();
  });

  it('uses increasing backoff delays', () => {
    FakeSocket.reset();
    const delays: number[] = [];
    const stream = new BinanceStream({
      socketFactory: (url) => new FakeSocket(url),
      backoffMs: [100, 200, 400],
      setTimeoutFn: (_fn, ms) => {
        delays.push(ms);
        return 0;
      },
      clearTimeoutFn: () => undefined,
      staleAfterMs: 999_999,
    });
    stream.subscribe('btcusdt@kline_15m');

    // Each failed connection schedules the next backoff step.
    for (let i = 0; i < 3; i++) {
      const live = FakeSocket.live[0];
      if (live) live.serverClose();
      // Re-open manually to simulate the retry actually happening.
      stream['open']();
    }
    // Ignore stale-timer entries; reconnects use the backoff table.
    const reconnectDelays = delays.filter((d) => [100, 200, 400].includes(d));
    expect(reconnectDelays[0]).toBe(100);
    expect(reconnectDelays[1]).toBe(200);
    stream.close();
  });

  it('a reconnect scheduled before close() does not resurrect the socket', () => {
    FakeSocket.reset();
    const { stream, timers } = makeStream();
    stream.subscribe('btcusdt@kline_15m');
    FakeSocket.opened[0]!.serverClose();

    // The component unmounts while the reconnect is pending.
    stream.close();
    timers.forEach((fn) => fn());

    expect(FakeSocket.live).toHaveLength(0);
  });
});

describe('status reporting', () => {
  it('goes connecting -> online on the first message', () => {
    FakeSocket.reset();
    const statuses: string[] = [];
    const { stream } = makeStream({
      onStatus: (s) => statuses.push(s),
      onCandle: () => undefined,
    });
    stream.subscribe('btcusdt@kline_15m');
    expect(statuses).toContain('connecting');
    FakeSocket.opened[0]!.open();
    expect(statuses).toContain('online');
    stream.close();
  });

  it('reports stale when no message arrives within the window', () => {
    FakeSocket.reset();
    const statuses: string[] = [];
    const staleFns: Array<() => void> = [];
    const stream = new BinanceStream({
      socketFactory: (url) => new FakeSocket(url),
      onStatus: (s) => statuses.push(s),
      setTimeoutFn: (fn) => {
        staleFns.push(fn);
        return staleFns.length;
      },
      clearTimeoutFn: () => undefined,
      staleAfterMs: 1_000,
    });
    stream.subscribe('btcusdt@kline_15m');
    FakeSocket.opened[0]!.open();
    // Trigger the stale timer.
    staleFns.forEach((fn) => fn());
    expect(statuses).toContain('stale');
    stream.close();
  });
});

describe('URL construction', () => {
  it('uses a path separator for the plain base URL', () => {
    const s = new BinanceStream({ socketFactory: (u) => new FakeSocket(u) });
    expect(s.buildUrl('btcusdt@kline_1m')).toBe(
      'wss://stream.binance.com:9443/ws/btcusdt@kline_1m',
    );
  });

  it('appends directly for the combined-stream base URL', () => {
    const s = new BinanceStream({
      socketFactory: (u) => new FakeSocket(u),
      baseUrl: 'wss://stream.binance.com:9443/stream?streams=',
    });
    expect(s.buildUrl('a@miniTicker/b@miniTicker')).toBe(
      'wss://stream.binance.com:9443/stream?streams=a@miniTicker/b@miniTicker',
    );
  });
});

describe('display-only guarantee', () => {
  it('the stream module imports neither the database nor the engine', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/web/binance-stream.ts', 'utf8');
    // A forming candle must be structurally incapable of reaching the engine.
    expect(src).not.toMatch(/from '.*\/db/);
    expect(src).not.toMatch(/from '.*strategy\//);
    expect(src).not.toMatch(/insertInto|updateTable|deleteFrom/);
    expect(src).not.toMatch(/evaluate\(|runEngineOnce/);
  });

  it('never exposes a way to persist a candle', () => {
    const stream = new BinanceStream({ socketFactory: (u) => new FakeSocket(u) });
    // The public surface is subscribe/close/status only.
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(stream));
    expect(surface).not.toContain('save');
    expect(surface).not.toContain('persist');
    expect(surface).toContain('subscribe');
    expect(surface).toContain('close');
  });
});

'use client';

/**
 * React bindings for the Binance display stream.
 *
 * DISPLAY ONLY. Nothing here reaches the database or the Smart Money engine —
 * see src/web/binance-stream.ts for the full rationale.
 */

import { useEffect, useRef, useState } from 'react';
import {
  BinanceStream,
  klineStreamName,
  tickerStreamName,
  type ConnectionStatus,
  type LiveCandle,
  type LiveTicker,
} from '@/web/binance-stream';

/**
 * Live kline for one symbol/timeframe.
 *
 * The effect key is exactly `symbol + timeframe`, so switching either one
 * tears the old socket down and opens exactly one new socket. The cleanup
 * function closes the stream on unmount.
 */
export function useLiveCandle(
  symbol: string,
  timeframe: string,
  enabled = true,
): { candle: LiveCandle | null; status: ConnectionStatus } {
  const [candle, setCandle] = useState<LiveCandle | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('offline');

  useEffect(() => {
    if (!enabled || !symbol || !timeframe) {
      setStatus('offline');
      return;
    }
    // A brand-new candle from a previous symbol must never leak into the next.
    setCandle(null);

    const stream = new BinanceStream({
      onCandle: (c) => setCandle(c),
      onStatus: (s) => setStatus(s),
    });
    stream.subscribe(klineStreamName(symbol, timeframe));

    return () => {
      stream.close();
    };
  }, [symbol, timeframe, enabled]);

  return { candle, status };
}

/**
 * Live prices for the TOP-10 table, keyed by symbol.
 *
 * Updates are collected into a ref and flushed on a timer so a busy market
 * cannot trigger a React render per tick (that was the source of flicker).
 */
export function useLiveTickers(
  symbols: readonly string[],
  enabled = true,
  flushMs = 700,
): { tickers: Record<string, LiveTicker>; status: ConnectionStatus } {
  const [tickers, setTickers] = useState<Record<string, LiveTicker>>({});
  const [status, setStatus] = useState<ConnectionStatus>('offline');
  const pending = useRef<Record<string, LiveTicker>>({});

  // Stable key so re-ordering the TOP-10 does not reopen the socket.
  const key = [...symbols].sort().join(',');

  useEffect(() => {
    const list = key ? key.split(',') : [];
    if (!enabled || list.length === 0) {
      setStatus('offline');
      return;
    }

    const stream = new BinanceStream({
      onTicker: (t) => {
        pending.current[t.symbol] = t;
      },
      onStatus: (s) => setStatus(s),
      // Combined streams live under /stream?streams=...
      baseUrl: 'wss://stream.binance.com:9443/stream?streams=',
    });
    stream.subscribe(tickerStreamName(list));

    const flush = setInterval(() => {
      if (Object.keys(pending.current).length === 0) return;
      const batch = pending.current;
      pending.current = {};
      setTickers((prev) => ({ ...prev, ...batch }));
    }, flushMs);

    return () => {
      clearInterval(flush);
      stream.close();
      pending.current = {};
    };
  }, [key, enabled, flushMs]);

  return { tickers, status };
}

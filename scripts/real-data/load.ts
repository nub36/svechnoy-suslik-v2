/**
 * Candle loader for the binary series cache produced by ingest.ts.
 *
 * One series at a time — never the whole dataset. A 1m series is ~2.1M candles;
 * materialising all 42 series as JS objects simultaneously would exhaust memory,
 * so callers must load, use, and drop each series in turn.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Candle, Timeframe } from '../../src/core/types';
import { TF_MS } from '../../src/core/types';
import { FIELDS } from './ingest';

export function seriesPath(cacheDir: string, symbol: string, tf: Timeframe): string {
  return join(cacheDir, `${symbol}-${tf}.bin`);
}

export function hasSeries(cacheDir: string, symbol: string, tf: Timeframe): boolean {
  return existsSync(seriesPath(cacheDir, symbol, tf));
}

/**
 * Load one series as Candle objects.
 *
 * `isClosed` is set to true for every candle: these are monthly ARCHIVE files,
 * which Binance only publishes for completed months, so every row is a closed
 * candle. The final row of the final month is the last fully closed candle of
 * 2025-12 — there is no forming candle in an archive.
 */
export function loadSeries(
  cacheDir: string, symbol: string, tf: Timeframe,
): Candle[] {
  const buf = readFileSync(seriesPath(cacheDir, symbol, tf));
  const a = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
  const n = a.length / FIELDS;
  const span = TF_MS[tf];
  const out: Candle[] = new Array<Candle>(n);
  for (let i = 0; i < n; i++) {
    const b = i * FIELDS;
    const openTime = a[b]!;
    out[i] = {
      openTime,
      open: a[b + 1]!,
      high: a[b + 2]!,
      low: a[b + 3]!,
      close: a[b + 4]!,
      volume: a[b + 5]!,
      // Use the canonical close time. The archive's own closeTime is byte-exact
      // except for the single candle truncated by the 2023-03-24 Binance halt;
      // the engine's HTF gate compares openTime + tfMs, so a canonical value
      // keeps closed-candle arithmetic consistent across timeframes.
      closeTime: openTime + span - 1,
      quoteVolume: 0,
      trades: 0,
      isClosed: true,
    };
  }
  return out;
}

/** Raw flat view, when object allocation is not wanted. */
export function loadRaw(cacheDir: string, symbol: string, tf: Timeframe): Float64Array {
  const buf = readFileSync(seriesPath(cacheDir, symbol, tf));
  return new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
}

/**
 * Subset ingest for the V3.0 parity harness.
 *
 * The full dataset ingest builds all 42 series from 2016 ZIPs, which is far
 * more than a parity check needs. This driver builds ONLY the series the
 * harness reads (the six V3.0 symbols at 1h and 4h) into a scratch cache. It
 * reuses the same ingest code path and validation as run-ingest.ts, so the
 * candles are identical to the ones the VALIDATION run used — only fewer of
 * them.
 *
 * Nothing under `artifacts/` is written: this is a scratch cache.
 *
 * Usage:
 *   npx tsx scripts/real-data/v30-parity-ingest.ts --dataset=<path> --cache=<dir>
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ingestSeries, type SeriesReport, type ZipRecord } from './ingest';

export const V30_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'DOGEUSDT',
] as const;

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

function main(): void {
  const datasetRoot = arg('dataset');
  const cacheDir = arg('cache');
  mkdirSync(cacheDir, { recursive: true });

  const reports: SeriesReport[] = [];
  const zips: ZipRecord[] = [];

  for (const symbol of V30_SYMBOLS) {
    for (const timeframe of ['1h', '4h'] as const) {
      const t0 = Date.now();
      const { rec, zips: z } = ingestSeries(datasetRoot, cacheDir, symbol, timeframe);
      reports.push(rec);
      zips.push(...z);
      console.log(
        `  ${symbol} ${timeframe}: ${rec.candles} candles, gaps ${rec.gapCount}, missing ${rec.missingCandles}, ` +
          `badCloseTime ${rec.badCloseTime} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
      );
    }
  }

  const summary = {
    symbols: V30_SYMBOLS,
    timeframes: ['1h', '4h'],
    series: reports.map((r) => ({
      symbol: r.symbol,
      timeframe: r.timeframe,
      candles: r.candles,
      firstOpenUtc: r.firstOpenUtc,
      lastOpenUtc: r.lastOpenUtc,
      gapCount: r.gapCount,
      missingCandles: r.missingCandles,
      duplicateOpenTime: r.duplicateOpenTime,
      outOfOrder: r.outOfOrder,
      invalidOhlc: r.invalidOhlc,
      invalidVolume: r.invalidVolume,
      badCloseTime: r.badCloseTime,
      timeUnits: r.timeUnits,
    })),
    totals: {
      zips: zips.length,
      candles: reports.reduce((a, r) => a + r.candles, 0),
      gapCount: reports.reduce((a, r) => a + r.gapCount, 0),
      missingCandles: reports.reduce((a, r) => a + r.missingCandles, 0),
      badCloseTime: reports.reduce((a, r) => a + r.badCloseTime, 0),
    },
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(cacheDir, 'subset-manifest.json'), JSON.stringify(summary, null, 2));
  console.log('');
  console.log(`wrote ${join(cacheDir, 'subset-manifest.json')} (${summary.totals.candles} candles)`);
}

void main();

/**
 * Driver for the dataset ingest (Steps 2-4).
 *
 * Usage:
 *   npx tsx scripts/real-data/run-ingest.ts --dataset=<path> --out=<runDir> --cache=<dir>
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Timeframe } from '../../src/core/types';
import {
  SYMBOLS, TIMEFRAMES, ingestSeries, parseZip,
  type SeriesReport, type ZipRecord,
} from './ingest';

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

const utc = (ms: number): string => new Date(ms).toISOString();

function main(): void {
  const datasetRoot = arg('dataset');
  const outDir = arg('out');
  const cacheDir = arg('cache');
  mkdirSync(outDir, { recursive: true });

  const datasetCommit = execFileSync('git', ['-C', datasetRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();

  console.log('dataset root  :', datasetRoot);
  console.log('dataset commit:', datasetCommit);
  console.log('');

  /* ---- Step 4 spot checks: manual UTC conversion, BEFORE bulk ingest ---- */
  console.log('=== STEP 4: manual timestamp spot-checks (x1000 guard) ===');
  const checks: { sym: string; tf: Timeframe; month: string }[] = [
    { sym: 'BTCUSDT', tf: '1m', month: '2022-01' },
    { sym: 'BTCUSDT', tf: '15m', month: '2024-06' },
    { sym: 'ETHUSDT', tf: '1h', month: '2025-12' },
  ];
  const spot: unknown[] = [];
  for (const c of checks) {
    const p = join(datasetRoot, c.sym, c.tf, `${c.sym}-${c.tf}-${c.month}.zip`);
    const { rec, data } = parseZip(p, c.sym, c.tf, c.month);
    const entry = {
      file: rec.path,
      detectedUnit: rec.timeUnit,
      rawFirstOpenTime: rec.timeUnit === 'us' ? rec.firstOpenTimeMs * 1000 : rec.firstOpenTimeMs,
      normalisedMs: data[0]!,
      firstOpenUtc: utc(data[0]!),
      firstCloseUtc: utc(data[6]!),
      ohlcv: {
        open: data[1], high: data[2], low: data[3], close: data[4], volume: data[5],
      },
      rows: rec.rows,
    };
    spot.push(entry);
    console.log(`  ${rec.path}`);
    console.log(`    unit=${rec.timeUnit}  first openTime -> ${entry.firstOpenUtc}`);
    console.log(`    first closeTime      -> ${entry.firstCloseUtc}`);
    console.log(`    O=${data[1]} H=${data[2]} L=${data[3]} C=${data[4]} V=${data[5]}`);
  }
  console.log('');

  /* ---- Steps 2-3: full ingest, one series at a time ---- */
  const allZips: ZipRecord[] = [];
  const series: SeriesReport[] = [];

  for (const sym of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      const t0 = Date.now();
      const { rec, zips } = ingestSeries(datasetRoot, cacheDir, sym, tf as Timeframe);
      allZips.push(...zips);
      series.push(rec);
      console.log(
        `${sym.padEnd(8)} ${String(tf).padEnd(4)} ` +
        `candles=${String(rec.candles).padStart(9)} ` +
        `dup=${rec.duplicateOpenTime} ooo=${rec.outOfOrder} ` +
        `gaps=${String(rec.gapCount).padStart(4)} (missing ${rec.missingCandles}) ` +
        `badOHLC=${rec.invalidOhlc} badVol=${rec.invalidVolume} badCT=${rec.badCloseTime} ` +
        `units=${rec.timeUnits.join('+')} ` +
        `[${rec.firstOpenUtc} .. ${rec.lastOpenUtc}] ${Date.now() - t0}ms`,
      );
    }
  }

  const zipDoc = {
    datasetRepo: 'https://github.com/nub36/svechnoy-suslik-binance-data.git',
    datasetCommit,
    generatedAt: new Date().toISOString(),
    zipCount: allZips.length,
    zips: allZips,
  };
  const manifestDoc = {
    datasetRepo: 'https://github.com/nub36/svechnoy-suslik-binance-data.git',
    datasetCommit,
    provenance: {
      exchange: 'Binance',
      market: 'Spot',
      quote: 'USDT',
      originalSource: 'https://data.binance.vision/data/spot/monthly/klines/',
      note: 'Original unmodified monthly ZIP archives, re-hosted on GitHub by the user.',
    },
    generatedAt: new Date().toISOString(),
    symbols: [...SYMBOLS],
    timeframes: [...TIMEFRAMES],
    period: { from: '2022-01', to: '2025-12' },
    spotChecks: spot,
    series,
    totals: {
      zips: allZips.length,
      candles: series.reduce((s, r) => s + r.candles, 0),
      duplicateOpenTime: series.reduce((s, r) => s + r.duplicateOpenTime, 0),
      outOfOrder: series.reduce((s, r) => s + r.outOfOrder, 0),
      gapCount: series.reduce((s, r) => s + r.gapCount, 0),
      missingCandles: series.reduce((s, r) => s + r.missingCandles, 0),
      invalidOhlc: series.reduce((s, r) => s + r.invalidOhlc, 0),
      invalidVolume: series.reduce((s, r) => s + r.invalidVolume, 0),
      badCloseTime: series.reduce((s, r) => s + r.badCloseTime, 0),
    },
  };

  const zipPath = join(outDir, 'zip-checksums.json');
  const manPath = join(outDir, 'dataset-manifest.json');
  writeFileSync(zipPath, JSON.stringify(zipDoc, null, 2));
  writeFileSync(manPath, JSON.stringify(manifestDoc, null, 2));

  const manHash = createHash('sha256').update(JSON.stringify(manifestDoc)).digest('hex');
  writeFileSync(join(outDir, 'dataset-manifest.sha256'), `${manHash}\n`);

  console.log('');
  console.log('TOTALS:', JSON.stringify(manifestDoc.totals, null, 1));
  console.log('dataset-manifest sha256:', manHash);
  console.log('wrote', zipPath);
  console.log('wrote', manPath);
}

main();

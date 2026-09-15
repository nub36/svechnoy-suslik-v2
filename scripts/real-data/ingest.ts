/**
 * REAL BINANCE DATA — ingest, validate, and cache (Steps 2-4).
 *
 * Reads the 2016 ORIGINAL monthly ZIPs from the frozen dataset checkout,
 * validates every one of them, and writes:
 *
 *   - zip-checksums.json    SHA-256 + verified metadata for each ZIP
 *   - dataset-manifest.json per (symbol,timeframe) series integrity report
 *   - <cache>/<SYM>-<TF>.bin  a compact Float64 binary cache of the series
 *
 * WHY A BINARY CACHE: the dataset is ~16.4M candles. Re-parsing 2016 CSVs for
 * every replay pass would dominate runtime, and holding all series as JS
 * objects at once would exhaust memory. Each series is parsed ONCE, validated,
 * and written as a flat Float64Array of 7 fields per candle. Replay then loads
 * exactly one series at a time.
 *
 * NOTHING HERE TOUCHES TRADING LOGIC. It only produces candles.
 *
 * TIMESTAMP UNITS (Step 3): Binance changed the archive timestamp unit part-way
 * through the covered period — early files are milliseconds (13 digits), later
 * files are MICROseconds (16 digits). The unit is detected PER FILE from the
 * magnitude of openTime and normalised to milliseconds. This is the ×1000 trap
 * the task warns about; getting it wrong silently shifts every candle to the
 * year 57000 and destroys all downstream timing.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TF_MS, type Timeframe } from '../../src/core/types';

export const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT',
] as const;
export type Symbol_ = (typeof SYMBOLS)[number];

export const TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

/** Fields persisted per candle in the binary cache. */
export const FIELDS = 7; // openTime, open, high, low, close, volume, closeTime

export interface ZipRecord {
  path: string;
  symbol: string;
  timeframe: string;
  month: string;
  sha256: string;
  bytes: number;
  csvName: string;
  rows: number;
  /** Detected timestamp unit of THIS file. */
  timeUnit: 'ms' | 'us';
  firstOpenTimeMs: number;
  lastOpenTimeMs: number;
  /** Did the CSV carry a textual header line? (Binance added one in 2025.) */
  hasHeader: boolean;
  schemaCols: number;
}

export interface SeriesReport {
  symbol: string;
  timeframe: string;
  files: number;
  candles: number;
  firstOpenTimeMs: number;
  lastOpenTimeMs: number;
  firstOpenUtc: string;
  lastOpenUtc: string;
  duplicateOpenTime: number;
  outOfOrder: number;
  gapCount: number;
  missingCandles: number;
  invalidOhlc: number;
  invalidVolume: number;
  badCloseTime: number;
  /** Largest gaps, for the integrity report. Never filled in. */
  gaps: { fromUtc: string; toUtc: string; missing: number }[];
  timeUnits: string[];
  cacheFile: string;
  cacheSha256: string;
}

const utc = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

/**
 * Detect the timestamp unit from magnitude.
 *
 * A millisecond timestamp for 2022-2025 is ~1.6e12 (13 digits); the same instant
 * in microseconds is ~1.6e15 (16 digits). The two are three orders of magnitude
 * apart, so the classification is unambiguous. Anything else is rejected rather
 * than guessed.
 */
export function detectTimeUnit(openTime: number): 'ms' | 'us' {
  if (openTime >= 1e12 && openTime < 1e13) return 'ms';
  if (openTime >= 1e15 && openTime < 1e16) return 'us';
  throw new Error(`cannot classify timestamp unit for value ${openTime}`);
}

export function toMs(v: number, unit: 'ms' | 'us'): number {
  return unit === 'ms' ? v : Math.floor(v / 1000);
}

function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function sha256Buf(b: Uint8Array | Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

/** Stream the single CSV out of a monthly ZIP using the system unzip. */
function readCsv(zipPath: string): { name: string; text: string } {
  const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  if (listing.length !== 1) {
    throw new Error(`expected exactly 1 entry in ${zipPath}, found ${listing.length}`);
  }
  const name = listing[0]!;
  const text = execFileSync('unzip', ['-p', zipPath], {
    encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
  });
  return { name, text };
}

export interface ParsedFile {
  rec: ZipRecord;
  /** Flat [openTime, o, h, l, c, v, closeTime] * n, all times in ms. */
  data: Float64Array;
}

/**
 * Parse and validate ONE monthly ZIP.
 *
 * Validation here is structural only (schema, units, parseability). Series-level
 * checks (ordering, duplicates, gaps) happen after concatenation, because they
 * span file boundaries.
 */
export function parseZip(
  zipPath: string, symbol: string, timeframe: string, month: string,
): ParsedFile {
  const { name, text } = readCsv(zipPath);

  // The filename inside the archive must match the archive's own identity.
  const expected = `${symbol}-${timeframe}-${month}.csv`;
  if (name !== expected) {
    throw new Error(`csv name mismatch in ${zipPath}: got '${name}', expected '${expected}'`);
  }

  const lines = text.split('\n');
  let start = 0;
  let hasHeader = false;
  // Binance added a header row to some 2025 archives. Detect it rather than
  // assume: a header's first field does not parse as a number.
  const first = lines[0] ?? '';
  if (first.length > 0 && !/^\d/.test(first.trim())) { hasHeader = true; start = 1; }

  const out: number[] = [];
  let cols = 0;
  let unit: 'ms' | 'us' | null = null;

  for (let li = start; li < lines.length; li++) {
    const line = lines[li]!.trim();
    if (line === '') continue;
    const f = line.split(',');
    if (cols === 0) cols = f.length;
    // Binance Spot kline schema: 12 columns (a 13th trailing empty field can
    // appear from the trailing comma in some vintages).
    if (f.length < 11) {
      throw new Error(`bad schema in ${zipPath} line ${li + 1}: ${f.length} cols`);
    }
    const rawOpen = Number(f[0]);
    const rawClose = Number(f[6]);
    if (!Number.isFinite(rawOpen)) {
      throw new Error(`unparseable openTime in ${zipPath} line ${li + 1}`);
    }
    if (unit === null) unit = detectTimeUnit(rawOpen);

    const o = Number(f[1]); const h = Number(f[2]);
    const l = Number(f[3]); const c = Number(f[4]); const v = Number(f[5]);
    if (![o, h, l, c, v].every(Number.isFinite)) {
      throw new Error(`unparseable OHLCV in ${zipPath} line ${li + 1}`);
    }
    out.push(toMs(rawOpen, unit), o, h, l, c, v, toMs(rawClose, unit));
  }

  if (unit === null || out.length === 0) {
    throw new Error(`no data rows in ${zipPath}`);
  }

  const data = Float64Array.from(out);
  const n = data.length / FIELDS;
  return {
    rec: {
      path: `${symbol}/${timeframe}/${symbol}-${timeframe}-${month}.zip`,
      symbol, timeframe, month,
      sha256: sha256File(zipPath),
      bytes: readFileSync(zipPath).length,
      csvName: name,
      rows: n,
      timeUnit: unit,
      firstOpenTimeMs: data[0]!,
      lastOpenTimeMs: data[(n - 1) * FIELDS]!,
      hasHeader,
      schemaCols: cols,
    },
    data,
  };
}

/** Months covered by the experiment, 2022-01 .. 2025-12 inclusive. */
export function months(): string[] {
  const out: string[] = [];
  for (let y = 2022; y <= 2025; y++) {
    for (let m = 1; m <= 12; m++) out.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return out;
}

export interface IngestResult {
  zips: ZipRecord[];
  series: SeriesReport[];
}

export function ingestSeries(
  datasetRoot: string, cacheDir: string, symbol: string, timeframe: Timeframe,
): { rec: SeriesReport; zips: ZipRecord[] } {
  const zips: ZipRecord[] = [];
  const parts: Float64Array[] = [];
  let total = 0;

  for (const month of months()) {
    const p = join(datasetRoot, symbol, timeframe, `${symbol}-${timeframe}-${month}.zip`);
    if (!existsSync(p)) throw new Error(`missing expected archive: ${p}`);
    const { rec, data } = parseZip(p, symbol, timeframe, month);
    zips.push(rec);
    parts.push(data);
    total += data.length;
  }

  // Concatenate once (per series only — never the whole dataset).
  const all = new Float64Array(total);
  let off = 0;
  for (const p of parts) { all.set(p, off); off += p.length; }
  parts.length = 0;

  const n = all.length / FIELDS;
  const step = TF_MS[timeframe];

  let duplicateOpenTime = 0, outOfOrder = 0, gapCount = 0, missingCandles = 0;
  let invalidOhlc = 0, invalidVolume = 0, badCloseTime = 0;
  const gaps: { fromUtc: string; toUtc: string; missing: number }[] = [];

  for (let i = 0; i < n; i++) {
    const b = i * FIELDS;
    const ot = all[b]!, o = all[b + 1]!, h = all[b + 2]!, l = all[b + 3]!,
      c = all[b + 4]!, v = all[b + 5]!, ct = all[b + 6]!;

    // OHLC validity — exactly the rules the task specifies.
    if (!(h >= o && h >= c && l <= o && l <= c && h >= l)) invalidOhlc++;
    if (!(v >= 0)) invalidVolume++;
    // closeTime must be the canonical openTime + step - 1 (ms).
    if (Math.abs(ct - (ot + step - 1)) > 1) badCloseTime++;

    if (i > 0) {
      const prev = all[(i - 1) * FIELDS]!;
      if (ot === prev) duplicateOpenTime++;
      else if (ot < prev) outOfOrder++;
      else {
        const delta = ot - prev;
        if (delta !== step) {
          // A real gap in the Binance archive. NEVER synthesised.
          gapCount++;
          const missing = Math.round(delta / step) - 1;
          missingCandles += missing;
          if (gaps.length < 50) {
            gaps.push({ fromUtc: utc(prev), toUtc: utc(ot), missing });
          }
        }
      }
    }
  }

  mkdirSync(cacheDir, { recursive: true });
  const cacheFile = join(cacheDir, `${symbol}-${timeframe}.bin`);
  const buf = Buffer.from(all.buffer, all.byteOffset, all.byteLength);
  writeFileSync(cacheFile, buf);

  const rec: SeriesReport = {
    symbol, timeframe,
    files: zips.length,
    candles: n,
    firstOpenTimeMs: all[0]!,
    lastOpenTimeMs: all[(n - 1) * FIELDS]!,
    firstOpenUtc: utc(all[0]!),
    lastOpenUtc: utc(all[(n - 1) * FIELDS]!),
    duplicateOpenTime, outOfOrder, gapCount, missingCandles,
    invalidOhlc, invalidVolume, badCloseTime,
    gaps,
    timeUnits: [...new Set(zips.map((z) => z.timeUnit))].sort(),
    cacheFile,
    cacheSha256: sha256Buf(buf),
  };
  return { rec, zips };
}

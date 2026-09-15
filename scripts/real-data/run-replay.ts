/**
 * REAL REPLAY DRIVER — V1 vs frozen V2 on real Binance candles.
 *
 * Processes ONE (symbol, timeframe) series at a time and streams trades to
 * disk, so peak memory stays bounded regardless of the 16.7M-candle dataset.
 *
 * Both engines see the SAME candles and the SAME chronological split
 * boundaries, and share the same execution/outcome code
 * (`resolveEntry` + `trackOutcome`). Differences are therefore attributable to
 * signal generation alone.
 *
 * Usage:
 *   npx tsx scripts/real-data/run-replay.ts --out=<runDir> --cache=<dir> [--tf=..] [--symbols=..]
 */

import { appendFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Settings } from '../../src/core/settings';
import type { Candle, Timeframe } from '../../src/core/types';
import { replaySeries, type ReplayTrade } from '../../src/replay/runner';
import { HTF_MAP } from '../../src/strategy/v2/htf';
import { SYMBOLS, TIMEFRAMES } from './ingest';
import { hasSeries, loadSeries } from './load';
import {
  emptyDiagnostics, replayV2Windowed, type V2RunDiagnostics, type V2Trade,
} from './windowed-replay';
import type { SplitBoundary } from './freeze-protocol';

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

export type Slice = 'train' | 'validation' | 'test';

/** Which candles belong to a slice, as an inclusive openTime window. */
export function windowFor(s: Slice, b: SplitBoundary): { from: number; to: number } {
  if (s === 'train') return { from: b.trainFromMs, to: b.trainToMs };
  if (s === 'validation') return { from: b.validFromMs, to: b.validToMs };
  return { from: b.testFromMs, to: b.testToMs };
}

/**
 * V1 score internals for the 25/25=100 hypothesis (Step 21).
 * `totalWeight` is V1's availableWeight: the summed weight of factors that
 * actually contributed. A tiny availableWeight with a high normalised score is
 * exactly the pathology under test.
 */
function v1ScoreParts(t: ReplayTrade): {
  rawScore: number | null; availableWeight: number | null; normalized: number | null;
} {
  const b = t.breakdown as {
    rawScore?: number; totalWeight?: number; score?: number;
  } | null;
  if (!b || typeof b !== 'object') {
    return { rawScore: null, availableWeight: null, normalized: null };
  }
  return {
    rawScore: typeof b.rawScore === 'number' ? b.rawScore : null,
    availableWeight: typeof b.totalWeight === 'number' ? b.totalWeight : null,
    normalized: typeof b.score === 'number' ? b.score : null,
  };
}

function main(): void {
  const outDir = arg('out');
  const cacheDir = arg('cache');
  const only = arg('tf', '');
  const onlySym = arg('symbols', '');
  mkdirSync(outDir, { recursive: true });

  const settings = Settings.fromDefaults();
  const splitsDoc = JSON.parse(
    readFileSync(join(outDir, 'splits.json'), 'utf8'),
  ) as { splits: SplitBoundary[] };
  const splitBy = new Map(
    splitsDoc.splits.map((s) => [`${s.symbol}|${s.timeframe}`, s]),
  );

  const timeframes = (only ? only.split(',') : [...TIMEFRAMES]) as Timeframe[];
  const symbols = onlySym ? onlySym.split(',') : [...SYMBOLS];

  // Streamed trade files (JSONL): never hold all trades in memory at once.
  const v1Path = join(outDir, 'v1-trades.jsonl');
  const v2Path = join(outDir, 'v2-trades.jsonl');
  writeFileSync(v1Path, '');
  writeFileSync(v2Path, '');

  const diagnostics: Record<string, V2RunDiagnostics> = {
    train: emptyDiagnostics(), validation: emptyDiagnostics(), test: emptyDiagnostics(),
  };
  const evaluated: Record<string, { v1: number; v2: number }> = {
    train: { v1: 0, v2: 0 }, validation: { v1: 0, v2: 0 }, test: { v1: 0, v2: 0 },
  };

  const t00 = Date.now();

  for (const symbol of symbols) {
    for (const tf of timeframes) {
      if (!hasSeries(cacheDir, symbol, tf)) { console.log(`skip ${symbol} ${tf}`); continue; }
      const b = splitBy.get(`${symbol}|${tf}`);
      if (!b) throw new Error(`no split boundary for ${symbol} ${tf}`);

      const t0 = Date.now();
      const candles = loadSeries(cacheDir, symbol, tf);

      // HTF series from the SAME real dataset.
      const htf: Partial<Record<Timeframe, readonly Candle[]>> = {};
      for (const h of HTF_MAP[tf] ?? []) {
        if (hasSeries(cacheDir, symbol, h)) htf[h] = loadSeries(cacheDir, symbol, h);
      }

      const counts: Record<string, { v1: number; v2: number }> = {};

      for (const slice of ['train', 'validation', 'test'] as Slice[]) {
        const w = windowFor(slice, b);

        const v1 = replaySeries({
          symbol, timeframe: tf, candles, settings, from: w.from, to: w.to,
        });
        evaluated[slice]!.v1 += v1.evaluations;
        for (const t of v1.trades) {
          const p = v1ScoreParts(t);
          appendFileSync(v1Path, JSON.stringify({
            slice, symbol, timeframe: tf,
            direction: t.direction, score: t.score,
            setupCandleTime: t.setupCandleTime, entryCandleTime: t.entryCandleTime,
            entryPrice: t.entryPrice, stopLoss: t.stopLoss, takeProfits: t.takeProfits,
            result: t.result, exitPrice: t.exitPrice, exitCandleTime: t.exitCandleTime,
            barsHeld: t.barsHeld, rMultiple: t.rMultiple, pnlPct: t.pnlPct,
            v1RawScore: p.rawScore, v1AvailableWeight: p.availableWeight,
            v1NormalizedScore: p.normalized,
          }) + '\n');
        }

        const diag = diagnostics[slice]!;
        const v2 = replayV2Windowed({
          symbol, timeframe: tf, candles, settings, htfCandles: htf,
          from: w.from, to: w.to, diagnostics: diag,
        });
        evaluated[slice]!.v2 += v2.evaluations;
        for (const t of v2.trades) {
          appendFileSync(v2Path, JSON.stringify({ slice, ...serializeV2(t) }) + '\n');
        }

        counts[slice] = { v1: v1.trades.length, v2: v2.trades.length };
      }

      console.log(
        `${symbol.padEnd(8)} ${String(tf).padEnd(4)} ` +
        `candles=${String(candles.length).padStart(9)} ` +
        `V1 tr=${counts['train']!.v1}/${counts['validation']!.v1}/${counts['test']!.v1} ` +
        `V2 tr=${counts['train']!.v2}/${counts['validation']!.v2}/${counts['test']!.v2} ` +
        `${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
    }
  }

  writeFileSync(join(outDir, 'v2-run-diagnostics.json'), JSON.stringify({
    evaluatedCandles: evaluated,
    perSlice: diagnostics,
  }, null, 2));

  console.log('');
  console.log(`total ${((Date.now() - t00) / 60000).toFixed(1)} min`);
  console.log('wrote', v1Path);
  console.log('wrote', v2Path);

  const totalViolations = Object.values(diagnostics)
    .reduce((a, d) => a + d.violations.length, 0);
  console.log(`liquidity invariant violations: ${totalViolations}`);
}

function serializeV2(t: V2Trade): Record<string, unknown> {
  return {
    symbol: t.symbol, timeframe: t.timeframe, direction: t.direction,
    setupCandleTime: t.setupCandleTime, entryCandleTime: t.entryCandleTime,
    entryPrice: t.entryPrice, stopLoss: t.stopLoss, takeProfits: t.takeProfits,
    result: t.result, exitPrice: t.exitPrice, exitCandleTime: t.exitCandleTime,
    barsHeld: t.barsHeld, rMultiple: t.rMultiple, pnlPct: t.pnlPct,
    setupKind: t.setupKind, location: t.location, htfAlignment: t.htfAlignment,
    evidence: t.evidence, conflict: t.conflict, netEvidence: t.netEvidence,
    adxRegime: t.adxRegime, rsiBucket: t.rsiBucket, emaAlignment: t.emaAlignment,
    macdState: t.macdState, rvolBucket: t.rvolBucket, fibZone: t.fibZone,
    hasOb: t.hasOb, hasFvg: t.hasFvg,
    sweepQuality: t.sweepQuality, breakoutQuality: t.breakoutQuality,
    roomR: t.roomR, atrAtSetup: t.atrAtSetup,
    riskDistance: t.riskDistance, riskAtr: t.riskAtr,
    stopAnchor: t.stopAnchor,
    tp1R: t.tp1R, tp2R: t.tp2R, tp3R: t.tp3R,
    tp1Source: t.tp1Source,
    firstTargetR: t.firstTargetR, nextStructuralR: t.nextStructuralR,
    finalTargetR: t.finalTargetR, rangeBrokenSide: t.rangeBrokenSide,
  };
}

main();

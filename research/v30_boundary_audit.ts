/**
 * V3.0 — SLICE BOUNDARY AUDIT (diagnostic, not a criterion).
 *
 * WHY THIS EXISTS.
 *
 * The frozen candidate detects setups only on bars inside the slice window, but
 * it manages a position over up to `TIMEOUT_BARS = 50` bars after the fill. A
 * trade that fills near the end of the window is therefore resolved using bars
 * that lie BEYOND it — for the VALIDATION slice that means the first days of the
 * TEST window; for the TRAIN slice it means the first days of VALIDATION.
 *
 * This behaviour is inherited, not introduced for this task: the V3.0 TRAIN
 * driver does exactly the same (its last fills resolve against VALIDATION bars),
 * and earlier V2.x trainers (`v28_gross_only.ts` and friends) managed positions
 * forward past their slice boundary as well. The V3.0 validation pre-registration
 * did not anticipate it; it was found while writing the report, i.e. AFTER the
 * single registered run, which is the only order in which it can honestly be
 * discovered.
 *
 * WHAT THIS TOOL DOES — and what it may not do.
 *
 *   1. Re-runs each slice with the TRACE HOOK of the same `runSlice()` used by
 *      the registered run, and ABORTS unless the aggregates reproduce the
 *      committed artifact EXACTLY. It cannot invent new headline numbers: if it
 *      disagrees with the registered run it fails outright.
 *   2. Counts the trades whose OUTCOME was decided on a bar beyond the slice
 *      boundary; reports their count, share of trades, share of gross R, exits.
 *   3. Recomputes the headline EXCLUDING those trades, and a worst-case bound in
 *      which each of them is instead charged as a full −1 R stop plus the
 *      population-average round-trip fee.
 *
 * The registered result stands as reported. This tool bounds the size of the
 * caveat; it does not replace the run and it cannot improve the number.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { TIMEOUT_BARS } from './v30_htf_trap';
import { hasSeries, loadSeries } from '../scripts/real-data/load';
import {
  fidelityDiff, lastIndexAtOrBefore, runSlice,
  type Slice, type SplitRow, type TradeTrace,
} from './v30_validate';

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

interface ArtifactShape {
  n: number;
  grossRPerTrade: number;
  netRPerTrade: { FUT_4: number; SPOT: number };
}

export interface SliceAudit {
  slice: Slice;
  reproducedArtifact: string;
  exactReproduction: boolean;
  windowEndUtcBySymbol: Record<string, string>;
  windowEndIndexBySymbol: Record<string, number>;
  /** fills whose management window would extend past the slice boundary */
  fillsWithPostBoundaryBars: number;
  affected: {
    count: number;
    shareOfTradesPct: number;
    grossR: number;
    feeFut4R: number;
    shareOfGrossRPct: number;
    exits: Record<string, number>;
    detail: TradeTrace[];
  };
  gross: { registered: number; excludingAffected: number };
  netFut4: {
    registered: number;
    excludingAffected: number;
    worstCaseAllAffectedAtMinus1: number;
  };
}

const r4 = (x: number): number => +x.toFixed(4);

function main(): void {
  const cache = arg('cache');
  const out = arg('out');
  const splitsDoc = JSON.parse(readFileSync(arg('splits'), 'utf8')) as { splits: SplitRow[] };
  const rows = splitsDoc.splits.filter((s) => s.timeframe === '1h' && hasSeries(cache, s.symbol, '1h'));

  const result: Record<string, SliceAudit> = {};

  for (const slice of ['valid', 'train'] as Slice[]) {
    const artifactPath = arg(`artifact-${slice}`);
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as ArtifactShape;

    const traces: TradeTrace[] = [];
    const metrics = runSlice({
      cache, splits: splitsDoc.splits, slice, onTrade: (t) => traces.push(t),
    });

    // The artifact carries two reporting-only fields the run itself does not
    // emit (`harnessFidelity`, `testGuard`); strip them so the comparison is
    // between the metrics and the metrics.
    const artifactMetrics: Record<string, unknown> = { ...(artifact as Record<string, unknown>) };
    delete artifactMetrics['harnessFidelity'];
    delete artifactMetrics['testGuard'];

    const diffs = fidelityDiff(metrics, artifactMetrics);
    if (diffs.length > 0) {
      console.error(`ABORT — ${slice}: the traced run does not reproduce ${artifactPath}`);
      for (const d of diffs.slice(0, 20)) console.error(`  ${d}`);
      process.exit(1);
    }
    console.error(`  ${slice}: traced run reproduces ${artifactPath} EXACTLY`);

    // Last bar inside the window, per symbol, in the same cached series the
    // driver walks. This is the boundary an exit must stay within.
    const windowEnd = new Map<string, { index: number; ms: number }>();
    for (const r of rows) {
      const toMs = slice === 'train' ? r.trainToMs : r.validToMs;
      const h1 = loadSeries(cache, r.symbol, '1h');
      windowEnd.set(r.symbol, { index: lastIndexAtOrBefore(h1, toMs), ms: toMs });
    }

    const endIndex = (sym: string): number => windowEnd.get(sym)?.index ?? Number.POSITIVE_INFINITY;
    const affected = traces.filter((t) => t.fillIndex + t.barsHeld - 1 > endIndex(t.symbol));
    const fillsWithPostBoundaryBars = traces.filter(
      (t) => t.fillIndex + TIMEOUT_BARS > endIndex(t.symbol),
    ).length;

    const n = traces.length;
    const nAff = affected.length;
    const sumAll = traces.reduce((s, t) => s + t.grossR, 0);
    const feeAll = traces.reduce((s, t) => s + t.feeFut4, 0);
    const sumAff = affected.reduce((s, t) => s + t.grossR, 0);
    const feeAff = affected.reduce((s, t) => s + t.feeFut4, 0);
    const avgFee = feeAll / n;

    const exits: Record<string, number> = {};
    for (const t of affected) exits[t.exit] = (exits[t.exit] ?? 0) + 1;

    const grossEx = (sumAll - sumAff) / (n - nAff);
    const netEx = (sumAll - sumAff - (feeAll - feeAff)) / (n - nAff);
    const netWorst = (sumAll - sumAff - nAff - (feeAll - feeAff) - nAff * avgFee) / (n - nAff);

    const windowEndUtcBySymbol: Record<string, string> = {};
    const windowEndIndexBySymbol: Record<string, number> = {};
    for (const [sym, v] of windowEnd) {
      windowEndUtcBySymbol[sym] = new Date(v.ms).toISOString();
      windowEndIndexBySymbol[sym] = v.index;
    }

    result[slice] = {
      slice,
      reproducedArtifact: artifactPath,
      exactReproduction: true,
      windowEndUtcBySymbol,
      windowEndIndexBySymbol,
      fillsWithPostBoundaryBars,
      affected: {
        count: nAff,
        shareOfTradesPct: r4((nAff / n) * 100),
        grossR: r4(sumAff),
        feeFut4R: r4(feeAff),
        shareOfGrossRPct: r4((sumAff / sumAll) * 100),
        exits,
        detail: affected,
      },
      gross: { registered: artifact.grossRPerTrade, excludingAffected: r4(grossEx) },
      netFut4: {
        registered: artifact.netRPerTrade.FUT_4,
        excludingAffected: r4(netEx),
        worstCaseAllAffectedAtMinus1: r4(netWorst),
      },
    };

    const a = result[slice]!;
    console.error(`  ${slice}: n=${n} fills touching the boundary=${fillsWithPostBoundaryBars}`
      + ` outcomes decided beyond it=${nAff} (${a.affected.shareOfTradesPct}% of trades,`
      + ` ${a.affected.shareOfGrossRPct}% of gross R)`);
  }

  writeFileSync(out, JSON.stringify({
    note: 'Diagnostic slice-boundary audit. Bounds a caveat; does not replace the registered run.',
    timeoutBars: TIMEOUT_BARS,
    slices: result,
  }, null, 2));
  console.log('');
  console.log('net @2/5 bps — registered | excluding affected | worst case:');
  for (const s of ['valid', 'train']) {
    const a = result[s]!;
    console.log(`  ${s.padEnd(5)} ${a.netFut4.registered} | ${a.netFut4.excludingAffected}`
      + ` | ${a.netFut4.worstCaseAllAffectedAtMinus1}`);
  }
  console.log('wrote', out);
}

main();

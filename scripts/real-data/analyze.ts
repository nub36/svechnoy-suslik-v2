/**
 * ANALYSIS — turns the streamed trade files into the report set (Steps 12-21).
 *
 * Reads v1-trades.jsonl / v2-trades.jsonl and emits:
 *   metrics.json               core metrics per split per engine
 *   breakdowns.json            V2 slices (symbol/tf/direction/kind/HTF/evidence)
 *   target-diagnostics.json    TP1/final-R/risk-ATR distributions + outlier lists
 *   wait-diagnostics.json      WAIT decomposition
 *   liquidity-diagnostics.json lifecycle census + invariant result
 *   v1-score-diagnostics.json  the 25/25=100 hypothesis
 *   timeout-sensitivity.json   TIMEOUT dependence
 *   outlier-sensitivity.json   dependence on a few extreme winners
 *
 * Records TEST_FIRST_VIEW_AT into run-metadata.json the first time TEST metrics
 * are computed, and refuses to run unless the pre-registration artifacts exist.
 */

import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { ReplayTrade } from '../../src/replay/runner';
import {
  EVIDENCE_BUCKETS, bucketOf, computeCore, distribution, groupBy, groupStats,
  outlierSensitivity, r4, spearman, median, type GroupStats,
} from './metrics';

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

interface V1Row extends ReplayTrade {
  slice: string;
  v1RawScore: number | null;
  v1AvailableWeight: number | null;
  v1NormalizedScore: number | null;
}
interface V2Row extends ReplayTrade {
  slice: string;
  setupKind: string | null;
  location: string;
  htfAlignment: string;
  evidence: number;
  netEvidence: number;
  riskAtr: number | null;
  atrAtSetup: number | null;
  riskDistance: number;
  tp1R: number | null;
  finalTargetR: number;
  firstTargetR: number;
  stopAnchor: string | null;
  rangeBrokenSide: string | null;
  tp1Source: string | null;
}

/**
 * Stream a JSONL file.
 *
 * `readFileSync(...,'utf8')` cannot be used here: the V1 trade file is ~370 MB,
 * well past Node's ~512 MB max string length (ERR_STRING_TOO_LONG), and
 * materialising it as one string would also double peak memory for no reason.
 */
async function readJsonl<T>(p: string): Promise<T[]> {
  if (!existsSync(p)) return [];
  const out: T[] = [];
  const rl = createInterface({
    input: createReadStream(p, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    out.push(JSON.parse(line) as T);
  }
  return out;
}

const SLICES = ['train', 'validation', 'test'] as const;

function breakdownSet(
  rows: readonly V2Row[], key: (t: V2Row) => string,
): GroupStats[] {
  return [...groupBy(rows, key)]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => groupStats(k, v));
}

async function main(): Promise<void> {
  const outDir = arg('out');

  // Step 12 gate: refuse to compute TEST without the pre-registration in place.
  for (const f of ['dataset-manifest.json', 'zip-checksums.json', 'settings.json',
    'settings.sha256', 'splits.json', 'run-metadata.json']) {
    if (!existsSync(join(outDir, f))) {
      throw new Error(`pre-registration artifact missing: ${f} — refusing to compute TEST`);
    }
  }
  if (!existsSync('docs/V2_REAL_REPLAY_PROTOCOL.md')) {
    throw new Error('protocol document missing — refusing to compute TEST');
  }

  const v1 = await readJsonl<V1Row>(join(outDir, 'v1-trades.jsonl'));
  const v2 = await readJsonl<V2Row>(join(outDir, 'v2-trades.jsonl'));
  const diag = JSON.parse(
    readFileSync(join(outDir, 'v2-run-diagnostics.json'), 'utf8'),
  ) as {
    evaluatedCandles: Record<string, { v1: number; v2: number }>;
    perSlice: Record<string, {
      evaluations: number; longDecisions: number; shortDecisions: number;
      waits: number; waitByCategory: Record<string, number>;
      htfCoverage: Record<string, number>;
      liquidity: Record<string, number>;
      targetsFromRestingLiquidity: number; targetsTotal: number;
      violations: unknown[];
    }>;
  };

  /* ---------------- TEST_FIRST_VIEW_AT (Step 22) ---------------- */
  const metaPath = join(outDir, 'run-metadata.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
  const firstView = (meta['testFirstViewAt'] as string | null) ?? null;
  const testFirstViewAt = firstView ?? new Date().toISOString();
  if (!firstView) {
    meta['testFirstViewAt'] = testFirstViewAt;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  /* ---------------- core metrics ---------------- */
  const metrics: Record<string, unknown> = { testFirstViewAt };
  for (const s of SLICES) {
    metrics[s] = {
      v1: computeCore(v1.filter((t) => t.slice === s), diag.evaluatedCandles[s]?.v1 ?? 0),
      v2: computeCore(v2.filter((t) => t.slice === s), diag.evaluatedCandles[s]?.v2 ?? 0),
    };
  }
  writeFileSync(join(outDir, 'metrics.json'), JSON.stringify(metrics, null, 2));

  /* ---------------- V2 breakdowns ---------------- */
  const breakdowns: Record<string, unknown> = {};
  for (const s of SLICES) {
    const rows = v2.filter((t) => t.slice === s);
    breakdowns[s] = {
      bySymbol: breakdownSet(rows, (t) => t.symbol),
      byTimeframe: breakdownSet(rows, (t) => t.timeframe),
      byDirection: breakdownSet(rows, (t) => t.direction),
      bySetupKind: breakdownSet(rows, (t) => t.setupKind ?? 'NA'),
      byHtfAlignment: breakdownSet(rows, (t) => t.htfAlignment),
      byLocation: breakdownSet(rows, (t) => t.location),
      byEvidenceBucket: EVIDENCE_BUCKETS.map(([label]) =>
        groupStats(label, rows.filter((t) => bucketOf(t.evidence) === label))),
      bySymbolTimeframe: breakdownSet(rows, (t) => `${t.symbol} ${t.timeframe}`),
    };
  }
  writeFileSync(join(outDir, 'breakdowns.json'), JSON.stringify(breakdowns, null, 2));

  /* ---------------- evidence association (Step 16) ---------------- */
  const assoc: Record<string, unknown> = {};
  for (const s of SLICES) {
    const closed = v2.filter((t) => t.slice === s && t.result !== 'OPEN');
    assoc[s] = {
      note: 'Evidence is NOT a probability. Association only; no calibration performed.',
      buckets: EVIDENCE_BUCKETS.map(([label]) => {
        const g = closed.filter((t) => bucketOf(t.evidence) === label);
        const st = groupStats(label, g);
        return {
          bucket: label, n: st.n, avgR: st.avgR, medianR: st.medianR,
          positiveRRate: st.positiveRRate, tpExitRate: st.tpExitRate,
          timeoutRate: st.timeoutRate,
        };
      }),
      spearmanEvidenceVsR: spearman(
        closed.map((t) => t.evidence), closed.map((t) => t.rMultiple),
      ),
      n: closed.length,
    };
  }
  writeFileSync(join(outDir, 'evidence-association.json'), JSON.stringify(assoc, null, 2));

  /* ---------------- target / risk diagnostics (Step 17) ---------------- */
  const targetDiag: Record<string, unknown> = {};
  for (const s of SLICES) {
    const rows = v2.filter((t) => t.slice === s);
    const finals = rows.map((t) => t.finalTargetR).filter((x) => Number.isFinite(x));
    const over = (x: number): { n: number; pct: number } => {
      const c = finals.filter((v) => v > x).length;
      return { n: c, pct: finals.length > 0 ? r4((c / finals.length) * 100) : 0 };
    };
    const closed = rows.filter((t) => t.result !== 'OPEN');
    // Timeout rate by final-target-R bucket: does an unreachable target cause
    // time exits?
    const tgtBuckets: [string, number, number][] = [
      ['<2R', 0, 2], ['2-5R', 2, 5], ['5-10R', 5, 10],
      ['10-20R', 10, 20], ['>20R', 20, Infinity],
    ];
    targetDiag[s] = {
      tp1R: distribution(rows.map((t) => t.tp1R ?? NaN)),
      finalTargetR: distribution(finals),
      riskDistanceAtr: distribution(rows.map((t) => t.riskAtr ?? NaN)),
      firstTargetR: distribution(rows.map((t) => t.firstTargetR)),
      finalTargetOver: { over5R: over(5), over10R: over(10), over20R: over(20) },
      timeoutRateByFinalTargetBucket: tgtBuckets.map(([label, lo, hi]) => {
        const g = closed.filter((t) => t.finalTargetR >= lo && t.finalTargetR < hi);
        const st = groupStats(label, g);
        return { bucket: label, n: st.n, timeoutRate: st.timeoutRate, avgR: st.avgR };
      }),
      tp1SourceCounts: Object.fromEntries(
        [...groupBy(rows, (t) => t.tp1Source ?? 'NA')].map(([k, v]) => [k, v.length])),
      stopAnchorCounts: Object.fromEntries(
        [...groupBy(rows, (t) => t.stopAnchor ?? 'NA')].map(([k, v]) => [k, v.length])),
    };
  }
  // Explicit trade lists the task asks to SEE but NOT auto-fix.
  const flag = (t: V2Row): Record<string, unknown> => ({
    slice: t.slice, symbol: t.symbol, timeframe: t.timeframe,
    entryUtc: new Date(t.entryCandleTime).toISOString(),
    direction: t.direction, result: t.result, rMultiple: r4(t.rMultiple),
    finalTargetR: r4(t.finalTargetR), tp1R: t.tp1R === null ? null : r4(t.tp1R),
    riskAtr: t.riskAtr === null ? null : r4(t.riskAtr),
    evidence: r4(t.evidence), stopAnchor: t.stopAnchor,
  });
  const over10 = v2.filter((t) => t.finalTargetR > 10).map(flag);
  const tightRisk = v2.filter((t) => t.riskAtr !== null && t.riskAtr < 0.5).map(flag);
  writeFileSync(join(outDir, 'target-diagnostics.json'), JSON.stringify({
    perSlice: targetDiag,
    note: 'Listed for inspection only. NOT auto-corrected in this experiment.',
    finalTargetOver10R: { count: over10.length, trades: over10.slice(0, 500) },
    riskDistanceUnder0_5Atr: { count: tightRisk.length, trades: tightRisk.slice(0, 500) },
  }, null, 2));

  /* ---------------- WAIT diagnostics (Step 18) ---------------- */
  const wait: Record<string, unknown> = {};
  for (const s of SLICES) {
    const d = diag.perSlice[s]!;
    wait[s] = {
      evaluations: d.evaluations,
      longDecisions: d.longDecisions,
      shortDecisions: d.shortDecisions,
      waits: d.waits,
      waitRate: d.evaluations > 0 ? r4((d.waits / d.evaluations) * 100) : 0,
      byDecisiveReason: d.waitByCategory,
      note: 'Diagnostic only. No threshold was changed.',
    };
  }
  writeFileSync(join(outDir, 'wait-diagnostics.json'), JSON.stringify(wait, null, 2));

  /* ---------------- liquidity lifecycle (Step 11/15) ---------------- */
  const liq: Record<string, unknown> = {};
  let violations = 0;
  for (const s of SLICES) {
    const d = diag.perSlice[s]!;
    violations += d.violations.length;
    liq[s] = {
      poolStateCensus: d.liquidity,
      targetsTotal: d.targetsTotal,
      targetsFromRestingLiquidity: d.targetsFromRestingLiquidity,
      invariantViolations: d.violations.length,
      violationSamples: d.violations.slice(0, 20),
    };
  }
  writeFileSync(join(outDir, 'liquidity-diagnostics.json'), JSON.stringify({
    invariant: 'A SWEPT or CONSUMED pool must never be used as a future target.',
    totalViolations: violations,
    verdict: violations === 0 ? 'INVARIANT_HELD' : 'INVARIANT_VIOLATED',
    perSlice: liq,
  }, null, 2));

  /* ---------------- HTF coverage (Step 9) ---------------- */
  writeFileSync(join(outDir, 'htf-coverage.json'), JSON.stringify(
    Object.fromEntries(SLICES.map((s) => [s, diag.perSlice[s]!.htfCoverage])), null, 2));

  /* ---------------- TIMEOUT sensitivity (Step 19) ---------------- */
  const tos: Record<string, unknown> = {};
  for (const s of SLICES) {
    for (const [name, rows] of [['v1', v1], ['v2', v2]] as const) {
      const closed = rows.filter((t) => t.slice === s && t.result !== 'OPEN');
      const to = closed.filter((t) => t.result === 'TIMEOUT');
      const exTo = closed.filter((t) => t.result !== 'TIMEOUT');
      const expAll = closed.length > 0
        ? closed.reduce((a, t) => a + t.rMultiple, 0) / closed.length : 0;
      const expEx = exTo.length > 0
        ? exTo.reduce((a, t) => a + t.rMultiple, 0) / exTo.length : 0;
      tos[`${s}.${name}`] = {
        timeoutCount: to.length,
        timeoutPositive: to.filter((t) => t.rMultiple > 0).length,
        timeoutNegative: to.filter((t) => t.rMultiple < 0).length,
        timeoutAvgR: to.length > 0
          ? r4(to.reduce((a, t) => a + t.rMultiple, 0) / to.length) : 0,
        timeoutMedianR: r4(median(to.map((t) => t.rMultiple))),
        timeoutTotalR: r4(to.reduce((a, t) => a + t.rMultiple, 0)),
        expectancyAllClosed: r4(expAll),
        expectancyExcludingTimeout: r4(expEx),
        signFlips: (expAll > 0) !== (expEx > 0),
        note: 'expectancyExcludingTimeout is DIAGNOSTIC SENSITIVITY ONLY.',
      };
    }
  }
  writeFileSync(join(outDir, 'timeout-sensitivity.json'), JSON.stringify(tos, null, 2));

  /* ---------------- outlier sensitivity (Step 20) ---------------- */
  const outl: Record<string, unknown> = {};
  for (const s of SLICES) {
    outl[s] = {
      v1: outlierSensitivity(v1.filter((t) => t.slice === s)),
      v2: outlierSensitivity(v2.filter((t) => t.slice === s)),
    };
  }
  writeFileSync(join(outDir, 'outlier-sensitivity.json'), JSON.stringify(outl, null, 2));

  /* ---------------- V1 25/25=100 hypothesis (Step 21) ---------------- */
  const wBuckets: [string, number, number][] = [
    ['<30', -Infinity, 30], ['30-50', 30, 50], ['>50', 50, Infinity],
  ];
  const sBuckets: [string, number, number][] = [
    ['<70', -Infinity, 70], ['70-90', 70, 90], ['90-100', 90, Infinity],
  ];
  const v1diag: Record<string, unknown> = {};
  for (const s of SLICES) {
    const rows = v1.filter((t) => t.slice === s && t.v1AvailableWeight !== null);
    const closed = rows.filter((t) => t.result !== 'OPEN');
    const cells: unknown[] = [];
    for (const [wl, wlo, whi] of wBuckets) {
      for (const [sl, slo, shi] of sBuckets) {
        const g = closed.filter((t) =>
          t.v1AvailableWeight! >= wlo && t.v1AvailableWeight! < whi &&
          t.v1NormalizedScore! >= slo && t.v1NormalizedScore! < shi);
        const st = groupStats(`w${wl} s${sl}`, g);
        cells.push({
          availableWeight: wl, scoreBucket: sl, n: st.n,
          avgR: st.avgR, medianR: st.medianR,
          positiveRRate: st.positiveRRate, tpExitRate: st.tpExitRate,
          profitFactor: st.profitFactor,
        });
      }
    }
    v1diag[s] = {
      n: closed.length,
      availableWeightDistribution: distribution(closed.map((t) => t.v1AvailableWeight!)),
      normalizedScoreDistribution: distribution(closed.map((t) => t.v1NormalizedScore!)),
      byWeightBucket: wBuckets.map(([l, lo, hi]) =>
        groupStats(l, closed.filter((t) =>
          t.v1AvailableWeight! >= lo && t.v1AvailableWeight! < hi))),
      byScoreBucket: sBuckets.map(([l, lo, hi]) =>
        groupStats(l, closed.filter((t) =>
          t.v1NormalizedScore! >= lo && t.v1NormalizedScore! < hi))),
      crossTab: cells,
      spearmanNormalizedScoreVsR: spearman(
        closed.map((t) => t.v1NormalizedScore!), closed.map((t) => t.rMultiple)),
      spearmanAvailableWeightVsR: spearman(
        closed.map((t) => t.v1AvailableWeight!), closed.map((t) => t.rMultiple)),
      note: 'Diagnostic only. V1 was NOT modified.',
    };
  }
  writeFileSync(join(outDir, 'v1-score-diagnostics.json'), JSON.stringify(v1diag, null, 2));

  /* ---------------- console summary ---------------- */
  console.log('TEST_FIRST_VIEW_AT:', testFirstViewAt, firstView ? '(pre-existing)' : '(recorded now)');
  console.log('');
  for (const s of SLICES) {
    const m = metrics[s] as { v1: ReturnType<typeof computeCore>; v2: ReturnType<typeof computeCore> };
    console.log(`=== ${s.toUpperCase()} ===`);
    for (const [name, x] of [['V1', m.v1], ['V2', m.v2]] as const) {
      console.log(
        `  ${name}  closed=${String(x.closed).padStart(6)} open=${String(x.open).padStart(4)} ` +
        `TP=${String(x.tp).padStart(5)} SL=${String(x.sl).padStart(6)} TO=${String(x.timeout).padStart(6)} ` +
        `tpExit=${String(x.tpExitRate).padStart(6)}% posR=${String(x.positiveRRate).padStart(6)}% ` +
        `exp=${String(x.expectancy).padStart(8)}R totR=${String(x.totalR).padStart(10)} ` +
        `PF=${String(x.profitFactor).padStart(6)} maxDD=${String(x.maxDrawdownR).padStart(10)}`,
      );
    }
  }
  console.log('');
  console.log('liquidity invariant:', violations === 0 ? 'HELD' : `VIOLATED (${violations})`);
}

void main();

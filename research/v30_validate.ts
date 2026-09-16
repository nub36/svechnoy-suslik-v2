/**
 * V3.0 — HTF LIQUIDATION TRAP — VALIDATION driver.
 *
 * Implements docs/V3_0_VALIDATION_PREREGISTRATION.md (committed at `6d735df`,
 * BEFORE this file existed and before any VALIDATION number was computed).
 *
 * WHAT THIS FILE IS ALLOWED TO CHANGE, AND WHAT IT IS NOT.
 *
 * The candidate is `research/v30_htf_trap.ts` at commit `5674e65`,
 * sha256 a821757ff0319a100a8a9087da1bdd137abb1df0785493d644ad4d87f05dc4cd.
 * That file is NOT edited here: this driver imports its exported primitives —
 * `confirmedLevels`, `detectTrap`, `manageTrade`, `legFeeR` and every
 * preregistered constant — and reimplements nothing but the WINDOW.
 *
 * That claim is not taken on trust. The driver can be run with `--slice=train`,
 * in which case it must reproduce `artifacts/research/v30/v30-train-metrics.json`
 * EXACTLY (`--fidelity=<path>`). The pre-registration makes an exact TRAIN
 * reproduction a PRECONDITION of reading the VALIDATION window: a mismatch
 * aborts the run instead of being explained away.
 *
 * Causality and safety inherited from the candidate:
 *   - 4H pivots usable only from `confirmedIndex = index + strength`;
 *   - 4H context bounded by `closedHtfCandles(..., closeTime)`;
 *   - corridor fills only from bar N+1, never on the reclaim bar;
 *   - same-bar ambiguity always resolved against the trade;
 *   - a hard guard aborts if any in-scope series' VALIDATION window reaches its
 *     TEST boundary, so TEST cannot be read by this driver.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { Settings } from '../src/core/settings';
import { buildAtrContext, buildVolumeContext } from '../src/strategy/v2/indicators';
import { loadSeries, hasSeries } from '../scripts/real-data/load';
import { quantileSorted } from '../scripts/real-data/audit-fee-readonly';
import {
  CORRIDOR_ATR_FRAC, CORRIDOR_EXPIRY_BARS, MAKER_BPS, MIN_BODY_RATIO, MIN_RVOL,
  STOP_BUFFER_ATR, TAKER_BPS, TIMEOUT_BARS, confirmedLevels, detectTrap,
  manageTrade, type Direction,
} from './v30_htf_trap';
import type { Timeframe } from '../src/core/types';

const EXEC_TF: Timeframe = '1h';
const STRUCT_TF: Timeframe = '4h';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];

export type Slice = 'train' | 'valid';

export interface SplitRow {
  symbol: string;
  timeframe: string;
  trainFromMs: number;
  trainToMs: number;
  validFromMs: number;
  validToMs: number;
  testFromMs: number;
  testToMs: number;
}

/** The window this driver is permitted to read for a given slice. */
export function sliceWindow(row: SplitRow, slice: Slice): { fromMs: number; toMs: number } {
  return slice === 'train'
    ? { fromMs: row.trainFromMs, toMs: row.trainToMs }
    : { fromMs: row.validFromMs, toMs: row.validToMs };
}

export interface TestGuardReport {
  checked: number;
  /** true when no in-scope series' read window reaches its TEST boundary */
  safe: boolean;
  violations: { symbol: string; validToMs: number; testFromMs: number }[];
}

/**
 * Hard TEST guard (pre-registration §6).
 *
 * The driver may only ever read up to `validToMs`. If any in-scope series has
 * `validToMs >= testFromMs`, the split itself is broken and the run must abort —
 * reading TEST would burn the untouched slice.
 */
export function testGuard(
  rows: readonly SplitRow[], execTf: string, symbols: readonly string[],
): TestGuardReport {
  const inScope = rows.filter(
    (r) => r.timeframe === execTf && symbols.includes(r.symbol),
  );
  const violations = inScope
    .filter((r) => !(r.validToMs < r.testFromMs))
    .map((r) => ({ symbol: r.symbol, validToMs: r.validToMs, testFromMs: r.testFromMs }));
  return { checked: inScope.length, safe: violations.length === 0, violations };
}

/* ---------------- fidelity: does this harness reproduce TRAIN? ---------------- */

type Json = Record<string, unknown>;

/**
 * Deep-compare the driver's output against the frozen TRAIN artifact.
 *
 * Only keys present in `frozen` are inspected — the validation artifact carries
 * extra reporting fields by design. Returns a list of human-readable
 * mismatches; an empty list means an exact reproduction.
 */
export function fidelityDiff(actual: unknown, frozen: unknown, path = '$'): string[] {
  if (frozen !== null && typeof frozen === 'object' && !Array.isArray(frozen)) {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      return [`${path}: expected object, got ${JSON.stringify(actual)}`];
    }
    const out: string[] = [];
    for (const [k, v] of Object.entries(frozen as Json)) {
      if (!(k in (actual as Json))) { out.push(`${path}.${k}: missing`); continue; }
      out.push(...fidelityDiff((actual as Json)[k], v, `${path}.${k}`));
    }
    return out;
  }
  if (Array.isArray(frozen)) {
    if (!Array.isArray(actual) || actual.length !== frozen.length) {
      return [`${path}: array length ${Array.isArray(actual) ? actual.length : 'n/a'} vs ${frozen.length}`];
    }
    return frozen.flatMap((v, i) => fidelityDiff(actual[i], v, `${path}[${i}]`));
  }
  if (!Object.is(actual, frozen)) {
    return [`${path}: ${JSON.stringify(actual)} vs frozen ${JSON.stringify(frozen)}`];
  }
  return [];
}

/* ---------------- accumulation (identical to the candidate's TRAIN driver) ---------------- */

interface Sub { n: number; sum: number }
interface Acc {
  n: number; sumG: number;
  sumFee: Record<string, number>;
  nTp1: number; nTp2: number; nPos: number;
  pos: number; neg: number;
  wins: number[]; losses: number[]; gs: number[]; seq: number[];
  stopPct: number[]; bars: number[];
  exits: Record<string, number>;
  byDir: Map<string, Sub>; bySym: Map<string, Sub>;
}
const mk = (): Acc => ({
  n: 0, sumG: 0, sumFee: { GROSS: 0, FUT_4: 0, SPOT: 0 },
  nTp1: 0, nTp2: 0, nPos: 0, pos: 0, neg: 0,
  wins: [], losses: [], gs: [], seq: [], stopPct: [], bars: [], exits: {},
  byDir: new Map(), bySym: new Map(),
});
const bump = (m: Map<string, Sub>, k: string, r: number): void => {
  const e = m.get(k) ?? { n: 0, sum: 0 }; e.n++; e.sum += r; m.set(k, e);
};
const med = (x: number[]): number =>
  x.length ? quantileSorted(x.slice().sort((a, b) => a - b), .5) : NaN;
const qq = (x: number[], f: number): number =>
  x.length ? quantileSorted(x.slice().sort((a, b) => a - b), f) : NaN;
const maxDD = (s: number[]): number => {
  let peak = 0, eq = 0, dd = 0;
  for (const r of s) { eq += r; if (eq > peak) peak = eq; if (eq - peak < dd) dd = eq - peak; }
  return dd;
};
const sub = (m: Map<string, Sub>): Record<string, unknown> =>
  Object.fromEntries([...m].map(([k, v]) =>
    [k, { n: v.n, grossExpectancy: +(v.sum / v.n).toFixed(4) }]));

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

/* ---------------- the windowed run ---------------- */

/**
 * Per-trade trace, produced only when `onTrade` is supplied.
 *
 * `fillIndex` is the index of the 1H bar on which the corridor filled, and the
 * exit bar is `fillIndex + barsHeld - 1`, because `manageTrade` counts the entry
 * bar as bar 1 and returns `barsHeld = exitIndex + 1` relative to the bar slice
 * that starts at the fill. That is enough to tell whether a trade's OUTCOME was
 * decided on a bar beyond the slice boundary, which is what the boundary audit
 * measures. Supplying no hook changes nothing.
 */
export interface TradeTrace {
  symbol: string;
  direction: Direction;
  fillIndex: number;
  fillTime: number;
  exit: string;
  barsHeld: number;
  grossR: number;
  feeFut4: number;
  fillingInLastBars: boolean;
}

export interface RunOptions {
  cache: string;
  splits: SplitRow[];
  slice: Slice;
  onTrade?: (t: TradeTrace) => void;
}

/** Index of the last candle with `openTime <= ms`, or -1. Binary search. */
export function lastIndexAtOrBefore(
  candles: readonly { openTime: number }[], ms: number,
): number {
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.openTime <= ms) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

/** Run the frozen candidate over exactly one slice of the frozen splits. */
export function runSlice(opts: RunOptions): Json {
  const { cache, slice } = opts;
  const splits = opts.splits
    .filter((s) => s.timeframe === EXEC_TF)
    .filter((s) => SYMBOLS.includes(s.symbol));

  const settings = Settings.fromDefaults();
  const strength = Math.floor(settings.num('engine.swing_lookback'));
  const atrPeriod = Math.floor(settings.num('risk.atr_period'));
  const volPeriod = Math.floor(settings.num('v2.volume_period'));

  const a = mk();
  let signals = 0, pending = 0, expired = 0, cancelled = 0, rejected = 0, unresolved = 0;

  for (const b of splits) {
    if (!hasSeries(cache, b.symbol, EXEC_TF) || !hasSeries(cache, b.symbol, STRUCT_TF)) continue;
    const win = sliceWindow(b, slice);
    const h1 = loadSeries(cache, b.symbol, EXEC_TF).filter((c) => c.isClosed);
    const h4 = loadSeries(cache, b.symbol, STRUCT_TF).filter((c) => c.isClosed);
    const windowEndIndex = lastIndexAtOrBefore(h1, win.toMs);

    interface Pending {
      dir: Direction; zoneLow: number; zoneHigh: number; stop: number;
      tp1: number; tp2: number; setupIndex: number;
    }
    let pend: Pending | null = null;
    const busy = false;

    for (let i = 60; i < h1.length; i++) {
      const c = h1[i]!;
      if (c.openTime < win.fromMs) continue;
      if (c.openTime > win.toMs) break;

      /* ---- advance a pending corridor (N+1 or later) ---- */
      if (pend && !busy) {
        const p = pend;
        const long = p.dir === 'LONG';
        const waited = i - p.setupIndex;
        const touches = long ? c.low <= p.zoneHigh : c.high >= p.zoneLow;
        const hitStop = long ? c.low <= p.stop : c.high >= p.stop;

        if (touches && hitStop) {            // ambiguous -> unfavourable
          cancelled++; pend = null;
        } else if (touches) {
          const fill = long ? Math.min(c.open, p.zoneHigh) : Math.max(c.open, p.zoneLow);
          const risk = Math.abs(fill - p.stop);
          const geomOk = risk > 0
            && (long ? p.stop < fill : p.stop > fill)
            && (long ? p.tp1 > fill && p.tp2 > p.tp1 : p.tp1 < fill && p.tp2 < p.tp1);
          if (!geomOk) { rejected++; pend = null; }
          else {
            const bars = h1.slice(i, Math.min(h1.length, i + TIMEOUT_BARS + 2));
            const r = manageTrade(p.dir, fill, p.stop, p.tp1, p.tp2, bars);
            if (!r) { unresolved++; pend = null; }
            else {
              a.n++; a.sumG += r.grossR; a.gs.push(r.grossR); a.seq.push(r.grossR);
              a.bars.push(r.barsHeld);
              a.stopPct.push((risk / fill) * 100);
              a.exits[r.exit] = (a.exits[r.exit] ?? 0) + 1;
              if (r.hitTp1) a.nTp1++;
              if (r.hitTp2) a.nTp2++;
              if (r.grossR > 0) { a.pos += r.grossR; a.nPos++; a.wins.push(r.grossR); }
              else { a.neg += -r.grossR; a.losses.push(r.grossR); }
              a.sumFee['GROSS'] = (a.sumFee['GROSS'] ?? 0) + r.feeR(0, 0);
              a.sumFee['FUT_4'] = (a.sumFee['FUT_4'] ?? 0) + r.feeR(MAKER_BPS, TAKER_BPS);
              a.sumFee['SPOT'] = (a.sumFee['SPOT'] ?? 0) + r.feeR(5, 5);
              bump(a.byDir, p.dir, r.grossR);
              bump(a.bySym, b.symbol, r.grossR);
              opts.onTrade?.({
                symbol: b.symbol, direction: p.dir, fillIndex: i, fillTime: c.openTime,
                exit: r.exit, barsHeld: r.barsHeld, grossR: r.grossR,
                feeFut4: r.feeR(MAKER_BPS, TAKER_BPS),
                fillingInLastBars: i + TIMEOUT_BARS >= windowEndIndex,
              });
              pend = null;
            }
          }
        } else if (hitStop) {
          cancelled++; pend = null;
        } else if (waited >= CORRIDOR_EXPIRY_BARS) {
          expired++; pend = null;
        }
      }

      /* ---- look for a new trap on this closed 1H bar ---- */
      if (pend === null) {
        const levels = confirmedLevels(h4, c.closeTime, strength);
        if (levels.swingHigh === null && levels.swingLow === null) continue;
        const vol = buildVolumeContext(h1.slice(0, i + 1), i, volPeriod);
        const sig = detectTrap(c, levels, vol.rvol);
        if (!sig) continue;
        const atr = buildAtrContext(h1.slice(0, i + 1), i, atrPeriod).atr;
        if (atr === null || !(atr > 0)) continue;
        if (levels.swingHigh === null || levels.swingLow === null) continue;

        signals++;
        const long = sig.direction === 'LONG';
        const half = CORRIDOR_ATR_FRAC * atr;
        const eq = (levels.swingHigh + levels.swingLow) / 2;   // 4H equilibrium
        const stop = long
          ? sig.sweepExtreme - STOP_BUFFER_ATR * atr
          : sig.sweepExtreme + STOP_BUFFER_ATR * atr;
        const tp2 = long ? levels.swingHigh : levels.swingLow; // opposing swing
        pend = {
          dir: sig.direction,
          zoneLow: c.close - half, zoneHigh: c.close + half,
          stop, tp1: eq, tp2, setupIndex: i,
        };
        pending++;
      }
      void busy;
    }
    console.error(`  ${b.symbol} ${EXEC_TF} ${slice} done`);
  }

  const gross = a.n ? a.sumG / a.n : 0;
  const sorted = a.gs.slice().sort((x, y) => y - x);
  const drop = (k: number): number => {
    const rest = sorted.slice(Math.min(k, sorted.length));
    return rest.length ? rest.reduce((p, q) => p + q, 0) / rest.length : 0;
  };
  const k1 = Math.max(1, Math.ceil(sorted.length * 0.01));
  const net = (lab: string): number =>
    a.n ? (a.sumG - (a.sumFee[lab] ?? 0)) / a.n : 0;
  const feeDrag = (lab: string): number => a.n ? (a.sumFee[lab] ?? 0) / a.n : 0;

  return {
    slice,
    execTimeframe: EXEC_TF, structuralTimeframe: STRUCT_TF,
    symbols: SYMBOLS,
    constants: {
      MIN_BODY_RATIO: 0.35, MIN_RVOL: 1.25, CORRIDOR_ATR_FRAC, CORRIDOR_EXPIRY_BARS,
      STOP_BUFFER_ATR, TIMEOUT_BARS, MAKER_BPS, TAKER_BPS,
    },
    funnel: { signals, pendingCreated: pending, filled: a.n, expired, cancelled, rejected, unresolved },
    n: a.n,
    tp1HitRatePct: a.n ? +((a.nTp1 / a.n) * 100).toFixed(2) : 0,
    tp2HitRatePct: a.n ? +((a.nTp2 / a.n) * 100).toFixed(2) : 0,
    positiveRRatePct: a.n ? +((a.nPos / a.n) * 100).toFixed(2) : 0,
    stopDistancePct: {
      p25: +qq(a.stopPct, .25).toFixed(4),
      median: +med(a.stopPct).toFixed(4),
      p75: +qq(a.stopPct, .75).toFixed(4),
    },
    feeDragR: { FUT_4: +feeDrag('FUT_4').toFixed(4), SPOT: +feeDrag('SPOT').toFixed(4) },
    grossRPerTrade: +gross.toFixed(4),
    netRPerTrade: { FUT_4: +net('FUT_4').toFixed(4), SPOT: +net('SPOT').toFixed(4) },
    profitFactor: a.neg > 0 ? +(a.pos / a.neg).toFixed(4) : null,
    maxDrawdownR: +maxDD(a.seq).toFixed(2),
    grossMedianR: +med(a.gs).toFixed(4),
    avgWinR: a.wins.length ? +(a.wins.reduce((p, q) => p + q, 0) / a.wins.length).toFixed(4) : 0,
    avgLossR: a.losses.length ? +(a.losses.reduce((p, q) => p + q, 0) / a.losses.length).toFixed(4) : 0,
    medianBarsHeld: +med(a.bars).toFixed(2),
    exits: a.exits,
    outlierDependence: {
      grossExpectancy: +gross.toFixed(4),
      exTop1: +drop(1).toFixed(4), exTop5: +drop(5).toFixed(4),
      exTop1Pct: +drop(k1).toFixed(4), removedForTop1Pct: k1,
    },
    byDirection: sub(a.byDir), bySymbol: sub(a.bySym),
    criterion: {
      rule: 'net R/trade > 0 at 2/5 bps',
      value: +net('FUT_4').toFixed(4), passed: net('FUT_4') > 0,
    },
  };
}

/* ---------------- driver ---------------- */

function main(): void {
  const cache = arg('cache');
  const outFile = arg('out');
  const slice = arg('slice') as Slice;
  if (slice !== 'train' && slice !== 'valid') throw new Error(`bad --slice=${slice}`);
  const splitsDoc = JSON.parse(readFileSync(arg('splits'), 'utf8')) as { splits: SplitRow[] };

  const guard = testGuard(splitsDoc.splits, EXEC_TF, SYMBOLS);
  console.error(`TEST guard: checked ${guard.checked} series, safe=${guard.safe}`);
  if (!guard.safe) {
    throw new Error(`TEST guard violated: ${JSON.stringify(guard.violations)}`);
  }

  const out = runSlice({ cache, splits: splitsDoc.splits, slice });
  let fidelity: Json | null = null;

  const fidelityArg = process.argv.slice(2).find((x) => x.startsWith('--fidelity='))?.split('=')[1];
  if (fidelityArg !== undefined) {
    const frozen = JSON.parse(readFileSync(fidelityArg, 'utf8')) as Json;
    // The gate is the TRAIN reproduction. When the requested slice already IS
    // train, the two runs are the same run and the result is reused.
    const trainRun = slice === 'train'
      ? out
      : runSlice({ cache, splits: splitsDoc.splits, slice: 'train' });
    const trainDiffs = fidelityDiff(trainRun, frozen);
    fidelity = {
      comparedAgainst: fidelityArg,
      sliceRequested: slice,
      sliceReproduced: trainDiffs.length === 0 ? 'train' : 'no',
      mismatches: trainDiffs,
      exact: trainDiffs.length === 0,
    };
    if (trainDiffs.length > 0) {
      writeFileSync(outFile, JSON.stringify({ ...out, harnessFidelity: fidelity }, null, 2));
      console.error(`FIDELITY FAILED — ${trainDiffs.length} mismatch(es):`);
      for (const d of trainDiffs.slice(0, 20)) console.error(`  ${d}`);
      throw new Error('harness fidelity failed: the TRAIN window was not reproduced exactly');
    }
    console.error('harness fidelity: TRAIN reproduced EXACTLY');
  }

  const artifact: Json = {
    ...out,
    ...(fidelity ? { harnessFidelity: fidelity } : {}),
    testGuard: guard,
  };
  writeFileSync(outFile, JSON.stringify(artifact, null, 2));

  console.log('');
  console.log(`V3.0 HTF LIQUIDATION TRAP — ${slice.toUpperCase()}`);
  console.log('');
  console.log(`  signals ${out.funnel ? (out.funnel as Json).signals : '?'}`
    + `  pending ${(out.funnel as Json).pendingCreated}  filled ${out.n}`
    + `  expired ${(out.funnel as Json).expired}  cancelled ${(out.funnel as Json).cancelled}`);
  console.log('');
  console.log('| n | TP1 hit % | TP2 hit % | stop % (med) | fee R | Gross R | Net R @2/5 | Net R @5/5 | PF | MaxDD |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  console.log(`| ${out.n} | ${out.tp1HitRatePct} | ${out.tp2HitRatePct}`
    + ` | ${(out.stopDistancePct as Json).median} | ${(out.feeDragR as Json).FUT_4}`
    + ` | ${out.grossRPerTrade} | ${(out.netRPerTrade as Json).FUT_4}`
    + ` | ${(out.netRPerTrade as Json).SPOT} | ${out.profitFactor} | ${out.maxDrawdownR} |`);
  console.log('');
  console.log('exits:', JSON.stringify(out.exits));
  console.log('outlier:', JSON.stringify(out.outlierDependence));
  console.log('byDirection:', JSON.stringify(out.byDirection));
  console.log('bySymbol:', JSON.stringify(out.bySymbol));
  console.log('');
  console.log(`CRITERION net>0 @2/5: ${(out.criterion as Json).value}`
    + ` -> ${(out.criterion as Json).passed ? 'PASS' : 'FAIL'}`);
  console.log('wrote', outFile);
}

const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replace(/\\/g, '/').endsWith('/v30_validate.ts');
if (invokedDirectly) main();

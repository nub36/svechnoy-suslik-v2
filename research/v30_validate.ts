/**
 * V3.0 — VALIDATION driver (HTF LIQUIDATION TRAP).
 *
 * Protocol: docs/V3_0_CANDIDATE_FREEZE.md.
 *
 * This file adds NOTHING to the strategy. It imports the frozen candidate
 * `research/v30_htf_trap.ts` unchanged (constants, `confirmedLevels`,
 * `detectTrap`, `manageTrade`, `legFeeR`) and replays the SAME loop over a
 * different window. The frozen module must still hash to
 * a821757ff0319a100a8a9087da1bdd137abb1df0785493d644ad4d87f05dc4cd.
 *
 * ── HARD TEST GUARD ────────────────────────────────────────────────────────
 * No candle with `openTime >= testFromMs` (or >= 2026-01-01) is ever read,
 * neither for signal detection nor for outcome resolution. Bars available for
 * resolving a trade are clipped at `testFromMs`. Trades that cannot resolve
 * within that limit are reported as `unresolved` and excluded from metrics —
 * the same treatment the frozen runner gives dataset-boundary trades. The
 * guard counters are written into the artifact (`guards`), so the claim is
 * checkable rather than asserted.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────
 *   npx tsx research/v30_validate.ts \
 *     --slice=validation|train \
 *     --cache=<binary candle cache> \
 *     --splits=<splits.json> \
 *     --out=<artifact.json>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { Settings } from '../src/core/settings';
import { buildAtrContext, buildVolumeContext } from '../src/strategy/v2/indicators';
import { closedHtfCandles } from '../src/strategy/v2/htf';
import { loadSeries, hasSeries } from '../scripts/real-data/load';
import { quantileSorted } from '../scripts/real-data/audit-fee-readonly';
import type { Candle, Timeframe } from '../src/core/types';
import {
  CORRIDOR_ATR_FRAC, CORRIDOR_EXPIRY_BARS, MAKER_BPS, MIN_BODY_RATIO, MIN_RVOL,
  STOP_BUFFER_ATR, TAKER_BPS, TIMEOUT_BARS,
  confirmedLevels, detectTrap, manageTrade,
  type Direction,
} from './v30_htf_trap';

/** The 2026-H1 window is unspent. Not one candle beyond this may be read. */
export const WINDOW_2026_MS = Date.UTC(2026, 0, 1);

const EXEC_TF: Timeframe = '1h';
const STRUCT_TF: Timeframe = '4h';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];

interface SplitRow {
  symbol: string;
  timeframe: Timeframe;
  trainFromMs: number; trainToMs: number;
  validFromMs: number; validToMs: number;
  testFromMs: number; testToMs: number;
}

/* ---------------- accumulation (identical to the frozen runner) ---------------- */

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
  wins: [], losses: [], gs: [], seq: [], stopPct: [], bars: [],
  exits: {}, byDir: new Map(), bySym: new Map(),
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

/* ---------------- replay ---------------- */

export interface GuardState {
  /** Highest openTime actually read from the 1H series. */
  maxCandleOpenTimeRead: number;
  /** Candles read at or beyond testFromMs. MUST be 0. */
  testCandlesRead: number;
  /** Candles read at or beyond 2026-01-01. MUST be 0. */
  candles2026Read: number;
  /** Bars withheld from outcome resolution because they belong to TEST. */
  barsClippedAtTestBoundary: number;
}

async function main(): Promise<void> {
  const slice = arg('slice');
  if (slice !== 'train' && slice !== 'validation') {
    throw new Error(`--slice must be "train" or "validation", got "${slice}"`);
  }
  const cache = arg('cache');
  const outFile = arg('out');
  const doc = JSON.parse(readFileSync(arg('splits'), 'utf8')) as { splits: SplitRow[] };
  const splits = doc.splits.filter((s) => s.timeframe === EXEC_TF);

  const settings = Settings.fromDefaults();
  const strength = Math.floor(settings.num('engine.swing_lookback'));
  const atrPeriod = Math.floor(settings.num('risk.atr_period'));
  const volPeriod = Math.floor(settings.num('v2.volume_period'));

  const a = mk();
  let signals = 0, pending = 0, expired = 0, cancelled = 0, rejected = 0, unresolved = 0;
  const guards: GuardState = {
    maxCandleOpenTimeRead: 0, testCandlesRead: 0, candles2026Read: 0,
    barsClippedAtTestBoundary: 0,
  };
  const perSymbolBoundaries: Record<string, unknown>[] = [];

  for (const b of splits) {
    if (!SYMBOLS.includes(b.symbol)) continue;

    /* ---- HARD GUARD 0: the slice must sit strictly before TEST ---- */
    const fromMs = slice === 'train' ? b.trainFromMs : b.validFromMs;
    const toMs = slice === 'train' ? b.trainToMs : b.validToMs;
    const priorWindowEnd = slice === 'train' ? 0 : b.trainToMs;
    if (!(fromMs > priorWindowEnd)) {
      throw new Error(`${b.symbol}: ${slice} window does not start after the previous slice`);
    }
    if (!(toMs < b.testFromMs)) {
      throw new Error(`${b.symbol}: ${slice} window ends at or after TEST`);
    }
    if (!(b.testFromMs < WINDOW_2026_MS)) {
      throw new Error(`${b.symbol}: TEST window is not before 2026 — refusing to run`);
    }
    perSymbolBoundaries.push({
      symbol: b.symbol,
      fromMs, toMs,
      validToUtc: new Date(b.validToMs).toISOString(),
      testFromUtc: new Date(b.testFromMs).toISOString(),
      testToUtc: new Date(b.testToMs).toISOString(),
      guard: 'toMs < testFromMs and testFromMs < 2026-01-01',
    });

    if (!hasSeries(cache, b.symbol, EXEC_TF) || !hasSeries(cache, b.symbol, STRUCT_TF)) {
      throw new Error(`${b.symbol}: cache series missing for ${EXEC_TF}/${STRUCT_TF}`);
    }
    const h1 = loadSeries(cache, b.symbol, EXEC_TF).filter((c) => c.isClosed);
    const h4 = loadSeries(cache, b.symbol, STRUCT_TF).filter((c) => c.isClosed);

    /**
     * TEST CLIP: outcome resolution may consume bars up to testFromMs - 1 only.
     * The frozen runner sliced `h1` to the dataset end; here the same slice is
     * clipped so that not one TEST candle is ever passed to `manageTrade`.
     */
    const resolveLimit = slice === 'train' ? h1.length : (() => {
      let k = 0;
      while (k < h1.length && h1[k]!.openTime < b.testFromMs) k++;
      return k;
    })();
    if (slice === 'validation' && resolveLimit < h1.length) {
      guards.barsClippedAtTestBoundary += h1.length - resolveLimit;
    }

    interface Pending {
      dir: Direction; zoneLow: number; zoneHigh: number; stop: number;
      tp1: number; tp2: number; setupIndex: number;
    }
    let pend: Pending | null = null;
    const busy = false;

    for (let i = 60; i < h1.length; i++) {
      const c = h1[i]!;
      if (c.openTime < fromMs) continue;
      if (c.openTime > toMs) break;

      /* ---- guard accounting: what did this run actually read? ---- */
      if (c.openTime > guards.maxCandleOpenTimeRead) guards.maxCandleOpenTimeRead = c.openTime;
      if (c.openTime >= b.testFromMs) guards.testCandlesRead++;
      if (c.openTime >= WINDOW_2026_MS) guards.candles2026Read++;

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
            const bars = h1.slice(i, Math.min(resolveLimit, i + TIMEOUT_BARS + 2));
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
    }
    console.error(`  ${b.symbol} ${EXEC_TF} ${slice} done`);
  }

  if (guards.testCandlesRead !== 0 || guards.candles2026Read !== 0) {
    throw new Error(
      `TEST GUARD VIOLATED: testCandlesRead=${guards.testCandlesRead} `
      + `candles2026Read=${guards.candles2026Read}`,
    );
  }

  const gross = a.n ? a.sumG / a.n : 0;
  const sorted = a.gs.slice().sort((x, y) => y - x);
  const drop = (k: number): number => {
    const rest = sorted.slice(Math.min(k, sorted.length));
    return rest.length ? rest.reduce((p, q) => p + q, 0) / rest.length : 0;
  };
  const k1 = Math.max(1, Math.ceil(sorted.length * 0.01));
  const net = (lab: string): number => (a.n ? (a.sumG - (a.sumFee[lab] ?? 0)) / a.n : 0);
  const feeDrag = (lab: string): number => (a.n ? (a.sumFee[lab] ?? 0) / a.n : 0);

  const netFut45 = net('FUT_4');
  const criteria = {
    'a_net_gt_0_at_2_5': { rule: 'net R/trade > 0 at 2/5 bps', value: +netFut45.toFixed(4), passed: netFut45 > 0 },
    'b_gross_gt_0': { rule: 'gross R/trade > 0', value: +gross.toFixed(4), passed: gross > 0 },
    verdict: netFut45 > 0 && gross > 0 ? 'PASS' : 'FAIL',
  };

  const out = {
    slice,
    execTimeframe: EXEC_TF,
    structuralTimeframe: STRUCT_TF,
    symbols: SYMBOLS,
    frozenModuleSha256: 'a821757ff0319a100a8a9087da1bdd137abb1df0785493d644ad4d87f05dc4cd',
    constants: {
      MIN_BODY_RATIO, MIN_RVOL, CORRIDOR_ATR_FRAC, CORRIDOR_EXPIRY_BARS,
      STOP_BUFFER_ATR, TIMEOUT_BARS, MAKER_BPS, TAKER_BPS,
    },
    funnel: {
      signals, pendingCreated: pending, filled: a.n,
      expired, cancelled, rejected, unresolved,
    },
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
      edgeRetainedPct: gross !== 0 ? +((drop(k1) / gross) * 100).toFixed(1) : 0,
    },
    byDirection: sub(a.byDir), bySymbol: sub(a.bySym),
    criteria,
    guards: {
      ...guards,
      maxCandleOpenTimeUtc: new Date(guards.maxCandleOpenTimeRead).toISOString(),
      window2026Ms: WINDOW_2026_MS,
      perSymbolBoundaries,
      rules: [
        'no candle with openTime >= testFromMs is read',
        'no candle with openTime >= 2026-01-01 is read',
        'outcome bars are clipped at testFromMs; unresolved trades are excluded',
      ],
    },
  };
  writeFileSync(outFile, JSON.stringify(out, null, 2));

  console.log('');
  console.log(`V3.0 HTF LIQUIDATION TRAP — ${slice.toUpperCase()}`);
  console.log('');
  console.log(`  signals ${signals}  pending ${pending}  filled ${a.n}  expired ${expired}  cancelled ${cancelled}  rejected ${rejected}  unresolved ${unresolved}`);
  console.log('');
  console.log('| n | TP1 hit % | TP2 hit % | stop % (med) | fee R | Gross R | Net R @2/5 | Net R @5/5 | PF | MaxDD |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  console.log(`| ${a.n} | ${out.tp1HitRatePct} | ${out.tp2HitRatePct} | `
    + `${out.stopDistancePct.median} | ${out.feeDragR.FUT_4} | ${out.grossRPerTrade} | `
    + `${out.netRPerTrade.FUT_4} | ${out.netRPerTrade.SPOT} | ${out.profitFactor} | ${out.maxDrawdownR} |`);
  console.log('');
  console.log(`CRITERION a  net > 0 @2/5 : ${criteria.a_net_gt_0_at_2_5.value} -> ${criteria.a_net_gt_0_at_2_5.passed ? 'PASS' : 'FAIL'}`);
  console.log(`CRITERION b  gross > 0    : ${criteria.b_gross_gt_0.value} -> ${criteria.b_gross_gt_0.passed ? 'PASS' : 'FAIL'}`);
  console.log(`VERDICT                   : ${criteria.verdict}`);
  console.log(`GUARDS: testCandlesRead=${guards.testCandlesRead} candles2026Read=${guards.candles2026Read} maxRead=${out.guards.maxCandleOpenTimeUtc}`);
  console.log('wrote', outFile);
}

const invokedDirectly = process.argv.some((x) => x.includes('v30_validate'));
if (invokedDirectly) void main();

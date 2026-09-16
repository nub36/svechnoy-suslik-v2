/**
 * V3.0 — HTF LIQUIDATION TRAP.
 *
 * Implements docs/V3_0_HTF_LIQUIDATION_TRAP_PREREGISTRATION.md exactly.
 *
 * THESIS: every strategy V2.1..V2.8 fought a 0.12-0.16 R fee drag because
 * `feeR = fee% * price / stopDistance` and they all used 1H-or-tighter stops.
 * V3.0 anchors the stop behind a **4H** sweep wick, which should widen the
 * denominator and cut fee-in-R to ~0.03-0.05 R. That is the only mechanism by
 * which it can beat fees.
 *
 * FROZEN SURFACE: nothing under `src/` is modified. The frozen `findSwingsV2`,
 * `buildAtrContext`, `buildVolumeContext` and `closedHtfCandles` are reused
 * as-is; this file contains only V3.0's own trap detection and trade management.
 *
 * CAUSALITY (asserted by tests):
 *   - a 4H pivot is usable only from `confirmedIndex = index + strength`;
 *   - 4H context at a 1H bar is bounded by `closedHtfCandles(..., closeTime)`;
 *   - the corridor fills only from bar N+1, never on the reclaim bar;
 *   - same-bar ambiguity always resolves against the trade.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { Settings } from '../src/core/settings';
import { findSwingsV2 } from '../src/strategy/v2/structure';
import { buildAtrContext, buildVolumeContext } from '../src/strategy/v2/indicators';
import { closedHtfCandles } from '../src/strategy/v2/htf';
import { loadSeries, hasSeries } from '../scripts/real-data/load';
import { quantileSorted } from '../scripts/real-data/audit-fee-readonly';
import type { Candle, Timeframe } from '../src/core/types';

/* ---------------- preregistered constants (NOT swept) ---------------- */

export const MIN_BODY_RATIO = 0.35;
export const MIN_RVOL = 1.25;            // note: 1.25, distinct from V2.x's 1.2
export const CORRIDOR_ATR_FRAC = 0.10;
export const CORRIDOR_EXPIRY_BARS = 3;
export const STOP_BUFFER_ATR = 0.15;
export const TIMEOUT_BARS = 50;
export const MAKER_BPS = 2;
export const TAKER_BPS = 5;

const EXEC_TF: Timeframe = '1h';
const STRUCT_TF: Timeframe = '4h';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];

export type Direction = 'LONG' | 'SHORT';
export type Terminal =
  | 'FILLED' | 'EXPIRED' | 'CANCELLED' | 'REJECTED_GEOMETRY';
export type ExitReason = 'SL' | 'TP2' | 'TP1_THEN_BE' | 'TP1_THEN_SL'
  | 'TP1_THEN_TIMEOUT' | 'TIMEOUT';

/* ---------------- trap detection ---------------- */

export interface TrapLevels {
  /** Confirmed 4H swing high and low available at this moment. */
  swingHigh: number | null;
  swingLow: number | null;
}

/**
 * Most recent CONFIRMED 4H swing high/low as of `asOfCloseTime`.
 *
 * Two causality filters, both required:
 *   1. only 4H bars that had closed by `asOfCloseTime` are visible;
 *   2. within those, a pivot counts only from `confirmedIndex` onward.
 */
export function confirmedLevels(
  htf4h: readonly Candle[], asOfCloseTime: number, strength: number,
): TrapLevels {
  const usable = closedHtfCandles(htf4h, STRUCT_TF, asOfCloseTime);
  if (usable.length < strength * 2 + 2) return { swingHigh: null, swingLow: null };
  const swings = findSwingsV2(usable, strength);
  const lastIdx = usable.length - 1;
  let swingHigh: number | null = null;
  let swingLow: number | null = null;
  for (const s of swings) {
    if (s.confirmedIndex > lastIdx) continue;   // right-bars not yet printed
    if (s.kind === 'HIGH') swingHigh = s.price;
    else swingLow = s.price;
  }
  return { swingHigh, swingLow };
}

export interface TrapSignal {
  direction: Direction;
  level: number;        // the 4H level that was swept
  sweepExtreme: number; // the wick extreme of the reclaim bar
  bodyRatio: number;
  rvol: number;
}

/** Body / full range of a candle, 0 when the range is degenerate. */
export function bodyRatio(c: Candle): number {
  const range = c.high - c.low;
  if (!(range > 0)) return 0;
  return Math.abs(c.close - c.open) / range;
}

/**
 * Detect a liquidation trap on closed 1H bar `c`.
 *
 * SHORT: pierces a 4H swing HIGH and closes back below it.
 * LONG : pierces a 4H swing LOW  and closes back above it.
 */
export function detectTrap(
  c: Candle, levels: TrapLevels, rvol: number | null,
): TrapSignal | null {
  const br = bodyRatio(c);
  if (br < MIN_BODY_RATIO) return null;
  if (rvol === null || !(rvol > MIN_RVOL)) return null;

  if (levels.swingHigh !== null
    && c.high > levels.swingHigh && c.close < levels.swingHigh) {
    return {
      direction: 'SHORT', level: levels.swingHigh,
      sweepExtreme: c.high, bodyRatio: br, rvol,
    };
  }
  if (levels.swingLow !== null
    && c.low < levels.swingLow && c.close > levels.swingLow) {
    return {
      direction: 'LONG', level: levels.swingLow,
      sweepExtreme: c.low, bodyRatio: br, rvol,
    };
  }
  return null;
}

/* ---------------- fees ---------------- */

/** Per-leg fee in R, charged on that leg's own notional. No rebate. */
export function legFeeR(
  price: number, weight: number, bps: number, risk: number,
): number {
  if (!(risk > 0)) return 0;
  return (bps / 10000) * price * weight / risk;
}

/* ---------------- trade simulation ---------------- */

export interface TradeResult {
  exit: ExitReason;
  grossR: number;
  /** fee in R at the given maker/taker pair, summed across all legs */
  feeR: (makerBps: number, takerBps: number) => number;
  barsHeld: number;
  hitTp1: boolean;
  hitTp2: boolean;
}

/**
 * Manage one filled position.
 *
 * Preregistered intrabar rules:
 *   R1 stop checked BEFORE targets on every bar;
 *   R2 TP1 books before TP2 when both land on one bar;
 *   R3 breakeven arms only on bars strictly AFTER the TP1 bar;
 *   R4 the stop never moves backwards;
 *   R5 timeout counts the entry bar as bar 1.
 */
export function manageTrade(
  direction: Direction, entry: number, stop0: number,
  tp1: number, tp2: number, bars: readonly Candle[],
): TradeResult | null {
  const risk = Math.abs(entry - stop0);
  if (!(risk > 0) || bars.length === 0) return null;
  const long = direction === 'LONG';
  const rOf = (p: number): number => (long ? p - entry : entry - p) / risk;

  let stop = stop0;
  let hitTp1 = false;
  let tp1Bar = -1;
  let realised = 0;              // R already booked from the TP1 half
  // legs: [price, weight]
  const legs: { price: number; weight: number; taker: boolean }[] = [];
  legs.push({ price: entry, weight: 1, taker: false });   // maker entry

  const finish = (
    exit: ExitReason, exitPrice: number, weight: number, i: number,
  ): TradeResult => {
    legs.push({ price: exitPrice, weight, taker: true });
    const gross = realised + weight * rOf(exitPrice);
    return {
      exit, grossR: gross, barsHeld: i + 1, hitTp1, hitTp2: exit === 'TP2',
      feeR: (mk, tk) => legs.reduce((s, l) =>
        s + legFeeR(l.price, l.weight, l.taker ? tk : mk, risk), 0),
    };
  };

  for (let i = 0; i < bars.length && i < TIMEOUT_BARS; i++) {
    const c = bars[i]!;
    const beArmed = hitTp1 && tp1Bar >= 0 && i > tp1Bar;   // R3
    const effStop = beArmed ? Math.max(stop, long ? entry : -Infinity) : stop;
    const stopNow = beArmed
      ? (long ? entry : entry)                              // breakeven price
      : stop;
    void effStop;

    const hitStop = long ? c.low <= stopNow : c.high >= stopNow;
    const hitT1 = !hitTp1 && (long ? c.high >= tp1 : c.low <= tp1);
    const hitT2 = long ? c.high >= tp2 : c.low <= tp2;

    // R1: stop first, always.
    if (hitStop) {
      if (!hitTp1) return finish('SL', stopNow, 1, i);
      return finish(beArmed ? 'TP1_THEN_BE' : 'TP1_THEN_SL', stopNow, 0.5, i);
    }

    if (hitT1) {
      hitTp1 = true; tp1Bar = i;
      realised += 0.5 * rOf(tp1);
      legs.push({ price: tp1, weight: 0.5, taker: true });
      // R2: TP1 books first, then TP2 may close the remainder on the same bar.
      if (hitT2) return finish('TP2', tp2, 0.5, i);
      if (i + 1 >= TIMEOUT_BARS) return finish('TP1_THEN_TIMEOUT', c.close, 0.5, i);
      continue;
    }

    if (hitTp1 && hitT2) return finish('TP2', tp2, 0.5, i);
    // TP2 without TP1 is impossible by construction (TP1 is nearer), but guard:
    if (!hitTp1 && hitT2) {
      hitTp1 = true;
      realised += 0.5 * rOf(tp1);
      legs.push({ price: tp1, weight: 0.5, taker: true });
      return finish('TP2', tp2, 0.5, i);
    }

    if (i + 1 >= TIMEOUT_BARS) {
      return finish(hitTp1 ? 'TP1_THEN_TIMEOUT' : 'TIMEOUT', c.close,
        hitTp1 ? 0.5 : 1, i);
    }
  }
  return null;   // unresolved at the dataset boundary
}

/* ---------------- accumulation ---------------- */

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

async function main(): Promise<void> {
  const cache = arg('cache');
  const outFile = arg('out');
  const splits = (JSON.parse(readFileSync(arg('splits'), 'utf8')) as {
    splits: { symbol: string; timeframe: Timeframe; trainFromMs: number; trainToMs: number }[];
  }).splits.filter((s) => s.timeframe === EXEC_TF);
  const settings = Settings.fromDefaults();
  const strength = Math.floor(settings.num('engine.swing_lookback'));
  const atrPeriod = Math.floor(settings.num('risk.atr_period'));
  const volPeriod = Math.floor(settings.num('v2.volume_period'));

  const a = mk();
  let signals = 0, pending = 0, expired = 0, cancelled = 0, rejected = 0, unresolved = 0;

  for (const b of splits) {
    if (!SYMBOLS.includes(b.symbol)) continue;
    if (!hasSeries(cache, b.symbol, EXEC_TF) || !hasSeries(cache, b.symbol, STRUCT_TF)) continue;
    const h1 = loadSeries(cache, b.symbol, EXEC_TF).filter((c) => c.isClosed);
    const h4 = loadSeries(cache, b.symbol, STRUCT_TF).filter((c) => c.isClosed);

    interface Pending {
      dir: Direction; zoneLow: number; zoneHigh: number; stop: number;
      tp1: number; tp2: number; setupIndex: number;
    }
    let pend: Pending | null = null;
    let busy = false;

    for (let i = 60; i < h1.length; i++) {
      const c = h1[i]!;
      if (c.openTime < b.trainFromMs) continue;
      if (c.openTime > b.trainToMs) break;

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
    console.error(`  ${b.symbol} ${EXEC_TF} done`);
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

  const out = {
    slice: 'train',
    execTimeframe: EXEC_TF, structuralTimeframe: STRUCT_TF,
    symbols: SYMBOLS,
    constants: {
      MIN_BODY_RATIO, MIN_RVOL, CORRIDOR_ATR_FRAC, CORRIDOR_EXPIRY_BARS,
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
  writeFileSync(outFile, JSON.stringify(out, null, 2));

  console.log('');
  console.log('V3.0 HTF LIQUIDATION TRAP — TRAIN');
  console.log('');
  console.log(`  signals ${signals}  pending ${pending}  filled ${a.n}  expired ${expired}  cancelled ${cancelled}`);
  console.log('');
  console.log('| n | TP1 hit % | TP2 hit % | stop % (med) | fee R | Gross R | Net R @2/5 | PF | MaxDD |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  console.log(`| ${a.n} | ${out.tp1HitRatePct} | ${out.tp2HitRatePct} | `
    + `${out.stopDistancePct.median} | ${out.feeDragR.FUT_4} | ${out.grossRPerTrade} | `
    + `${out.netRPerTrade.FUT_4} | ${out.profitFactor} | ${out.maxDrawdownR} |`);
  console.log('');
  console.log(`CRITERION net>0 @2/5: ${out.criterion.value} -> ${out.criterion.passed ? 'PASS' : 'FAIL'}`);
  console.log('wrote', outFile);
}

const invokedDirectly = process.argv.some((x) => x.includes('v30_htf_trap'));
if (invokedDirectly) void main();

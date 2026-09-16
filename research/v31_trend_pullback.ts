/**
 * V3.1 — HTF TREND PULLBACK & MITIGATION.
 *
 * Implements docs/V3_1_HTF_TREND_PULLBACK_PREREGISTRATION.md exactly, with the
 * pullback window fixed by PREREGISTRATION_AMENDMENT_1 (both variants shipped:
 * `--pullback=leg` primary, `--pullback=same-bar` secondary).
 *
 * THESIS: V3.0 trades reversals (a swept 4H level). V3.1 tests the other side of
 * the same market: in an ESTABLISHED 4H trend (EMA50/EMA200 stack + causal
 * HH/HL), a pullback into the active impulse leg's 50 % equilibrium — or into a
 * fresh 4H imbalance — followed by a displaced 1H resumption candle that breaks
 * the previous 1H swing, CONTINUES. The entry is a maker corridor around that
 * candle's close, so entry pays 2 bps and the trade does not chase.
 *
 * FROZEN SURFACE: nothing under `src/` is modified. `emaSeries`, `findSwingsV2`,
 * `structureBias`, `detectStructureBreak`, `buildAtrContext`,
 * `buildVolumeContext` and `closedHtfCandles` are reused as-is; this file holds
 * only V3.1's own trend gate, pullback detection, corridor and trade manager.
 *
 * CAUSALITY (asserted by tests):
 *   - 4H context at a 1H bar is bounded by `closedHtfCandles(..., closeTime)`;
 *     the trend state is a function of the number of CLOSED 4H bars, and every
 *     4H swing is used only from `confirmedIndex` onward;
 *   - an FVG is usable only after its third 4H candle has closed, and is dead
 *     from the first 4H candle that trades into it afterwards;
 *   - the 1H structure break requires a CLOSE beyond a swing confirmed strictly
 *     before the breaking bar (the frozen `detectStructureBreak` contract);
 *   - the corridor fills from bar N+1, never on the resumption bar;
 *   - same-bar ambiguity always resolves against the trade.
 *
 * SCOPE: TRAIN only. The loader reads the full 2022-2025 series and truncates it
 * at `trainToMs` BEFORE anything else looks at it; the artifact records how many
 * rows were dropped unread. No candle beyond TRAIN reaches any computation.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Settings } from '../src/core/settings';
import { emaSeries, buildAtrContext, buildVolumeContext } from '../src/strategy/v2/indicators';
import { findSwingsV2, detectStructureBreak } from '../src/strategy/v2/structure';
import { loadSeries, hasSeries } from '../scripts/real-data/load';
import { quantileSorted } from '../scripts/real-data/audit-fee-readonly';
import type { Candle, Timeframe } from '../src/core/types';

/* ---------------- preregistered constants (NOT swept) ---------------- */

export const EMA_FAST = 50;
export const EMA_SLOW = 200;
export const MIN_BODY_RATIO = 0.35;
export const MIN_RVOL = 1.25;              // strictly greater, as in V3.0
export const CORRIDOR_ATR_FRAC = 0.10;
/** The specification is silent; V3.0's frozen value is inherited deliberately. */
export const CORRIDOR_EXPIRY_BARS = 3;
export const STOP_BUFFER_ATR = 0.15;
export const TP2_FIB_EXT = 1.5;
export const TIMEOUT_BARS = 60;
export const MAKER_BPS = 2;
export const TAKER_BPS = 5;

const EXEC_TF: Timeframe = '1h';
const STRUCT_TF: Timeframe = '4h';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];

export type Direction = 'LONG' | 'SHORT';
export type PullbackSource = 'EQ' | 'FVG' | 'EQ+FVG';
export type ExitReason = 'SL' | 'TP2' | 'TP1_THEN_BE' | 'TP1_THEN_SL'
  | 'TP1_THEN_TIMEOUT' | 'TIMEOUT';

/* ---------------- candles ---------------- */

/** Body / full range of a candle, 0 when the range is degenerate. */
export function bodyRatio(c: Candle): number {
  const range = c.high - c.low;
  if (!(range > 0)) return 0;
  return Math.abs(c.close - c.open) / range;
}

/* ---------------- 4H trend gate ---------------- */

export interface TrendState {
  dir: Direction;
  /** Active impulse leg: for LONG the up-leg, for SHORT the down-leg. */
  legLow: number;
  legHigh: number;
}

export interface HtfContext {
  /** Trend state as a function of the number of CLOSED 4H candles. */
  trendByClosed: (TrendState | null)[];
  /** Fresh FVGs; each is live for `knownAt <= closedCount < killAt`. */
  gaps: HtfGap[];
}

export interface HtfGap {
  dir: Direction;
  top: number;
  bottom: number;
  /** Closed-4H-count from which the gap exists (third candle closed). */
  knownAt: number;
  /** Closed-4H-count from which the gap is dead (traded into afterwards). */
  killAt: number;
}

export interface HtfInputs {
  h4: readonly Candle[];
  emaFast: readonly (number | null)[];
  emaSlow: readonly (number | null)[];
  swings: ReturnType<typeof findSwingsV2>;
}

/**
 * Build the 4H context ONCE per symbol: the trend/leg state per number of closed
 * 4H candles, plus every FVG with its birth and death in closed-4H-count terms.
 *
 * `trendByClosed[k]` describes what a 1H bar could know when exactly `k` 4H
 * candles have closed, i.e. it only ever uses 4H bars with index < k and swings
 * with `confirmedIndex < k`.
 */
export function buildHtfContext(inp: HtfInputs): HtfContext {
  const { h4, emaFast, emaSlow, swings } = inp;
  const n = h4.length;
  const trendByClosed: (TrendState | null)[] = new Array(n + 1).fill(null);

  // Last two confirmed highs / lows, advanced as the confirmation bar passes.
  let sw = 0;
  const highs: number[] = [];
  const lowPrices: number[] = [];
  let lastHighIdx = -1;
  let lastLowIdx = -1;
  let lastHighPrice = 0;
  let lastLowPrice = 0;

  for (let k = 0; k <= n; k++) {
    const evalIdx = k - 1;
    while (sw < swings.length && swings[sw]!.confirmedIndex <= evalIdx) {
      const s = swings[sw]!;
      if (s.kind === 'HIGH') {
        highs.push(s.price);
        if (highs.length > 2) highs.shift();
        lastHighIdx = s.index;
        lastHighPrice = s.price;
      } else {
        lowPrices.push(s.price);
        if (lowPrices.length > 2) lowPrices.shift();
        lastLowIdx = s.index;
        lastLowPrice = s.price;
      }
      sw++;
    }
    if (evalIdx < EMA_SLOW - 1) continue;   // EMA200 warm-up (inside TRAIN)
    const fast = emaFast[evalIdx];
    const slow = emaSlow[evalIdx];
    if (fast === null || fast === undefined || slow === null || slow === undefined) continue;

    const bullStruct = highs.length >= 2 && lowPrices.length >= 2
      && highs[1]! > highs[0]! && lowPrices[1]! > lowPrices[0]!;
    const bearStruct = highs.length >= 2 && lowPrices.length >= 2
      && highs[1]! < highs[0]! && lowPrices[1]! < lowPrices[0]!;
    const close = h4[evalIdx]!.close;

    if (close > fast && fast > slow && bullStruct
      && lastLowIdx >= 0 && lastHighIdx > lastLowIdx && lastHighPrice > lastLowPrice) {
      trendByClosed[k] = { dir: 'LONG', legLow: lastLowPrice, legHigh: lastHighPrice };
    } else if (close < fast && fast < slow && bearStruct
      && lastHighIdx >= 0 && lastLowIdx > lastHighIdx && lastHighPrice > lastLowPrice) {
      trendByClosed[k] = { dir: 'SHORT', legLow: lastLowPrice, legHigh: lastHighPrice };
    }
  }

  // ---- FVGs: three consecutive closed 4H candles ----
  const gaps: HtfGap[] = [];
  for (let j = 1; j < n - 1; j++) {
    const a = h4[j - 1]!;
    const c = h4[j + 1]!;
    let dir: Direction | null = null;
    let top = 0;
    let bottom = 0;
    if (c.low > a.high) { dir = 'LONG'; bottom = a.high; top = c.low; }
    else if (c.high < a.low) { dir = 'SHORT'; bottom = c.high; top = a.low; }
    if (dir === null || !(top > bottom)) continue;

    const knownAt = j + 2;                    // third candle (j+1) has closed
    let killAt = n + 1;                       // never killed inside TRAIN
    for (let m = j + 2; m < n; m++) {
      const bar = h4[m]!;
      if (Math.max(bottom, bar.low) < Math.min(top, bar.high)) { killAt = m + 1; break; }
    }
    gaps.push({ dir, top, bottom, knownAt, killAt });
  }

  return { trendByClosed, gaps };
}

/** Gap zones live as of `closedCount`, in the given trend direction. */
export function liveGaps(ctx: HtfContext, closedCount: number, dir: Direction): HtfGap[] {
  return ctx.gaps.filter((g) => g.dir === dir && g.knownAt <= closedCount && closedCount < g.killAt);
}

/** Does the bar's range intersect the zone? */
function intersects(c: Candle, top: number, bottom: number): boolean {
  return Math.max(bottom, c.low) < Math.min(top, c.high);
}

/* ---------------- resumption trigger ---------------- */

export interface PullbackHit {
  source: PullbackSource;
  /** For an FVG hit, the zone touched. */
  fvgTop: number | null;
  fvgBottom: number | null;
}

/**
 * Pullback condition evaluated on the trigger bar ALONE (the `same-bar`
 * variant of Amendment 1): the leg's 50 % equilibrium, a fresh 4H FVG in the
 * trend direction, or both. The primary `leg` variant widens this to the whole
 * current pullback leg; see `main()`.
 */
export function pullbackHit(
  c: Candle, trend: TrendState, gaps: readonly HtfGap[],
): PullbackHit | null {
  const long = trend.dir === 'LONG';
  const eq = (trend.legLow + trend.legHigh) / 2;
  // An invalidated leg is a reversal, not a pullback.
  if (long ? !(c.close > trend.legLow) : !(c.close < trend.legHigh)) return null;

  const atEq = long ? c.low <= eq : c.high >= eq;
  const hit = gaps.find((g) => intersects(c, g.top, g.bottom));
  if (!atEq && !hit) return null;
  return {
    source: atEq && hit ? 'EQ+FVG' : atEq ? 'EQ' : 'FVG',
    fvgTop: hit ? hit.top : null,
    fvgBottom: hit ? hit.bottom : null,
  };
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
 * Manage one filled position. Intrabar rules are V3.0's frozen conventions:
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

  let hitTp1 = false;
  let tp1Bar = -1;
  let realised = 0;                       // R already booked from the TP1 half
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
    const beArmed = hitTp1 && tp1Bar >= 0 && i > tp1Bar;    // R3
    const stopNow = beArmed ? entry : stop0;                // breakeven / original

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

    // TP1 was booked on an EARLIER bar and TP2 prints now: close the remainder.
    if (hitTp1 && hitT2) return finish('TP2', tp2, 0.5, i);
    // TP2 without TP1 is impossible by construction (TP1 is nearer), but guard:
    if (!hitTp1 && hitT2) {
      hitTp1 = true;
      realised += 0.5 * rOf(tp1);
      legs.push({ price: tp1, weight: 0.5, taker: true });
      return finish('TP2', tp2, 0.5, i);
    }

    if (i + 1 >= TIMEOUT_BARS) {
      return finish(hitTp1 ? 'TP1_THEN_TIMEOUT' : 'TIMEOUT', c.close, hitTp1 ? 0.5 : 1, i);
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
  stopPct: number[]; bars: number[]; tp1R: number[]; tp2R: number[];
  exits: Record<string, number>;
  sources: Record<string, number>;
  breaks: Record<string, number>;
  byDir: Map<string, Sub>; bySym: Map<string, Sub>;
}
const mk = (): Acc => ({
  n: 0, sumG: 0, sumFee: { GROSS: 0, FUT_4: 0, SPOT: 0 },
  nTp1: 0, nTp2: 0, nPos: 0, pos: 0, neg: 0,
  wins: [], losses: [], gs: [], seq: [], stopPct: [], bars: [],
  tp1R: [], tp2R: [], exits: {}, sources: {}, breaks: {},
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

/* ---------------- runner ---------------- */

interface SplitRow {
  symbol: string;
  timeframe: Timeframe;
  trainFromMs: number; trainToMs: number;
  validFromMs: number;
}

async function main(): Promise<void> {
  const cache = arg('cache');
  const outFile = arg('out');
  const doc = JSON.parse(readFileSync(arg('splits'), 'utf8')) as { splits: SplitRow[] };
  const splits = doc.splits.filter((s) => s.timeframe === EXEC_TF);

  const pullbackMode = arg('pullback', 'leg');
  if (pullbackMode !== 'leg' && pullbackMode !== 'same-bar') {
    throw new Error(`--pullback must be "leg" or "same-bar", got "${pullbackMode}"`);
  }
  const only = arg('symbols', '');
  const wanted = only ? only.split(',') : SYMBOLS;
  if (only) console.error(`(smoke run: ${wanted.join(',')})`);

  const settings = Settings.fromDefaults();
  const strength = Math.floor(settings.num('engine.swing_lookback'));
  const atrPeriod = Math.floor(settings.num('risk.atr_period'));
  const volPeriod = Math.floor(settings.num('v2.volume_period'));

  const a = mk();
  let signals = 0, pending = 0, expired = 0, cancelled = 0, rejected = 0, unresolved = 0;
  let candlesIgnoredBeyondTrain = 0;

  for (const b of splits) {
    if (!wanted.includes(b.symbol)) continue;
    if (!(b.trainFromMs < b.trainToMs && b.trainToMs < b.validFromMs)) {
      throw new Error(`${b.symbol}: TRAIN window is not strictly before VALIDATION — refusing`);
    }
    if (!hasSeries(cache, b.symbol, EXEC_TF) || !hasSeries(cache, b.symbol, STRUCT_TF)) {
      throw new Error(`${b.symbol}: cache series missing for ${EXEC_TF}/${STRUCT_TF}`);
    }

    /* ---- HARD TRUNCATION: only TRAIN rows survive the load ---- */
    const execAll = loadSeries(cache, b.symbol, EXEC_TF).filter((c) => c.isClosed);
    const ctxAll = loadSeries(cache, b.symbol, STRUCT_TF).filter((c) => c.isClosed);
    const h1 = execAll.filter((c) => c.openTime >= b.trainFromMs && c.openTime <= b.trainToMs);
    const h4 = ctxAll.filter((c) => c.openTime <= b.trainToMs);
    candlesIgnoredBeyondTrain += (execAll.length - h1.length) + (ctxAll.length - h4.length);

    const htf = buildHtfContext({
      h4,
      emaFast: emaSeries(h4.map((c) => c.close), EMA_FAST),
      emaSlow: emaSeries(h4.map((c) => c.close), EMA_SLOW),
      swings: findSwingsV2(h4, strength),
    });
    const swings1h = findSwingsV2(h1, strength);

    interface Pending {
      dir: Direction; zoneLow: number; zoneHigh: number; stop: number;
      tp1: number; tp2: number; setupIndex: number;
    }
    let pend: Pending | null = null;

    // Amendment 1: which bar last traded into the value zone / a fresh FVG, per
    // direction. Bounded to the current pullback leg by the anchor index below.
    const lastTouchEq = { LONG: -1, SHORT: -1 } as Record<Direction, number>;
    const lastTouchFvg = { LONG: -1, SHORT: -1 } as Record<Direction, number>;

    // Closed-4H-count pointer: advances as 1H time passes. This is the O(1)
    // equivalent of `closedHtfCandles(h4, '4h', c.closeTime).length` — the same
    // `openTime + 4h <= closeTime` rule — and a test pins that equivalence.
    let closed4h = 0;

    for (let i = WARMUP_BARS; i < h1.length; i++) {
      const c = h1[i]!;
      if (c.openTime < b.trainFromMs) continue;
      // (openTime > trainToMs cannot happen: h1 was truncated at load.)

      const span4h = 4 * 3_600_000;
      while (closed4h < h4.length && h4[closed4h]!.openTime + span4h <= c.closeTime) closed4h++;

      const trendHere = htf.trendByClosed[closed4h] ?? null;
      if (trendHere) {
        const long = trendHere.dir === 'LONG';
        const eq = (trendHere.legLow + trendHere.legHigh) / 2;
        if (long ? c.low <= eq : c.high >= eq) lastTouchEq[trendHere.dir] = i;
        const gaps = liveGaps(htf, closed4h, trendHere.dir);
        if (gaps.some((g) => intersects(c, g.top, g.bottom))) lastTouchFvg[trendHere.dir] = i;
      }

      /* ---- advance a pending corridor (N+1 or later) ---- */
      if (pend) {
        const p = pend;
        const long = p.dir === 'LONG';
        const waited = i - p.setupIndex;
        const touches = long ? c.low <= p.zoneHigh : c.high >= p.zoneLow;
        const hitStop = long ? c.low <= p.stop : c.high >= p.stop;

        if (touches && hitStop) {              // ambiguous -> unfavourable
          cancelled++; pend = null;
        } else if (touches) {
          const fill = long ? Math.min(c.open, p.zoneHigh) : Math.max(c.open, p.zoneLow);
          const risk = Math.abs(fill - p.stop);
          const geomOk = risk > 0
            && (long ? p.stop < fill : p.stop > fill)
            && (long ? p.tp1 > fill && p.tp2 > p.tp1 : p.tp1 < fill && p.tp2 < p.tp1);
          if (!geomOk) { rejected++; pend = null; }
          else {
            const bars = h1.slice(i, i + TIMEOUT_BARS + 2);
            const r = manageTrade(p.dir, fill, p.stop, p.tp1, p.tp2, bars);
            if (!r) { unresolved++; pend = null; }
            else {
              a.n++; a.sumG += r.grossR; a.gs.push(r.grossR); a.seq.push(r.grossR);
              a.bars.push(r.barsHeld);
              a.stopPct.push((risk / fill) * 100);
              a.tp1R.push((long ? p.tp1 - fill : fill - p.tp1) / risk);
              a.tp2R.push((long ? p.tp2 - fill : fill - p.tp2) / risk);
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

      /* ---- look for a new pullback-continuation setup on this closed 1H bar ---- */
      if (pend === null) {
        const trend = trendHere;
        if (!trend) continue;
        const long0 = trend.dir === 'LONG';
        // §2.2: an invalidated leg is a reversal, not a pullback.
        if (long0 ? !(c.close > trend.legLow) : !(c.close < trend.legHigh)) continue;

        const br = bodyRatio(c);
        if (br < MIN_BODY_RATIO) continue;
        if (long0 ? !(c.close > c.open) : !(c.close < c.open)) continue;
        const vol = buildVolumeContext(h1, i, volPeriod);
        if (vol.rvol === null || !(vol.rvol > MIN_RVOL)) continue;
        const atr = buildAtrContext(h1, i, atrPeriod).atr;
        if (atr === null || !(atr > 0)) continue;

        const brk = detectStructureBreak(h1, swings1h, i, atr, 0);
        if (!brk || brk.wickOnly || brk.direction !== trend.dir) continue;
        if (brk.levelIndex >= i) continue;

        // Amendment 1: pullback evidence inside the current pullback leg.
        const anchor = brk.levelIndex;
        const eqTouch = lastTouchEq[trend.dir] > anchor ? lastTouchEq[trend.dir] : -1;
        const fvgTouch = lastTouchFvg[trend.dir] > anchor ? lastTouchFvg[trend.dir] : -1;
        if (eqTouch < 0 && fvgTouch < 0) continue;
        if (pullbackMode === 'same-bar' && eqTouch !== i && fvgTouch !== i) continue;
        const hit: PullbackHit = {
          source: eqTouch >= 0 && fvgTouch >= 0 ? 'EQ+FVG' : eqTouch >= 0 ? 'EQ' : 'FVG',
          fvgTop: null,
          fvgBottom: null,
        };

        // Pullback extreme: the deepest excursion of the leg that started at the
        // broken swing. This is the stop anchor the specification names.
        let extreme = trend.dir === 'LONG' ? Infinity : -Infinity;
        for (let m = brk.levelIndex + 1; m <= i; m++) {
          const bar = h1[m]!;
          extreme = trend.dir === 'LONG'
            ? Math.min(extreme, bar.low)
            : Math.max(extreme, bar.high);
        }
        if (!Number.isFinite(extreme)) continue;

        signals++;
        const long = long0;
        const half = CORRIDOR_ATR_FRAC * atr;
        const stop = long
          ? extreme - STOP_BUFFER_ATR * atr
          : extreme + STOP_BUFFER_ATR * atr;
        const leg = trend.legHigh - trend.legLow;
        // TP1: the leg's terminal extreme — where the pullback began.
        // TP2: the 1.5 Fibonacci extension of the same leg.
        const tp1 = long ? trend.legHigh : trend.legLow;
        const tp2 = long
          ? trend.legLow + TP2_FIB_EXT * leg
          : trend.legHigh - TP2_FIB_EXT * leg;
        a.sources[hit.source] = (a.sources[hit.source] ?? 0) + 1;
        a.breaks[brk.type] = (a.breaks[brk.type] ?? 0) + 1;
        pend = {
          dir: trend.dir,
          zoneLow: c.close - half, zoneHigh: c.close + half,
          stop, tp1, tp2, setupIndex: i,
        };
        pending++;
      }
    }
    console.error(`  ${b.symbol} ${EXEC_TF} done`);
  }

  /* ---------------- report ---------------- */
  const gross = a.n ? a.sumG / a.n : 0;
  const sorted = a.gs.slice().sort((x, y) => y - x);
  const drop = (k: number): number => {
    const rest = sorted.slice(Math.min(k, sorted.length));
    return rest.length ? rest.reduce((p, q) => p + q, 0) / rest.length : 0;
  };
  const k1 = Math.max(1, Math.ceil(sorted.length * 0.01));
  const net = (lab: string): number => a.n ? (a.sumG - (a.sumFee[lab] ?? 0)) / a.n : 0;
  const feeDrag = (lab: string): number => a.n ? (a.sumFee[lab] ?? 0) / a.n : 0;

  let vsV30: Record<string, unknown> | null = null;
  try {
    const v30 = JSON.parse(readFileSync(
      'artifacts/research/v30/v30-train-metrics.json', 'utf8')) as Record<string, unknown>;
    vsV30 = {
      source: 'artifacts/research/v30/v30-train-metrics.json',
      n: v30['n'], feeDragR: (v30['feeDragR'] as Record<string, number>)['FUT_4'],
      grossRPerTrade: v30['grossRPerTrade'],
      netRPerTrade: (v30['netRPerTrade'] as Record<string, number>)['FUT_4'],
      profitFactor: v30['profitFactor'], maxDrawdownR: v30['maxDrawdownR'],
      stopDistancePctMedian: (v30['stopDistancePct'] as Record<string, number>)['median'],
      tp1HitRatePct: v30['tp1HitRatePct'], tp2HitRatePct: v30['tp2HitRatePct'],
    };
  } catch { vsV30 = null; }

  const out = {
    strategy: 'V3.1 HTF TREND PULLBACK & MITIGATION',
    preregistration: 'docs/V3_1_HTF_TREND_PULLBACK_PREREGISTRATION.md',
    slice: 'train',
    pullbackMode,
    pullbackWindow: pullbackMode === 'leg'
      ? 'touch anywhere in (broken swing index, N] — Amendment 1, PRIMARY'
      : 'touch on bar N itself — original §2.3(4), SECONDARY',
    execTimeframe: EXEC_TF, structuralTimeframe: STRUCT_TF,
    symbols: wanted,
    constants: {
      EMA_FAST, EMA_SLOW, MIN_BODY_RATIO, MIN_RVOL, CORRIDOR_ATR_FRAC,
      CORRIDOR_EXPIRY_BARS, STOP_BUFFER_ATR, TP2_FIB_EXT, TIMEOUT_BARS,
      MAKER_BPS, TAKER_BPS,
    },
    frozenSurface: { swingStrength: strength, atrPeriod, volumePeriod: volPeriod, srcModified: false },
    guards: {
      trainFromUtc: new Date(splits[0]!.trainFromMs).toISOString(),
      trainToUtc: new Date(splits[0]!.trainToMs).toISOString(),
      validFromUtc: new Date(splits[0]!.validFromMs).toISOString(),
      hardTruncation: 'both series truncated at trainToMs immediately after load',
      candlesIgnoredBeyondTrain,
      candlesBeyondTrainRead: 0,
      candles2026Read: 0,
      warmupBarsSkipped: WARMUP_BARS,
      note: 'no VALIDATION and no TEST candle reaches any computation',
    },
    funnel: {
      signals, pendingCreated: pending, filled: a.n, expired, cancelled, rejected, unresolved,
    },
    pullbackSource: a.sources,
    structureBreakType: a.breaks,
    n: a.n,
    underpowered: a.n < 100,
    tp1HitRatePct: a.n ? +((a.nTp1 / a.n) * 100).toFixed(2) : 0,
    tp2HitRatePct: a.n ? +((a.nTp2 / a.n) * 100).toFixed(2) : 0,
    positiveRRatePct: a.n ? +((a.nPos / a.n) * 100).toFixed(2) : 0,
    stopDistancePct: {
      p25: +qq(a.stopPct, .25).toFixed(4),
      median: +med(a.stopPct).toFixed(4),
      p75: +qq(a.stopPct, .75).toFixed(4),
    },
    targetRMultiple: {
      tp1: { p25: +qq(a.tp1R, .25).toFixed(4), median: +med(a.tp1R).toFixed(4), p75: +qq(a.tp1R, .75).toFixed(4) },
      tp2: { p25: +qq(a.tp2R, .25).toFixed(4), median: +med(a.tp2R).toFixed(4), p75: +qq(a.tp2R, .75).toFixed(4) },
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
      F1_netPositive: { rule: 'net R/trade > 0 at 2/5 bps', value: +net('FUT_4').toFixed(4), passed: net('FUT_4') > 0 },
      F2_feeDrag: { rule: 'fee drag < 0.10 R at 2/5 bps', value: +feeDrag('FUT_4').toFixed(4), passed: feeDrag('FUT_4') < 0.10 },
      F3_tp1Rate: { rule: 'TP1 hit rate >= 40 %', value: a.n ? +((a.nTp1 / a.n) * 100).toFixed(2) : 0, passed: a.n > 0 && (a.nTp1 / a.n) >= 0.40 },
    },
    vsV30Train: vsV30,
  };

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(out, null, 2));

  console.log('');
  console.log(`V3.1 HTF TREND PULLBACK & MITIGATION — TRAIN (pullback=${pullbackMode})`);
  console.log('');
  console.log(`  signals ${signals}  pending ${pending}  filled ${a.n}  expired ${expired}` +
    `  cancelled ${cancelled}  rejected ${rejected}  unresolved ${unresolved}`);
  console.log(`  pullback source ${JSON.stringify(a.sources)}  breaks ${JSON.stringify(a.breaks)}`);
  console.log('');
  console.log('| n | TP1 hit % | TP2 hit % | stop % (med) | fee R | Gross R | Net R @2/5 | PF | MaxDD |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  console.log(`| ${a.n} | ${out.tp1HitRatePct} | ${out.tp2HitRatePct} | `
    + `${out.stopDistancePct.median} | ${out.feeDragR.FUT_4} | ${out.grossRPerTrade} | `
    + `${out.netRPerTrade.FUT_4} | ${out.profitFactor} | ${out.maxDrawdownR} |`);
  console.log('');
  console.log(`F1 net>0 @2/5: ${out.criterion.F1_netPositive.value} -> ${out.criterion.F1_netPositive.passed ? 'PASS' : 'FAIL'}`);
  console.log(`F2 fee drag<0.10: ${out.criterion.F2_feeDrag.value} -> ${out.criterion.F2_feeDrag.passed ? 'HOLDS' : 'FALSIFIED'}`);
  console.log(`F3 TP1>=40%: ${out.criterion.F3_tp1Rate.value} -> ${out.criterion.F3_tp1Rate.passed ? 'HOLDS' : 'FALSIFIED'}`);
  console.log('wrote', outFile);
}

/** Bars skipped at the start of each series, inside TRAIN, before evaluation. */
export const WARMUP_BARS = 60;

const invokedDirectly = process.argv.some((x) => x.includes('v31_trend_pullback'));
if (invokedDirectly) void main();

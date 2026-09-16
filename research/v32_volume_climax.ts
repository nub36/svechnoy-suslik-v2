/**
 * V3.2 — HTF VOLUME CLIMAX & ABSORPTION.
 *
 * Implements docs/V3_2_VOLUME_CLIMAX_PREREGISTRATION.md exactly. Both
 * specification ambiguities are shipped rather than chosen: `--cascade=union`
 * (the largest qualifying k in 3..6, PRIMARY) or `fast3` (k = 3), and
 * `--tp1=cascade` (the 50 % retracement of the cascade leg, PRIMARY) or `ema50`.
 *
 * THESIS: V3.0 fades a LEVEL (a swept 4H swing) and V3.1 joined a TREND. V3.2
 * fades a FLOW EVENT: a >= 2 ATR directional expansion over 3-6 bars that prints
 * a volume climax (RVOL >= 2.2) and an absorption signature (long rejection wick
 * or a strong engulfing reversal). The claim is that such a bar is a forced
 * liquidation cascade the maker has sized into, so price mean-reverts into the
 * cascade's own range rather than continuing.
 *
 * FROZEN SURFACE: nothing under `src/` is modified. `buildAtrContext`,
 * `buildVolumeContext` and `emaSeries` are reused as-is; this file holds only
 * V3.2's cascade detection, absorption test, corridor and trade manager.
 *
 * CAUSALITY (asserted by tests):
 *   - every quantity is a function of bars up to and including the climax bar N
 *     (ATR/RVOL/EMA never look forward);
 *   - the corridor fills from bar N+1, never on the climax bar;
 *   - same-bar ambiguity always resolves against the trade.
 *
 * SCOPE: TRAIN only. The loader reads the 2022-2025 series and truncates it at
 * `trainToMs` BEFORE anything else looks at it; the artifact records how many
 * rows were dropped unread. No candle beyond TRAIN reaches any computation.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Settings } from '../src/core/settings';
import {
  atrSeriesV2, buildVolumeContext, emaSeries,
} from '../src/strategy/v2/indicators';
import { loadSeries, hasSeries } from '../scripts/real-data/load';
import { quantileSorted } from '../scripts/real-data/audit-fee-readonly';
import type { Candle, Timeframe } from '../src/core/types';

/* ---------------- preregistered constants (NOT swept) ---------------- */

export const EXPANSION_ATR_MULT = 2.0;
export const CASCADE_K_MIN = 3;
export const CASCADE_K_MAX = 6;
export const MIN_RVOL = 2.2;              // inclusive, as written (V3.0/V3.1 used >)
export const WICK_FRAC_MIN = 0.40;
export const ENGULF_BODY_MIN = 0.40;
export const CLOSE_TOP_FRAC = 0.70;       // bullish: close in the upper 30 %
export const CLOSE_BOTTOM_FRAC = 0.30;    // bearish: close in the lower 30 %
export const EMA_TP1_PERIOD = 50;
export const CORRIDOR_ATR_FRAC = 0.10;
/** The specification is silent; V3.0's frozen value is inherited deliberately. */
export const CORRIDOR_EXPIRY_BARS = 3;
export const STOP_BUFFER_ATR = 0.15;
export const TIMEOUT_BARS = 48;
export const MAKER_BPS = 2;
export const TAKER_BPS = 5;
/** Bars skipped at the start of the series, inside TRAIN, before evaluation. */
export const WARMUP_BARS = 60;

const EXEC_TF: Timeframe = '1h';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];

export type Direction = 'LONG' | 'SHORT';
export type CascadeMode = 'union' | 'fast3';
export type Tp1Mode = 'cascade' | 'ema50';
export type AbsorptionKind = 'WICK' | 'ENGULF' | 'WICK+ENGULF';
export type ExitReason = 'SL' | 'TP2' | 'TP1_THEN_BE' | 'TP1_THEN_SL'
  | 'TP1_THEN_TIMEOUT' | 'TIMEOUT';

/* ---------------- candle helpers ---------------- */

/** Body / full range of a candle, 0 when the range is degenerate. */
export function bodyRatio(c: Candle): number {
  const range = c.high - c.low;
  if (!(range > 0)) return 0;
  return Math.abs(c.close - c.open) / range;
}

/** Where the close sits in the range, 0 at the low and 1 at the high. */
export function closePosition(c: Candle): number {
  const range = c.high - c.low;
  if (!(range > 0)) return 0;
  return (c.close - c.low) / range;
}

/* ---------------- cascade detection ---------------- */

export interface Cascade {
  /** Reversal direction the cascade invites. */
  dir: Direction;
  /** Window length actually used. */
  k: number;
  /** Index of the window's first bar (N - k). */
  startIndex: number;
  /** Extreme against the cascade (where the move started): TP2 for a fade. */
  origin: number;
  /** Extreme with the cascade (where it ended). */
  terminal: number;
  /** |close(N) - close(N-k)| in ATR units. */
  moveAtr: number;
}

/**
 * Fast directional expansion over the last 3-6 bars.
 *
 * `union` (primary) takes the LARGEST qualifying k, i.e. the earliest origin the
 * specification allows; `fast3` takes k = 3 only. A downward cascade invites a
 * LONG fade and vice versa.
 */
export function detectCascade(
  candles: readonly Candle[], index: number, atr: number, mode: CascadeMode,
): Cascade | null {
  if (!(atr > 0)) return null;
  const close = candles[index]!.close;
  const ks = mode === 'fast3'
    ? [CASCADE_K_MIN]
    : [CASCADE_K_MAX, 5, 4, CASCADE_K_MIN];

  for (const k of ks) {
    const startIndex = index - k;
    if (startIndex < 0) continue;
    const then = candles[startIndex]!.close;
    const signed = close - then;
    if (Math.abs(signed) < EXPANSION_ATR_MULT * atr) continue;

    let high = -Infinity;
    let low = Infinity;
    for (let m = startIndex; m <= index; m++) {
      const bar = candles[m]!;
      high = Math.max(high, bar.high);
      low = Math.min(low, bar.low);
    }
    const down = signed < 0;                       // cascade direction
    return {
      dir: down ? 'LONG' : 'SHORT',                // fade it
      k,
      startIndex,
      origin: down ? high : low,
      terminal: down ? low : high,
      moveAtr: Math.abs(signed) / atr,
    };
  }
  return null;
}

/* ---------------- absorption signature ---------------- */

/**
 * Absorption rejection at the climax bar: a long rejection wick, or a strong
 * body-engulfing reversal closing in the outer 30 % of the range.
 */
export function absorption(
  c: Candle, prev: Candle | undefined, dir: Direction,
): AbsorptionKind | null {
  const range = c.high - c.low;
  if (!(range > 0)) return null;
  const long = dir === 'LONG';

  // The wick branch additionally requires the candle to close with the fade.
  const wick = long
    ? (Math.min(c.open, c.close) - c.low) / range
    : (c.high - Math.max(c.open, c.close)) / range;
  const wickOk = wick >= WICK_FRAC_MIN
    && (long ? c.close > c.open : c.close < c.open);

  let engulfOk = false;
  if (prev) {
    const body = bodyRatio(c);
    const pos = closePosition(c);
    const engulfs = long
      ? prev.close < prev.open && c.close > c.open
        && c.open <= prev.close && c.close >= prev.open
      : prev.close > prev.open && c.close < c.open
        && c.open >= prev.close && c.close <= prev.open;
    const closes = long ? pos >= CLOSE_TOP_FRAC : pos <= CLOSE_BOTTOM_FRAC;
    engulfOk = engulfs && body >= ENGULF_BODY_MIN && closes;
  }

  if (wickOk && engulfOk) return 'WICK+ENGULF';
  if (engulfOk) return 'ENGULF';
  if (wickOk) return 'WICK';
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
 * Manage one filled position. Intrabar rules are the programme's frozen
 * conventions:
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
    const stopNow = beArmed ? entry : stop0;

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

    // TP1 was booked on an EARLIER bar and TP2 prints now.
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
  rvol: number[]; cascadeAtr: number[]; kUsed: number[];
  exits: Record<string, number>;
  absorb: Record<string, number>;
  byDir: Map<string, Sub>; bySym: Map<string, Sub>;
}
const mk = (): Acc => ({
  n: 0, sumG: 0, sumFee: { GROSS: 0, FUT_4: 0, SPOT: 0 },
  nTp1: 0, nTp2: 0, nPos: 0, pos: 0, neg: 0,
  wins: [], losses: [], gs: [], seq: [], stopPct: [], bars: [],
  tp1R: [], tp2R: [], rvol: [], cascadeAtr: [], kUsed: [],
  exits: {}, absorb: {}, byDir: new Map(), bySym: new Map(),
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
const counts = (x: number[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const v of x) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
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
  const cascadeMode = arg('cascade', 'union') as CascadeMode;
  const tp1Mode = arg('tp1', 'cascade') as Tp1Mode;
  if (cascadeMode !== 'union' && cascadeMode !== 'fast3') {
    throw new Error(`--cascade must be "union" or "fast3", got "${cascadeMode}"`);
  }
  if (tp1Mode !== 'cascade' && tp1Mode !== 'ema50') {
    throw new Error(`--tp1 must be "cascade" or "ema50", got "${tp1Mode}"`);
  }
  const only = arg('symbols', '');
  const wanted = only ? only.split(',') : SYMBOLS;

  const doc = JSON.parse(readFileSync(arg('splits'), 'utf8')) as { splits: SplitRow[] };
  const splits = doc.splits.filter((s) => s.timeframe === EXEC_TF);

  const settings = Settings.fromDefaults();
  const atrPeriod = Math.floor(settings.num('risk.atr_period'));
  const volPeriod = Math.floor(settings.num('v2.volume_period'));

  const a = mk();
  let signals = 0, pending = 0, expired = 0, cancelled = 0, rejected = 0, unresolved = 0;
  let queues = 0;                 // cascades seen that failed the climax signature
  let candlesIgnoredBeyondTrain = 0;

  for (const b of splits) {
    if (!wanted.includes(b.symbol)) continue;
    if (!(b.trainFromMs < b.trainToMs && b.trainToMs < b.validFromMs)) {
      throw new Error(`${b.symbol}: TRAIN window is not strictly before VALIDATION — refusing`);
    }
    if (!hasSeries(cache, b.symbol, EXEC_TF)) {
      throw new Error(`${b.symbol}: cache series missing for ${EXEC_TF}`);
    }

    /* ---- HARD TRUNCATION: only TRAIN rows survive the load ---- */
    const all = loadSeries(cache, b.symbol, EXEC_TF).filter((c) => c.isClosed);
    const h1 = all.filter((c) => c.openTime >= b.trainFromMs && c.openTime <= b.trainToMs);
    candlesIgnoredBeyondTrain += all.length - h1.length;

    const ema50 = emaSeries(h1.map((c) => c.close), EMA_TP1_PERIOD);
    // Wilder ATR as a SERIES. `buildAtrContext(h1, i, p)` recomputes the whole
    // ATR from bar 0 on every call, which is O(n) per bar and makes the replay
    // O(n^2); the series is the same recurrence over the same prefix, so the
    // value at `i` is identical. Verified by re-running the artifacts unchanged.
    const atrAll = atrSeriesV2(h1, atrPeriod);

    interface Pending {
      dir: Direction; zoneLow: number; zoneHigh: number; stop: number;
      tp1: number; tp2: number; setupIndex: number;
    }
    let pend: Pending | null = null;

    for (let i = WARMUP_BARS; i < h1.length; i++) {
      const c = h1[i]!;

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

      /* ---- look for a new climax fade on this closed 1H bar ---- */
      if (pend === null) {
        const atr = atrAll[i] ?? null;
        if (atr === null || !(atr > 0)) continue;

        const cascade = detectCascade(h1, i, atr, cascadeMode);
        if (!cascade) continue;

        const vol = buildVolumeContext(h1, i, volPeriod);
        if (vol.rvol === null || !(vol.rvol >= MIN_RVOL)) continue;

        const kind = absorption(c, h1[i - 1], cascade.dir);
        if (!kind) { queues++; continue; }

        signals++;
        const long = cascade.dir === 'LONG';
        const half = CORRIDOR_ATR_FRAC * atr;
        const stop = long ? c.low - STOP_BUFFER_ATR * atr : c.high + STOP_BUFFER_ATR * atr;
        const mid = (cascade.origin + cascade.terminal) / 2;   // 50 % mean reversion
        const tp1 = tp1Mode === 'cascade' ? mid : (ema50[i] ?? mid);
        const tp2 = cascade.origin;                           // the cascade's origin
        a.rvol.push(vol.rvol);
        a.cascadeAtr.push(cascade.moveAtr);
        a.kUsed.push(cascade.k);
        a.absorb[kind] = (a.absorb[kind] ?? 0) + 1;
        pend = {
          dir: cascade.dir,
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

  let vsV31: Record<string, unknown> | null = null;
  try {
    const v31 = JSON.parse(readFileSync(
      'artifacts/research/v31/v31-train-metrics.json', 'utf8')) as Record<string, unknown>;
    vsV31 = {
      source: 'artifacts/research/v31/v31-train-metrics.json',
      n: v31['n'], feeDragR: (v31['feeDragR'] as Record<string, number>)['FUT_4'],
      grossRPerTrade: v31['grossRPerTrade'],
      netRPerTrade: (v31['netRPerTrade'] as Record<string, number>)['FUT_4'],
    };
  } catch { vsV31 = null; }

  const tp1Rate = a.n ? (a.nTp1 / a.n) * 100 : 0;
  const out = {
    strategy: 'V3.2 HTF VOLUME CLIMAX & ABSORPTION',
    preregistration: 'docs/V3_2_VOLUME_CLIMAX_PREREGISTRATION.md',
    cascadeMode, tp1Mode,
    isPrimary: cascadeMode === 'union' && tp1Mode === 'cascade',
    slice: 'train',
    execTimeframe: EXEC_TF,
    symbols: wanted,
    constants: {
      EXPANSION_ATR_MULT, CASCADE_K_MIN, CASCADE_K_MAX, MIN_RVOL, WICK_FRAC_MIN,
      ENGULF_BODY_MIN, CLOSE_TOP_FRAC, CLOSE_BOTTOM_FRAC, EMA_TP1_PERIOD,
      CORRIDOR_ATR_FRAC, CORRIDOR_EXPIRY_BARS, STOP_BUFFER_ATR, TIMEOUT_BARS,
      MAKER_BPS, TAKER_BPS,
    },
    frozenSurface: { atrPeriod, volumePeriod: volPeriod, srcModified: false },
    guards: {
      trainFromUtc: new Date(splits[0]!.trainFromMs).toISOString(),
      trainToUtc: new Date(splits[0]!.trainToMs).toISOString(),
      validFromUtc: new Date(splits[0]!.validFromMs).toISOString(),
      hardTruncation: 'the 1H series is truncated at trainToMs immediately after load',
      candlesIgnoredBeyondTrain,
      candlesBeyondTrainRead: 0,
      candles2026Read: 0,
      warmupBarsSkipped: WARMUP_BARS,
      htfSeriesLoaded: [],
      note: 'no VALIDATION and no TEST candle reaches any computation',
    },
    funnel: {
      cascadesWithVolume: signals,
      cascadesFailingAbsorption: queues,
      pendingCreated: pending, filled: a.n, expired, cancelled, rejected, unresolved,
    },
    absorption: a.absorb,
    cascadeWindowUsed: counts(a.kUsed),
    rvolOfEnteredTrades: {
      p25: +qq(a.rvol, .25).toFixed(2), median: +med(a.rvol).toFixed(2),
      p75: +qq(a.rvol, .75).toFixed(2),
    },
    cascadeSizeAtr: {
      p25: +qq(a.cascadeAtr, .25).toFixed(2), median: +med(a.cascadeAtr).toFixed(2),
      p75: +qq(a.cascadeAtr, .75).toFixed(2),
    },
    n: a.n,
    underpowered: a.n < 100,
    tp1HitRatePct: +tp1Rate.toFixed(2),
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
      F3_tp1Rate: { rule: 'TP1 hit rate >= 50 %', value: +tp1Rate.toFixed(2), passed: a.n > 0 && tp1Rate >= 50 },
    },
    vsV30Train: vsV30,
    vsV31Train: vsV31,
  };

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(out, null, 2));

  console.log('');
  console.log(`V3.2 VOLUME CLIMAX & ABSORPTION — TRAIN (cascade=${cascadeMode}, tp1=${tp1Mode})`);
  console.log('');
  console.log(`  cascades+volume ${signals}  failed absorption ${queues}  filled ${a.n}` +
    `  expired ${expired}  cancelled ${cancelled}  rejected ${rejected}  unresolved ${unresolved}`);
  console.log(`  absorption ${JSON.stringify(a.absorb)}  window k ${JSON.stringify(counts(a.kUsed))}`);
  console.log('');
  console.log('| n | TP1 hit % | TP2 hit % | stop % (med) | fee R | Gross R | Net R @2/5 | PF | MaxDD |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  console.log(`| ${a.n} | ${out.tp1HitRatePct} | ${out.tp2HitRatePct} | `
    + `${out.stopDistancePct.median} | ${out.feeDragR.FUT_4} | ${out.grossRPerTrade} | `
    + `${out.netRPerTrade.FUT_4} | ${out.profitFactor} | ${out.maxDrawdownR} |`);
  console.log('');
  console.log(`F1 net>0 @2/5: ${out.criterion.F1_netPositive.value} -> ${out.criterion.F1_netPositive.passed ? 'PASS' : 'FAIL'}`);
  console.log(`F2 fee drag<0.10: ${out.criterion.F2_feeDrag.value} -> ${out.criterion.F2_feeDrag.passed ? 'HOLDS' : 'FALSIFIED'}`);
  console.log(`F3 TP1>=50%: ${out.criterion.F3_tp1Rate.value} -> ${out.criterion.F3_tp1Rate.passed ? 'HOLDS' : 'FALSIFIED'}`);
  console.log('wrote', outFile);
}

const invokedDirectly = process.argv.some((x) => x.includes('v32_volume_climax'));
if (invokedDirectly) void main();

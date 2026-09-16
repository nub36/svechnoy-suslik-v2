/**
 * V3.3 — HTF ZONE MITIGATION & LTF SQUEEZE.
 *
 * Implements docs/V3_3_HTF_ZONE_MITIGATION_PREREGISTRATION.md, with the
 * tie-breaks registered by AMENDMENT 1 (simultaneous triggers on one bar).
 *
 * THESIS: V3.0 faded a swept level, V3.1 joined a trend, V3.2 faded a 1H flow
 * event and found a zero pre-cost edge. V3.3 asks whether the missing ingredient
 * is CONFLUENCE ACROSS TIMEFRAMES: a fresh 4H zone created by a displacement
 * (order block or imbalance), mitigated by price on the 1H timeframe, plus a 1H
 * exhaustion signature at that zone. Entry is a maker corridor at the trigger
 * close; TP1 is the equilibrium of the leg that created the zone, TP2 the
 * opposing confirmed 4H swing.
 *
 * FROZEN SURFACE: nothing under `src/` is modified. `detectDisplacement`,
 * `buildOrderBlock`, `findFvg`, `findSwingsV2`, `detectStructureBreak`,
 * `atrSeriesV2` and `buildVolumeContext` are reused as-is; this file holds only
 * V3.3's zone bookkeeping, its 1H mitigation tracker and its trade manager.
 *
 * CAUSALITY (asserted by tests):
 *   - a zone is usable only after the 4H bar that revealed it has CLOSED, which
 *     is the `closedHtfCandles` rule `openTime + 4h <= closeTime`;
 *   - the FVG fill tracker reproduces the frozen `findFvg` filledFraction when
 *     fed only closed bars;
 *   - the corridor fills from bar N+1, never on the trigger bar;
 *   - same-bar ambiguity always resolves against the trade.
 *
 * SCOPE: TRAIN only. The loader reads the 2022-2025 series and truncates BOTH
 * the 1H and the 4H series at `trainToMs` before anything else looks at them;
 * the artifact records how many rows were dropped unread.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Settings } from '../src/core/settings';
import { atrSeriesV2, buildVolumeContext } from '../src/strategy/v2/indicators';
import {
  buildOrderBlock, detectDisplacement, detectStructureBreak, findFvg, findSwingsV2,
} from '../src/strategy/v2/structure';
import { loadSeries, hasSeries } from '../scripts/real-data/load';
import { quantileSorted } from '../scripts/real-data/audit-fee-readonly';
import type { Candle, Timeframe } from '../src/core/types';
import type { V2Swing } from '../src/strategy/v2/types';

/* ---------------- preregistered constants (NOT swept) ---------------- */

export const MIN_RVOL = 1.25;             // inclusive, as written
export const WICK_FRAC_MIN = 0.35;
export const RECLAIM_BODY_MIN = 0.40;
export const CLOSE_TOP_FRAC = 0.70;       // bullish: close in the upper 30 %
export const CLOSE_BOTTOM_FRAC = 0.30;
export const CORRIDOR_ATR_FRAC = 0.10;
/** The request is silent; V3.0's frozen value is inherited deliberately. */
export const CORRIDOR_EXPIRY_BARS = 3;
export const STOP_BUFFER_ATR = 0.15;
export const TIMEOUT_BARS = 48;
export const MAKER_BPS = 2;
export const TAKER_BPS = 5;
export const FVG_FILL_MIN = 0.50;         // "fills at least 50 % of the 4H FVG"
/** Bars skipped at the start of the series, inside TRAIN, before evaluation. */
export const WARMUP_BARS = 60;

const EXEC_TF: Timeframe = '1h';
const STRUCT_TF: Timeframe = '4h';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];

export type Direction = 'LONG' | 'SHORT';
export type ZoneType = 'OB' | 'FVG';
export type WindowMode = 'while' | 'first';
export type StopMode = 'protective' | 'climax';
/** Amendment 1: how the leg that produced TP1 is measured. */
export type LegMode = 'displacement' | 'swing';
export type AbsorptionKind = 'WICK' | 'RECLAIM' | 'WICK+RECLAIM';
export type ExitReason = 'SL' | 'TP2' | 'TP1_THEN_BE' | 'TP1_THEN_SL'
  | 'TP1_THEN_TIMEOUT' | 'TIMEOUT';

/* ---------------- candle helpers ---------------- */

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

/** Lower (LONG) / upper (SHORT) rejection wick as a fraction of the range. */
export function rejectionWick(c: Candle, dir: Direction): number {
  const range = c.high - c.low;
  if (!(range > 0)) return 0;
  return dir === 'LONG'
    ? (Math.min(c.open, c.close) - c.low) / range
    : (c.high - Math.max(c.open, c.close)) / range;
}

/* ---------------- zones ---------------- */

export interface Zone {
  id: number;
  type: ZoneType;
  /** Direction the zone invites (a bullish zone invites a LONG fade). */
  dir: Direction;
  zoneLow: number;
  zoneHigh: number;
  /** 4H index of the bar that revealed the zone (its close makes it usable). */
  knownAt4h: number;
  /** The 4H displacement leg that created the zone (primary reading). */
  legLow: number;
  legHigh: number;
  /**
   * Amendment 1: the confirmed 4H swing-to-swing impulse leg in progress when
   * the zone was revealed, frozen at creation; null when the two most recent
   * confirmed swings are not ordered LOW→HIGH / HIGH→LOW.
   */
  swingLegLow: number | null;
  swingLegHigh: number | null;
  /** Displacement strength of the creating move (metadata + tie-break). */
  strength: number;
  /** Origin label; metadata only, never part of the geometry. */
  origin: string;
}

export interface HtfZonesInput {
  h4: readonly Candle[];
  atr4: readonly (number | null)[];
  rvol4: readonly (number | null)[];
  swings4: ReturnType<typeof findSwingsV2>;
  displacementMinBodyAtr: number;
  fvgMinSizeAtr: number;
  /** Amendment 1: ordered swing legs per closed-4H count. */
  levels: SwingLevels;
}

/**
 * Build every 4H zone once per symbol: order blocks from displacement moves and
 * displacement-created fair-value gaps. Only the frozen definitions are used; a
 * zone's `knownAt4h` is the index of the bar whose CLOSE reveals it (the
 * displacement bar for an OB, the third bar for an FVG).
 */
export function buildZones(inp: HtfZonesInput): Zone[] {
  const { h4, atr4, rvol4, swings4, displacementMinBodyAtr, fvgMinSizeAtr, levels } = inp;
  const zones: Zone[] = [];
  let id = 0;

  for (let i = 1; i < h4.length - 1; i++) {
    const atr = atr4[i] ?? null;
    if (atr === null || !(atr > 0)) continue;
    const rvol = rvol4[i] ?? null;
    const disp = detectDisplacement(h4, i, atr, rvol, displacementMinBodyAtr);
    if (!disp) continue;

    // ---- order block from the same displacement ----
    const brk = detectStructureBreak(h4, swings4, i, atr, 0);
    const origin = brk && !brk.wickOnly && brk.direction === disp.direction
      ? brk.type : 'SWEEP_REACTION';
    const ob = buildOrderBlock(h4, disp, origin, i, STRUCT_TF);
    if (ob) {
      let legLow = Infinity;
      let legHigh = -Infinity;
      for (let m = ob.index; m <= i; m++) {
        legLow = Math.min(legLow, h4[m]!.low);
        legHigh = Math.max(legHigh, h4[m]!.high);
      }
      const sl = legAt(levels, disp.direction, i);
      zones.push({
        id: id++, type: 'OB', dir: disp.direction,
        zoneLow: ob.low, zoneHigh: ob.high, knownAt4h: i,
        legLow, legHigh, swingLegLow: sl?.legLow ?? null, swingLegHigh: sl?.legHigh ?? null,
        strength: disp.strength, origin,
      });
    }

    // ---- fair-value gap whose middle bar is this displacement ----
    const gap = findFvg(h4, i, atr, i + 1, STRUCT_TF, fvgMinSizeAtr);
    if (gap) {
      let legLow = Infinity;
      let legHigh = -Infinity;
      for (let m = i - 1; m <= i + 1; m++) {
        legLow = Math.min(legLow, h4[m]!.low);
        legHigh = Math.max(legHigh, h4[m]!.high);
      }
      const sl = legAt(levels, gap.direction, i + 1);
      zones.push({
        id: id++, type: 'FVG', dir: gap.direction,
        zoneLow: gap.bottom, zoneHigh: gap.top, knownAt4h: i + 1,
        legLow, legHigh, swingLegLow: sl?.legLow ?? null, swingLegHigh: sl?.legHigh ?? null,
        strength: disp.strength, origin: gap.direction === 'LONG'
          ? 'BULLISH_IMBALANCE' : 'BEARISH_IMBALANCE',
      });
    }
  }
  return zones;
}

/**
 * The ordered impulse leg in progress when a zone was revealed: computed from
 * the CLOSED count at creation and frozen into the zone (Amendment 1).
 */
export function legAt(
  levels: SwingLevels, dir: Direction, closedCount: number,
): { legLow: number; legHigh: number } | null {
  const table = dir === 'LONG' ? levels.bullLeg : levels.bearLeg;
  return table[closedCount] ?? null;
}
/** Does the bar's range intersect the zone? */
export function intersects(c: Candle, low: number, high: number): boolean {
  return c.low <= high && c.high >= low;
}

/**
 * Fill fraction of a gap after one more bar, exactly as the frozen `findFvg`
 * computes it: the largest single-bar overlap fraction, lifted to 1 when the bar
 * trades fully through the far edge.
 */
export function advanceFill(
  c: Candle, dir: Direction, bottom: number, top: number, current: number,
): number {
  const size = top - bottom;
  if (!(size > 0)) return current;
  const overlapLow = Math.max(bottom, c.low);
  const overlapHigh = Math.min(top, c.high);
  let frac = current;
  if (overlapHigh > overlapLow) {
    frac = Math.max(frac, Math.min(1, (overlapHigh - overlapLow) / size));
  }
  const fullyThrough = dir === 'LONG' ? c.low <= bottom : c.high >= top;
  if (fullyThrough) frac = 1;
  return frac;
}

/* ---------------- mitigation tracking ---------------- */

export interface ZoneWindow {
  zone: Zone;
  /** 1H index from which the zone is known (its revealing 4H bar has closed). */
  startIndex: number;
  /** 1H index of the bar that mitigates the zone. */
  mitigationIndex: number;
  /** 1H index after which the zone is dead (invalidation), or `h1.length`. */
  deathIndex: number;
}

/**
 * Track one zone on the 1H series: when it becomes usable, when it is mitigated
 * (OB: first touch; FVG: fill fraction >= 50 %) and when it dies (OB: a close
 * beyond the far edge; FVG: a full fill). A bar that mitigates AND invalidates
 * kills the zone outright — ambiguity resolves against the trade.
 */
export function trackZone(
  h1: readonly Candle[], zone: Zone, closed4hAt: Int32Array, fvgFillMin = FVG_FILL_MIN,
): ZoneWindow | null {
  const need = zone.knownAt4h + 1;
  let start = -1;
  for (let i = 0; i < h1.length; i++) {
    if (closed4hAt[i]! >= need) { start = i; break; }
  }
  if (start < 0) return null;

  let fill = 0;
  let mitigationIndex = -1;
  let deathIndex = h1.length;

  for (let i = start; i < h1.length; i++) {
    const c = h1[i]!;
    let mitigatedNow = false;
    if (zone.type === 'OB') {
      mitigatedNow = intersects(c, zone.zoneLow, zone.zoneHigh);
    } else {
      fill = advanceFill(c, zone.dir, zone.zoneLow, zone.zoneHigh, fill);
      mitigatedNow = fill >= fvgFillMin;
    }
    const invalid = zone.type === 'OB'
      ? (zone.dir === 'LONG' ? c.close < zone.zoneLow : c.close > zone.zoneHigh)
      : fill >= 1;
    if (invalid) {
      if (mitigationIndex < 0) return null;      // died before it was ever usable
      deathIndex = i;
      break;
    }
    if (mitigationIndex < 0 && mitigatedNow) mitigationIndex = i;
  }
  if (mitigationIndex < 0) return null;
  return { zone, startIndex: start, mitigationIndex, deathIndex };
}

/* ---------------- exhaustion trigger ---------------- */

/** The absorption branch that fires on the trigger bar, if any. */
export function absorption(c: Candle, dir: Direction): AbsorptionKind | null {
  const range = c.high - c.low;
  if (!(range > 0)) return null;
  const wickOk = rejectionWick(c, dir) >= WICK_FRAC_MIN;
  const reclaimOk = bodyRatio(c) >= RECLAIM_BODY_MIN
    && (dir === 'LONG'
      ? closePosition(c) >= CLOSE_TOP_FRAC
      : closePosition(c) <= CLOSE_BOTTOM_FRAC);
  if (wickOk && reclaimOk) return 'WICK+RECLAIM';
  if (reclaimOk) return 'RECLAIM';
  if (wickOk) return 'WICK';
  return null;
}

/* ---------------- fees ---------------- */

export function legFeeR(price: number, weight: number, bps: number, risk: number): number {
  if (!(risk > 0)) return 0;
  return (bps / 10000) * price * weight / risk;
}

/* ---------------- trade simulation ---------------- */

export interface TradeResult {
  exit: ExitReason;
  grossR: number;
  feeR: (makerBps: number, takerBps: number) => number;
  barsHeld: number;
  hitTp1: boolean;
  hitTp2: boolean;
}

/**
 * R1 stop before targets on every bar; R2 TP1 books before TP2; R3 breakeven
 * arms only on bars strictly after the TP1 bar; R4 the stop never moves
 * backwards; R5 the timeout counts the entry bar as bar 1.
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
  let realised = 0;
  const legs: { price: number; weight: number; taker: boolean }[] = [];
  legs.push({ price: entry, weight: 1, taker: false });

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
    const beArmed = hitTp1 && tp1Bar >= 0 && i > tp1Bar;      // R3
    const stopNow = beArmed ? entry : stop0;

    const hitStop = long ? c.low <= stopNow : c.high >= stopNow;
    const hitT1 = !hitTp1 && (long ? c.high >= tp1 : c.low <= tp1);
    const hitT2 = long ? c.high >= tp2 : c.low <= tp2;

    if (hitStop) {                                             // R1
      if (!hitTp1) return finish('SL', stopNow, 1, i);
      return finish(beArmed ? 'TP1_THEN_BE' : 'TP1_THEN_SL', stopNow, 0.5, i);
    }

    if (hitT1) {
      hitTp1 = true; tp1Bar = i;
      realised += 0.5 * rOf(tp1);
      legs.push({ price: tp1, weight: 0.5, taker: true });
      if (hitT2) return finish('TP2', tp2, 0.5, i);            // R2
      if (i + 1 >= TIMEOUT_BARS) return finish('TP1_THEN_TIMEOUT', c.close, 0.5, i);
      continue;
    }

    if (hitTp1 && hitT2) return finish('TP2', tp2, 0.5, i);
    if (!hitTp1 && hitT2) {                                    // impossible, but guard
      hitTp1 = true;
      realised += 0.5 * rOf(tp1);
      legs.push({ price: tp1, weight: 0.5, taker: true });
      return finish('TP2', tp2, 0.5, i);
    }

    if (i + 1 >= TIMEOUT_BARS) {
      return finish(hitTp1 ? 'TP1_THEN_TIMEOUT' : 'TIMEOUT', c.close, hitTp1 ? 0.5 : 1, i);
    }
  }
  return null;
}

/* ---------------- confirmed 4H swings (the TP2 level) ---------------- */

/**
 * Last confirmed 4H swing high/low as a function of the number of CLOSED 4H
 * bars — the incremental equivalent of the V3.0 `confirmedLevels` helper
 * (pinned equal by a test). `byClosed[k]` is what a 1H bar knows when exactly
 * `k` 4H bars have closed.
 */
export interface SwingLevels {
  /** Last confirmed 4H swing high / low per number of CLOSED 4H bars. */
  high: (number | null)[];
  low: (number | null)[];
  /** Amendment 1: the ordered last-two-swing impulse leg, per closed count. */
  bullLeg: ({ legLow: number; legHigh: number } | null)[];
  bearLeg: ({ legLow: number; legHigh: number } | null)[];
}

export function confirmedSwingLevels(
  h4: readonly Candle[], swings: readonly V2Swing[], strength: number,
): SwingLevels {
  void strength;
  const n = h4.length;
  const high: (number | null)[] = new Array(n + 1).fill(null);
  const low: (number | null)[] = new Array(n + 1).fill(null);
  const bullLeg: ({ legLow: number; legHigh: number } | null)[] = new Array(n + 1).fill(null);
  const bearLeg: ({ legLow: number; legHigh: number } | null)[] = new Array(n + 1).fill(null);
  let sw = 0;
  let lastHigh: number | null = null;
  let lastLow: number | null = null;
  // The two most recent confirmed swings, in confirmation order.
  type Swing = { kind: 'HIGH' | 'LOW'; price: number };
  const recent: Swing[] = [];
  for (let k = 0; k <= n; k++) {
    const evalIdx = k - 1;
    while (sw < swings.length && swings[sw]!.confirmedIndex <= evalIdx) {
      const s = swings[sw]!;
      if (s.kind === 'HIGH') lastHigh = s.price;
      else lastLow = s.price;
      recent.push({ kind: s.kind, price: s.price });
      if (recent.length > 2) recent.shift();
      sw++;
    }
    high[k] = lastHigh;
    low[k] = lastLow;
    const older: Swing | undefined = recent[recent.length - 2];
    const newer: Swing | undefined = recent[recent.length - 1];
    bullLeg[k] = older && newer && older.kind === 'LOW' && newer.kind === 'HIGH'
      ? { legLow: older.price, legHigh: newer.price } : null;
    bearLeg[k] = older && newer && older.kind === 'HIGH' && newer.kind === 'LOW'
      ? { legLow: newer.price, legHigh: older.price } : null;
  }
  return { high, low, bullLeg, bearLeg };
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
  zoneSource: Record<string, number>;
  absorb: Record<string, number>;
  wickDirMix: Record<string, number>;
  byDir: Map<string, Sub>; bySym: Map<string, Sub>;
}
const mkAcc = (): Acc => ({
  n: 0, sumG: 0, sumFee: { GROSS: 0, FUT_4: 0, SPOT: 0 },
  nTp1: 0, nTp2: 0, nPos: 0, pos: 0, neg: 0,
  wins: [], losses: [], gs: [], seq: [], stopPct: [], bars: [],
  tp1R: [], tp2R: [], exits: {}, zoneSource: {}, absorb: {}, wickDirMix: {},
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
  const windowMode = arg('window', 'while') as WindowMode;
  const stopMode = arg('stop', 'protective') as StopMode;
  const legMode = arg('leg', 'displacement') as LegMode;
  if (windowMode !== 'while' && windowMode !== 'first') {
    throw new Error(`--window must be "while" or "first", got "${windowMode}"`);
  }
  if (stopMode !== 'protective' && stopMode !== 'climax') {
    throw new Error(`--stop must be "protective" or "climax", got "${stopMode}"`);
  }
  if (legMode !== 'displacement' && legMode !== 'swing') {
    throw new Error(`--leg must be "displacement" or "swing", got "${legMode}"`);
  }
  const only = arg('symbols', '');
  const wanted = only ? only.split(',') : SYMBOLS;

  const doc = JSON.parse(readFileSync(arg('splits'), 'utf8')) as { splits: SplitRow[] };
  const splits = doc.splits.filter((s) => s.timeframe === EXEC_TF);

  const settings = Settings.fromDefaults();
  const strength = Math.floor(settings.num('engine.swing_lookback'));
  const atrPeriod = Math.floor(settings.num('risk.atr_period'));
  const volPeriod = Math.floor(settings.num('v2.volume_period'));
  const dispMinBodyAtr = settings.num('v2.displacement_min_body_atr');
  const fvgMinSizeAtr = settings.num('v2.fvg_min_size_atr');

  const a = mkAcc();
  let zonesTotal = 0, zonesMitigated = 0, zonesDead = 0, zonesSkippedByWarmup = 0;
  const zonesByType: Record<string, number> = {};
  let skippedNoSwingLeg = 0;
  let triggersInZone = 0, multiZoneBars = 0;
  let pending1h = 0, expired = 0, cancelled = 0, rejected = 0, unresolved = 0;
  let triggersWithTp1BehindClose = 0;
  let candlesIgnoredBeyondTrain = 0;
  const htfSeriesLoaded: string[] = [];

  for (const b of splits) {
    if (!wanted.includes(b.symbol)) continue;
    if (!(b.trainFromMs < b.trainToMs && b.trainToMs < b.validFromMs)) {
      throw new Error(`${b.symbol}: TRAIN window is not strictly before VALIDATION — refusing`);
    }
    if (!hasSeries(cache, b.symbol, EXEC_TF) || !hasSeries(cache, b.symbol, STRUCT_TF)) {
      throw new Error(`${b.symbol}: cache series missing for ${EXEC_TF}/${STRUCT_TF}`);
    }
    htfSeriesLoaded.push(`${b.symbol}-${STRUCT_TF}`);

    /* ---- HARD TRUNCATION: only TRAIN rows survive the load ---- */
    const all1 = loadSeries(cache, b.symbol, EXEC_TF).filter((c) => c.isClosed);
    const all4 = loadSeries(cache, b.symbol, STRUCT_TF).filter((c) => c.isClosed);
    const h1 = all1.filter((c) => c.openTime >= b.trainFromMs && c.openTime <= b.trainToMs);
    const h4 = all4.filter((c) => c.openTime <= b.trainToMs);
    candlesIgnoredBeyondTrain += (all1.length - h1.length) + (all4.length - h4.length);

    const atr1 = atrSeriesV2(h1, atrPeriod);
    const atr4 = atrSeriesV2(h4, atrPeriod);
    const rvol4: (number | null)[] = h4.map((_, i) => buildVolumeContext(h4, i, volPeriod).rvol);
    const swings4 = findSwingsV2(h4, strength);
    const levels = confirmedSwingLevels(h4, swings4, strength);

    /* ---- 4H zones ---- */
    const zones = buildZones({
      h4, atr4, rvol4, swings4, displacementMinBodyAtr: dispMinBodyAtr,
      fvgMinSizeAtr: fvgMinSizeAtr, levels,
    });
    zonesTotal += zones.length;
    for (const z of zones) zonesByType[z.type] = (zonesByType[z.type] ?? 0) + 1;

    /* ---- closed-4H-count pointer per 1H bar ---- */
    const span4h = 4 * 3_600_000;
    const closed4hAt = new Int32Array(h1.length);
    {
      let k = 0;
      for (let i = 0; i < h1.length; i++) {
        while (k < h4.length && h4[k]!.openTime + span4h <= h1[i]!.closeTime) k++;
        closed4hAt[i] = k;
      }
    }

    /* ---- mitigation windows per zone ---- */
    const windows: ZoneWindow[] = [];
    for (const z of zones) {
      const w = trackZone(h1, z, closed4hAt, FVG_FILL_MIN);
      if (!w) continue;
      zonesMitigated++;
      if (w.deathIndex < h1.length) zonesDead++;
      windows.push(w);
    }

    /* ---- windows bucketed by their first usable bar ---- */
    const startsAt = new Map<number, ZoneWindow[]>();
    for (const w of windows) {
      if (w.startIndex < WARMUP_BARS) { zonesSkippedByWarmup++; continue; }
      const list = startsAt.get(w.startIndex) ?? [];
      list.push(w);
      startsAt.set(w.startIndex, list);
    }

    interface Pending {
      dir: Direction; zoneLow: number; zoneHigh: number; stop: number;
      tp1: number; tp2: number; setupIndex: number;
    }
    let pend: Pending | null = null;
    let active: ZoneWindow[] = [];

    for (let i = WARMUP_BARS; i < h1.length; i++) {
      const c = h1[i]!;

      /* ---- advance a pending corridor (N+1 or later) ---- */
      if (pend) {
        const p = pend;
        const long = p.dir === 'LONG';
        const waited = i - p.setupIndex;
        const touches = long ? c.low <= p.zoneHigh : c.high >= p.zoneLow;
        const hitStop = long ? c.low <= p.stop : c.high >= p.stop;

        if (touches && hitStop) {
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

      /* ---- refresh the set of mitigations usable at this bar ---- */
      const starting = startsAt.get(i);
      if (starting) active = active.concat(starting);
      if (active.length > 0) active = active.filter((w) => i < w.deathIndex);

      /* ---- look for a new trigger on this closed 1H bar ---- */
      if (pend === null && active.length > 0) {
        const atr = atr1[i] ?? null;
        if (atr !== null && atr > 0) {
          const vol = buildVolumeContext(h1, i, volPeriod);
          if (vol.rvol !== null && vol.rvol >= MIN_RVOL) {
            // Candidates: usable zones whose window contains this bar and whose
            // range intersects the zone AND that pass the exhaustion signature.
            const candidates: { w: ZoneWindow; kind: AbsorptionKind }[] = [];
            for (const w of active) {
              if (w.mitigationIndex > i) continue;
              if (windowMode === 'first' && w.mitigationIndex !== i) continue;
              const z = w.zone;
              if (!intersects(c, z.zoneLow, z.zoneHigh)) continue;
              const kind = absorption(c, z.dir);
              if (!kind) continue;
              candidates.push({ w, kind });
            }
            if (candidates.length > 0) {
              if (candidates.length > 1) multiZoneBars++;
              // AMENDMENT 1 tie-break: the MOST RECENTLY created zone wins;
              // equal creation index is impossible (one zone per id), and an OB
              // precedes the FVG built from the same displacement.
              candidates.sort((x, y) => {
                const kd = y.w.zone.knownAt4h - x.w.zone.knownAt4h;
                if (kd !== 0) return kd;
                return (x.w.zone.type === 'OB' ? 0 : 1) - (y.w.zone.type === 'OB' ? 0 : 1);
              });
              const { w, kind } = candidates[0]!;
              const z = w.zone;
              const long = z.dir === 'LONG';
              const half = CORRIDOR_ATR_FRAC * atr;
              const zoneEdge = long ? z.zoneLow : z.zoneHigh;
              const climax = long ? c.low : c.high;
              const stop = stopMode === 'protective'
                ? (long
                  ? Math.min(climax, zoneEdge) - STOP_BUFFER_ATR * atr
                  : Math.max(climax, zoneEdge) + STOP_BUFFER_ATR * atr)
                : (long
                  ? climax - STOP_BUFFER_ATR * atr
                  : climax + STOP_BUFFER_ATR * atr);
              const closed4h = closed4hAt[i]!;
              const opposing = long ? levels.high[closed4h] : levels.low[closed4h];
              if (opposing === null || opposing === undefined) continue;
              let legLow = z.legLow;
              let legHigh = z.legHigh;
              if (legMode === 'swing') {
                if (z.swingLegLow === null || z.swingLegHigh === null) {
                  skippedNoSwingLeg++;
                  continue;
                }
                legLow = z.swingLegLow;
                legHigh = z.swingLegHigh;
              }
              const tp1 = (legLow + legHigh) / 2;

              triggersInZone++;
              a.zoneSource[z.type] = (a.zoneSource[z.type] ?? 0) + 1;
              a.absorb[kind] = (a.absorb[kind] ?? 0) + 1;
              if (kind !== 'RECLAIM') {
                const closeDir = c.close >= c.open ? 'UP' : 'DOWN';
                const key = `${z.dir}:close${closeDir}`;
                a.wickDirMix[key] = (a.wickDirMix[key] ?? 0) + 1;
              }
              if (long ? !(tp1 > c.close) : !(tp1 < c.close)) triggersWithTp1BehindClose++;
              pend = {
                dir: z.dir,
                zoneLow: c.close - half, zoneHigh: c.close + half,
                stop, tp1, tp2: opposing, setupIndex: i,
              };
              pending1h++;
            }
          }
        }
      }
    }
    console.error(`  ${b.symbol} ${EXEC_TF}: zones ${zones.length}, mitigations ${windows.length}`);
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

  let vsV32: Record<string, unknown> | null = null;
  try {
    const v32 = JSON.parse(readFileSync(
      'artifacts/research/v32/v32-train-metrics.json', 'utf8')) as Record<string, unknown>;
    vsV32 = {
      source: 'artifacts/research/v32/v32-train-metrics.json',
      n: v32['n'], feeDragR: (v32['feeDragR'] as Record<string, number>)['FUT_4'],
      grossRPerTrade: v32['grossRPerTrade'],
      netRPerTrade: (v32['netRPerTrade'] as Record<string, number>)['FUT_4'],
      profitFactor: v32['profitFactor'], maxDrawdownR: v32['maxDrawdownR'],
      tp1HitRatePct: v32['tp1HitRatePct'], tp2HitRatePct: v32['tp2HitRatePct'],
      stopDistancePctMedian: (v32['stopDistancePct'] as Record<string, number>)['median'],
    };
  } catch { vsV32 = null; }

  const tp1Rate = a.n ? (a.nTp1 / a.n) * 100 : 0;
  const out = {
    strategy: 'V3.3 HTF ZONE MITIGATION & LTF SQUEEZE',
    preregistration: 'docs/V3_3_HTF_ZONE_MITIGATION_PREREGISTRATION.md',
    amendment: 'docs/V3_3_HTF_ZONE_MITIGATION_PREREGISTRATION_AMENDMENT_1.md',
    windowMode, stopMode, legMode,
    isPrimary: windowMode === 'while' && stopMode === 'protective' && legMode === 'displacement',
    slice: 'train',
    execTimeframe: EXEC_TF, structuralTimeframe: STRUCT_TF,
    symbols: wanted,
    constants: {
      MIN_RVOL, WICK_FRAC_MIN, RECLAIM_BODY_MIN, CLOSE_TOP_FRAC, CLOSE_BOTTOM_FRAC,
      FVG_FILL_MIN, CORRIDOR_ATR_FRAC, CORRIDOR_EXPIRY_BARS, STOP_BUFFER_ATR,
      TIMEOUT_BARS, MAKER_BPS, TAKER_BPS, WARMUP_BARS,
    },
    frozenSurface: {
      swingStrength: strength, atrPeriod, volumePeriod: volPeriod,
      displacementMinBodyAtr: dispMinBodyAtr, fvgMinSizeAtr, srcModified: false,
    },
    guards: {
      trainFromUtc: new Date(splits[0]!.trainFromMs).toISOString(),
      trainToUtc: new Date(splits[0]!.trainToMs).toISOString(),
      validFromUtc: new Date(splits[0]!.validFromMs).toISOString(),
      hardTruncation: 'both the 1H and the 4H series truncated at trainToMs immediately after load',
      candlesIgnoredBeyondTrain,
      candlesBeyondTrainRead: 0,
      candles2026Read: 0,
      warmupBarsSkipped: WARMUP_BARS,
      htfSeriesLoaded,
      note: 'no VALIDATION and no TEST candle reaches any computation',
    },
    funnel: {
      zonesTotal, zonesMitigated, zonesDead,
      zonesSkippedByWarmup, skippedNoSwingLeg, triggersInZone,
      multiZoneBars, pendingCreated: pending1h,
      filled: a.n, expired, cancelled, rejected, unresolved, triggersWithTp1BehindClose,
    },
    zonesByType,
    zoneSource: a.zoneSource,
    absorption: a.absorb,
    wickTriggerCloseDirection: a.wickDirMix,
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
    vsV32Train: vsV32,
  };

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(out, null, 2));

  console.log('');
  console.log(`V3.3 ZONE MITIGATION & LTF SQUEEZE — TRAIN` +
    ` (window=${windowMode}, stop=${stopMode}, leg=${legMode})`);
  console.log('');
  console.log(`  zones ${zonesTotal}  mitigated ${zonesMitigated}  dead ${zonesDead}` +
    `  triggers ${triggersInZone}  filled ${a.n}  expired ${expired}` +
    `  cancelled ${cancelled}  rejected ${rejected}  unresolved ${unresolved}`);
  console.log(`  zone source ${JSON.stringify(a.zoneSource)}  absorption ${JSON.stringify(a.absorb)}`);
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

const invokedDirectly = process.argv.some((x) => x.includes('v33_zone_mitigation'));
if (invokedDirectly) void main();

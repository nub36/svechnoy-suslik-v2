/**
 * SMC V2 — market structure, range, liquidity, sweep vs breakout.
 *
 * ANTI-LOOK-AHEAD CONTRACT (the most important property in this file):
 *   - A swing pivot at bar p requires `strength` bars on BOTH sides, so it is
 *     confirmed only at p + strength. Every consumer must filter by
 *     `confirmedIndex <= evalIndex`. Helpers here do that for you.
 *   - A structure break is decided by the CLOSE of the breaking bar; a wick
 *     through a level is explicitly NOT a break.
 *   - "held" / "reclaimed" flags only ever consult bars at or before evalIndex.
 */

import type { Candle, Direction, Timeframe } from '../../core/types';
import type {
  BreakoutEvent, Displacement, FairValueGap, FibMap, LiquidityPool,
  OrderBlock, RangeLocation, StructureBias, StructureBreak, SweepEvent,
  V2Range, V2Swing,
} from './types';

/** Map RVOL to 0..1: 0.8x average scores 0, 2.0x scores 1. */
function rvolToScore(rvol: number): number {
  return Math.max(0, Math.min(1, (rvol - 0.8) / 1.2));
}

/* ------------------------------------------------------------------ */
/* Swings                                                              */
/* ------------------------------------------------------------------ */

/**
 * Fractal pivots. A high at i is a pivot when it is the strict maximum of
 * [i-s, i+s]. Confirmed at i+s — never before.
 *
 * Labels (HH/LH/HL/LL) are assigned in confirmation order, so the label a
 * consumer sees is the label that was knowable at the time.
 */
export function findSwingsV2(candles: readonly Candle[], strength: number): V2Swing[] {
  const s = Math.max(1, Math.floor(strength));
  const raw: Omit<V2Swing, 'label'>[] = [];
  for (let i = s; i < candles.length - s; i++) {
    const c = candles[i];
    if (!c) continue;
    let isHigh = true;
    let isLow = true;
    for (let j = i - s; j <= i + s; j++) {
      if (j === i) continue;
      const o = candles[j];
      if (!o) continue;
      if (o.high >= c.high) isHigh = false;
      if (o.low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) {
      raw.push({ kind: 'HIGH', index: i, confirmedIndex: i + s, time: c.openTime, price: c.high });
    }
    if (isLow) {
      raw.push({ kind: 'LOW', index: i, confirmedIndex: i + s, time: c.openTime, price: c.low });
    }
  }
  raw.sort((a, b) => a.index - b.index);

  const out: V2Swing[] = [];
  let lastHigh: number | null = null;
  let lastLow: number | null = null;
  for (const r of raw) {
    let label: V2Swing['label'] = 'FIRST';
    if (r.kind === 'HIGH') {
      if (lastHigh !== null) label = r.price > lastHigh ? 'HH' : 'LH';
      lastHigh = r.price;
    } else {
      if (lastLow !== null) label = r.price > lastLow ? 'HL' : 'LL';
      lastLow = r.price;
    }
    out.push({ ...r, label });
  }
  return out;
}

/** Only pivots whose confirmation bar has already happened. */
export function knownSwings(swings: readonly V2Swing[], atIndex: number): V2Swing[] {
  return swings.filter((s) => s.confirmedIndex <= atIndex);
}

/**
 * Structural bias from the last two confirmed highs and lows.
 *   HH + HL -> BULLISH
 *   LH + LL -> BEARISH
 *   anything else -> RANGE
 */
export function structureBias(swings: readonly V2Swing[], atIndex: number): StructureBias {
  const known = knownSwings(swings, atIndex);
  const highs = known.filter((s) => s.kind === 'HIGH').slice(-2);
  const lows = known.filter((s) => s.kind === 'LOW').slice(-2);
  if (highs.length < 2 || lows.length < 2) return 'RANGE';
  const hh = highs[1]!.price > highs[0]!.price;
  const hl = lows[1]!.price > lows[0]!.price;
  const lh = highs[1]!.price < highs[0]!.price;
  const ll = lows[1]!.price < lows[0]!.price;
  if (hh && hl) return 'BULLISH';
  if (lh && ll) return 'BEARISH';
  return 'RANGE';
}

/* ------------------------------------------------------------------ */
/* BOS / CHoCH                                                         */
/* ------------------------------------------------------------------ */

/**
 * Detect a structure break at `index`.
 *
 * A break requires the bar to CLOSE beyond the most recent confirmed swing in
 * that direction. A wick through the level is recorded (wickOnly = true) but
 * is NOT a break — this is an explicit requirement and is covered by tests.
 *
 * BOS   = break that CONTINUES the prevailing bias.
 * CHoCH = break that OPPOSES the prevailing bias (potential regime change).
 */
export function detectStructureBreak(
  candles: readonly Candle[],
  swings: readonly V2Swing[],
  index: number,
  atr: number | null,
  minPenetrationAtr: number,
): StructureBreak | null {
  const bar = candles[index];
  if (!bar || atr === null || atr <= 0) return null;

  // Swings must be confirmed BEFORE the breaking bar.
  const known = knownSwings(swings, index - 1);
  const priorBias = structureBias(swings, index - 1);

  const lastHigh = [...known].reverse().find((s) => s.kind === 'HIGH');
  const lastLow = [...known].reverse().find((s) => s.kind === 'LOW');

  const mk = (
    direction: Direction,
    level: number,
    levelIndex: number,
  ): StructureBreak => {
    const closeBeyond = direction === 'LONG' ? bar.close - level : level - bar.close;
    const wickBeyond = direction === 'LONG' ? bar.high - level : level - bar.low;
    const wickOnly = closeBeyond <= 0 && wickBeyond > 0;
    const continues =
      (direction === 'LONG' && priorBias === 'BULLISH') ||
      (direction === 'SHORT' && priorBias === 'BEARISH');
    return {
      type: continues ? 'BOS' : 'CHOCH',
      direction,
      index,
      time: bar.openTime,
      level,
      levelIndex,
      penetrationAtr: closeBeyond / atr,
      wickPenetrationAtr: wickBeyond / atr,
      wickOnly,
      reason: wickOnly
        ? `Wick through ${direction === 'LONG' ? 'high' : 'low'} ${level} but no close beyond — not a break`
        : `${continues ? 'BOS' : 'CHoCH'} ${direction}: close ${bar.close} beyond ${level} by ${(closeBeyond / atr).toFixed(2)} ATR`,
    };
  };

  if (lastHigh && bar.high > lastHigh.price) {
    const br = mk('LONG', lastHigh.price, lastHigh.index);
    if (!br.wickOnly && br.penetrationAtr >= minPenetrationAtr) return br;
    return br.wickOnly ? br : null;
  }
  if (lastLow && bar.low < lastLow.price) {
    const br = mk('SHORT', lastLow.price, lastLow.index);
    if (!br.wickOnly && br.penetrationAtr >= minPenetrationAtr) return br;
    return br.wickOnly ? br : null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Range                                                               */
/* ------------------------------------------------------------------ */

/**
 * Build the working range from CONFIRMED structural swings — not from a naive
 * max/min of the last N candles.
 *
 * The range anchors on the highest confirmed swing high and lowest confirmed
 * swing low within the lookback window. Confidence rewards multiple touches
 * and penalises a range that is tiny relative to ATR.
 */
export function buildRange(
  candles: readonly Candle[],
  swings: readonly V2Swing[],
  index: number,
  atr: number | null,
  lookback: number,
  timeframe: Timeframe,
): V2Range | null {
  const known = knownSwings(swings, index).filter((s) => s.index >= index - lookback);
  const highs = known.filter((s) => s.kind === 'HIGH');
  const lows = known.filter((s) => s.kind === 'LOW');
  if (highs.length === 0 || lows.length === 0) return null;

  const topSwing = highs.reduce((a, b) => (b.price > a.price ? b : a));
  const botSwing = lows.reduce((a, b) => (b.price < a.price ? b : a));
  const high = topSwing.price;
  const low = botSwing.price;
  if (!(high > low)) return null;

  const size = high - low;
  const bar = candles[index];
  if (!bar) return null;

  // Touch counting: bars whose extreme came within 10% of the boundary.
  const tol = size * 0.1;
  let touchHigh = 0;
  let touchLow = 0;
  const start = Math.max(0, index - lookback);
  for (let i = start; i <= index; i++) {
    const c = candles[i];
    if (!c) continue;
    if (c.high >= high - tol) touchHigh++;
    if (c.low <= low + tol) touchLow++;
  }

  const establishedAt = Math.max(topSwing.confirmedIndex, botSwing.confirmedIndex);
  const age = index - establishedAt;

  // Confidence: needs real size vs ATR, and evidence both edges are respected.
  const sizeScore = atr !== null && atr > 0 ? Math.min(1, size / (atr * 4)) : 0.5;
  const touchScore = Math.min(1, (Math.min(touchHigh, touchLow) + 1) / 3);
  const ageScore = Math.min(1, Math.max(0, age) / 10);
  const confidence = Math.max(0, Math.min(1, sizeScore * 0.5 + touchScore * 0.3 + ageScore * 0.2));

  return {
    high,
    low,
    mid: (high + low) / 2,
    size,
    age,
    knownAtIndex: establishedAt,
    highIndex: topSwing.index,
    lowIndex: botSwing.index,
    touchCountHigh: touchHigh,
    touchCountLow: touchLow,
    position: Math.max(0, Math.min(1, (bar.close - low) / size)),
    confidence,
    sourceTimeframe: timeframe,
  };
}

/**
 * Where price sits in the range. `edgePct` is the fraction of the range that
 * counts as "at the edge" (default 25%).
 */
export function rangeLocation(range: V2Range | null, edgePct: number): RangeLocation {
  if (!range) return 'MID';
  if (range.position >= 1 - edgePct) return 'HIGH';
  if (range.position <= edgePct) return 'LOW';
  return 'MID';
}

/**
 * Fibonacci map of the range. Anchored low->high; `pricePosition` is the
 * fraction of the range where the close sits, so it reads the same for both
 * directions. 50% is equilibrium.
 */
export function buildFib(range: V2Range | null, close: number): FibMap | null {
  if (!range) return null;
  const { low, size } = range;
  const at = (f: number): number => low + size * f;
  const pos = Math.max(0, Math.min(1, (close - low) / size));
  return {
    level0: low,
    level236: at(0.236),
    level382: at(0.382),
    level500: at(0.5),
    level618: at(0.618),
    level786: at(0.786),
    level1000: range.high,
    pricePosition: pos,
    zone: pos > 0.55 ? 'PREMIUM' : pos < 0.45 ? 'DISCOUNT' : 'EQUILIBRIUM',
  };
}

/* ------------------------------------------------------------------ */
/* Liquidity pools                                                     */
/* ------------------------------------------------------------------ */

/**
 * Liquidity rests above highs (buy-side) and below lows (sell-side).
 * Equal highs/lows within `tolAtr` ATR of each other are clustered into one
 * pool — clustered levels hold more resting orders and are stronger.
 */
export function findLiquidityPools(
  swings: readonly V2Swing[],
  index: number,
  atr: number | null,
  tolAtr: number,
  lookback: number,
): LiquidityPool[] {
  if (atr === null || atr <= 0) return [];
  const tol = atr * tolAtr;
  const known = knownSwings(swings, index).filter((s) => s.index >= index - lookback);
  const out: LiquidityPool[] = [];

  for (const side of ['BUY_SIDE', 'SELL_SIDE'] as const) {
    const kind = side === 'BUY_SIDE' ? 'HIGH' : 'LOW';
    const pts = known.filter((s) => s.kind === kind).sort((a, b) => a.price - b.price);
    let i = 0;
    while (i < pts.length) {
      const group = [pts[i]!];
      let j = i + 1;
      while (j < pts.length && Math.abs(pts[j]!.price - group[0]!.price) <= tol) {
        group.push(pts[j]!);
        j++;
      }
      const prices = group.map((g) => g.price);
      // The pool level is the extreme of the cluster — that is where stops sit.
      const price = side === 'BUY_SIDE' ? Math.max(...prices) : Math.min(...prices);
      const knownAt = Math.max(...group.map((g) => g.confirmedIndex));
      const touches = group.length;
      const age = index - knownAt;
      const ageScore = Math.min(1, Math.max(0, age) / 20);
      const touchScore = Math.min(1, touches / 3);
      out.push({
        side,
        price,
        knownAtIndex: knownAt,
        memberIndexes: group.map((g) => g.index),
        touches,
        strength: Math.max(0, Math.min(1, touchScore * 0.6 + ageScore * 0.4)),
        kind: touches >= 3 ? 'CLUSTER' : touches === 2 ? 'EQUAL' : 'SWING',
      });
      i = j;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Displacement                                                        */
/* ------------------------------------------------------------------ */

/**
 * A displacement bar is a genuine impulse, not noise:
 *   bodyAtr       = |close-open| / ATR
 *   bodyRatio     = |close-open| / (high-low)
 *   closeLocation = (close-low)/(high-low), 1 = closed on the high
 * strength blends these with RVOL and consecutive directional bars.
 */
export function detectDisplacement(
  candles: readonly Candle[],
  index: number,
  atr: number | null,
  rvol: number | null,
  minBodyAtr: number,
): Displacement | null {
  const c = candles[index];
  if (!c || atr === null || atr <= 0) return null;
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range <= 0) return null;
  const bodyAtr = body / atr;
  if (bodyAtr < minBodyAtr) return null;

  const direction: Direction = c.close >= c.open ? 'LONG' : 'SHORT';
  const bodyRatio = body / range;
  const closeLocation = (c.close - c.low) / range;

  let consecutive = 1;
  for (let i = index - 1; i >= 0; i--) {
    const p = candles[i];
    if (!p) break;
    const d: Direction = p.close >= p.open ? 'LONG' : 'SHORT';
    if (d !== direction) break;
    consecutive++;
    if (consecutive >= 5) break;
  }

  const locScore = direction === 'LONG' ? closeLocation : 1 - closeLocation;
  const rvolScore = rvol === null ? 0.5 : Math.max(0, Math.min(1, (rvol - 0.8) / 1.2));
  const strength = Math.max(0, Math.min(1,
    Math.min(1, bodyAtr / 2) * 0.4 +
    bodyRatio * 0.25 +
    locScore * 0.2 +
    rvolScore * 0.15));

  return {
    direction,
    index,
    time: c.openTime,
    bodyAtr,
    bodyRatio,
    closeLocation,
    consecutive,
    rvol: rvol ?? 0,
    strength,
  };
}

/* ------------------------------------------------------------------ */
/* Sweep vs breakout — the core classifier                             */
/* ------------------------------------------------------------------ */

/**
 * A SWEEP takes liquidity beyond a level and then FAILS: price closes back on
 * the original side (reclaim). It implies a REVERSAL.
 *
 * Requirements (all measured, none assumed):
 *   - the bar's extreme penetrates the pool level by >= minPenetrationAtr
 *   - the bar CLOSES back on the original side of the level (reclaim), or
 *     reclaims within `reclaimWindow` known bars
 *   - a rejection wick beyond the level
 *
 * Mere touching of a level is explicitly NOT a sweep.
 */
export function detectSweep(
  candles: readonly Candle[],
  pools: readonly LiquidityPool[],
  index: number,
  atr: number | null,
  rvol: number | null,
  opts: { minPenetrationAtr: number; minWickRatio: number; reclaimWindow: number },
): SweepEvent | null {
  if (atr === null || atr <= 0) return null;
  const evalBar = candles[index];
  if (!evalBar) return null;

  let best: SweepEvent | null = null;

  // Candidate sweep bars: the current bar and up to `reclaimWindow` bars back.
  // Scanning backwards lets a reclaim be confirmed by bars that are ALREADY
  // known at `index` — never by future bars.
  const oldest = Math.max(0, index - opts.reclaimWindow);
  for (let j = index; j >= oldest; j--) {
    const bar = candles[j];
    if (!bar) continue;
    const range = bar.high - bar.low;
    if (range <= 0) continue;

    for (const pool of pools) {
      // The pool must have existed BEFORE the sweeping bar.
      if (pool.knownAtIndex >= j) continue;

      const isBuySide = pool.side === 'BUY_SIDE';
      const penetration = isBuySide ? bar.high - pool.price : pool.price - bar.low;
      if (penetration <= 0) continue;
      const penetrationAtr = penetration / atr;
      if (penetrationAtr < opts.minPenetrationAtr) continue;

      // Reclaim: a close back on the original side, on the sweep bar itself or
      // on any later bar up to and including the evaluation bar.
      let reclaimBars: number | null = null;
      for (let k = j; k <= index; k++) {
        const c = candles[k];
        if (!c) break;
        const back = isBuySide ? c.close < pool.price : c.close > pool.price;
        if (back) {
          reclaimBars = k - j;
          break;
        }
      }
      if (reclaimBars === null) continue;

      const wick = isBuySide
        ? bar.high - Math.max(bar.open, bar.close)
        : Math.min(bar.open, bar.close) - bar.low;
      const wickRatio = wick / range;
      if (wickRatio < opts.minWickRatio) continue;

      const bodyRatio = Math.abs(bar.close - bar.open) / range;
      const rvolScore = rvol === null ? 0.5 : rvolToScore(rvol);
      const quality = Math.max(0, Math.min(1,
        Math.min(1, penetrationAtr / 1.0) * 0.25 +
        wickRatio * 0.25 +
        pool.strength * 0.25 +
        rvolScore * 0.15 +
        (reclaimBars === 0 ? 0.1 : 0.05)));

      const ev: SweepEvent = {
        side: pool.side,
        // Taking buy-side liquidity implies a SHORT reversal, and vice versa.
        direction: isBuySide ? 'SHORT' : 'LONG',
        index: j,
        time: bar.openTime,
        level: pool.price,
        penetrationAtr,
        wickRatio,
        bodyRatio,
        reclaimed: true,
        reclaimBars,
        rvol: rvol ?? 0,
        ageBars: j - pool.knownAtIndex,
        levelStrength: pool.strength,
        quality,
        reason:
          `Swept ${pool.side} at ${pool.price} by ${penetrationAtr.toFixed(2)} ATR, ` +
          `reclaimed after ${reclaimBars} bar(s) (wick ${(wickRatio * 100).toFixed(0)}% of range)`,
      };
      if (!best || ev.quality > best.quality) best = ev;
    }
  }
  return best;
}

/**
 * A BREAKOUT genuinely accepts beyond the level: a decisive CLOSE past it with
 * displacement and no immediate reclaim. It implies CONTINUATION and, crucially,
 * it INVALIDATES the opposite reversal idea at that level.
 */
export function detectBreakout(
  candles: readonly Candle[],
  pools: readonly LiquidityPool[],
  index: number,
  atr: number | null,
  rvol: number | null,
  opts: { minCloseBeyondAtr: number; minBodyAtr: number; holdWindow: number },
): BreakoutEvent | null {
  if (atr === null || atr <= 0) return null;

  let best: BreakoutEvent | null = null;

  // Candidate breakout bars: current bar back to `holdWindow` bars ago, so the
  // "did it hold?" test uses bars already known at `index`.
  const oldest = Math.max(0, index - opts.holdWindow);
  for (let j = index; j >= oldest; j--) {
    const bar = candles[j];
    if (!bar) continue;
    const range = bar.high - bar.low;
    if (range <= 0) continue;

    for (const pool of pools) {
      if (pool.knownAtIndex >= j) continue;
      const isBuySide = pool.side === 'BUY_SIDE';
      const closeBeyond = isBuySide ? bar.close - pool.price : pool.price - bar.close;
      if (closeBeyond <= 0) continue;
      const closeBeyondAtr = closeBeyond / atr;
      if (closeBeyondAtr < opts.minCloseBeyondAtr) continue;

      const body = Math.abs(bar.close - bar.open);
      const displacementAtr = body / atr;
      if (displacementAtr < opts.minBodyAtr) continue;

      const direction: Direction = isBuySide ? 'LONG' : 'SHORT';
      // The breaking candle must itself move in the break direction.
      const barDir: Direction = bar.close >= bar.open ? 'LONG' : 'SHORT';
      if (barDir !== direction) continue;

      // Hold check over bars that are already known at `index`.
      let holdBars = 0;
      let immediateReclaim = false;
      for (let k = j + 1; k <= index; k++) {
        const nxt = candles[k];
        if (!nxt) break;
        const stillBeyond = isBuySide ? nxt.close > pool.price : nxt.close < pool.price;
        if (stillBeyond) holdBars++;
        else {
          immediateReclaim = true;
          break;
        }
      }

      const bodyRatio = body / range;
      const rvolScore = rvol === null ? 0.5 : rvolToScore(rvol);
      const holdScore = immediateReclaim ? 0 : Math.min(1, holdBars / 2);
      const quality = Math.max(0, Math.min(1,
        Math.min(1, closeBeyondAtr / 1.0) * 0.28 +
        Math.min(1, displacementAtr / 1.5) * 0.28 +
        bodyRatio * 0.16 +
        rvolScore * 0.16 +
        holdScore * 0.12));

      const ev: BreakoutEvent = {
        direction,
        index: j,
        time: bar.openTime,
        level: pool.price,
        closeBeyondAtr,
        displacementAtr,
        bodyRatio,
        rvol: rvol ?? 0,
        held: !immediateReclaim,
        holdBars,
        immediateReclaim,
        quality,
        reason:
          `Breakout ${direction}: closed ${closeBeyondAtr.toFixed(2)} ATR beyond ${pool.price} ` +
          `with ${displacementAtr.toFixed(2)} ATR body, held ${holdBars} bar(s)`,
      };
      if (!best || ev.quality > best.quality) best = ev;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Order blocks & FVG                                                  */
/* ------------------------------------------------------------------ */

/**
 * An Order Block is the last opposing candle BEFORE a displacement that is tied
 * to a real structural event — never simply "the last red/green candle".
 *
 * Lifecycle:
 *   FRESH       - created, untouched
 *   TOUCHED     - price traded into the zone
 *   MITIGATED   - price traded through >= 50% of the zone
 *   INVALIDATED - price closed fully beyond the far side
 */
export function buildOrderBlock(
  candles: readonly Candle[],
  displacement: Displacement,
  origin: OrderBlock['origin'],
  evalIndex: number,
  timeframe: Timeframe,
): OrderBlock | null {
  const want: Direction = displacement.direction === 'LONG' ? 'SHORT' : 'LONG';
  let originIdx = -1;
  for (let i = displacement.index - 1; i >= Math.max(0, displacement.index - 5); i--) {
    const c = candles[i];
    if (!c) break;
    const d: Direction = c.close >= c.open ? 'LONG' : 'SHORT';
    if (d === want) {
      originIdx = i;
      break;
    }
  }
  if (originIdx < 0) return null;
  const oc = candles[originIdx]!;

  const ob: OrderBlock = {
    direction: displacement.direction,
    high: oc.high,
    low: oc.low,
    index: originIdx,
    time: oc.openTime,
    knownAtIndex: displacement.index,
    state: 'FRESH',
    stateIndex: displacement.index,
    displacementStrength: displacement.strength,
    origin,
    timeframe,
  };

  // Walk forward ONLY to evalIndex.
  const mid = (ob.high + ob.low) / 2;
  for (let i = displacement.index + 1; i <= evalIndex; i++) {
    const c = candles[i];
    if (!c) break;
    const touched = c.low <= ob.high && c.high >= ob.low;
    if (touched && ob.state === 'FRESH') {
      ob.state = 'TOUCHED';
      ob.stateIndex = i;
    }
    const throughMid = ob.direction === 'LONG' ? c.low <= mid : c.high >= mid;
    if (touched && throughMid && ob.state !== 'INVALIDATED') {
      ob.state = 'MITIGATED';
      ob.stateIndex = i;
    }
    const invalid = ob.direction === 'LONG' ? c.close < ob.low : c.close > ob.high;
    if (invalid) {
      ob.state = 'INVALIDATED';
      ob.stateIndex = i;
      break;
    }
  }
  return ob;
}

/**
 * Fair Value Gap: a 3-bar imbalance where bar[i-1] and bar[i+1] do not overlap.
 *   bullish: low[i+1]  > high[i-1]   -> gap (high[i-1], low[i+1])
 *   bearish: high[i+1] < low[i-1]    -> gap (high[i+1], low[i-1])
 * The FVG is only KNOWN once bar i+1 has closed.
 */
export function findFvg(
  candles: readonly Candle[],
  index: number,
  atr: number | null,
  evalIndex: number,
  timeframe: Timeframe,
  minSizeAtr: number,
): FairValueGap | null {
  const a = candles[index - 1];
  const b = candles[index];
  const c = candles[index + 1];
  if (!a || !b || !c || atr === null || atr <= 0) return null;
  if (index + 1 > evalIndex) return null; // not yet known

  let direction: Direction;
  let top: number;
  let bottom: number;
  if (c.low > a.high) {
    direction = 'LONG';
    bottom = a.high;
    top = c.low;
  } else if (c.high < a.low) {
    direction = 'SHORT';
    bottom = c.high;
    top = a.low;
  } else {
    return null;
  }

  const size = top - bottom;
  const sizeAtr = size / atr;
  if (sizeAtr < minSizeAtr) return null;

  const fvg: FairValueGap = {
    direction,
    top,
    bottom,
    size,
    sizeAtr,
    index,
    time: b.openTime,
    knownAtIndex: index + 1,
    state: 'FRESH',
    filledFraction: 0,
    timeframe,
  };

  for (let i = index + 2; i <= evalIndex; i++) {
    const k = candles[i];
    if (!k) break;
    const overlapLow = Math.max(bottom, k.low);
    const overlapHigh = Math.min(top, k.high);
    if (overlapHigh > overlapLow) {
      const frac = (overlapHigh - overlapLow) / size;
      fvg.filledFraction = Math.max(fvg.filledFraction, Math.min(1, frac));
    }
    const fullyThrough = direction === 'LONG' ? k.low <= bottom : k.high >= top;
    if (fullyThrough) {
      fvg.filledFraction = 1;
      fvg.state = 'FILLED';
      break;
    }
  }
  if (fvg.state !== 'FILLED') {
    fvg.state = fvg.filledFraction > 0.05 ? 'PARTIAL' : 'FRESH';
  }
  return fvg;
}

/**
 * Smart Money factor detectors — THE single engine (no V1/V2).
 *
 * Factor model:
 *   INDEPENDENT  BOS, ORDER_BLOCK, FVG, LIQUIDITY_SWEEP, RANGE_POSITION
 *   CONTEXT      INTERNAL_STRUCTURE
 *   DERIVED      OB_FVG_CONFLUENCE
 *
 * Contract for every detector:
 *  - Input `candles` contains CLOSED candles only.
 *  - A detector may only look at candles[0..evalIndex]; never beyond.
 *  - Each emitted event carries a stable `dedupeKey` describing the underlying
 *    market fact, so scoring can collapse duplicates (anti-double-counting).
 *  - ATR is NOT used by any detector for confirmation (risk module only).
 *
 * The DERIVED factor is produced by `deriveConfluence()`, which runs AFTER the
 * independent detectors and reads their events — it never re-adds their weight.
 */

import type { Candle, DetectorEvent, Direction, FactorId } from '../core/types';
import type { Settings } from '../core/settings';
import {
  clamp01,
  dealingRange,
  findSwings,
  lastSwing,
  smaAt,
  swingsKnownAt,
  type Swing,
} from './structure';

export interface DetectorContext {
  candles: readonly Candle[];
  /** index of candle N — the last CLOSED candle being evaluated */
  evalIndex: number;
  swings: readonly Swing[];
  settings: Settings;
}

export function buildContext(
  candles: readonly Candle[],
  evalIndex: number,
  settings: Settings,
): DetectorContext {
  const strength = settings.num('engine.swing_lookback');
  return { candles, evalIndex, swings: findSwings(candles, strength), settings };
}

/* ------------------------------------------------------------------ */
/* BOS — Break of Structure                     [INDEPENDENT]          */
/* ------------------------------------------------------------------ */
/**
 * Price closes beyond the most recent confirmed swing high (bullish BOS) or
 * swing low (bearish BOS).
 *
 * BOS is about EXTERNAL structure: the confirmed swing pivots. It is kept
 * strictly distinct from INTERNAL_STRUCTURE, which reads the minor
 * (sub-pivot) leg sequence instead.
 */
export function detectBOS(ctx: DetectorContext): DetectorEvent[] {
  const { candles, evalIndex, swings } = ctx;
  const out: DetectorEvent[] = [];
  const ttl = ctx.settings.num('detectors.event_ttl_bars');
  const minBreakPct = ctx.settings.num('detectors.bos_min_break_pct');
  const start = Math.max(1, evalIndex - ttl + 1);

  for (let i = start; i <= evalIndex; i++) {
    const c = candles[i];
    if (!c) continue;
    // Only swings confirmed BEFORE this candle may be broken by it.
    const priorHigh = lastSwing(swings, 'HIGH', i - 1);
    const priorLow = lastSwing(swings, 'LOW', i - 1);

    if (priorHigh && priorHigh.index < i && c.close > priorHigh.price) {
      // Ensure the previous candle had NOT already broken it (edge only).
      const prev = candles[i - 1];
      if (prev && prev.close <= priorHigh.price) {
        const dist = (c.close - priorHigh.price) / priorHigh.price;
        if (dist * 100 >= minBreakPct) {
          out.push({
            detector: 'BOS',
            kind: 'INDEPENDENT',
            direction: 'LONG',
            index: i,
            time: c.openTime,
            strength: clamp01(0.55 + dist * 40),
            reason: `Close ${c.close} broke swing high ${priorHigh.price} (BOS up)`,
            line: { from: priorHigh.time, to: c.openTime, price: priorHigh.price },
            dedupeKey: `BOS:LONG:${priorHigh.time}:${priorHigh.price}`,
          });
        }
      }
    }
    if (priorLow && priorLow.index < i && c.close < priorLow.price) {
      const prev = candles[i - 1];
      if (prev && prev.close >= priorLow.price) {
        const dist = (priorLow.price - c.close) / priorLow.price;
        if (dist * 100 >= minBreakPct) {
          out.push({
            detector: 'BOS',
            kind: 'INDEPENDENT',
            direction: 'SHORT',
            index: i,
            time: c.openTime,
            strength: clamp01(0.55 + dist * 40),
            reason: `Close ${c.close} broke swing low ${priorLow.price} (BOS down)`,
            line: { from: priorLow.time, to: c.openTime, price: priorLow.price },
            dedupeKey: `BOS:SHORT:${priorLow.time}:${priorLow.price}`,
          });
        }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Order Block                                  [INDEPENDENT]          */
/* ------------------------------------------------------------------ */
/**
 * The last opposite-colour candle before an impulsive displacement move.
 * Bullish OB = last down candle before a strong up leg.
 */
export function detectOrderBlock(ctx: DetectorContext): DetectorEvent[] {
  const { candles, evalIndex } = ctx;
  const out: DetectorEvent[] = [];
  const ttl = ctx.settings.num('detectors.event_ttl_bars');
  const minDisp = ctx.settings.num('detectors.ob_min_displacement');
  const maxScan = Math.floor(ctx.settings.num('detectors.ob_lookback_bars'));
  const start = Math.max(2, evalIndex - ttl + 1);

  for (let i = start; i <= evalIndex; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (!c || !prev) continue;

    const body = Math.abs(c.close - c.open);
    const avgBody = smaAt(candles, i - 1, 20, (x) => Math.abs(x.close - x.open));
    if (avgBody === null || avgBody <= 0) continue;
    const displacement = body / avgBody;
    if (displacement < minDisp) continue;

    const bullish = c.close > c.open;
    // find the last opposite candle before the displacement
    let obIdx = -1;
    for (let j = i - 1; j >= Math.max(0, i - maxScan); j--) {
      const o = candles[j];
      if (!o) continue;
      const isOpposite = bullish ? o.close < o.open : o.close > o.open;
      if (isOpposite) {
        obIdx = j;
        break;
      }
    }
    if (obIdx < 0) continue;
    const ob = candles[obIdx];
    if (!ob) continue;

    out.push({
      detector: 'ORDER_BLOCK',
      kind: 'INDEPENDENT',
      direction: bullish ? 'LONG' : 'SHORT',
      index: i,
      time: c.openTime,
      strength: clamp01(0.45 + (displacement - minDisp) * 0.25),
      reason: `${bullish ? 'Bullish' : 'Bearish'} order block at ${ob.low}-${ob.high} before ${displacement.toFixed(1)}x displacement`,
      zone: {
        from: ob.openTime,
        to: c.openTime,
        priceLow: Math.min(ob.low, ob.open, ob.close),
        priceHigh: Math.max(ob.high, ob.open, ob.close),
      },
      dedupeKey: `OB:${bullish ? 'LONG' : 'SHORT'}:${ob.openTime}`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* FVG — Fair Value Gap                         [INDEPENDENT]          */
/* ------------------------------------------------------------------ */
/**
 * Three-candle imbalance: candle i-2 high < candle i low (bullish gap) or
 * candle i-2 low > candle i high (bearish gap).
 */
export function detectFVG(ctx: DetectorContext): DetectorEvent[] {
  const { candles, evalIndex } = ctx;
  const out: DetectorEvent[] = [];
  const ttl = ctx.settings.num('detectors.event_ttl_bars');
  const minPct = ctx.settings.num('detectors.fvg_min_pct');
  const start = Math.max(2, evalIndex - ttl + 1);

  for (let i = start; i <= evalIndex; i++) {
    const a = candles[i - 2];
    const b = candles[i - 1];
    const c = candles[i];
    if (!a || !b || !c) continue;

    if (c.low > a.high) {
      const gap = c.low - a.high;
      const gapPct = (gap / a.high) * 100;
      if (gapPct >= minPct) {
        out.push({
          detector: 'FVG',
          kind: 'INDEPENDENT',
          direction: 'LONG',
          index: i,
          time: c.openTime,
          strength: clamp01(0.35 + gapPct / 2),
          reason: `Bullish FVG ${a.high}-${c.low} (${gapPct.toFixed(2)}%)`,
          zone: { from: a.openTime, to: c.openTime, priceLow: a.high, priceHigh: c.low },
          dedupeKey: `FVG:LONG:${b.openTime}`,
        });
      }
    }
    if (c.high < a.low) {
      const gap = a.low - c.high;
      const gapPct = (gap / c.high) * 100;
      if (gapPct >= minPct) {
        out.push({
          detector: 'FVG',
          kind: 'INDEPENDENT',
          direction: 'SHORT',
          index: i,
          time: c.openTime,
          strength: clamp01(0.35 + gapPct / 2),
          reason: `Bearish FVG ${c.high}-${a.low} (${gapPct.toFixed(2)}%)`,
          zone: { from: a.openTime, to: c.openTime, priceLow: c.high, priceHigh: a.low },
          dedupeKey: `FVG:SHORT:${b.openTime}`,
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Liquidity sweep (stop hunt)                  [INDEPENDENT]          */
/* ------------------------------------------------------------------ */
/**
 * Wick pierces a prior confirmed swing but the candle CLOSES back inside —
 * liquidity taken, rejection confirmed.
 */
export function detectLiquiditySweep(ctx: DetectorContext): DetectorEvent[] {
  const { candles, evalIndex, swings } = ctx;
  const out: DetectorEvent[] = [];
  const ttl = ctx.settings.num('detectors.event_ttl_bars');
  const minWick = ctx.settings.num('detectors.sweep_min_wick_ratio');
  const start = Math.max(1, evalIndex - ttl + 1);

  for (let i = start; i <= evalIndex; i++) {
    const c = candles[i];
    if (!c) continue;
    const range = c.high - c.low;
    if (range <= 0) continue;

    const priorHigh = lastSwing(swings, 'HIGH', i - 1);
    const priorLow = lastSwing(swings, 'LOW', i - 1);

    // Sweep of highs -> bearish (sell-side opportunity)
    if (priorHigh && priorHigh.index < i && c.high > priorHigh.price && c.close < priorHigh.price) {
      const wick = (c.high - Math.max(c.open, c.close)) / range;
      if (wick >= minWick) {
        out.push({
          detector: 'LIQUIDITY_SWEEP',
          kind: 'INDEPENDENT',
          direction: 'SHORT',
          index: i,
          time: c.openTime,
          strength: clamp01(0.4 + wick),
          reason: `Swept highs at ${priorHigh.price}, closed back below (${(wick * 100).toFixed(0)}% wick)`,
          line: { from: priorHigh.time, to: c.openTime, price: priorHigh.price },
          dedupeKey: `SWEEP:SHORT:${priorHigh.time}:${priorHigh.price}`,
        });
      }
    }
    // Sweep of lows -> bullish
    if (priorLow && priorLow.index < i && c.low < priorLow.price && c.close > priorLow.price) {
      const wick = (Math.min(c.open, c.close) - c.low) / range;
      if (wick >= minWick) {
        out.push({
          detector: 'LIQUIDITY_SWEEP',
          kind: 'INDEPENDENT',
          direction: 'LONG',
          index: i,
          time: c.openTime,
          strength: clamp01(0.4 + wick),
          reason: `Swept lows at ${priorLow.price}, closed back above (${(wick * 100).toFixed(0)}% wick)`,
          line: { from: priorLow.time, to: c.openTime, price: priorLow.price },
          dedupeKey: `SWEEP:LONG:${priorLow.time}:${priorLow.price}`,
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Range position                               [INDEPENDENT]          */
/* ------------------------------------------------------------------ */
/**
 * Where price sits inside the current dealing range.
 *
 * This reuses the dealing-range arithmetic that previously powered the
 * premium/discount factor, but the factor EXPOSED to scoring, settings and the
 * UI is RANGE_POSITION. Deep in the range's lower band favours longs (price is
 * cheap relative to the range); the upper band favours shorts.
 */
export function detectRangePosition(ctx: DetectorContext): DetectorEvent[] {
  const { candles, evalIndex, swings } = ctx;
  const dr = dealingRange(candles, swings, evalIndex);
  const c = candles[evalIndex];
  if (!dr || !c) return [];

  // Outer bands only; the middle of a range carries no directional edge.
  const band = ctx.settings.num('detectors.range_edge_band');
  const lower = band;
  const upper = 1 - band;

  if (dr.position <= lower) {
    return [
      {
        detector: 'RANGE_POSITION',
        kind: 'INDEPENDENT',
        direction: 'LONG',
        index: evalIndex,
        time: c.openTime,
        strength: clamp01(((lower - dr.position) / lower) * 0.8 + 0.2),
        reason: `Price at ${(dr.position * 100).toFixed(0)}% of dealing range ${dr.low}-${dr.high} (lower band)`,
        zone: {
          from: candles[0]?.openTime ?? c.openTime,
          to: c.openTime,
          priceLow: dr.low,
          priceHigh: dr.mid,
        },
        dedupeKey: `RANGE:LONG:${dr.low}:${dr.high}`,
      },
    ];
  }
  if (dr.position >= upper) {
    return [
      {
        detector: 'RANGE_POSITION',
        kind: 'INDEPENDENT',
        direction: 'SHORT',
        index: evalIndex,
        time: c.openTime,
        strength: clamp01(((dr.position - upper) / (1 - upper)) * 0.8 + 0.2),
        reason: `Price at ${(dr.position * 100).toFixed(0)}% of dealing range ${dr.low}-${dr.high} (upper band)`,
        zone: {
          from: candles[0]?.openTime ?? c.openTime,
          to: c.openTime,
          priceLow: dr.mid,
          priceHigh: dr.high,
        },
        dedupeKey: `RANGE:SHORT:${dr.low}:${dr.high}`,
      },
    ];
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* Internal structure                           [CONTEXT]              */
/* ------------------------------------------------------------------ */
/**
 * Internal (minor) market structure — the CONTEXT factor.
 *
 * Where BOS looks at CONFIRMED swing pivots (external structure) and fires on
 * the single candle that breaks one, INTERNAL_STRUCTURE describes the shape of
 * the recent leg sequence: it measures whether the minor highs and lows
 * between the major pivots are stepping up (bullish internal structure) or
 * stepping down (bearish internal structure).
 *
 * Deliberate differences from BOS, so the two never duplicate each other:
 *   - uses a SMALLER pivot strength (minor legs, not confirmed major swings)
 *   - is a continuous state describing the whole window, not a break event
 *   - emits at most ONE event, always at the evaluation candle
 *   - never references the swing levels BOS breaks
 */
export function detectInternalStructure(ctx: DetectorContext): DetectorEvent[] {
  const { candles, evalIndex, settings } = ctx;
  const c = candles[evalIndex];
  if (!c) return [];

  const minorStrength = Math.max(
    1,
    Math.floor(settings.num('detectors.internal_structure_strength')),
  );
  const legs = Math.max(2, Math.floor(settings.num('detectors.internal_structure_legs')));

  // Minor pivots, strictly causal: a pivot at p is only known at p+strength.
  const minor = findSwings(candles, minorStrength);
  const known = swingsKnownAt(minor, evalIndex);
  const highs = known.filter((s) => s.kind === 'HIGH').slice(-legs);
  const lows = known.filter((s) => s.kind === 'LOW').slice(-legs);
  if (highs.length < 2 || lows.length < 2) return [];

  // Count rising/falling steps across the minor legs.
  let up = 0;
  let down = 0;
  let steps = 0;
  for (let i = 1; i < highs.length; i++) {
    const a = highs[i - 1];
    const b = highs[i];
    if (!a || !b) continue;
    steps++;
    if (b.price > a.price) up++;
    else if (b.price < a.price) down++;
  }
  for (let i = 1; i < lows.length; i++) {
    const a = lows[i - 1];
    const b = lows[i];
    if (!a || !b) continue;
    steps++;
    if (b.price > a.price) up++;
    else if (b.price < a.price) down++;
  }
  if (steps === 0) return [];

  const net = up - down;
  if (net === 0) return []; // balanced internal structure = no context bias

  const direction: Direction = net > 0 ? 'LONG' : 'SHORT';
  const agreement = Math.abs(net) / steps; // 0..1
  // A clean, fully-aligned internal structure is worth the most.
  const strength = clamp01(0.35 + agreement * 0.65);

  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];

  return [
    {
      detector: 'INTERNAL_STRUCTURE',
      kind: 'CONTEXT',
      direction,
      index: evalIndex,
      time: c.openTime,
      strength,
      reason:
        `Internal structure ${direction === 'LONG' ? 'bullish' : 'bearish'}: ` +
        `${up} rising / ${down} falling minor legs (${(agreement * 100).toFixed(0)}% aligned)`,
      line:
        lastHigh && lastLow
          ? {
              from: Math.min(lastHigh.time, lastLow.time),
              to: c.openTime,
              price: direction === 'LONG' ? lastLow.price : lastHigh.price,
            }
          : undefined,
      dedupeKey: `INTSTRUCT:${direction}:${c.openTime}`,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* OB + FVG confluence                          [DERIVED]              */
/* ------------------------------------------------------------------ */
/**
 * DERIVED factor: an order block whose zone overlaps a fair value gap in the
 * same direction. Institutional demand/supply sitting inside an imbalance is
 * a stronger setup than either fact alone.
 *
 * CRITICAL — anti-double-counting:
 * this factor contributes ONLY its own small configurable bonus weight. The OB
 * and FVG parents keep contributing exactly once each through their own
 * weights; nothing here re-adds `ORDER_BLOCK.weight` or `FVG.weight`. The
 * parent dedupeKeys are recorded in `derivedFrom` so the breakdown is
 * auditable.
 *
 * Runs after the independent detectors and reads their events.
 */
export function deriveConfluence(
  events: readonly DetectorEvent[],
  ctx: DetectorContext,
): DetectorEvent[] {
  const { settings } = ctx;
  const minOverlap = settings.num('detectors.confluence_min_overlap_pct');
  const out: DetectorEvent[] = [];

  const obs = events.filter((e) => e.detector === 'ORDER_BLOCK' && e.zone);
  const fvgs = events.filter((e) => e.detector === 'FVG' && e.zone);

  for (const direction of ['LONG', 'SHORT'] as const) {
    const dirObs = obs.filter((e) => e.direction === direction);
    const dirFvgs = fvgs.filter((e) => e.direction === direction);

    // Keep only the single best pairing per direction — one derived factor,
    // one bonus, no stacking across many OB/FVG combinations.
    let best: { ob: DetectorEvent; fvg: DetectorEvent; overlap: number } | null = null;

    for (const ob of dirObs) {
      for (const fvg of dirFvgs) {
        const oz = ob.zone;
        const fz = fvg.zone;
        if (!oz || !fz) continue;

        const lo = Math.max(oz.priceLow, fz.priceLow);
        const hi = Math.min(oz.priceHigh, fz.priceHigh);
        const overlapHeight = hi - lo;
        if (overlapHeight <= 0) continue;

        // Overlap as a fraction of the SMALLER zone: a tiny gap fully inside a
        // big order block still counts as real confluence.
        const obH = oz.priceHigh - oz.priceLow;
        const fvgH = fz.priceHigh - fz.priceLow;
        const smaller = Math.min(obH, fvgH);
        if (smaller <= 0) continue;
        const overlapPct = (overlapHeight / smaller) * 100;
        if (overlapPct < minOverlap) continue;

        if (best === null || overlapPct > best.overlap) {
          best = { ob, fvg, overlap: overlapPct };
        }
      }
    }

    if (best === null) continue;

    const { ob, fvg, overlap } = best;
    // Confluence strength blends how much the zones agree with how strong the
    // two parents were. It is NOT the sum of the parents' contributions.
    const confluenceStrength = clamp01(
      (Math.min(overlap, 100) / 100) * 0.5 + ((ob.strength + fvg.strength) / 2) * 0.5,
    );
    const index = Math.max(ob.index, fvg.index);
    const time = Math.max(ob.time, fvg.time);
    const oz = ob.zone;
    const fz = fvg.zone;

    out.push({
      detector: 'OB_FVG_CONFLUENCE',
      kind: 'DERIVED',
      direction,
      index,
      time,
      strength: confluenceStrength,
      reason:
        `Order block overlaps ${direction === 'LONG' ? 'bullish' : 'bearish'} FVG ` +
        `by ${overlap.toFixed(0)}% (bonus only — OB and FVG weights counted once each)`,
      zone:
        oz && fz
          ? {
              from: Math.min(oz.from, fz.from),
              to: time,
              priceLow: Math.max(oz.priceLow, fz.priceLow),
              priceHigh: Math.min(oz.priceHigh, fz.priceHigh),
            }
          : undefined,
      dedupeKey: `CONFLUENCE:${direction}:${ob.dedupeKey}:${fvg.dedupeKey}`,
      derivedFrom: [ob.dedupeKey, fvg.dedupeKey],
    });
  }

  return out;
}

export type DetectorFn = (ctx: DetectorContext) => DetectorEvent[];

/**
 * Independent + context detectors, keyed by factor id.
 * The DERIVED factor is not here — it is produced by `deriveConfluence()`
 * after these have run.
 */
export const DETECTORS: Partial<Record<FactorId, DetectorFn>> = {
  BOS: detectBOS,
  ORDER_BLOCK: detectOrderBlock,
  FVG: detectFVG,
  LIQUIDITY_SWEEP: detectLiquiditySweep,
  RANGE_POSITION: detectRangePosition,
  INTERNAL_STRUCTURE: detectInternalStructure,
};

/**
 * Smart Money detectors — THE single engine (no V1/V2).
 *
 * Contract for every detector:
 *  - Input `candles` contains CLOSED candles only.
 *  - A detector may only look at candles[0..evalIndex]; never beyond.
 *  - Each emitted event carries a stable `dedupeKey` describing the underlying
 *    market fact, so scoring can collapse duplicates (anti-double-counting).
 *  - ATR is NOT used by any detector for confirmation (risk module only).
 */

import type { Candle, DetectorEvent, Direction } from '../core/types';
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
/* BOS — Break of Structure                                            */
/* ------------------------------------------------------------------ */
/**
 * Price closes beyond the most recent confirmed swing high (bullish BOS) or
 * swing low (bearish BOS) — continuation of the prevailing structure.
 */
export function detectBOS(ctx: DetectorContext): DetectorEvent[] {
  const { candles, evalIndex, swings } = ctx;
  const out: DetectorEvent[] = [];
  const ttl = ctx.settings.num('detectors.event_ttl_bars');
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
        out.push({
          detector: 'BOS',
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
    if (priorLow && priorLow.index < i && c.close < priorLow.price) {
      const prev = candles[i - 1];
      if (prev && prev.close >= priorLow.price) {
        const dist = (priorLow.price - c.close) / priorLow.price;
        out.push({
          detector: 'BOS',
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
  return out;
}

/* ------------------------------------------------------------------ */
/* CHoCH — Change of Character                                         */
/* ------------------------------------------------------------------ */
/**
 * A break AGAINST the prevailing structural trend: the first sign of reversal.
 * Distinguished from BOS by the trend that preceded it.
 */
export function detectCHOCH(ctx: DetectorContext): DetectorEvent[] {
  const { candles, evalIndex, swings } = ctx;
  const out: DetectorEvent[] = [];
  const ttl = ctx.settings.num('detectors.event_ttl_bars');
  const start = Math.max(2, evalIndex - ttl + 1);

  for (let i = start; i <= evalIndex; i++) {
    const c = candles[i];
    if (!c) continue;
    const known = swingsKnownAt(swings, i - 1);
    const highs = known.filter((s) => s.kind === 'HIGH');
    const lows = known.filter((s) => s.kind === 'LOW');
    if (highs.length < 2 || lows.length < 2) continue;

    const h1 = highs[highs.length - 2] as Swing;
    const h2 = highs[highs.length - 1] as Swing;
    const l1 = lows[lows.length - 2] as Swing;
    const l2 = lows[lows.length - 1] as Swing;

    const wasDown = h2.price < h1.price && l2.price < l1.price;
    const wasUp = h2.price > h1.price && l2.price > l1.price;
    const prev = candles[i - 1];
    if (!prev) continue;

    // Downtrend broken to the upside -> bullish CHoCH
    if (wasDown && c.close > h2.price && prev.close <= h2.price) {
      out.push({
        detector: 'CHOCH',
        direction: 'LONG',
        index: i,
        time: c.openTime,
        strength: clamp01(0.6 + ((c.close - h2.price) / h2.price) * 40),
        reason: `Downtrend reversed: close ${c.close} > lower-high ${h2.price} (CHoCH up)`,
        line: { from: h2.time, to: c.openTime, price: h2.price },
        dedupeKey: `CHOCH:LONG:${h2.time}:${h2.price}`,
      });
    }
    // Uptrend broken to the downside -> bearish CHoCH
    if (wasUp && c.close < l2.price && prev.close >= l2.price) {
      out.push({
        detector: 'CHOCH',
        direction: 'SHORT',
        index: i,
        time: c.openTime,
        strength: clamp01(0.6 + ((l2.price - c.close) / l2.price) * 40),
        reason: `Uptrend reversed: close ${c.close} < higher-low ${l2.price} (CHoCH down)`,
        line: { from: l2.time, to: c.openTime, price: l2.price },
        dedupeKey: `CHOCH:SHORT:${l2.time}:${l2.price}`,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Order Block                                                         */
/* ------------------------------------------------------------------ */
/**
 * The last opposite-colour candle before an impulsive displacement move.
 * Bullish OB = last down candle before a strong up leg.
 */
export function detectOrderBlock(ctx: DetectorContext): DetectorEvent[] {
  const { candles, evalIndex } = ctx;
  const out: DetectorEvent[] = [];
  const ttl = ctx.settings.num('detectors.event_ttl_bars');
  const start = Math.max(2, evalIndex - ttl + 1);

  for (let i = start; i <= evalIndex; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (!c || !prev) continue;

    const body = Math.abs(c.close - c.open);
    const avgBody = smaAt(candles, i - 1, 20, (x) => Math.abs(x.close - x.open));
    if (avgBody === null || avgBody <= 0) continue;
    const displacement = body / avgBody;
    if (displacement < 1.6) continue;

    const bullish = c.close > c.open;
    // find the last opposite candle before the displacement
    let obIdx = -1;
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
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
      direction: bullish ? 'LONG' : 'SHORT',
      index: i,
      time: c.openTime,
      strength: clamp01(0.45 + (displacement - 1.6) * 0.25),
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
/* FVG — Fair Value Gap                                                */
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
/* Liquidity sweep (stop hunt)                                         */
/* ------------------------------------------------------------------ */
/**
 * Wick pierces a prior confirmed swing but the candle CLOSES back inside —
 * liquidity taken, rejection confirmed.
 */
export function detectLiquiditySweep(ctx: DetectorContext): DetectorEvent[] {
  const { candles, evalIndex, swings } = ctx;
  const out: DetectorEvent[] = [];
  const ttl = ctx.settings.num('detectors.event_ttl_bars');
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
      out.push({
        detector: 'LIQUIDITY_SWEEP',
        direction: 'SHORT',
        index: i,
        time: c.openTime,
        strength: clamp01(0.4 + wick),
        reason: `Swept highs at ${priorHigh.price}, closed back below (${(wick * 100).toFixed(0)}% wick)`,
        line: { from: priorHigh.time, to: c.openTime, price: priorHigh.price },
        dedupeKey: `SWEEP:SHORT:${priorHigh.time}:${priorHigh.price}`,
      });
    }
    // Sweep of lows -> bullish
    if (priorLow && priorLow.index < i && c.low < priorLow.price && c.close > priorLow.price) {
      const wick = (Math.min(c.open, c.close) - c.low) / range;
      out.push({
        detector: 'LIQUIDITY_SWEEP',
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
  return out;
}

/* ------------------------------------------------------------------ */
/* Equal highs / lows                                                  */
/* ------------------------------------------------------------------ */
/** Two confirmed swings at (nearly) the same price = resting liquidity pool. */
export function detectEqualLevels(ctx: DetectorContext): DetectorEvent[] {
  const { evalIndex, swings, candles } = ctx;
  const out: DetectorEvent[] = [];
  const tol = ctx.settings.num('detectors.equal_level_tolerance_pct');
  const known = swingsKnownAt(swings, evalIndex);
  const cur = candles[evalIndex];
  if (!cur) return out;

  for (const kind of ['HIGH', 'LOW'] as const) {
    const list = known.filter((s) => s.kind === kind).slice(-4);
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const s1 = list[a];
        const s2 = list[b];
        if (!s1 || !s2) continue;
        const diff = Math.abs(s1.price - s2.price) / ((s1.price + s2.price) / 2) * 100;
        if (diff > tol) continue;
        // Equal highs -> liquidity above -> price likely draws up then reverses:
        // treat as SHORT bias target (liquidity above) and vice versa.
        const direction: Direction = kind === 'HIGH' ? 'SHORT' : 'LONG';
        out.push({
          detector: 'EQUAL_LEVELS',
          direction,
          index: evalIndex,
          time: cur.openTime,
          strength: clamp01(0.5 - diff / (tol * 2) * 0.2),
          reason: `Equal ${kind === 'HIGH' ? 'highs' : 'lows'} at ~${s2.price.toFixed(6)} (${diff.toFixed(3)}% apart) = liquidity pool`,
          line: { from: s1.time, to: cur.openTime, price: (s1.price + s2.price) / 2 },
          dedupeKey: `EQL:${kind}:${s1.time}:${s2.time}`,
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Premium / Discount                                                  */
/* ------------------------------------------------------------------ */
/** Position within the dealing range: discount favours longs, premium shorts. */
export function detectPremiumDiscount(ctx: DetectorContext): DetectorEvent[] {
  const { candles, evalIndex, swings } = ctx;
  const dr = dealingRange(candles, swings, evalIndex);
  const c = candles[evalIndex];
  if (!dr || !c) return [];

  // Only meaningful in the outer thirds of the range.
  if (dr.position <= 0.35) {
    return [
      {
        detector: 'PREMIUM_DISCOUNT',
        direction: 'LONG',
        index: evalIndex,
        time: c.openTime,
        strength: clamp01((0.35 - dr.position) / 0.35 * 0.8 + 0.2),
        reason: `Price in discount zone (${(dr.position * 100).toFixed(0)}% of range ${dr.low}-${dr.high})`,
        zone: { from: candles[0]?.openTime ?? c.openTime, to: c.openTime, priceLow: dr.low, priceHigh: dr.mid },
        dedupeKey: `PD:LONG:${dr.low}:${dr.high}`,
      },
    ];
  }
  if (dr.position >= 0.65) {
    return [
      {
        detector: 'PREMIUM_DISCOUNT',
        direction: 'SHORT',
        index: evalIndex,
        time: c.openTime,
        strength: clamp01((dr.position - 0.65) / 0.35 * 0.8 + 0.2),
        reason: `Price in premium zone (${(dr.position * 100).toFixed(0)}% of range ${dr.low}-${dr.high})`,
        zone: { from: candles[0]?.openTime ?? c.openTime, to: c.openTime, priceLow: dr.mid, priceHigh: dr.high },
        dedupeKey: `PD:SHORT:${dr.low}:${dr.high}`,
      },
    ];
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* Volume imbalance                                                    */
/* ------------------------------------------------------------------ */
/** Volume surge relative to its SMA, directional by candle body. */
export function detectVolumeImbalance(ctx: DetectorContext): DetectorEvent[] {
  const { candles, evalIndex } = ctx;
  const out: DetectorEvent[] = [];
  const ttl = ctx.settings.num('detectors.event_ttl_bars');
  const mult = ctx.settings.num('detectors.volume_surge_mult');
  const start = Math.max(20, evalIndex - ttl + 1);

  for (let i = start; i <= evalIndex; i++) {
    const c = candles[i];
    if (!c) continue;
    const avg = smaAt(candles, i - 1, 20, (x) => x.volume);
    if (avg === null || avg <= 0) continue;
    const ratio = c.volume / avg;
    if (ratio < mult) continue;
    const range = c.high - c.low;
    if (range <= 0) continue;
    const bodyRatio = Math.abs(c.close - c.open) / range;
    if (bodyRatio < 0.5) continue; // need conviction, not a doji
    const direction: Direction = c.close > c.open ? 'LONG' : 'SHORT';
    out.push({
      detector: 'VOLUME_IMBALANCE',
      direction,
      index: i,
      time: c.openTime,
      strength: clamp01(0.3 + (ratio - mult) * 0.15 + bodyRatio * 0.3),
      reason: `Volume ${ratio.toFixed(1)}x average with ${(bodyRatio * 100).toFixed(0)}% body`,
      dedupeKey: `VOL:${direction}:${c.openTime}`,
    });
  }
  return out;
}

export type DetectorFn = (ctx: DetectorContext) => DetectorEvent[];

export const DETECTORS: Record<string, DetectorFn> = {
  BOS: detectBOS,
  CHOCH: detectCHOCH,
  ORDER_BLOCK: detectOrderBlock,
  FVG: detectFVG,
  LIQUIDITY_SWEEP: detectLiquiditySweep,
  EQUAL_LEVELS: detectEqualLevels,
  PREMIUM_DISCOUNT: detectPremiumDiscount,
  VOLUME_IMBALANCE: detectVolumeImbalance,
};

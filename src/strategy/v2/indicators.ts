/**
 * SMC V2 — indicator mathematics.
 *
 * Every function here is CAUSAL: the value at index i depends only on
 * candles[0..i]. No function may look at i+1. This is asserted by tests.
 *
 * The exact formulas are documented in docs/STRATEGY.md; the implementations
 * below are the single source of truth and the doc must match them.
 */

import type { Candle } from '../../core/types';
import type {
  AdxContext, AdxRegime, AtrContext, EmaContext, MacdContext, RsiContext,
  StructureBias, VolatilityRegime, VolumeContext,
} from './types';

const last = <T>(a: readonly T[]): T | undefined => a[a.length - 1];

/* ------------------------------------------------------------------ */
/* EMA                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Exponential moving average.
 *   k        = 2 / (period + 1)
 *   EMA[t]   = price[t] * k + EMA[t-1] * (1 - k)
 *   EMA[p-1] = SMA(price[0..p-1])        (seed)
 * Returns an array aligned to `values`, null until the seed bar.
 */
export function emaSeries(values: readonly number[], period: number): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (period < 1 || n < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i] ?? 0;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < n; i++) {
    prev = (values[i] ?? 0) * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* ATR (Wilder)                                                        */
/* ------------------------------------------------------------------ */

/**
 * True range:
 *   TR[t] = max(high-low, |high - close[t-1]|, |low - close[t-1]|)
 * Wilder smoothing:
 *   ATR[p-1] = mean(TR[0..p-1])
 *   ATR[t]   = (ATR[t-1] * (p-1) + TR[t]) / p
 */
export function trueRanges(candles: readonly Candle[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (i === 0) {
      out.push(c.high - c.low);
      continue;
    }
    const pc = candles[i - 1]!.close;
    out.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
  }
  return out;
}

export function atrSeriesV2(candles: readonly Candle[], period: number): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (period < 1 || n < period) return out;
  const tr = trueRanges(candles);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i] ?? 0;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < n; i++) {
    prev = (prev * (period - 1) + (tr[i] ?? 0)) / period;
    out[i] = prev;
  }
  return out;
}

export function buildAtrContext(
  candles: readonly Candle[],
  index: number,
  period: number,
): AtrContext {
  const series = atrSeriesV2(candles.slice(0, index + 1), period);
  const atr = series[index] ?? null;
  const close = candles[index]?.close ?? 0;
  const known = series.filter((v): v is number => v !== null);
  let ratio: number | null = null;
  if (atr !== null && known.length >= 10) {
    const sorted = [...known].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? atr;
    ratio = median > 0 ? atr / median : null;
  }
  let regime: VolatilityRegime = 'NORMAL';
  if (ratio !== null) {
    if (ratio < 0.75) regime = 'LOW';
    else if (ratio > 1.4) regime = 'HIGH';
  }
  return {
    atr,
    atrPct: atr !== null && close > 0 ? (atr / close) * 100 : null,
    atrRatio: ratio,
    regime,
  };
}

/* ------------------------------------------------------------------ */
/* MACD 12/26/9                                                        */
/* ------------------------------------------------------------------ */

/**
 *   MACD      = EMA(close,fast) - EMA(close,slow)
 *   signal    = EMA(MACD, signalPeriod)
 *   histogram = MACD - signal
 * Periods are fixed at the 12/26/9 baseline and are NOT optimised here.
 */
export function buildMacdContext(
  candles: readonly Candle[],
  index: number,
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdContext {
  const closes = candles.slice(0, index + 1).map((c) => c.close);
  const empty: MacdContext = {
    macd: null, signal: null, histogram: null, histogramSlope: null,
    crossUp: false, crossDown: false, aboveZero: false, accelerating: false,
  };
  if (closes.length < slow + signalPeriod) return empty;

  const fastE = emaSeries(closes, fast);
  const slowE = emaSeries(closes, slow);
  const macdLine: number[] = [];
  const macdIdx: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const f = fastE[i];
    const s = slowE[i];
    if (f === null || f === undefined || s === null || s === undefined) continue;
    macdLine.push(f - s);
    macdIdx.push(i);
  }
  if (macdLine.length < signalPeriod + 2) return empty;

  const signalArr = emaSeries(macdLine, signalPeriod);
  const hist: (number | null)[] = macdLine.map((m, i) => {
    const s = signalArr[i];
    return s === null || s === undefined ? null : m - s;
  });

  const j = macdLine.length - 1;
  const macd = macdLine[j] ?? null;
  const signal = signalArr[j] ?? null;
  const h = hist[j] ?? null;
  const hPrev = hist[j - 1] ?? null;
  const hPrev2 = hist[j - 2] ?? null;

  const crossUp = hPrev !== null && h !== null && hPrev <= 0 && h > 0;
  const crossDown = hPrev !== null && h !== null && hPrev >= 0 && h < 0;
  const slope = h !== null && hPrev !== null ? h - hPrev : null;
  const accelerating =
    h !== null && hPrev !== null && hPrev2 !== null
      ? Math.abs(h) > Math.abs(hPrev) && Math.abs(hPrev) > Math.abs(hPrev2)
      : false;

  return {
    macd, signal, histogram: h, histogramSlope: slope,
    crossUp, crossDown, aboveZero: macd !== null && macd > 0, accelerating,
  };
}

/* ------------------------------------------------------------------ */
/* RSI(14) — Wilder                                                    */
/* ------------------------------------------------------------------ */

/**
 *   gain[t] / loss[t] from close-to-close change
 *   avgGain[p] = mean(gain[1..p]),  then Wilder smoothing
 *   RS  = avgGain / avgLoss
 *   RSI = 100 - 100 / (1 + RS)     (RSI = 100 when avgLoss == 0)
 */
export function rsiSeries(closes: readonly number[], period = 14): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < n; i++) {
    const d = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    const g = d >= 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * Divergence: price makes a higher high while RSI makes a lower high
 * (bearish), or price a lower low while RSI makes a higher low (bullish).
 * Compares the two most recent local extremes within the lookback window.
 */
function detectDivergence(
  candles: readonly Candle[],
  rsi: readonly (number | null)[],
  index: number,
  lookback = 30,
): { bullish: boolean; bearish: boolean } {
  const start = Math.max(1, index - lookback);
  let hi1 = -1;
  let hi2 = -1;
  let lo1 = -1;
  let lo2 = -1;
  for (let i = start + 1; i < index; i++) {
    const p = candles[i - 1]!;
    const c = candles[i]!;
    const n2 = candles[i + 1]!;
    if (c.high > p.high && c.high > n2.high) {
      hi2 = hi1;
      hi1 = i;
    }
    if (c.low < p.low && c.low < n2.low) {
      lo2 = lo1;
      lo1 = i;
    }
  }
  let bearish = false;
  let bullish = false;
  if (hi1 > 0 && hi2 > 0) {
    const r1 = rsi[hi1];
    const r2 = rsi[hi2];
    if (r1 !== null && r1 !== undefined && r2 !== null && r2 !== undefined) {
      bearish = candles[hi1]!.high > candles[hi2]!.high && r1 < r2;
    }
  }
  if (lo1 > 0 && lo2 > 0) {
    const r1 = rsi[lo1];
    const r2 = rsi[lo2];
    if (r1 !== null && r1 !== undefined && r2 !== null && r2 !== undefined) {
      bullish = candles[lo1]!.low < candles[lo2]!.low && r1 > r2;
    }
  }
  return { bullish, bearish };
}

export function buildRsiContext(
  candles: readonly Candle[],
  index: number,
  period = 14,
): RsiContext {
  const slice = candles.slice(0, index + 1);
  const closes = slice.map((c) => c.close);
  const series = rsiSeries(closes, period);
  const v = series[index] ?? null;
  const prev = series[index - 1] ?? null;
  const div = v === null ? { bullish: false, bearish: false }
    : detectDivergence(slice, series, index);
  return {
    rsi: v,
    slope: v !== null && prev !== null ? v - prev : null,
    overbought: v !== null && v > 70,
    oversold: v !== null && v < 30,
    above50: v !== null && v > 50,
    crossedUp50: v !== null && prev !== null && prev <= 50 && v > 50,
    crossedDown50: v !== null && prev !== null && prev >= 50 && v < 50,
    bullishDivergence: div.bullish,
    bearishDivergence: div.bearish,
  };
}

/* ------------------------------------------------------------------ */
/* ADX(14) — Wilder                                                    */
/* ------------------------------------------------------------------ */

/**
 *   +DM = high-prevHigh  when > (prevLow-low) and > 0, else 0
 *   -DM = prevLow-low    when > (high-prevHigh) and > 0, else 0
 *   Smoothed with Wilder over `period`, then
 *   +DI = 100 * smoothed(+DM) / ATR_wilder
 *   -DI = 100 * smoothed(-DM) / ATR_wilder
 *   DX  = 100 * |+DI - -DI| / (+DI + -DI)
 *   ADX = Wilder average of DX
 *
 * ADX measures trend STRENGTH only; it never chooses a direction.
 */
export function buildAdxContext(
  candles: readonly Candle[],
  index: number,
  period = 14,
): AdxContext {
  const c = candles.slice(0, index + 1);
  const empty: AdxContext = {
    adx: null, plusDi: null, minusDi: null, regime: 'RANGE', bullishPressure: false,
  };
  if (c.length < period * 2 + 1) return empty;

  const tr = trueRanges(c);
  const plusDm: number[] = [0];
  const minusDm: number[] = [0];
  for (let i = 1; i < c.length; i++) {
    const up = c[i]!.high - c[i - 1]!.high;
    const dn = c[i - 1]!.low - c[i]!.low;
    plusDm.push(up > dn && up > 0 ? up : 0);
    minusDm.push(dn > up && dn > 0 ? dn : 0);
  }

  const wilder = (src: readonly number[]): number[] => {
    const out: number[] = new Array(src.length).fill(0);
    let sum = 0;
    for (let i = 1; i <= period; i++) sum += src[i] ?? 0;
    out[period] = sum;
    for (let i = period + 1; i < src.length; i++) {
      out[i] = (out[i - 1] ?? 0) - (out[i - 1] ?? 0) / period + (src[i] ?? 0);
    }
    return out;
  };

  const trS = wilder(tr);
  const pS = wilder(plusDm);
  const mS = wilder(minusDm);

  const dx: (number | null)[] = new Array(c.length).fill(null);
  for (let i = period; i < c.length; i++) {
    const t = trS[i] ?? 0;
    if (t === 0) continue;
    const pdi = 100 * ((pS[i] ?? 0) / t);
    const mdi = 100 * ((mS[i] ?? 0) / t);
    const sum = pdi + mdi;
    dx[i] = sum === 0 ? 0 : 100 * (Math.abs(pdi - mdi) / sum);
  }

  const dxVals: number[] = [];
  for (let i = period; i < c.length; i++) {
    const v = dx[i];
    if (v !== null && v !== undefined) dxVals.push(v);
  }
  if (dxVals.length < period) return empty;

  let adx = dxVals.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < dxVals.length; i++) {
    adx = (adx * (period - 1) + (dxVals[i] ?? 0)) / period;
  }

  const t = trS[c.length - 1] ?? 0;
  const plusDi = t > 0 ? 100 * ((pS[c.length - 1] ?? 0) / t) : null;
  const minusDi = t > 0 ? 100 * ((mS[c.length - 1] ?? 0) / t) : null;

  let regime: AdxRegime = 'RANGE';
  if (adx >= 25) regime = 'STRONG';
  else if (adx >= 20) regime = 'DEVELOPING';

  return {
    adx,
    plusDi,
    minusDi,
    regime,
    bullishPressure: plusDi !== null && minusDi !== null && plusDi > minusDi,
  };
}

/* ------------------------------------------------------------------ */
/* Volume / RVOL                                                       */
/* ------------------------------------------------------------------ */

/**
 *   RVOL = volume[t] / mean(volume[t-period .. t-1])
 * The average deliberately EXCLUDES the current bar, so a huge bar does not
 * dilute its own signal.
 */
export function buildVolumeContext(
  candles: readonly Candle[],
  index: number,
  period = 20,
): VolumeContext {
  const cur = candles[index];
  const volume = cur?.volume ?? 0;
  const start = index - period;
  if (start < 0) {
    return { volume, avgVolume: null, medianVolume: null, rvol: null, spike: false };
  }
  const win: number[] = [];
  for (let i = start; i < index; i++) win.push(candles[i]?.volume ?? 0);
  const avg = win.reduce((s, x) => s + x, 0) / win.length;
  const sorted = [...win].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const rvol = avg > 0 ? volume / avg : null;
  return {
    volume,
    avgVolume: avg,
    medianVolume: median,
    rvol,
    spike: rvol !== null && rvol >= 1.8,
  };
}

/* ------------------------------------------------------------------ */
/* EMA context                                                         */
/* ------------------------------------------------------------------ */

export function buildEmaContext(
  candles: readonly Candle[],
  index: number,
  atr: number | null,
): EmaContext {
  const closes = candles.slice(0, index + 1).map((c) => c.close);
  const e20 = last(emaSeries(closes, 20)) ?? null;
  const e50 = last(emaSeries(closes, 50)) ?? null;
  const e200 = closes.length >= 200 ? (last(emaSeries(closes, 200)) ?? null) : null;
  const price = closes[closes.length - 1] ?? 0;

  const s20 = emaSeries(closes, 20);
  const cur = s20[index] ?? null;
  const prev = s20[index - 1] ?? null;
  const slopeRaw = cur !== null && prev !== null ? cur - prev : null;
  const slope20Atr = slopeRaw !== null && atr !== null && atr > 0 ? slopeRaw / atr : null;
  const spreadAtr =
    e20 !== null && e50 !== null && atr !== null && atr > 0
      ? Math.abs(e20 - e50) / atr
      : null;

  const fastAboveSlow = e20 !== null && e50 !== null && e20 > e50;
  const slowAboveAnchor = e50 !== null && e200 !== null && e50 > e200;

  let alignment: StructureBias = 'RANGE';
  if (e20 !== null && e50 !== null) {
    const bull = price > e20 && fastAboveSlow && (e200 === null || slowAboveAnchor);
    const bear = price < e20 && !fastAboveSlow && (e200 === null || !slowAboveAnchor);
    if (bull) alignment = 'BULLISH';
    else if (bear) alignment = 'BEARISH';
  }

  return {
    ema20: e20,
    ema50: e50,
    ema200: e200,
    priceAbove20: e20 !== null && price > e20,
    priceAbove50: e50 !== null && price > e50,
    priceAbove200: e200 !== null && price > e200,
    fastAboveSlow,
    slowAboveAnchor,
    slope20Atr,
    spreadAtr,
    alignment,
  };
}

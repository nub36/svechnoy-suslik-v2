/**
 * SMC V2 — higher-timeframe context.
 *
 * THE RULE THAT MATTERS: an HTF candle may only be consulted once it has
 * actually CLOSED at or before the close time of the LTF bar being evaluated.
 * Using a forming 4h candle to justify a 15m entry is look-ahead bias, and it
 * is the single easiest way to produce a backtest that cannot be traded.
 */

import type { Candle, Timeframe } from '../../core/types';
import { tfMs } from '../../core/types';
import type { HtfAlignment, HtfContext, StructureBias } from './types';
import { findSwingsV2, structureBias } from './structure';

/** Which higher timeframes inform each strategy timeframe. */
export const HTF_MAP: Readonly<Record<Timeframe, readonly Timeframe[]>> = {
  '1m': ['5m', '15m'],
  '5m': ['15m', '1h'],
  '15m': ['1h', '4h'],
  '30m': ['1h', '4h'],
  '1h': ['4h', '1d'],
  '4h': ['1d'],
  '1d': ['1w'],
  '1w': [],
};

/**
 * Candles of `htf` that had fully closed by `asOfCloseTime`.
 *
 * A candle with openTime T on timeframe tf closes at T + tfMs(tf). It is
 * usable only when that close time is <= the evaluated bar's close time.
 */
export function closedHtfCandles(
  candles: readonly Candle[],
  htf: Timeframe,
  asOfCloseTime: number,
): Candle[] {
  const span = tfMs(htf);
  return candles.filter((c) => c.isClosed && c.openTime + span <= asOfCloseTime);
}

/**
 * Structural bias of one higher timeframe, computed only from HTF candles that
 * had already closed.
 */
export function htfContext(
  candles: readonly Candle[] | undefined,
  htf: Timeframe,
  asOfCloseTime: number,
  swingStrength: number,
): HtfContext {
  const usable = candles ? closedHtfCandles(candles, htf, asOfCloseTime) : [];
  if (usable.length < swingStrength * 4 + 2) {
    return {
      timeframe: htf,
      bias: 'RANGE',
      asOfTime: usable.length > 0 ? usable[usable.length - 1]!.openTime : 0,
      bars: usable.length,
      available: false,
    };
  }
  const swings = findSwingsV2(usable, swingStrength);
  return {
    timeframe: htf,
    bias: structureBias(swings, usable.length - 1),
    asOfTime: usable[usable.length - 1]!.openTime,
    bars: usable.length,
    available: true,
  };
}

/**
 * Build every HTF context for a strategy timeframe.
 * Absent data yields `available: false` rather than a fabricated bias.
 */
export function buildHtfContexts(
  timeframe: Timeframe,
  htfCandles: Partial<Record<Timeframe, readonly Candle[]>> | undefined,
  asOfCloseTime: number,
  swingStrength: number,
): HtfContext[] {
  return (HTF_MAP[timeframe] ?? []).map((htf) =>
    htfContext(htfCandles?.[htf], htf, asOfCloseTime, swingStrength),
  );
}

/**
 * Is the proposed direction aligned with, or against, higher timeframes?
 *
 * Counter-trend is NOT forbidden — it is labelled, so statistics can later
 * decide whether such setups are worth taking.
 */
export function htfAlignment(
  contexts: readonly HtfContext[],
  direction: 'LONG' | 'SHORT',
): HtfAlignment {
  const usable = contexts.filter((c) => c.available);
  if (usable.length === 0) return 'UNKNOWN';
  const want: StructureBias = direction === 'LONG' ? 'BULLISH' : 'BEARISH';
  const against: StructureBias = direction === 'LONG' ? 'BEARISH' : 'BULLISH';
  const pro = usable.filter((c) => c.bias === want).length;
  const con = usable.filter((c) => c.bias === against).length;
  if (pro > con) return 'ALIGNED';
  if (con > pro) return 'COUNTER_TREND';
  return 'NEUTRAL';
}

/** 0..1 evidence score for the HTF component. */
export function htfScore(alignment: HtfAlignment): number {
  switch (alignment) {
    case 'ALIGNED': return 1;
    case 'NEUTRAL': return 0.5;
    case 'COUNTER_TREND': return 0.15;
    default: return 0.4;
  }
}

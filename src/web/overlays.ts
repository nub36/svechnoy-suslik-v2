/**
 * Chart overlay construction — BACKEND ONLY.
 *
 * The frontend receives ready-to-draw geometry and never runs any Smart Money
 * logic itself. Every zone/line/marker here comes from the same `evaluate()`
 * call the live engine uses.
 */

import type { Candle, DetectorId, Evaluation, Timeframe } from '../core/types';
import type { Settings } from '../core/settings';
import { evaluate } from '../strategy/smart-money';
import { explain } from '../strategy/scoring';

export interface OverlayBox {
  id: string;
  detector: DetectorId;
  direction: 'LONG' | 'SHORT';
  from: number;
  to: number;
  priceLow: number;
  priceHigh: number;
  label: string;
  reason: string;
  strength: number;
}

export interface OverlayLine {
  id: string;
  detector: DetectorId;
  direction: 'LONG' | 'SHORT';
  from: number;
  to: number;
  price: number;
  label: string;
  reason: string;
  strength: number;
}

export interface OverlayMarker {
  time: number;
  position: 'aboveBar' | 'belowBar';
  shape: 'arrowUp' | 'arrowDown' | 'circle';
  color: string;
  text: string;
  detector: DetectorId;
}

export interface ChartOverlays {
  boxes: OverlayBox[];
  lines: OverlayLine[];
  markers: OverlayMarker[];
}

export interface ChartPayload {
  symbol: string;
  timeframe: Timeframe;
  candles: Array<{
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    isClosed: boolean;
  }>;
  overlays: ChartOverlays;
  evaluation: {
    candleTime: number;
    closePrice: number;
    atr: number | null;
    long: Evaluation['long'];
    short: Evaluation['short'];
    decision: Evaluation['decision'];
    explainLong: string[];
    explainShort: string[];
  } | null;
  /** How many of the returned candles are closed (the engine only sees these). */
  closedCount: number;
}

const COLOR: Record<DetectorId, string> = {
  BOS: '#22c55e',
  CHOCH: '#f97316',
  ORDER_BLOCK: '#3b82f6',
  FVG: '#a855f7',
  LIQUIDITY_SWEEP: '#ef4444',
  EQUAL_LEVELS: '#eab308',
  PREMIUM_DISCOUNT: '#14b8a6',
  VOLUME_IMBALANCE: '#64748b',
};

export function detectorColor(d: DetectorId): string {
  return COLOR[d] ?? '#94a3b8';
}

/**
 * Build the full chart payload for a symbol/timeframe.
 * `candles` may include the forming bar — it is sent for display but the
 * evaluation below strictly uses closed candles only.
 */
export function buildChartPayload(
  symbol: string,
  timeframe: Timeframe,
  candles: readonly Candle[],
  settings: Settings,
): ChartPayload {
  const ev = evaluate({ symbol, timeframe, candles, settings });

  const boxes: OverlayBox[] = [];
  const lines: OverlayLine[] = [];
  const markers: OverlayMarker[] = [];

  if (ev) {
    for (const e of ev.events) {
      const id = `${e.detector}-${e.dedupeKey}`;
      if (e.zone) {
        boxes.push({
          id,
          detector: e.detector,
          direction: e.direction,
          from: e.zone.from,
          to: e.zone.to,
          priceLow: e.zone.priceLow,
          priceHigh: e.zone.priceHigh,
          label: e.detector,
          reason: e.reason,
          strength: e.strength,
        });
      }
      if (e.line) {
        lines.push({
          id,
          detector: e.detector,
          direction: e.direction,
          from: e.line.from,
          to: e.line.to,
          price: e.line.price,
          label: e.detector,
          reason: e.reason,
          strength: e.strength,
        });
      }
      // Structural events get a marker on the confirming candle.
      if (e.detector === 'BOS' || e.detector === 'CHOCH' || e.detector === 'LIQUIDITY_SWEEP') {
        markers.push({
          time: e.time,
          position: e.direction === 'LONG' ? 'belowBar' : 'aboveBar',
          shape: e.direction === 'LONG' ? 'arrowUp' : 'arrowDown',
          color: detectorColor(e.detector),
          text: e.detector,
          detector: e.detector,
        });
      }
    }
  }

  const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);

  return {
    symbol,
    timeframe,
    candles: sorted.map((c) => ({
      time: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      isClosed: c.isClosed,
    })),
    overlays: { boxes, lines, markers },
    evaluation: ev
      ? {
          candleTime: ev.candleTime,
          closePrice: ev.closePrice,
          atr: ev.atr,
          long: ev.long,
          short: ev.short,
          decision: ev.decision,
          explainLong: explain(ev.long),
          explainShort: explain(ev.short),
        }
      : null,
    closedCount: sorted.filter((c) => c.isClosed).length,
  };
}

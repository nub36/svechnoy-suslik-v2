'use client';

/**
 * TradingView **Lightweight Charts** candlestick chart.
 *
 * NOTE: this is the lightweight-charts library, NOT the tv.js embed widget.
 *
 * All Smart Money overlays are supplied by the BACKEND (/api/chart) and merely
 * rendered here. This component contains no detection logic whatsoever.
 *
 * Layout goals (a conventional trading-chart look):
 *  - the latest candle sits ~12% left of the price scale, so there is visible
 *    empty "future" space to its right;
 *  - ~100-150 visible candles on desktop instead of squeezing in all 300;
 *  - comfortable vertical margins so candles never touch the edges;
 *  - the chart re-fits on symbol/timeframe change and on resize, but it does
 *    NOT fight the user once they have panned or zoomed manually.
 */

import { useEffect, useRef } from 'react';
import { decimalsFromTickSize, priceDecimals } from '../lib/format';
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';

export interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;
}

export interface ChartBox {
  id: string;
  detector: string;
  direction: string;
  from: number;
  to: number;
  priceLow: number;
  priceHigh: number;
  label: string;
  reason: string;
  strength: number;
}

export interface ChartLine {
  id: string;
  detector: string;
  direction: string;
  from: number;
  to: number;
  price: number;
  label: string;
  reason: string;
  strength: number;
}

export interface ChartMarker {
  time: number;
  position: 'aboveBar' | 'belowBar';
  shape: 'arrowUp' | 'arrowDown' | 'circle';
  color: string;
  text: string;
  detector: string;
  groupCount?: number;
}

export interface ChartSignalLevel {
  kind: 'ENTRY' | 'SL' | 'TP1' | 'TP2' | 'TP3';
  price: number;
  label: string;
  color: string;
}

export interface ChartSignal {
  id: number;
  direction: 'LONG' | 'SHORT';
  state: string;
  score: number;
  setupCandleTime: number;
  entryCandleTime: number | null;
  entryPrice: number | null;
  levels: ChartSignalLevel[];
  waitingForEntry: boolean;
  /** Finished trade (TP3_HIT/STOPPED/EXPIRED) shown for reference only. */
  historical?: boolean;
}

/**
 * A live (usually still forming) candle pushed from the Binance WebSocket.
 *
 * DISPLAY ONLY. It is applied with series.update() so the chart animates in
 * real time, but it is never persisted and never reaches the Smart Money
 * engine — signals come exclusively from CLOSED candles stored in PostgreSQL.
 */
export interface LiveCandleUpdate {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;
}

export interface CandleChartProps {
  candles: ChartCandle[];
  boxes?: ChartBox[];
  lines?: ChartLine[];
  markers?: ChartMarker[];
  signal?: ChartSignal | null;
  showOverlays?: boolean;
  height?: number;
  /** Changing this string refits the view (symbol/timeframe switch). */
  fitKey?: string;
  /** Real-time forming candle. Display only — see LiveCandleUpdate. */
  liveCandle?: LiveCandleUpdate | null;
  /**
   * Binance PRICE_FILTER tickSize for the displayed symbol. Sets the decimals
   * used by the right price scale, the crosshair label and every ENTRY/SL/TP
   * label, so the chart never disagrees with the tables. null -> heuristic.
   */
  tickSize?: number | null;
}

/** Smallest price increment for a given number of decimals (2 -> 0.01). */
function minMoveFor(decimals: number): number {
  return Number(Math.pow(10, -decimals).toFixed(decimals));
}

/**
 * Chart price decimals.
 *
 * Binance tickSize is authoritative. When it is unknown we fall back to the
 * magnitude of the data actually on screen, so a cheap asset still renders
 * meaningfully instead of collapsing to 0.00.
 */
function resolveChartDecimals(
  tickSize: number | null | undefined,
  candles: readonly ChartCandle[],
): number {
  const fromTick = decimalsFromTickSize(tickSize);
  if (fromTick !== null) return fromTick;
  const last = candles.length > 0 ? candles[candles.length - 1]?.close : undefined;
  return priceDecimals(last ?? 0);
}

/**
 * Palette for the ACTIVE factor set only. Removed factors
 * (change-of-character, equal levels, volume imbalance, premium/discount)
 * intentionally have no entry.
 */
const FACTOR_COLOR: Record<string, string> = {
  BOS: '#22c55e',
  ORDER_BLOCK: '#3b82f6',
  FVG: '#a855f7',
  LIQUIDITY_SWEEP: '#ef4444',
  RANGE_POSITION: '#14b8a6',
  INTERNAL_STRUCTURE: '#94a3b8',
  OB_FVG_CONFLUENCE: '#f59e0b',
};

function colorOf(d: string): string {
  return FACTOR_COLOR[d] ?? '#94a3b8';
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Minimum vertical distance (px) between two axis labels before they are
 * considered to collide. Roughly one label height.
 */
const LABEL_MIN_GAP_PX = 14;

/**
 * Approximate pixels per unit of price for the current view, used only to
 * decide whether two labels would overlap. Never used to alter a price.
 */
function priceSpanToPixels(
  candles: readonly { high: number; low: number }[],
  heightPx: number,
): number {
  if (candles.length === 0) return 0;
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of candles) {
    if (c.high > hi) hi = c.high;
    if (c.low < lo) lo = c.low;
  }
  const span = hi - lo;
  if (!Number.isFinite(span) || span <= 0) return 0;
  // The candle pane occupies roughly the upper 86% (volume takes the rest).
  return (heightPx * 0.86) / span;
}

/** Target number of candles visible by default. */
const DESKTOP_VISIBLE = 130;
const MOBILE_VISIBLE = 60;
/** Fraction of the width kept empty to the right of the latest candle. */
const RIGHT_WHITESPACE = 0.12;

export default function CandleChart({
  candles,
  boxes = [],
  lines = [],
  markers = [],
  signal = null,
  showOverlays = true,
  height = 520,
  fitKey = '',
  liveCandle = null,
  tickSize = null,
}: CandleChartProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const overlaySeriesRef = useRef<ISeriesApi<'Line'>[]>([]);
  /**
   * Every price line created by createPriceLine(), so it can be removed again.
   *
   * Price lines live on the CANDLE series, and that series is created once and
   * survives symbol/timeframe changes. Without this registry each redraw
   * stacked another SL/ENTRY/TP set onto the right axis and they accumulated
   * until a full page reload.
   */
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  // Set once the user pans/zooms, so we stop auto-fitting under their hands.
  const userInteractedRef = useRef(false);
  const lastFitKeyRef = useRef<string>('');
  /** openTime of the newest bar loaded from the backend (REST/DB history). */
  const lastHistoryTimeRef = useRef<number>(0);

  /**
   * Price precision derived from tickSize. Held in refs so the create-chart
   * effect can read the current value without taking tickSize as a dependency
   * — the chart must NEVER be recreated when only precision changes.
   */
  const decimals = resolveChartDecimals(tickSize, candles);
  const priceDecimalsRef = useRef<number>(decimals);
  priceDecimalsRef.current = decimals;
  const minMoveRef = useRef<number>(minMoveFor(decimals));
  minMoveRef.current = minMoveFor(decimals);

  /** Detach every tracked signal price line and empty the registry. */
  const clearPriceLines = (): void => {
    const series = candleSeriesRef.current;
    for (const line of priceLinesRef.current) {
      try {
        series?.removePriceLine(line);
      } catch {
        /* series already disposed */
      }
    }
    priceLinesRef.current = [];
  };

  /**
   * Push precision changes onto the EXISTING series when the symbol changes.
   * applyOptions() mutates in place — no chart teardown, no data refetch.
   */
  useEffect(() => {
    candleSeriesRef.current?.applyOptions({
      priceFormat: { type: 'price', precision: decimals, minMove: minMoveFor(decimals) },
    });
  }, [decimals]);

  /* ---------------- create chart once ---------------- */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      width: el.clientWidth,
      height,
      layout: {
        background: { color: '#0b1220' },
        textColor: '#cbd5e1',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 184, 0.07)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.07)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(148, 163, 184, 0.25)',
        // Comfortable vertical breathing room: candles and overlay labels
        // never touch the top/bottom boundary.
        scaleMargins: { top: 0.1, bottom: 0.18 },
        entireTextOnly: true,
      },
      timeScale: {
        borderColor: 'rgba(148, 163, 184, 0.25)',
        timeVisible: true,
        secondsVisible: false,
        // Empty space to the right of the newest candle. This is what stops
        // the candles from being jammed against the price scale.
        rightOffset: 12,
        barSpacing: 8,
        minBarSpacing: 0.5,
        fixLeftEdge: false,
        lockVisibleTimeRangeOnResize: true,
      },
      crosshair: {
        mode: 1,
        vertLine: { color: 'rgba(148,163,184,0.4)', labelBackgroundColor: '#1e293b' },
        horzLine: { color: 'rgba(148,163,184,0.4)', labelBackgroundColor: '#1e293b' },
      },
      handleScroll: true,
      handleScale: true,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      // Precision from Binance tickSize: the axis, the crosshair readout and
      // every price line label all inherit this, so one rule covers them all.
      priceFormat: {
        type: 'price',
        precision: priceDecimalsRef.current,
        minMove: minMoveRef.current,
      },
      upColor: '#16a34a',
      downColor: '#dc2626',
      borderUpColor: '#16a34a',
      borderDownColor: '#dc2626',
      wickUpColor: '#16a34a',
      wickDownColor: '#dc2626',
      // ONE clear current-price line + right-hand label. No duplicates.
      priceLineVisible: true,
      priceLineWidth: 1,
      priceLineColor: '#94a3b8',
      priceLineStyle: 2,
      lastValueVisible: true,
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      color: 'rgba(148, 163, 184, 0.35)',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    // Volume occupies only the bottom sliver.
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.86, bottom: 0 },
      visible: false,
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    markersRef.current = createSeriesMarkers(candleSeries, []);

    // Detect manual pan/zoom so we stop refitting the range afterwards.
    const onRangeChange = (): void => {
      userInteractedRef.current = true;
    };
    // Only USER-driven scroll/scale counts, not our own programmatic fits.
    el.addEventListener('wheel', onRangeChange, { passive: true });
    el.addEventListener('pointerdown', onRangeChange, { passive: true });
    el.addEventListener('touchstart', onRangeChange, { passive: true });

    // Container-driven sizing: works on desktop and mobile, no fixed width.
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = Math.floor(entry.contentRect.width);
      if (w > 0) chart.applyOptions({ width: w });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', onRangeChange);
      el.removeEventListener('pointerdown', onRangeChange);
      el.removeEventListener('touchstart', onRangeChange);
      clearPriceLines();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      markersRef.current = null;
      overlaySeriesRef.current = [];
      priceLinesRef.current = [];
    };
  }, [height]);

  /* ---------------- data + overlays ---------------- */
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const el = containerRef.current;
    if (!chart || !candleSeries || !volumeSeries || !el) return;

    const sorted = [...candles].sort((a, b) => a.time - b.time);
    lastHistoryTimeRef.current = sorted.length > 0 ? sorted[sorted.length - 1]!.time : 0;

    candleSeries.setData(
      sorted.map((c) => ({
        time: (c.time / 1000) as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    volumeSeries.setData(
      sorted.map((c) => ({
        time: (c.time / 1000) as UTCTimestamp,
        value: c.volume,
        color:
          c.close >= c.open ? 'rgba(22, 163, 74, 0.30)' : 'rgba(220, 38, 38, 0.30)',
      })),
    );

    /* ---- clear previous overlay series and price lines ---- */
    for (const s of overlaySeriesRef.current) {
      try {
        chart.removeSeries(s);
      } catch {
        /* already removed */
      }
    }
    overlaySeriesRef.current = [];
    // MUST happen on every redraw — symbol change, timeframe change or a new
    // selected signal — otherwise the previous set stays on the price axis.
    clearPriceLines();

    if (showOverlays) {
      /* ---- zones: subtle translucent bands, never overpowering candles ---- */
      for (const b of boxes) {
        const color = colorOf(b.detector);
        const from = (b.from / 1000) as UTCTimestamp;
        const to = (b.to / 1000) as UTCTimestamp;
        // A zone is drawn as a pair of faint horizontal edges.
        for (const price of [b.priceHigh, b.priceLow]) {
          const s = chart.addSeries(LineSeries, {
            color: hexToRgba(color, 0.5),
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          s.setData([
            { time: from, value: price },
            { time: to, value: price },
          ]);
          overlaySeriesRef.current.push(s);
        }
      }

      /* ---- structural levels: thin dashed lines ---- */
      for (const l of lines) {
        const color = colorOf(l.detector);
        const s = chart.addSeries(LineSeries, {
          color: hexToRgba(color, 0.75),
          lineWidth: 1,
          lineStyle: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        s.setData([
          { time: (l.from / 1000) as UTCTimestamp, value: l.price },
          { time: (l.to / 1000) as UTCTimestamp, value: l.price },
        ]);
        overlaySeriesRef.current.push(s);
      }
    }

    /* ---- signal levels: ENTRY / SL / TP1-3 with right-side labels ---- */
    // Drawn as price lines on the candle series so each gets a clean label on
    // the right axis. Never drawn while WAITING_ENTRY (no fabricated entry).
    //
    // LABEL COLLISIONS: when two levels sit very close together their axis
    // labels overlap and both become unreadable. We never move a line or round
    // a price to create space — the geometry stays exactly on the real value.
    // Instead, when a label would collide with the one below it, we drop the
    // TEXT of the less important label and keep its line and axis price. The
    // price shown is always the true price.
    if (signal && !signal.waitingForEntry) {
      const pxPerPrice = priceSpanToPixels(sorted, height);
      // Rank: ENTRY and SL must keep their text; TP text yields first.
      const priority = (k: string): number =>
        k === 'ENTRY' ? 0 : k === 'SL' ? 1 : 2;

      const ordered = [...signal.levels].sort((a, b) => a.price - b.price);
      const suppressed = new Set<number>();
      for (let i = 1; i < ordered.length; i++) {
        const prev = ordered[i - 1];
        const cur = ordered[i];
        if (!prev || !cur) continue;
        const gapPx = Math.abs(cur.price - prev.price) * pxPerPrice;
        if (gapPx < LABEL_MIN_GAP_PX) {
          // Suppress the text of whichever of the pair matters less.
          const loser = priority(cur.kind) >= priority(prev.kind) ? cur : prev;
          suppressed.add(loser.price);
        }
      }

      for (const lv of signal.levels) {
        const line = candleSeries.createPriceLine({
          price: lv.price,
          color: lv.color,
          lineWidth: lv.kind === 'ENTRY' ? 2 : 1,
          // Finished trades are history, not a live position: dot them so they
          // read differently from an active setup.
          lineStyle: signal.historical ? 3 : lv.kind === 'ENTRY' ? 0 : 2,
          axisLabelVisible: true,
          // Only the TEXT is dropped on collision; the price is untouched.
          title: suppressed.has(lv.price) ? '' : lv.label,
        });
        // Registered so the next redraw can detach it.
        priceLinesRef.current.push(line);
      }
    }

    /* ---- markers ---- */
    if (markersRef.current) {
      const list: SeriesMarker<Time>[] = showOverlays
        ? markers.map((m) => ({
            time: (m.time / 1000) as Time,
            position: m.position,
            shape: m.shape,
            color: m.color,
            text: m.groupCount && m.groupCount > 1 ? `${m.text} x${m.groupCount}` : m.text,
            size: 1,
          }))
        : [];

      // The LONG/SHORT signal marker sits on the setup candle, offset to the
      // opposite side of the bar so it does not cover the candle body.
      if (signal) {
        list.push({
          time: (signal.setupCandleTime / 1000) as Time,
          position: signal.direction === 'LONG' ? 'belowBar' : 'aboveBar',
          shape: signal.direction === 'LONG' ? 'arrowUp' : 'arrowDown',
          color: signal.direction === 'LONG' ? '#22c55e' : '#ef4444',
          text: `${signal.direction} ${signal.score.toFixed(0)}`,
          size: 2,
        });
      }

      list.sort((a, b) => (a.time as number) - (b.time as number));
      markersRef.current.setMarkers(list);
    }

    /* ---- initial / refit view ---- */
    const shouldFit = fitKey !== lastFitKeyRef.current;
    if (shouldFit) {
      lastFitKeyRef.current = fitKey;
      userInteractedRef.current = false;
    }

    if ((shouldFit || !userInteractedRef.current) && sorted.length > 0) {
      const width = el.clientWidth || 800;
      const isMobile = width < 640;
      const targetVisible = Math.min(
        sorted.length,
        isMobile ? MOBILE_VISIBLE : DESKTOP_VISIBLE,
      );
      // Reserve the right-hand whitespace, then size bars to fill the rest.
      const usable = width * (1 - RIGHT_WHITESPACE);
      const barSpacing = Math.max(2, usable / targetVisible);
      const rightOffset = Math.max(4, Math.round((width * RIGHT_WHITESPACE) / barSpacing));

      chart.timeScale().applyOptions({ barSpacing, rightOffset });
      // Anchor to the newest data; rightOffset supplies the future whitespace.
      chart.timeScale().scrollToRealTime();
    }
  }, [candles, boxes, lines, markers, signal, showOverlays, fitKey]);

  /* ---------------- real-time forming candle ----------------
   *
   * Deliberately a SEPARATE effect keyed only on `liveCandle`: a websocket
   * tick must not re-run the overlay//fit work above, and must never call
   * setData() (which would rebuild the series and kill the user's zoom).
   * series.update() mutates the single affected bar in place.
   *
   * This is presentation only. The bar drawn here carries no weight in the
   * Smart Money evaluation; the backend scores CLOSED candles exclusively.
   */
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    if (!candleSeries || !volumeSeries || !liveCandle) return;

    // Ignore ticks that predate our loaded history: lightweight-charts
    // requires monotonically non-decreasing times and would throw.
    if (liveCandle.time < lastHistoryTimeRef.current) return;

    const t = (liveCandle.time / 1000) as UTCTimestamp;
    try {
      candleSeries.update({
        time: t,
        open: liveCandle.open,
        high: liveCandle.high,
        low: liveCandle.low,
        close: liveCandle.close,
      });
      volumeSeries.update({
        time: t,
        value: liveCandle.volume,
        color:
          liveCandle.close >= liveCandle.open
            ? 'rgba(22, 163, 74, 0.30)'
            : 'rgba(220, 38, 38, 0.30)',
      });
      // Once Binance marks the bar final, treat it as the new history edge so
      // the next bar's ticks are accepted.
      if (liveCandle.isClosed) lastHistoryTimeRef.current = liveCandle.time;
    } catch {
      /* out-of-order tick during a symbol switch — the next REST load fixes it */
    }
  }, [liveCandle]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', maxWidth: '100%', overflow: 'hidden' }}
      data-testid="candle-chart"
    />
  );
}

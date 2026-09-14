'use client';

/**
 * TradingView **Lightweight Charts** candlestick chart.
 *
 * NOTE: this is the lightweight-charts library, NOT the tv.js embed widget.
 *
 * All Smart Money overlays are supplied by the BACKEND (/api/chart) and merely
 * rendered here. This component contains no detection logic whatsoever.
 */

import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
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
}

export interface CandleChartProps {
  candles: ChartCandle[];
  boxes?: ChartBox[];
  lines?: ChartLine[];
  markers?: ChartMarker[];
  showOverlays?: boolean;
  height?: number;
}

const DETECTOR_COLOR: Record<string, string> = {
  BOS: '#22c55e',
  CHOCH: '#f97316',
  ORDER_BLOCK: '#3b82f6',
  FVG: '#a855f7',
  LIQUIDITY_SWEEP: '#ef4444',
  EQUAL_LEVELS: '#eab308',
  PREMIUM_DISCOUNT: '#14b8a6',
  VOLUME_IMBALANCE: '#64748b',
};

function toSec(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

export default function CandleChart({
  candles,
  boxes = [],
  lines = [],
  markers = [],
  showOverlays = true,
  height = 480,
}: CandleChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const overlayRefs = useRef<Array<ISeriesApi<'Line'>>>([]);

  // ---- create the chart once ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const chart = createChart(host, {
      width: host.clientWidth,
      height,
      layout: {
        background: { color: '#131722' },
        textColor: '#d1d4dc',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#1c2030' },
        horzLines: { color: '#1c2030' },
      },
      rightPriceScale: { borderColor: '#262b3a', scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderColor: '#262b3a', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderUpColor: '#26a69a',
      borderDownColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    });
    chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    chartRef.current = chart;
    candleRef.current = candleSeries;
    volumeRef.current = volumeSeries;

    const onResize = (): void => {
      if (hostRef.current) chart.applyOptions({ width: hostRef.current.clientWidth });
    };
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(host);

    return () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      overlayRefs.current = [];
    };
  }, [height]);

  // ---- feed candle + volume data ----
  useEffect(() => {
    const cs = candleRef.current;
    const vs = volumeRef.current;
    if (!cs || !vs) return;

    // Deduplicate + sort: lightweight-charts requires strictly ascending time.
    const seen = new Set<number>();
    const rows = [...candles]
      .sort((a, b) => a.time - b.time)
      .filter((c) => {
        const t = Math.floor(c.time / 1000);
        if (seen.has(t)) return false;
        seen.add(t);
        return true;
      });

    cs.setData(
      rows.map((c) => ({
        time: toSec(c.time),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    vs.setData(
      rows.map((c) => ({
        time: toSec(c.time),
        value: c.volume,
        color: c.close >= c.open ? 'rgba(38,166,154,0.35)' : 'rgba(239,83,80,0.35)',
      })),
    );

    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  // ---- render backend-supplied overlays ----
  useEffect(() => {
    const chart = chartRef.current;
    const cs = candleRef.current;
    if (!chart || !cs) return;

    // clear previous overlay series
    for (const s of overlayRefs.current) {
      try {
        chart.removeSeries(s);
      } catch {
        /* already removed */
      }
    }
    overlayRefs.current = [];

    if (!showOverlays) {
      createSeriesMarkers(cs, []);
      return;
    }

    // Zones (order blocks, FVGs, premium/discount) are drawn as a pair of
    // horizontal line segments bounding the zone.
    for (const b of boxes) {
      const color = DETECTOR_COLOR[b.detector] ?? '#94a3b8';
      for (const price of [b.priceLow, b.priceHigh]) {
        const s = chart.addSeries(LineSeries, {
          color,
          lineWidth: 1,
          lineStyle: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        const from = Math.min(b.from, b.to);
        const to = Math.max(b.from, b.to);
        s.setData([
          { time: toSec(from), value: price },
          { time: toSec(to), value: price },
        ]);
        overlayRefs.current.push(s);
      }
    }

    // Structural levels (BOS/CHoCH/sweep/equal levels).
    for (const l of lines) {
      const color = DETECTOR_COLOR[l.detector] ?? '#94a3b8';
      const s = chart.addSeries(LineSeries, {
        color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      const from = Math.min(l.from, l.to);
      const to = Math.max(l.from, l.to);
      s.setData(
        from === to
          ? [{ time: toSec(from), value: l.price }]
          : [
              { time: toSec(from), value: l.price },
              { time: toSec(to), value: l.price },
            ],
      );
      overlayRefs.current.push(s);
    }

    // Event markers.
    const seenMarker = new Set<string>();
    const uniqueMarkers = markers
      .filter((m) => {
        const k = `${m.time}-${m.detector}-${m.shape}`;
        if (seenMarker.has(k)) return false;
        seenMarker.add(k);
        return true;
      })
      .sort((a, b) => a.time - b.time)
      .map((m) => ({
        time: toSec(m.time) as Time,
        position: m.position,
        shape: m.shape,
        color: m.color,
        text: m.text,
      }));

    createSeriesMarkers(cs, uniqueMarkers);
  }, [boxes, lines, markers, showOverlays]);

  return <div ref={hostRef} className="chart-host" style={{ height }} />;
}

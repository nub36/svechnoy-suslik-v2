'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import type { ChartBox, ChartCandle, ChartLine, ChartMarker } from './components/CandleChart';

const CandleChart = dynamic(() => import('./components/CandleChart'), {
  ssr: false,
  loading: () => <div className="loading">Loading chart…</div>,
});

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const;
type Tf = (typeof TIMEFRAMES)[number];

interface SymbolRow {
  symbol: string;
  rank: number;
  baseAsset: string;
  lastPrice: number;
  quoteVolume24h: number;
  priceChangePct: number;
}

interface ScoreComponent {
  detector: string;
  strength: number;
  weight: number;
  contribution: number;
  counted: boolean;
  skippedReason?: string;
  reason: string;
}

interface Breakdown {
  direction: string;
  rawScore: number;
  totalWeight: number;
  score: number;
  components: ScoreComponent[];
  duplicatesRemoved: number;
}

interface ChartData {
  symbol: string;
  timeframe: string;
  candles: ChartCandle[];
  overlays: { boxes: ChartBox[]; lines: ChartLine[]; markers: ChartMarker[] };
  closedCount: number;
  empty?: boolean;
  evaluation: {
    candleTime: number;
    closePrice: number;
    atr: number | null;
    long: Breakdown;
    short: Breakdown;
    decision: { direction: string; score: number; threshold: number; passed: boolean } | null;
    explainLong: string[];
    explainShort: string[];
  } | null;
}

function fmtVol(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtPrice(v: number): string {
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(4);
  return v.toFixed(6);
}

export default function HomePage() {
  const [symbols, setSymbols] = useState<SymbolRow[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [timeframe, setTimeframe] = useState<Tf>('1h');
  const [chart, setChart] = useState<ChartData | null>(null);
  const [showOverlays, setShowOverlays] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSymbols = useCallback(async () => {
    try {
      const res = await fetch('/api/symbols');
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      const list: SymbolRow[] = json.data.symbols;
      setSymbols(list);
      setSelected((cur) => cur || (list[0]?.symbol ?? ''));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load symbols');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadChart = useCallback(async (symbol: string, tf: Tf) => {
    if (!symbol) return;
    try {
      const res = await fetch(`/api/chart?symbol=${symbol}&timeframe=${tf}&limit=300`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      setChart(json.data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load chart');
    }
  }, []);

  useEffect(() => {
    void loadSymbols();
    const t = setInterval(() => void loadSymbols(), 30_000);
    return () => clearInterval(t);
  }, [loadSymbols]);

  useEffect(() => {
    void loadChart(selected, timeframe);
    const t = setInterval(() => void loadChart(selected, timeframe), 30_000);
    return () => clearInterval(t);
  }, [selected, timeframe, loadChart]);

  const ev = chart?.evaluation ?? null;
  const best = useMemo(() => {
    if (!ev) return null;
    return ev.long.score >= ev.short.score ? ev.long : ev.short;
  }, [ev]);

  const overlayCount =
    (chart?.overlays.boxes.length ?? 0) +
    (chart?.overlays.lines.length ?? 0) +
    (chart?.overlays.markers.length ?? 0);

  return (
    <div>
      <h1>Markets — Binance Spot USDT TOP-{symbols.length || 10}</h1>
      <p className="subtitle">
        Ranked by 24h quote volume. Single venue (Binance Spot) — prices and signals come from
        one exchange only, with no cross-venue aggregation.
      </p>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="loading">Loading markets…</div>
      ) : symbols.length === 0 ? (
        <div className="alert alert-info">
          No symbols yet. Start the market worker (<code>npm run worker:market</code>) or run the
          seed/bootstrap script to populate the TOP-10.
        </div>
      ) : (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Symbol</th>
                <th className="num">Last price</th>
                <th className="num">24h %</th>
                <th className="num">24h quote volume</th>
              </tr>
            </thead>
            <tbody>
              {symbols.map((s) => (
                <tr
                  key={s.symbol}
                  className="clickable"
                  onClick={() => setSelected(s.symbol)}
                  style={
                    s.symbol === selected
                      ? { background: '#1e2a44', outline: '1px solid #2962ff' }
                      : undefined
                  }
                >
                  <td className="muted">{s.rank}</td>
                  <td>
                    <b>{s.symbol}</b>
                  </td>
                  <td className="num mono">{fmtPrice(s.lastPrice)}</td>
                  <td className={`num ${s.priceChangePct >= 0 ? 'up' : 'down'}`}>
                    {s.priceChangePct >= 0 ? '+' : ''}
                    {s.priceChangePct.toFixed(2)}%
                  </td>
                  <td className="num mono">{fmtVol(s.quoteVolume24h)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <div className="panel">
          <div className="toolbar">
            <h2 style={{ margin: 0 }}>{selected}</h2>
            <div className="tf-group">
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  className={tf === timeframe ? 'active' : ''}
                  onClick={() => setTimeframe(tf)}
                >
                  {tf}
                </button>
              ))}
            </div>
            <button
              className={showOverlays ? 'active' : ''}
              onClick={() => setShowOverlays((v) => !v)}
            >
              Smart Money overlays {showOverlays ? 'ON' : 'OFF'}
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              {chart ? `${chart.candles.length} candles (${chart.closedCount} closed)` : ''} ·{' '}
              {overlayCount} overlay objects from backend
            </span>
          </div>

          {chart && chart.candles.length > 0 ? (
            <>
              <CandleChart
                candles={chart.candles}
                boxes={chart.overlays.boxes}
                lines={chart.overlays.lines}
                markers={chart.overlays.markers}
                showOverlays={showOverlays}
              />
              <div className="legend">
                {[
                  ['BOS', '#22c55e'],
                  ['CHOCH', '#f97316'],
                  ['ORDER_BLOCK', '#3b82f6'],
                  ['FVG', '#a855f7'],
                  ['LIQUIDITY_SWEEP', '#ef4444'],
                  ['EQUAL_LEVELS', '#eab308'],
                  ['PREMIUM_DISCOUNT', '#14b8a6'],
                ].map(([name, color]) => (
                  <span className="item" key={name}>
                    <span className="swatch" style={{ background: color }} />
                    {name}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <div className="alert alert-info">
              No candles stored for {selected} {timeframe} yet. The market worker fetches the
              timeframes configured in Admin → engine.timeframes.
            </div>
          )}
        </div>
      )}

      {ev && best && (
        <div className="grid grid-2">
          <div className="panel">
            <h3>Live Smart Money evaluation</h3>
            <div className="grid grid-3" style={{ marginBottom: 12 }}>
              <div className="stat">
                <div className="label">Bias</div>
                <div className="value">
                  <span className={`pill ${best.direction === 'LONG' ? 'pill-long' : 'pill-short'}`}>
                    {best.direction}
                  </span>
                </div>
              </div>
              <div className="stat">
                <div className="label">Score</div>
                <div className="value">{best.score.toFixed(2)}</div>
                <div className="sub">threshold {ev.decision?.threshold ?? '—'}</div>
              </div>
              <div className="stat">
                <div className="label">Signal</div>
                <div className="value">
                  <span className={`pill ${ev.decision?.passed ? 'pill-ok' : 'pill-idle'}`}>
                    {ev.decision?.passed ? 'PASS' : 'NO SETUP'}
                  </span>
                </div>
              </div>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              Evaluated on CLOSED candle{' '}
              <b>{new Date(ev.candleTime).toISOString().replace('T', ' ').slice(0, 16)}</b> · close{' '}
              {fmtPrice(ev.closePrice)} · ATR {ev.atr?.toFixed(6) ?? '—'} (risk only)
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              Entry, if triggered, is the OPEN of the NEXT candle (N+1) — never this close.
            </div>
          </div>

          <div className="panel">
            <h3>Score breakdown — {best.direction}</h3>
            <pre className="breakdown">
              {(best.direction === 'LONG' ? ev.explainLong : ev.explainShort).join('\n')}
            </pre>
            <details style={{ marginTop: 8 }}>
              <summary>Show opposite direction</summary>
              <pre className="breakdown" style={{ marginTop: 8 }}>
                {(best.direction === 'LONG' ? ev.explainShort : ev.explainLong).join('\n')}
              </pre>
            </details>
          </div>
        </div>
      )}
    </div>
  );
}

'use client';

/**
 * Home page — the CHART is the hero element.
 *
 * Order (desktop and mobile alike):
 *   1. chart toolbar (pair selector + timeframes + live price + status)
 *   2. chart
 *   3. Smart Money evaluation
 *   4. TOP-10 market table
 *   5. secondary notes
 *
 * The TOP-10 table deliberately sits BELOW the chart so the chart is visible
 * immediately at 1366x768 without scrolling.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type {
  ChartBox,
  ChartCandle,
  ChartLine,
  ChartMarker,
  ChartSignal,
} from './components/CandleChart';
import SymbolPicker from './components/SymbolPicker';
import { useLiveCandle, useLiveTickers } from './lib/useBinanceStream';
import {
  fmtNum,
  fmtPct,
  fmtPrice,
  fmtShortTime,
  fmtUsd,
  fmtVolume,
  pairName,
} from './lib/format';

const CandleChart = dynamic(() => import('./components/CandleChart'), {
  ssr: false,
  loading: () => <div className="loading">Загрузка графика...</div>,
});

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const;
type Tf = (typeof TIMEFRAMES)[number];

/** Product defaults, per specification. */
const DEFAULT_SYMBOL = 'BTCUSDT';
const DEFAULT_TIMEFRAME: Tf = '15m';

interface SymbolRow {
  symbol: string;
  rank: number;
  baseAsset: string;
  lastPrice: number;
  quoteVolume24h: number;
  priceChangePct: number;
  /** Binance tickSize — price precision for this pair. */
  tickSize?: number | null;
}

interface ScoreComponent {
  detector: string;
  kind?: string;
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
  confirmations?: number;
}

interface LegendEntry {
  detector: string;
  label: string;
  color: string;
}

/** SMC V2 diagnostics as delivered by /api/chart. */
interface V2Diag {
  direction: 'LONG' | 'SHORT' | 'WAIT';
  setup: 'REVERSAL' | 'CONTINUATION' | null;
  location: 'HIGH' | 'LOW' | 'MID';
  phase: string;
  bias: string;
  longEvidence: number;
  shortEvidence: number;
  conflict: number;
  range: { high: number; low: number; mid: number; confidence: number } | null;
  equilibrium: number | null;
  fibZone: string | null;
  rows: Array<{ label: string; value: string; detail?: string }>;
  reasons: string[];
  waitReasons: string[];
  levels: {
    entry: number | null;
    stop: number | null;
    stopReason: string | null;
    targets: Array<{ price: number; basis: string; r: number; reason: string }>;
  };
}

interface ChartData {
  symbol: string;
  timeframe: string;
  /** Binance tickSize for display precision (axis, crosshair, levels). */
  tickSize?: number | null;
  candles: ChartCandle[];
  overlays: {
    boxes: ChartBox[];
    lines: ChartLine[];
    markers: ChartMarker[];
    legend?: LegendEntry[];
  };
  signal?: ChartSignal | null;
  /** SMC V2 research diagnostics; null unless v2.enabled is on. */
  v2?: V2Diag | null;
  closedCount: number;
  empty?: boolean;
  evaluation: {
    candleTime: number;
    closePrice: number;
    atr: number | null;
    long: Breakdown;
    short: Breakdown;
    longScore?: number;
    shortScore?: number;
    confirmations?: number;
    decision: {
      direction: string;
      score: number;
      threshold: number;
      passed: boolean;
      confirmations?: number;
      minConfirmations?: number;
    } | null;
    explainLong: string[];
    explainShort: string[];
  } | null;
}

/**
 * The ACTIVE Smart Money factor set, used as the legend fallback when the
 * current viewport happens to contain no drawn overlays.
 *
 * Removed by specification and deliberately absent: change-of-character,
 * equal levels, volume imbalance, premium/discount.
 */
const ACTIVE_FACTORS: LegendEntry[] = [
  { detector: 'BOS', label: 'BOS', color: '#22c55e' },
  { detector: 'ORDER_BLOCK', label: 'ORDER BLOCK', color: '#3b82f6' },
  { detector: 'FVG', label: 'FVG', color: '#a855f7' },
  { detector: 'LIQUIDITY_SWEEP', label: 'LIQUIDITY SWEEP', color: '#ef4444' },
  { detector: 'RANGE_POSITION', label: 'RANGE POSITION', color: '#14b8a6' },
  { detector: 'INTERNAL_STRUCTURE', label: 'INTERNAL STRUCTURE', color: '#94a3b8' },
  { detector: 'OB_FVG_CONFLUENCE', label: 'OB + FVG CONFLUENCE', color: '#f59e0b' },
];

/**
 * Realtime socket states. «Онлайн» is shown ONLY while ticks are actually
 * arriving — a socket that has gone quiet reports «Задержка», and a dropped
 * one reports «Переподключение», so the indicator never claims a live feed
 * that is not live.
 */
const STATUS_RU: Record<string, string> = {
  online: 'Онлайн',
  connecting: 'Переподключение',
  offline: 'Нет связи · REST',
  stale: 'Задержка',
};

/** Title text explaining what each state means. */
const STATUS_HINT_RU: Record<string, string> = {
  online: 'WebSocket активен, котировки поступают в реальном времени',
  connecting: 'Восстановление WebSocket-соединения',
  offline: 'WebSocket недоступен — данные обновляются периодическими REST-запросами',
  stale: 'Соединение открыто, но новых котировок давно не было',
};

/**
 * Read `?symbol=` / `?timeframe=` written by the «На график» button on
 * /signals. Both are validated: an unknown timeframe or a malformed symbol
 * silently falls back to the default rather than requesting garbage. Whether
 * the symbol actually exists is settled later against the loaded list.
 */
function readQueryParams(): { symbol: string | null; timeframe: Tf | null } {
  if (typeof window === 'undefined') return { symbol: null, timeframe: null };
  const q = new URLSearchParams(window.location.search);

  const rawSymbol = (q.get('symbol') ?? '').toUpperCase();
  const symbol = /^[A-Z0-9]{2,16}USDT$/.test(rawSymbol) ? rawSymbol : null;

  const rawTf = q.get('timeframe');
  const timeframe = TIMEFRAMES.includes(rawTf as Tf) ? (rawTf as Tf) : null;

  return { symbol, timeframe };
}

export default function HomePage(): React.ReactElement {
  // Read once on mount so later manual selection is never overridden.
  const initial = useRef<{ symbol: string | null; timeframe: Tf | null } | null>(null);
  initial.current ??= readQueryParams();

  const [symbols, setSymbols] = useState<SymbolRow[]>([]);
  const [selected, setSelected] = useState<string>(initial.current.symbol ?? DEFAULT_SYMBOL);
  const [timeframe, setTimeframe] = useState<Tf>(initial.current.timeframe ?? DEFAULT_TIMEFRAME);
  const [chart, setChart] = useState<ChartData | null>(null);
  const [showOverlays, setShowOverlays] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /** Generation guard for /api/chart so a stale response cannot win. */
  const chartReqRef = useRef<{ gen: number; controller: AbortController | null }>({
    gen: 0,
    controller: null,
  });

  /* ---------- live data (DISPLAY ONLY — never feeds the engine) ---------- */
  const { candle: liveCandle, status: liveStatus } = useLiveCandle(selected, timeframe);
  const tickerSymbols = useMemo(() => symbols.map((s) => s.symbol), [symbols]);
  const { tickers } = useLiveTickers(tickerSymbols);

  const loadSymbols = useCallback(async () => {
    try {
      const res = await fetch('/api/symbols');
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      const list: SymbolRow[] = json.data.symbols;
      setSymbols(list);
      // Prefer BTCUSDT; fall back to the top-ranked pair if it is not listed.
      setSelected((cur) => {
        // A pair requested via ?symbol= that is not in the current TOP-10 is
        // not an error: fall back to the default instead of showing nothing.
        if (cur && list.some((s) => s.symbol === cur)) return cur;
        if (list.some((s) => s.symbol === DEFAULT_SYMBOL)) return DEFAULT_SYMBOL;
        return list[0]?.symbol ?? cur;
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить список пар');
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Load chart history for one symbol/timeframe.
   *
   * RACE GUARD: requests are not guaranteed to resolve in order. If the user
   * selects ETH 5m while a BTC 15m request is still in flight, the late BTC
   * response must NOT paint over the ETH chart. Every call takes a generation
   * number; only the newest generation may write state. The in-flight request
   * is also aborted, so we do not pay for a response we will discard.
   */
  const loadChart = useCallback(async (symbol: string, tf: Tf) => {
    if (!symbol) return;

    chartReqRef.current.controller?.abort();
    const controller = new AbortController();
    const gen = chartReqRef.current.gen + 1;
    chartReqRef.current = { gen, controller };

    try {
      const res = await fetch(
        `/api/chart?symbol=${symbol}&timeframe=${tf}&limit=300`,
        { signal: controller.signal },
      );
      const json = await res.json();
      // A newer request superseded this one while it was in flight.
      if (chartReqRef.current.gen !== gen) return;
      if (!json.ok) throw new Error(json.error);
      setChart(json.data);
      setError(null);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      if (chartReqRef.current.gen !== gen) return;
      setError(e instanceof Error ? e.message : 'Не удалось загрузить график');
    }
  }, []);

  useEffect(() => {
    void loadSymbols();
    const t = setInterval(() => void loadSymbols(), 30_000);
    return () => clearInterval(t);
  }, [loadSymbols]);

  // REST history + backend Smart Money overlays. The websocket only animates
  // the newest bar between these refreshes; it never replaces this call.
  useEffect(() => {
    void loadChart(selected, timeframe);
    const t = setInterval(() => void loadChart(selected, timeframe), 30_000);
    return () => {
      clearInterval(t);
      // Abandon any in-flight request for the symbol/timeframe we just left.
      chartReqRef.current.controller?.abort();
    };
  }, [selected, timeframe, loadChart]);

  /** Merge live ticker prices over the REST snapshot for the table. */
  const mergedSymbols = useMemo(
    () =>
      symbols.map((s) => {
        const t = tickers[s.symbol];
        return t
          ? { ...s, lastPrice: t.lastPrice, priceChangePct: t.priceChangePct }
          : s;
      }),
    [symbols, tickers],
  );

  /**
   * Current price: prefer the websocket tick, then the live ticker, then the
   * last REST close. Always something sensible on screen.
   */
  const currentPrice = useMemo(() => {
    if (liveCandle && liveCandle.close > 0) return liveCandle.close;
    const t = tickers[selected];
    if (t) return t.lastPrice;
    const row = symbols.find((s) => s.symbol === selected);
    if (row) return row.lastPrice;
    const last = chart?.candles[chart.candles.length - 1];
    return last?.close ?? null;
  }, [liveCandle, tickers, selected, symbols, chart]);

  /**
   * Adapt the stream candle to the chart's prop shape. Guarded on the loaded
   * symbol/timeframe so a late tick from the PREVIOUS subscription can never
   * be drawn onto the newly selected series.
   */
  const liveForChart = useMemo(() => {
    if (!liveCandle || !chart) return null;
    if (chart.symbol !== selected || chart.timeframe !== timeframe) return null;
    return {
      time: liveCandle.openTime,
      open: liveCandle.open,
      high: liveCandle.high,
      low: liveCandle.low,
      close: liveCandle.close,
      volume: liveCandle.volume,
      isClosed: liveCandle.isClosed,
    };
  }, [liveCandle, chart, selected, timeframe]);

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
      {error && <div className="alert alert-error">{error}</div>}

      {/* ============ 1-2. CHART PANEL (hero) ============ */}
      <div className="panel chart-panel" data-testid="chart-panel">
        <div className="chart-toolbar">
          <SymbolPicker
            symbols={mergedSymbols}
            selected={selected}
            onSelect={setSelected}
          />

          <div className="tf-group tf-scroll" data-testid="timeframe-group">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                type="button"
                className={tf === timeframe ? 'active' : ''}
                aria-pressed={tf === timeframe}
                onClick={() => setTimeframe(tf)}
              >
                {tf}
              </button>
            ))}
          </div>

          <div className="chart-price" data-testid="current-price">
            <span className="muted">Цена:</span>{' '}
            <b className="mono">{fmtPrice(currentPrice, chart?.tickSize)}</b>
          </div>

          {/* Colour is paired with a text label, never used alone. */}
          <span
            className={`conn conn-${liveStatus}`}
            data-testid="conn-status"
            title={STATUS_HINT_RU[liveStatus] ?? liveStatus}
            role="status"
            aria-label={`Состояние подключения: ${STATUS_RU[liveStatus] ?? liveStatus}`}
          >
            <span className="dot" aria-hidden="true">
              ●
            </span>
            {STATUS_RU[liveStatus] ?? liveStatus}
          </span>

          <button
            type="button"
            className={`sm-toggle${showOverlays ? ' active' : ''}`}
            aria-pressed={showOverlays}
            onClick={() => setShowOverlays((v) => !v)}
          >
            Разметка Smart Money: {showOverlays ? 'ВКЛ' : 'ВЫКЛ'}
          </button>
        </div>

        {chart && chart.candles.length > 0 ? (
          <>
            <CandleChart
              candles={chart.candles}
              boxes={chart.overlays.boxes}
              lines={chart.overlays.lines}
              markers={chart.overlays.markers}
              signal={chart.signal ?? null}
              showOverlays={showOverlays}
              fitKey={`${chart.symbol}:${chart.timeframe}`}
              liveCandle={liveForChart}
              tickSize={chart.tickSize ?? null}
            />
            <div className="legend">
              {(chart.overlays.legend && chart.overlays.legend.length > 0
                ? chart.overlays.legend
                : ACTIVE_FACTORS
              ).map((f) => (
                <span className="item" key={f.detector}>
                  <span className="swatch" style={{ background: f.color }} />
                  {f.label}
                </span>
              ))}
              <span className="item muted chart-meta">
                {chart.candles.length} свечей ({chart.closedCount} закрытых) · {overlayCount}{' '}
                объектов разметки
              </span>
            </div>
          </>
        ) : (
          <div className="alert alert-info">
            Для пары {pairName(selected)} на таймфрейме {timeframe} ещё нет свечей. Воркер
            рыночных данных загружает таймфреймы, указанные в Админке → engine.timeframes.
          </div>
        )}
      </div>

      {/* ============ 3. SMART MONEY EVALUATION ============ */}
      {ev && best && (
        <div className="grid grid-2">
          <div className="panel">
            <h3>Анализ Smart Money</h3>
            <div className="grid grid-3" style={{ marginBottom: 12 }}>
              <div className="stat">
                <div className="label">Направление</div>
                <div className="value">
                  <span className={`pill ${best.direction === 'LONG' ? 'pill-long' : 'pill-short'}`}>
                    {best.direction}
                  </span>
                </div>
              </div>
              <div className="stat">
                <div className="label">Оценка</div>
                <div className="value">{fmtNum(best.score)}</div>
                <div className="sub">порог {ev.decision?.threshold ?? '—'}</div>
              </div>
              <div className="stat">
                <div className="label">Сигнал</div>
                <div className="value">
                  <span className={`pill ${ev.decision?.passed ? 'pill-ok' : 'pill-idle'}`}>
                    {ev.decision?.passed ? 'Есть' : 'Нет сетапа'}
                  </span>
                </div>
              </div>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              Рассчитано по ЗАКРЫТОЙ свече <b>{fmtShortTime(ev.candleTime)}</b> · закрытие{' '}
              {fmtPrice(ev.closePrice, chart?.tickSize)} · ATR{' '}
              {ev.atr === null ? '—' : fmtPrice(ev.atr, chart?.tickSize)} (только
              для расчёта риска)
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              Вход, если сигнал сработает, — это OPEN СЛЕДУЮЩЕЙ свечи (N+1), а не текущее
              закрытие. Текущая формирующаяся свеча и данные WebSocket на расчёт не влияют.
            </div>
          </div>

          <div className="panel">
            <h3>Расчёт оценки — {best.direction}</h3>
            <pre className="breakdown">
              {(best.direction === 'LONG' ? ev.explainLong : ev.explainShort).join('\n')}
            </pre>
            <details style={{ marginTop: 8 }}>
              <summary>Показать противоположное направление</summary>
              <pre className="breakdown" style={{ marginTop: 8 }}>
                {(best.direction === 'LONG' ? ev.explainShort : ev.explainLong).join('\n')}
              </pre>
            </details>
          </div>
        </div>
      )}

      {/* ============ 3b. SMC V2 DIAGNOSTICS (research engine) ============ */}
      {chart?.v2 && (
        <div className="panel" data-testid="v2-diagnostics">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Диагностика SMC V2</h3>
            <span className="badge badge-muted" title="V2 не управляет сигналами">
              исследовательский режим
            </span>
          </div>

          <div className="v2-head">
            <span
              className={
                chart.v2.direction === 'WAIT'
                  ? 'v2-dir v2-dir-wait'
                  : chart.v2.direction === 'LONG'
                    ? 'v2-dir v2-dir-long'
                    : 'v2-dir v2-dir-short'
              }
            >
              {chart.v2.direction === 'WAIT' ? 'ЖДЁМ' : chart.v2.direction}
            </span>
            <span className="muted">
              {chart.v2.setup === 'REVERSAL'
                ? 'Разворот'
                : chart.v2.setup === 'CONTINUATION'
                  ? 'Продолжение'
                  : 'Сетап не сформирован'}
            </span>
            <span className="muted">
              Положение:{' '}
              {chart.v2.location === 'HIGH'
                ? 'у верхней границы'
                : chart.v2.location === 'LOW'
                  ? 'у нижней границы'
                  : 'середина диапазона'}
            </span>
          </div>

          {chart.v2.range && (
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              Диапазон: {fmtPrice(chart.v2.range.low, chart?.tickSize)} —{' '}
              {fmtPrice(chart.v2.range.high, chart?.tickSize)} · равновесие 50%{' '}
              {fmtPrice(chart.v2.range.mid, chart?.tickSize)}
              {chart.v2.fibZone ? ` · зона ${chart.v2.fibZone}` : ''}
            </div>
          )}

          <div className="v2-grid">
            {chart.v2.rows.map((r) => (
              <div className="v2-row" key={r.label}>
                <span className="v2-label">{r.label}</span>
                <span className="v2-value">{r.value}</span>
                {r.detail ? <span className="v2-detail">{r.detail}</span> : null}
              </div>
            ))}
          </div>

          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            Доказательства (не вероятность): LONG {chart.v2.longEvidence.toFixed(2)} ·
            SHORT {chart.v2.shortEvidence.toFixed(2)} · конфликт{' '}
            {chart.v2.conflict.toFixed(2)}
          </div>

          {chart.v2.direction === 'WAIT' && chart.v2.waitReasons.length > 0 && (
            <div className="alert alert-info" style={{ marginTop: 8 }}>
              <b>Почему ждём:</b>
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {chart.v2.waitReasons.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {chart.v2.direction !== 'WAIT' && chart.v2.reasons.length > 0 && (
            <div className="alert alert-info" style={{ marginTop: 8 }}>
              <b>Основание:</b>
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {chart.v2.reasons.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {chart.v2.levels.stop !== null && (
            <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
              Стоп {fmtPrice(chart.v2.levels.stop, chart?.tickSize)}
              {chart.v2.levels.stopReason ? ` — ${chart.v2.levels.stopReason}` : ''}
              {chart.v2.levels.targets.length > 0 && (
                <>
                  {' · цели: '}
                  {chart.v2.levels.targets
                    .map(
                      (t) =>
                        `${fmtPrice(t.price, chart?.tickSize)} (${t.r.toFixed(1)}R)`,
                    )
                    .join(' → ')}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* ============ 4. TOP-10 MARKET TABLE (below the chart) ============ */}
      <div className="panel" data-testid="top-symbols">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>
            Рынок — Binance Spot USDT, ТОП-{symbols.length || 10}
          </h2>
          <span className="muted" style={{ fontSize: 11 }}>
            По объёму торгов за 24 часа
          </span>
        </div>

        {loading ? (
          <div className="loading">Загрузка...</div>
        ) : symbols.length === 0 ? (
          <div className="alert alert-info">
            Список пар пока пуст. Запустите воркер рыночных данных (
            <code>npm run worker:market</code>) или скрипт первичной загрузки, чтобы заполнить
            ТОП-10.
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Пара</th>
                  <th className="num">Цена</th>
                  <th className="num">Изменение 24ч</th>
                  <th className="num">Объём 24ч</th>
                </tr>
              </thead>
              <tbody>
                {mergedSymbols.map((s) => (
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
                      <b>{pairName(s.symbol)}</b>
                    </td>
                    <td className="num mono cell-price">{fmtUsd(s.lastPrice, s.tickSize)}</td>
                    <td className={`num ${s.priceChangePct >= 0 ? 'up' : 'down'}`}>
                      {fmtPct(s.priceChangePct)}
                    </td>
                    <td className="num mono">{fmtVolume(s.quoteVolume24h)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ============ 5. SECONDARY INFO ============ */}
      <p className="subtitle" style={{ marginTop: 12 }}>
        Данные только с Binance Spot (одна биржа, без агрегации между площадками). Сигналы
        формируются исключительно по закрытым свечам; вход — по цене открытия следующей свечи.
      </p>
    </div>
  );
}

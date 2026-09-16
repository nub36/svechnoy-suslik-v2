'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  OUTCOME_RU,
  SIGNAL_STATE_RU,
  fmtNum,
  fmtPrice,
  fmtShortTime,
  pairName,
  ru,
} from '../lib/format';

/** Small chart glyph for the «На график» action. Decorative only. */
function ChartIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M2 13.5V2.5M2 13.5H14M4.5 11V7M7.5 11V4M10.5 11V8.5M13.5 11V5.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface Component {
  detector: string;
  strength: number;
  weight: number;
  contribution: number;
  counted: boolean;
  skippedReason?: string;
  reason: string;
}

interface Signal {
  id: number;
  symbol: string;
  timeframe: string;
  direction: string;
  state: string;
  mode: string;
  score: number;
  threshold: number;
  breakdown: {
    rawScore?: number;
    totalWeight?: number;
    score?: number;
    components?: Component[];
    duplicatesRemoved?: number;
    /** Present only for V3.0 signals (HTF Liquidation Trap). */
    v30?: {
      strategy: string;
      plan: { direction: string; level: number; zoneLow: number; zoneHigh: number; stop: number; tp1: number; tp2: number };
      lastOutcome?: { exit: string; netR: number; grossR: number; feeR: number; barsHeld: number };
    };
  } | null;
  setupCandleTime: number;
  setupClose: number;
  entryCandleTime: number | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfits: number[];
  atr: number | null;
  rrTp1: number | null;
  tpLevel?: number;
  legacyInconsistent?: boolean;
  /** Binance tickSize for this symbol; drives price precision. */
  tickSize?: number | null;
  outcome: {
    result: string;
    exitPrice: number;
    barsHeld: number;
    pnlPct: number;
    rMultiple: number;
    maxFavorablePct: number;
    maxAdversePct: number;
  } | null;
}

const STATES = [
  '',
  'WAITING_ENTRY',
  'OPEN',
  'TP1_HIT',
  'TP2_HIT',
  'TP3_HIT',
  'STOPPED',
  'EXPIRED',
];

function statePill(s: string): string {
  if (s === 'TP1_HIT' || s === 'TP2_HIT' || s === 'TP3_HIT') return 'pill-ok';
  if (s === 'STOPPED') return 'pill-err';
  if (s === 'OPEN') return 'pill-warn';
  return 'pill-idle';
}

const ts = fmtShortTime;

/**
 * Prices keep per-asset precision from Binance tickSize; a cheap coin must
 * never round to zero. `dp` switches to plain number formatting (ratios).
 */
const fmt = (v: number | null, dp?: number, tickSize?: number | null): string =>
  dp === undefined ? fmtPrice(v, tickSize) : fmtNum(v, dp);

export default function SignalsPage() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [milestones, setMilestones] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/signals?limit=200${filter ? `&state=${filter}` : ''}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      setSignals(json.data.signals);
      setSummary(json.data.summary);
      setMilestones(json.data.milestoneSummary ?? {});
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить сигналы');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div>
      <h1>Сигналы</h1>
      <p className="subtitle">
        Каждый сигнал формируется по ЗАКРЫТОЙ свече (N), а вход выполняется по цене открытия
        свечи N+1. Пока сигнал в состоянии «Ожидание входа», поля входа остаются пустыми.
      </p>

      {error && <div className="alert alert-error">{error}</div>}

      {/* CURRENT STATE — mutually exclusive: every signal is counted once.
          The accent colour only accompanies the text label; it is never the
          sole indicator of a state. */}
      <div className="panel">
        <h2 className="panel-title">
          Текущее состояние
          <span className="hint">
            каждый сигнал учитывается ровно один раз — сумма равна «Всего»
          </span>
        </h2>
        <div className="stat-strip" data-testid="state-summary">
          {(
            [
              ['Всего', summary['total'] ?? 0, 'stat-total'],
              ['Ожидание', summary['waiting'] ?? 0, 'stat-wait'],
              ['Открыто', summary['open'] ?? 0, 'stat-open'],
              ['TP1', summary['tp1'] ?? 0, 'stat-tp'],
              ['TP2', summary['tp2'] ?? 0, 'stat-tp'],
              ['TP3', summary['tp3'] ?? 0, 'stat-tp'],
              ['Стоп', summary['stopped'] ?? 0, 'stat-stop'],
              ['Истёк', summary['expired'] ?? 0, 'stat-expired'],
            ] as Array<[string, number, string]>
          ).map(([label, value, tone]) => (
            <div className={`stat stat-sm stat-accent ${tone}`} key={label}>
              <div className="label">{label}</div>
              <div className="value">{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* HISTORICAL MILESTONES — deliberately overlapping, kept separate. */}
      <div className="panel">
        <h2 className="panel-title">
          Достигнутые цели
          <span className="hint">
            исторический факт: включает сделки, позже закрытые по стопу
          </span>
        </h2>
        <div className="stat-strip" data-testid="milestone-summary">
          {(
            [
              ['TP1 когда-либо', milestones['tp1Ever'] ?? 0],
              ['TP2 когда-либо', milestones['tp2Ever'] ?? 0],
              ['TP3 когда-либо', milestones['tp3Ever'] ?? 0],
            ] as Array<[string, number]>
          ).map(([label, value]) => (
            <div className="stat stat-sm stat-accent stat-tp" key={label}>
              <div className="label">{label}</div>
              <div className="value">{value}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="toolbar">
        <span className="muted">Состояние:</span>
        {STATES.map((s) => (
          <button key={s || 'ALL'} className={filter === s ? 'active' : ''} onClick={() => setFilter(s)}>
            {s === '' ? 'Все' : ru(SIGNAL_STATE_RU, s)}
          </button>
        ))}
        <button onClick={() => void load()}>Обновить</button>
      </div>

      <div className="panel">
        {loading ? (
          <div className="loading">Загрузка...</div>
        ) : signals.length === 0 ? (
          <div className="muted" style={{ padding: 20, textAlign: 'center' }}>
            Сигналов пока нет. Воркер стратегии создаёт сигнал только в момент перехода
            состояния, когда оценка превышает порог.
          </div>
        ) : (
          <table>
            <thead>
              {/* Column order follows importance: pair, TF, direction,
                  state, score, entry, SL, TP, R, action. Timestamps and the
                  mode moved into the expandable details row. */}
              <tr>
                <th>Пара</th>
                <th>ТФ</th>
                <th>Напр.</th>
                <th>Состояние</th>
                <th className="num">Оценка</th>
                <th className="num">Entry</th>
                <th className="num">SL</th>
                <th className="num">TP1</th>
                <th className="num">TP2</th>
                <th className="num">TP3</th>
                <th className="num">R</th>
                <th>Цели</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {signals.map((s) => (
                <>
                  <tr
                    key={s.id}
                    className="clickable"
                    onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                  >
                    <td className="cell-key">
                      {pairName(s.symbol)}
                      <div className="cell-meta">#{s.id}</div>
                    </td>
                    <td>{s.timeframe}</td>
                    <td>
                      <span className={`pill ${s.direction === 'LONG' ? 'pill-long' : 'pill-short'}`}>
                        {s.direction}
                      </span>
                    </td>
                    <td>
                      <span className={`pill ${statePill(s.state)}`}>
                        {ru(SIGNAL_STATE_RU, s.state)}
                      </span>
                      {s.legacyInconsistent && (
                        <span
                          className="pill pill-idle"
                          style={{ marginLeft: 4 }}
                          title="Исторические данные: состояние и результат противоречат друг другу (создано прежней логикой). Запись сохранена без изменений."
                        >
                          устаревшие
                        </span>
                      )}
                    </td>
                    <td className="num">
                      {s.breakdown?.v30 ? (
                        <>
                          <b>V3.0</b>
                          <span className="cell-meta">
                            {' '}
                            {s.breakdown.v30.plan.level.toFixed(2)} →{' '}
                            {s.breakdown.v30.plan.tp1.toFixed(2)}
                          </span>
                        </>
                      ) : (
                        <>
                          <b>{s.score.toFixed(1)}</b>
                          <span className="cell-meta"> /{s.threshold}</span>
                        </>
                      )}
                    </td>
                    {/* Prices use this symbol's Binance tickSize precision. */}
                    <td className="num cell-price mono">
                      {s.entryPrice === null ? (
                        s.breakdown?.v30 ? (
                          <span className="cell-meta" title="Лимитный коридор вокруг закрытия свечи возврата">
                            {fmtPrice(s.breakdown.v30.plan.zoneLow, s.tickSize)}–
                            {fmtPrice(s.breakdown.v30.plan.zoneHigh, s.tickSize)}
                          </span>
                        ) : (
                          <span className="cell-meta">ожидание N+1</span>
                        )
                      ) : (
                        fmtPrice(s.entryPrice, s.tickSize)
                      )}
                    </td>
                    <td className="num cell-price mono">{fmtPrice(s.stopLoss, s.tickSize)}</td>
                    <td className="num cell-price mono">
                      {fmtPrice(s.takeProfits?.[0] ?? null, s.tickSize)}
                    </td>
                    <td className="num cell-price mono">
                      {fmtPrice(s.takeProfits?.[1] ?? null, s.tickSize)}
                    </td>
                    <td className="num cell-price mono">
                      {fmtPrice(s.takeProfits?.[2] ?? null, s.tickSize)}
                    </td>
                    <td className={`num ${(s.outcome?.rMultiple ?? 0) >= 0 ? 'up' : 'down'}`}>
                      {s.outcome ? s.outcome.rMultiple.toFixed(2) : '—'}
                    </td>
                    {/* Milestones reached at any point, even if later stopped. */}
                    <td>
                      {(s.tpLevel ?? 0) > 0 ? (
                        <span
                          className="pill pill-ok"
                          title="Цели, достигнутые за время сделки. Это исторический факт, а не зафиксированная прибыль."
                        >
                          {Array.from({ length: Math.min(s.tpLevel ?? 0, 3) }, (_, i) => `TP${i + 1}`).join(' ')}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {/* Reuses the existing chart on the home page — a plain
                          link, so Back/Forward behave normally. */}
                      <a
                        className="btn btn-sm btn-primary btn-icon"
                        href={`/?symbol=${encodeURIComponent(s.symbol)}&timeframe=${encodeURIComponent(s.timeframe)}`}
                        onClick={(e) => e.stopPropagation()}
                        title={`Открыть ${pairName(s.symbol)} ${s.timeframe} на графике`}
                        aria-label={`Открыть ${pairName(s.symbol)} ${s.timeframe} на графике`}
                      >
                        <ChartIcon />
                        На график
                      </a>
                    </td>
                  </tr>
                  {expanded === s.id && (
                    <tr key={`${s.id}-detail`}>
                      <td colSpan={13} style={{ background: '#0b0e14' }}>
                        <div className="grid grid-2">
                          <div>
                            <h3 className="panel-title">
                              {s.breakdown?.v30 ? 'План V3.0 (HTF Liquidation Trap)' : 'Расчёт оценки (прозрачный)'}
                            </h3>
                            {s.breakdown?.v30 && (
                              <div className="subpanel">
                                <div className="muted" style={{ fontSize: 12, lineHeight: 1.8 }}>
                                  Вынесенный уровень 4H: <b>{fmtPrice(s.breakdown.v30.plan.level, s.tickSize)}</b>
                                  <br />
                                  Коридор входа: <b>{fmtPrice(s.breakdown.v30.plan.zoneLow, s.tickSize)}</b> –{' '}
                                  <b>{fmtPrice(s.breakdown.v30.plan.zoneHigh, s.tickSize)}</b>
                                  <br />
                                  Стоп: <b>{fmtPrice(s.breakdown.v30.plan.stop, s.tickSize)}</b> · TP1
                                  (равновесие): <b>{fmtPrice(s.breakdown.v30.plan.tp1, s.tickSize)}</b> · TP2
                                  (противоположный свинг):{' '}
                                  <b>{fmtPrice(s.breakdown.v30.plan.tp2, s.tickSize)}</b>
                                  {s.breakdown.v30.lastOutcome && (
                                    <>
                                      <br />
                                      Выход: <b>{s.breakdown.v30.lastOutcome.exit}</b> · net{' '}
                                      <b>{s.breakdown.v30.lastOutcome.netR.toFixed(3)} R</b> · gross{' '}
                                      {s.breakdown.v30.lastOutcome.grossR.toFixed(3)} R · комиссии{' '}
                                      {s.breakdown.v30.lastOutcome.feeR.toFixed(3)} R · свечей{' '}
                                      {s.breakdown.v30.lastOutcome.barsHeld}
                                    </>
                                  )}
                                  <br />
                                  У V3.0 нет балльной оценки: сигнал выдаёт геометрия 4H-выноса, поэтому
                                  в колонке оценки стоит «V3.0», а не выдуманное число.
                                </div>
                              </div>
                            )}
                            {/* Every number is kept — name, strength, weight and
                                contribution are simply easier to tell apart. */}
                            <div className="subpanel">
                              {(s.breakdown?.components ?? []).map((c, i) => (
                                <div
                                  className={`sm-factor${c.counted ? '' : ' is-skipped'}`}
                                  key={i}
                                >
                                  <div className="sm-name">
                                    {c.detector}
                                    {!c.counted && (
                                      <span
                                        className="pill pill-idle"
                                        style={{ marginLeft: 6 }}
                                        title={c.skippedReason}
                                      >
                                        ПРОПУЩЕН
                                      </span>
                                    )}
                                  </div>
                                  <div className="sm-math">
                                    сила {c.strength.toFixed(3)} × вес {c.weight}
                                  </div>
                                  <div className="sm-contrib">
                                    {c.counted ? `+${c.contribution.toFixed(3)}` : '0'}
                                  </div>
                                </div>
                              ))}
                            </div>
                            <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
                              сумма вкладов {s.breakdown?.rawScore?.toFixed(3) ?? '—'} / сумма
                              весов {s.breakdown?.totalWeight?.toFixed(1) ?? '—'} × 100 ={' '}
                              <b style={{ color: 'var(--text-strong)' }}>
                                {s.breakdown?.score?.toFixed(2) ?? '—'}
                              </b>
                              {(s.breakdown?.duplicatesRemoved ?? 0) > 0 &&
                                ` · исключено дубликатов: ${s.breakdown?.duplicatesRemoved} (защита от двойного учёта)`}
                            </div>
                          </div>
                          <div>
                            <h3 className="panel-title">Исполнение и результат</h3>
                            <table>
                              <tbody>
                                {/* Moved out of the main table to keep the
                                    columns focused on price and state. */}
                                <tr>
                                  <td className="muted">Свеча сетапа (N)</td>
                                  <td className="mono num">{ts(s.setupCandleTime)}</td>
                                </tr>
                                <tr>
                                  <td className="muted">Свеча входа (N+1)</td>
                                  <td className="mono num">
                                    {s.entryCandleTime === null
                                      ? 'ожидается N+1'
                                      : ts(s.entryCandleTime)}
                                  </td>
                                </tr>
                                <tr>
                                  <td className="muted">Режим</td>
                                  <td className="mono num">{s.mode}</td>
                                </tr>
                                <tr>
                                  <td className="muted">Закрытие свечи сетапа (N)</td>
                                  <td className="mono num">{fmt(s.setupClose, undefined, s.tickSize)}</td>
                                </tr>
                                <tr>
                                  <td className="muted">Вход (OPEN свечи N+1)</td>
                                  <td className="mono num">{fmt(s.entryPrice, undefined, s.tickSize)}</td>
                                </tr>
                                <tr>
                                  <td className="muted">Стоп-лосс (SL)</td>
                                  <td className="mono num">{fmt(s.stopLoss, undefined, s.tickSize)}</td>
                                </tr>
                                <tr>
                                  <td className="muted">Тейк-профиты (TP)</td>
                                  <td className="mono num">
                                    {(s.takeProfits ?? [])
                                      .map((t) => fmt(t, undefined, s.tickSize))
                                      .join(' · ') || '—'}
                                  </td>
                                </tr>
                                <tr>
                                  <td className="muted">ATR (только для риска)</td>
                                  <td className="mono num">{fmt(s.atr, undefined, s.tickSize)}</td>
                                </tr>
                                <tr>
                                  <td className="muted">R:R до TP1</td>
                                  <td className="mono num">{fmt(s.rrTp1, 2)}</td>
                                </tr>
                                {s.outcome && (
                                  <>
                                    <tr>
                                      <td className="muted">Результат</td>
                                      <td>
                                        <span
                                          className={`pill ${
                                            s.outcome.result === 'TP' ? 'pill-ok' : s.outcome.result === 'SL' ? 'pill-err' : 'pill-idle'
                                          }`}
                                        >
                                          {ru(OUTCOME_RU, s.outcome.result)}
                                        </span>
                                      </td>
                                    </tr>
                                    <tr>
                                      <td className="muted">Цена выхода</td>
                                      <td className="mono num">{fmt(s.outcome.exitPrice, undefined, s.tickSize)}</td>
                                    </tr>
                                    <tr>
                                      <td className="muted">Свечей в сделке</td>
                                      <td className="mono num">{s.outcome.barsHeld}</td>
                                    </tr>
                                    <tr>
                                      <td className="muted">Прибыль/убыток, %</td>
                                      <td className={`mono num ${s.outcome.pnlPct >= 0 ? 'up' : 'down'}`}>
                                        {s.outcome.pnlPct.toFixed(3)}%
                                      </td>
                                    </tr>
                                    <tr>
                                      <td className="muted">R-мультипликатор</td>
                                      <td className={`mono num ${s.outcome.rMultiple >= 0 ? 'up' : 'down'}`}>
                                        {s.outcome.rMultiple.toFixed(3)}
                                      </td>
                                    </tr>
                                    <tr>
                                      <td className="muted">Макс. в плюс / в минус</td>
                                      <td className="mono num">
                                        {s.outcome.maxFavorablePct.toFixed(2)}% /{' '}
                                        {s.outcome.maxAdversePct.toFixed(2)}%
                                      </td>
                                    </tr>
                                  </>
                                )}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

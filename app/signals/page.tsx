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
  } | null;
  setupCandleTime: number;
  setupClose: number;
  entryCandleTime: number | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfits: number[];
  atr: number | null;
  rrTp1: number | null;
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

/** Prices keep per-asset precision; a cheap coin must not round to zero. */
const fmt = (v: number | null, dp?: number): string =>
  dp === undefined ? fmtPrice(v) : fmtNum(v, dp);

export default function SignalsPage() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [summary, setSummary] = useState<Record<string, number>>({});
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

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        {[
          ['Всего', summary['total'] ?? 0],
          ['Ожидание входа', summary['waiting'] ?? 0],
          ['Открыто', summary['active'] ?? 0],
          ['TP', summary['tp'] ?? 0],
          ['SL', summary['sl'] ?? 0],
          ['Таймаут', summary['timeout'] ?? 0],
        ].map(([label, value]) => (
          <div className="stat" key={String(label)}>
            <div className="label">{label}</div>
            <div className="value">{value}</div>
          </div>
        ))}
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
              <tr>
                <th>ID</th>
                <th>Пара</th>
                <th>ТФ</th>
                <th>Направление</th>
                <th>Состояние</th>
                <th>Режим</th>
                <th className="num">Оценка</th>
                <th>Свеча сетапа (N)</th>
                <th>Свеча входа (N+1)</th>
                <th className="num">Entry</th>
                <th className="num">SL</th>
                <th className="num">TP1</th>
                <th className="num">R</th>
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
                    <td className="muted">#{s.id}</td>
                    <td>
                      <b>{pairName(s.symbol)}</b>
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
                    </td>
                    <td className="muted" style={{ fontSize: 11 }}>
                      {s.mode}
                    </td>
                    <td className="num">
                      <b>{s.score.toFixed(1)}</b>
                      <span className="muted"> /{s.threshold}</span>
                    </td>
                    <td className="mono">{ts(s.setupCandleTime)}</td>
                    <td className="mono">
                      {s.entryCandleTime === null ? (
                        <span className="muted">ожидается N+1</span>
                      ) : (
                        ts(s.entryCandleTime)
                      )}
                    </td>
                    <td className="num mono">{fmt(s.entryPrice)}</td>
                    <td className="num mono">{fmt(s.stopLoss)}</td>
                    <td className="num mono">{fmt(s.takeProfits?.[0] ?? null)}</td>
                    <td className={`num ${(s.outcome?.rMultiple ?? 0) >= 0 ? 'up' : 'down'}`}>
                      {s.outcome ? s.outcome.rMultiple.toFixed(2) : '—'}
                    </td>
                  </tr>
                  {expanded === s.id && (
                    <tr key={`${s.id}-detail`}>
                      <td colSpan={13} style={{ background: '#0b0e14' }}>
                        <div className="grid grid-2">
                          <div>
                            <h3>Расчёт оценки (прозрачный)</h3>
                            <table>
                              <thead>
                                <tr>
                                  <th>Фактор</th>
                                  <th className="num">Сила</th>
                                  <th className="num">Вес</th>
                                  <th className="num">Вклад</th>
                                  <th>Учтён</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(s.breakdown?.components ?? []).map((c, i) => (
                                  <tr key={i}>
                                    <td>{c.detector}</td>
                                    <td className="num mono">{c.strength.toFixed(3)}</td>
                                    <td className="num mono">{c.weight}</td>
                                    <td className="num mono">
                                      {c.counted ? c.contribution.toFixed(3) : '0'}
                                    </td>
                                    <td>
                                      {c.counted ? (
                                        <span className="pill pill-ok">ДА</span>
                                      ) : (
                                        <span className="pill pill-idle" title={c.skippedReason}>
                                          ПРОПУЩЕН
                                        </span>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                              сумма вкладов {s.breakdown?.rawScore?.toFixed(3) ?? '—'} / сумма
                              весов {s.breakdown?.totalWeight?.toFixed(1) ?? '—'} × 100 ={' '}
                              <b>{s.breakdown?.score?.toFixed(2) ?? '—'}</b>
                              {(s.breakdown?.duplicatesRemoved ?? 0) > 0 &&
                                ` · исключено дубликатов: ${s.breakdown?.duplicatesRemoved} (защита от двойного учёта)`}
                            </div>
                          </div>
                          <div>
                            <h3>Исполнение и результат</h3>
                            <table>
                              <tbody>
                                <tr>
                                  <td className="muted">Закрытие свечи сетапа (N)</td>
                                  <td className="mono num">{fmt(s.setupClose)}</td>
                                </tr>
                                <tr>
                                  <td className="muted">Вход (OPEN свечи N+1)</td>
                                  <td className="mono num">{fmt(s.entryPrice)}</td>
                                </tr>
                                <tr>
                                  <td className="muted">Стоп-лосс (SL)</td>
                                  <td className="mono num">{fmt(s.stopLoss)}</td>
                                </tr>
                                <tr>
                                  <td className="muted">Тейк-профиты (TP)</td>
                                  <td className="mono num">
                                    {(s.takeProfits ?? []).map((t) => fmt(t)).join(' · ') || '—'}
                                  </td>
                                </tr>
                                <tr>
                                  <td className="muted">ATR (только для риска)</td>
                                  <td className="mono num">{fmt(s.atr)}</td>
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
                                      <td className="mono num">{fmt(s.outcome.exitPrice)}</td>
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

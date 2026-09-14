'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  OUTCOME_RU,
  fmtIsoDateTime,
  fmtNum,
  fmtPrice,
  fmtShortTime,
  pairName,
  ru,
} from '../lib/format';

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const;

interface Stats {
  total: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number;
  avgR: number;
  totalR: number;
  profitFactor: number;
  maxDrawdownR: number;
}

interface Trade {
  symbol: string;
  timeframe: string;
  direction: string;
  score: number;
  setupCandleTime: number;
  entryCandleTime: number;
  entryPrice: number;
  stopLoss: number;
  takeProfits: number[];
  result: string;
  exitPrice: number | null;
  barsHeld: number;
  rMultiple: number;
  pnlPct: number;
}

interface SeriesResult {
  symbol: string;
  timeframe: string;
  candlesSeen: number;
  evaluations: number;
  tradeCount: number;
  tradesTruncated?: boolean;
  stats: Stats;
  trades: Trade[];
}

interface Run {
  id: number;
  label: string;
  symbols: string[];
  timeframes: string[];
  candlesSeen: number;
  signals: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number;
  avgR: number;
  totalR: number;
  profitFactor: number;
  maxDrawdownR: number;
  createdAt: string;
}

export default function ReplayPage() {
  const [symbols, setSymbols] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [tfs, setTfs] = useState<string[]>(['1h']);
  const [results, setResults] = useState<SeriesResult[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authed, setAuthed] = useState(true);

  const loadRuns = useCallback(async () => {
    const res = await fetch('/api/replay');
    const json = await res.json();
    if (json.ok) setRuns(json.data.runs);
  }, []);

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/symbols');
      const json = await res.json();
      if (json.ok) {
        const list: string[] = json.data.symbols.map((s: { symbol: string }) => s.symbol);
        setSymbols(list);
        setPicked(list.slice(0, 3));
      }
    })();
    void loadRuns();
  }, [loadRuns]);

  const run = async (): Promise<void> => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          symbols: picked,
          timeframes: tfs,
          label: `UI replay ${new Date().toISOString().slice(0, 16)}`,
        }),
      });
      if (res.status === 401) {
        setAuthed(false);
        throw new Error('Для запуска Replay нужен вход в админку.');
      }
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      setResults(json.data.results);
      await loadRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выполнить Replay');
    } finally {
      setRunning(false);
    }
  };

  const toggle = (arr: string[], v: string, set: (x: string[]) => void): void => {
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  };

  const agg = results.reduce(
    (acc, r) => ({
      total: acc.total + r.stats.total,
      wins: acc.wins + r.stats.wins,
      losses: acc.losses + r.stats.losses,
      timeouts: acc.timeouts + r.stats.timeouts,
      totalR: acc.totalR + r.stats.totalR,
      evaluations: acc.evaluations + r.evaluations,
      candles: acc.candles + r.candlesSeen,
    }),
    { total: 0, wins: 0, losses: 0, timeouts: 0, totalR: 0, evaluations: 0, candles: 0 },
  );

  return (
    <div>
      <h1>История / Replay</h1>
      <p className="subtitle">
        Пошаговое воспроизведение истории на <b>том же движке Smart Money</b>, что и в реальном
        времени: те же факторы, тот же расчёт оценки, та же машина состояний, то же правило
        входа по свече N+1 и тот же учёт результатов.
      </p>

      {error && <div className="alert alert-error">{error}</div>}
      {!authed && (
        <div className="alert alert-info">
          Сначала войдите в админку — запуск Replay доступен только авторизованным.
        </div>
      )}

      <div className="panel">
        <h3>Пары</h3>
        <div className="row" style={{ marginBottom: 12 }}>
          {symbols.length === 0 && <span className="muted">Доступных пар нет.</span>}
          {symbols.map((s) => (
            <button
              key={s}
              className={picked.includes(s) ? 'active' : ''}
              onClick={() => toggle(picked, s, setPicked)}
            >
              {pairName(s)}
            </button>
          ))}
        </div>
        <h3>Таймфреймы</h3>
        <div className="row" style={{ marginBottom: 12 }}>
          {TIMEFRAMES.map((t) => (
            <button key={t} className={tfs.includes(t) ? 'active' : ''} onClick={() => toggle(tfs, t, setTfs)}>
              {t}
            </button>
          ))}
        </div>
        <button
          className="primary"
          disabled={running || picked.length === 0 || tfs.length === 0}
          onClick={() => void run()}
        >
          {running ? 'Выполняется...' : `Запустить Replay (${picked.length} × ${tfs.length})`}
        </button>
      </div>

      {results.length > 0 && (
        <>
          <div className="grid grid-4" style={{ marginBottom: 16 }}>
            <div className="stat">
              <div className="label">Обработано свечей</div>
              <div className="value">{agg.candles.toLocaleString('ru-RU')}</div>
            </div>
            <div className="stat">
              <div className="label">Расчётов</div>
              <div className="value">{agg.evaluations.toLocaleString('ru-RU')}</div>
            </div>
            <div className="stat">
              <div className="label">Закрытых сделок</div>
              <div className="value">{agg.total}</div>
              <div className="sub">
                {agg.wins} побед / {agg.losses} убытков / {agg.timeouts} по таймауту
              </div>
            </div>
            <div className="stat">
              <div className="label">Доля прибыльных</div>
              <div className="value">
                {agg.total > 0 ? fmtNum((agg.wins / agg.total) * 100, 1) : '0,0'}%
              </div>
            </div>
            <div className="stat">
              <div className="label">Суммарный R</div>
              <div className={`value ${agg.totalR >= 0 ? 'up' : 'down'}`}>{fmtNum(agg.totalR)}</div>
            </div>
            <div className="stat">
              <div className="label">Средний R</div>
              <div className={`value ${agg.totalR >= 0 ? 'up' : 'down'}`}>
                {agg.total > 0 ? fmtNum(agg.totalR / agg.total, 3) : '0'}
              </div>
            </div>
          </div>

          <div className="panel">
            <h2>По каждой серии</h2>
            <table>
              <thead>
                <tr>
                  <th>Пара</th>
                  <th>ТФ</th>
                  <th className="num">Свечей</th>
                  <th className="num">Расчётов</th>
                  <th className="num">Сделок</th>
                  <th className="num">П/У/Т</th>
                  <th className="num">Прибыльных %</th>
                  <th className="num">Суммарный R</th>
                  <th className="num">Средний R</th>
                  <th className="num">ПФ</th>
                  <th className="num">Макс. просадка</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={`${r.symbol}-${r.timeframe}`}>
                    <td>
                      <b>{pairName(r.symbol)}</b>
                    </td>
                    <td>{r.timeframe}</td>
                    <td className="num mono">{r.candlesSeen}</td>
                    <td className="num mono">{r.evaluations}</td>
                    <td className="num mono">{r.tradeCount}</td>
                    <td className="num mono">
                      {r.stats.wins}/{r.stats.losses}/{r.stats.timeouts}
                    </td>
                    <td className="num mono">{fmtNum(r.stats.winRate, 1)}%</td>
                    <td className={`num mono ${r.stats.totalR >= 0 ? 'up' : 'down'}`}>
                      {fmtNum(r.stats.totalR)}
                    </td>
                    <td className={`num mono ${r.stats.avgR >= 0 ? 'up' : 'down'}`}>
                      {fmtNum(r.stats.avgR, 3)}
                    </td>
                    <td className="num mono">
                      {Number.isFinite(r.stats.profitFactor) ? fmtNum(r.stats.profitFactor) : '∞'}
                    </td>
                    <td className="num mono down">{fmtNum(r.stats.maxDrawdownR)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h2>Примеры сделок (вход по свече N+1)</h2>
            <p className="muted small">
              Это только выборка для просмотра — статистика выше рассчитана по всем сделкам
              прогона ({results.reduce((a, r) => a + r.tradeCount, 0)}).
            </p>
            <table>
              <thead>
                <tr>
                  <th>Пара</th>
                  <th>ТФ</th>
                  <th>Направление</th>
                  <th className="num">Оценка</th>
                  <th>Свеча сетапа (N)</th>
                  <th>Свеча входа (N+1)</th>
                  <th className="num">Entry</th>
                  <th className="num">SL</th>
                  <th>Результат</th>
                  <th className="num">Свечей</th>
                  <th className="num">R</th>
                </tr>
              </thead>
              <tbody>
                {results.flatMap((r) => r.trades.slice(0, 12)).slice(0, 60).map((t, i) => (
                  <tr key={i}>
                    <td>{pairName(t.symbol)}</td>
                    <td>{t.timeframe}</td>
                    <td>
                      <span className={`pill ${t.direction === 'LONG' ? 'pill-long' : 'pill-short'}`}>
                        {t.direction}
                      </span>
                    </td>
                    <td className="num mono">{fmtNum(t.score, 1)}</td>
                    <td className="mono">
                      {fmtShortTime(t.setupCandleTime)}
                    </td>
                    <td className="mono">
                      {fmtShortTime(t.entryCandleTime)}
                    </td>
                    <td className="num mono">{fmtPrice(t.entryPrice)}</td>
                    <td className="num mono">{fmtPrice(t.stopLoss)}</td>
                    <td>
                      <span
                        className={`pill ${
                          t.result === 'TP' ? 'pill-ok' : t.result === 'SL' ? 'pill-err' : 'pill-idle'
                        }`}
                      >
                        {ru(OUTCOME_RU, t.result)}
                      </span>
                    </td>
                    <td className="num mono">{t.barsHeld}</td>
                    <td className={`num mono ${t.rMultiple >= 0 ? 'up' : 'down'}`}>
                      {fmtNum(t.rMultiple, 3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="panel">
        <h2>Сохранённые прогоны</h2>
        {runs.length === 0 ? (
          <div className="muted">Сохранённых прогонов пока нет.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Название</th>
                <th>Пары</th>
                <th>ТФ</th>
                <th className="num">Сделок</th>
                <th className="num">Прибыльных %</th>
                <th className="num">Суммарный R</th>
                <th className="num">ПФ</th>
                <th>Создан</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="muted">#{r.id}</td>
                  <td>{r.label}</td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {(r.symbols ?? []).join(', ')}
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {(r.timeframes ?? []).join(', ')}
                  </td>
                  <td className="num mono">{r.signals}</td>
                  <td className="num mono">{fmtNum(r.winRate, 1)}%</td>
                  <td className={`num mono ${r.totalR >= 0 ? 'up' : 'down'}`}>{fmtNum(r.totalR)}</td>
                  <td className="num mono">{fmtNum(r.profitFactor)}</td>
                  <td className="mono muted" style={{ fontSize: 11 }}>
                    {fmtIsoDateTime(r.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

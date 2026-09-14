'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  HEALTH_RU,
  SIGNAL_STATE_RU,
  WORKER_RU,
  fmtAge,
  fmtIsoDateTime,
  fmtNum,
  fmtShortTime,
  ru,
} from '../lib/format';

interface Monitoring {
  timestamp: string;
  health: {
    database: string;
    overall: string;
    workers: Array<{
      worker: string;
      status: string;
      detail: string;
      ageSec: number | null;
      loops: number;
      errors: number;
    }>;
  };
  engine: {
    enabled: boolean;
    tradingMode: string;
    liveTradingEnabled: boolean;
    liveLocked: boolean;
    threshold: number;
    minComponents: number;
    timeframes: string[];
    maxConcurrent: number;
  };
  market: {
    exchange: string;
    quoteAsset: string;
    activeSymbols: number;
    topN: number;
    candlesByTimeframe: Array<{
      timeframe: string;
      symbols: number;
      candles: number;
      closed: number;
      latest: number;
    }>;
  };
  states: { machines: number; byState: Record<string, number> };
  signals: Record<string, number>;
  performance: {
    total: number;
    wins: number;
    losses: number;
    timeouts: number;
    winRate: number;
    avgR: number;
    totalR: number;
    profitFactor: number;
    maxDrawdownR: number;
  };
  logs: Array<{
    id: number;
    level: string;
    worker: string;
    message: string;
    createdAt: string;
  }>;
}

function healthPill(s: string): string {
  if (s === 'OK' || s === 'HEALTHY') return 'pill-ok';
  if (s === 'DEGRADED' || s === 'STALE') return 'pill-warn';
  return 'pill-err';
}

export default function MonitoringPage() {
  const [data, setData] = useState<Monitoring | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/monitoring');
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      setData(json.data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить данные мониторинга');
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <div className="alert alert-error">{error}</div>;
  if (!data) return <div className="loading">Загрузка...</div>;

  const p = data.performance;

  return (
    <div>
      <h1>Мониторинг</h1>
      <p className="subtitle">
        Обновлено: {fmtIsoDateTime(data.timestamp)} · автообновление каждые 10 секунд
      </p>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="label">Общее состояние</div>
          <div className="value">
            <span className={`pill ${healthPill(data.health.overall)}`}>
              {ru(HEALTH_RU, data.health.overall)}
            </span>
          </div>
        </div>
        <div className="stat">
          <div className="label">База данных</div>
          <div className="value">
            <span className={`pill ${healthPill(data.health.database)}`}>
              {ru(HEALTH_RU, data.health.database)}
            </span>
          </div>
        </div>
        <div className="stat">
          <div className="label">Режим торговли</div>
          <div className="value">
            <span className="pill pill-warn">{data.engine.tradingMode}</span>
          </div>
          <div className="sub">режим LIVE заблокирован</div>
        </div>
        <div className="stat">
          <div className="label">Движок</div>
          <div className="value">
            <span className={`pill ${data.engine.enabled ? 'pill-ok' : 'pill-idle'}`}>
              {data.engine.enabled ? 'Включён' : 'Выключен'}
            </span>
          </div>
        </div>
      </div>

      {data.engine.liveTradingEnabled ? (
        <div className="alert alert-error">
          КРИТИЧНО: включён флаг реальной торговли — эта сборка не должна этого допускать.
        </div>
      ) : (
        <div className="alert alert-ok">
          Режим LIVE заблокирован. Доступны только DRY_RUN и FORWARD_TEST; кода для отправки
          ордеров на биржу в проекте нет.
        </div>
      )}

      <div className="grid grid-2">
        <div className="panel">
          <h2>Воркеры</h2>
          <table>
            <thead>
              <tr>
                <th>Воркер</th>
                <th>Статус</th>
                <th className="num">Последний сигнал</th>
                <th className="num">Циклов</th>
                <th className="num">Ошибок</th>
                <th>Подробности</th>
              </tr>
            </thead>
            <tbody>
              {data.health.workers.map((w) => (
                <tr key={w.worker}>
                  <td>
                    <b>{ru(WORKER_RU, w.worker)}</b>
                  </td>
                  <td>
                    <span className={`pill ${healthPill(w.status)}`}>
                      {ru(HEALTH_RU, w.status)}
                    </span>
                  </td>
                  <td className="num mono">{fmtAge(w.ageSec)}</td>
                  <td className="num mono">{w.loops}</td>
                  <td className={`num mono ${w.errors > 0 ? 'down' : ''}`}>{w.errors}</td>
                  <td className="muted" style={{ fontSize: 11 }}>
                    {w.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            Ожидаемые процессы PM2: svechnoy-suslik-v2-web / -market / -strategy / -outcome
          </p>
        </div>

        <div className="panel">
          <h2>Конфигурация движка (из базы данных)</h2>
          <table>
            <tbody>
              <tr>
                <td className="muted">Порог оценки</td>
                <td className="num mono">{data.engine.threshold}</td>
              </tr>
              <tr>
                <td className="muted">Мин. число подтверждений</td>
                <td className="num mono">{data.engine.minComponents}</td>
              </tr>
              <tr>
                <td className="muted">Активные таймфреймы</td>
                <td className="mono">{data.engine.timeframes.join(', ')}</td>
              </tr>
              <tr>
                <td className="muted">Макс. одновременных позиций</td>
                <td className="num mono">{data.engine.maxConcurrent}</td>
              </tr>
              <tr>
                <td className="muted">Биржа</td>
                <td className="mono">
                  {data.market.exchange} · {data.market.quoteAsset}
                </td>
              </tr>
              <tr>
                <td className="muted">Активные пары</td>
                <td className="num mono">
                  {data.market.activeSymbols} / ТОП-{data.market.topN}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>Покрытие свечами по таймфреймам</h2>
        {data.market.candlesByTimeframe.length === 0 ? (
          <div className="muted">Свечей пока нет.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Таймфрейм</th>
                <th className="num">Пар</th>
                <th className="num">Свечей</th>
                <th className="num">Закрытых</th>
                <th>Последняя свеча</th>
              </tr>
            </thead>
            <tbody>
              {data.market.candlesByTimeframe.map((c) => (
                <tr key={c.timeframe}>
                  <td>
                    <b>{c.timeframe}</b>
                  </td>
                  <td className="num mono">{c.symbols}</td>
                  <td className="num mono">{c.candles}</td>
                  <td className="num mono">{c.closed}</td>
                  <td className="mono">
                    {c.latest > 0 ? fmtShortTime(c.latest) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid grid-2">
        <div className="panel">
          <h2>Результаты форвард-теста</h2>
          <div className="grid grid-3">
            <div className="stat">
              <div className="label">Закрытых сделок</div>
              <div className="value">{p.total}</div>
              <div className="sub">
                {p.wins} побед / {p.losses} убытков / {p.timeouts} по таймауту
              </div>
            </div>
            <div className="stat">
              <div className="label">Доля прибыльных</div>
              <div className="value">{fmtNum(p.winRate, 1)}%</div>
            </div>
            <div className="stat">
              <div className="label">Суммарный R</div>
              <div className={`value ${p.totalR >= 0 ? 'up' : 'down'}`}>{fmtNum(p.totalR)}</div>
            </div>
            <div className="stat">
              <div className="label">Средний R</div>
              <div className={`value ${p.avgR >= 0 ? 'up' : 'down'}`}>{fmtNum(p.avgR, 3)}</div>
            </div>
            <div className="stat">
              <div className="label">Профит-фактор</div>
              <div className="value">
                {Number.isFinite(p.profitFactor) ? fmtNum(p.profitFactor) : '∞'}
              </div>
            </div>
            <div className="stat">
              <div className="label">Макс. просадка (R)</div>
              <div className="value down">{fmtNum(p.maxDrawdownR)}</div>
            </div>
          </div>
        </div>

        <div className="panel">
          <h2>Машины состояний</h2>
          <div className="muted" style={{ marginBottom: 8, fontSize: 12 }}>
            Сохранённых машин состояний: {data.states.machines}
          </div>
          <table>
            <tbody>
              {Object.entries(data.states.byState).map(([state, n]) => (
                <tr key={state}>
                  <td>{ru(SIGNAL_STATE_RU, state)}</td>
                  <td className="num mono">{n}</td>
                </tr>
              ))}
              {Object.keys(data.states.byState).length === 0 && (
                <tr>
                  <td className="muted">Машин состояний пока нет</td>
                </tr>
              )}
            </tbody>
          </table>
          <h3 style={{ marginTop: 14 }}>Сигналы по состояниям</h3>
          <table>
            <tbody>
              {Object.entries(data.signals).map(([state, n]) => (
                <tr key={state}>
                  <td>{ru(SIGNAL_STATE_RU, state)}</td>
                  <td className="num mono">{n}</td>
                </tr>
              ))}
              {Object.keys(data.signals).length === 0 && (
                <tr>
                  <td className="muted">Сигналов пока нет</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>Журнал движка (последние 50 записей)</h2>
        {data.logs.length === 0 ? (
          <div className="muted">Записей в журнале нет.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Время</th>
                <th>Уровень</th>
                <th>Воркер</th>
                <th>Сообщение</th>
              </tr>
            </thead>
            <tbody>
              {data.logs.map((l) => (
                <tr key={l.id}>
                  <td className="mono muted" style={{ whiteSpace: 'nowrap' }}>
                    {fmtIsoDateTime(l.createdAt)}
                  </td>
                  <td>
                    <span
                      className={`pill ${
                        l.level === 'error' ? 'pill-err' : l.level === 'warn' ? 'pill-warn' : 'pill-idle'
                      }`}
                    >
                      {l.level}
                    </span>
                  </td>
                  <td className="muted">{ru(WORKER_RU, l.worker)}</td>
                  <td style={{ fontSize: 12 }}>{l.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';

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
      setError(e instanceof Error ? e.message : 'Failed to load monitoring');
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <div className="alert alert-error">{error}</div>;
  if (!data) return <div className="loading">Loading monitoring…</div>;

  const p = data.performance;

  return (
    <div>
      <h1>Monitoring</h1>
      <p className="subtitle">
        Updated {new Date(data.timestamp).toISOString().replace('T', ' ').slice(0, 19)} UTC ·
        auto-refresh 10s
      </p>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="label">Overall</div>
          <div className="value">
            <span className={`pill ${healthPill(data.health.overall)}`}>{data.health.overall}</span>
          </div>
        </div>
        <div className="stat">
          <div className="label">Database</div>
          <div className="value">
            <span className={`pill ${healthPill(data.health.database)}`}>{data.health.database}</span>
          </div>
        </div>
        <div className="stat">
          <div className="label">Trading mode</div>
          <div className="value">
            <span className="pill pill-warn">{data.engine.tradingMode}</span>
          </div>
          <div className="sub">LIVE is locked</div>
        </div>
        <div className="stat">
          <div className="label">Engine</div>
          <div className="value">
            <span className={`pill ${data.engine.enabled ? 'pill-ok' : 'pill-idle'}`}>
              {data.engine.enabled ? 'ENABLED' : 'DISABLED'}
            </span>
          </div>
        </div>
      </div>

      {data.engine.liveTradingEnabled ? (
        <div className="alert alert-error">
          CRITICAL: live trading flag is enabled — this build must never allow it.
        </div>
      ) : (
        <div className="alert alert-ok">
          LIVE trading is locked. Only DRY_RUN and FORWARD_TEST are possible; no order-placement
          code path exists.
        </div>
      )}

      <div className="grid grid-2">
        <div className="panel">
          <h2>Workers</h2>
          <table>
            <thead>
              <tr>
                <th>Worker</th>
                <th>Status</th>
                <th className="num">Last beat</th>
                <th className="num">Loops</th>
                <th className="num">Errors</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.health.workers.map((w) => (
                <tr key={w.worker}>
                  <td>
                    <b>{w.worker}</b>
                  </td>
                  <td>
                    <span className={`pill ${healthPill(w.status)}`}>{w.status}</span>
                  </td>
                  <td className="num mono">{w.ageSec === null ? '—' : `${w.ageSec}s ago`}</td>
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
            Expected PM2 processes: svechnoy-suslik-v2-web / -market / -strategy / -outcome
          </p>
        </div>

        <div className="panel">
          <h2>Engine configuration (from DB)</h2>
          <table>
            <tbody>
              <tr>
                <td className="muted">Score threshold</td>
                <td className="num mono">{data.engine.threshold}</td>
              </tr>
              <tr>
                <td className="muted">Min confluences</td>
                <td className="num mono">{data.engine.minComponents}</td>
              </tr>
              <tr>
                <td className="muted">Active timeframes</td>
                <td className="mono">{data.engine.timeframes.join(', ')}</td>
              </tr>
              <tr>
                <td className="muted">Max concurrent</td>
                <td className="num mono">{data.engine.maxConcurrent}</td>
              </tr>
              <tr>
                <td className="muted">Exchange</td>
                <td className="mono">
                  {data.market.exchange} · {data.market.quoteAsset}
                </td>
              </tr>
              <tr>
                <td className="muted">Active symbols</td>
                <td className="num mono">
                  {data.market.activeSymbols} / TOP-{data.market.topN}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>Candle coverage by timeframe</h2>
        {data.market.candlesByTimeframe.length === 0 ? (
          <div className="muted">No candles stored yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Timeframe</th>
                <th className="num">Symbols</th>
                <th className="num">Candles</th>
                <th className="num">Closed</th>
                <th>Latest candle</th>
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
                    {c.latest > 0
                      ? new Date(c.latest).toISOString().replace('T', ' ').slice(0, 16)
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid grid-2">
        <div className="panel">
          <h2>Forward-test performance</h2>
          <div className="grid grid-3">
            <div className="stat">
              <div className="label">Closed trades</div>
              <div className="value">{p.total}</div>
              <div className="sub">
                {p.wins}W / {p.losses}L / {p.timeouts}T
              </div>
            </div>
            <div className="stat">
              <div className="label">Win rate</div>
              <div className="value">{p.winRate.toFixed(1)}%</div>
            </div>
            <div className="stat">
              <div className="label">Total R</div>
              <div className={`value ${p.totalR >= 0 ? 'up' : 'down'}`}>{p.totalR.toFixed(2)}</div>
            </div>
            <div className="stat">
              <div className="label">Avg R</div>
              <div className={`value ${p.avgR >= 0 ? 'up' : 'down'}`}>{p.avgR.toFixed(3)}</div>
            </div>
            <div className="stat">
              <div className="label">Profit factor</div>
              <div className="value">{Number.isFinite(p.profitFactor) ? p.profitFactor.toFixed(2) : '∞'}</div>
            </div>
            <div className="stat">
              <div className="label">Max DD (R)</div>
              <div className="value down">{p.maxDrawdownR.toFixed(2)}</div>
            </div>
          </div>
        </div>

        <div className="panel">
          <h2>State machines</h2>
          <div className="muted" style={{ marginBottom: 8, fontSize: 12 }}>
            {data.states.machines} persistent machine(s)
          </div>
          <table>
            <tbody>
              {Object.entries(data.states.byState).map(([state, n]) => (
                <tr key={state}>
                  <td>{state}</td>
                  <td className="num mono">{n}</td>
                </tr>
              ))}
              {Object.keys(data.states.byState).length === 0 && (
                <tr>
                  <td className="muted">No state machines yet</td>
                </tr>
              )}
            </tbody>
          </table>
          <h3 style={{ marginTop: 14 }}>Signals by state</h3>
          <table>
            <tbody>
              {Object.entries(data.signals).map(([state, n]) => (
                <tr key={state}>
                  <td>{state}</td>
                  <td className="num mono">{n}</td>
                </tr>
              ))}
              {Object.keys(data.signals).length === 0 && (
                <tr>
                  <td className="muted">No signals yet</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>Engine log (latest 50)</h2>
        {data.logs.length === 0 ? (
          <div className="muted">No log entries.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Level</th>
                <th>Worker</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {data.logs.map((l) => (
                <tr key={l.id}>
                  <td className="mono muted" style={{ whiteSpace: 'nowrap' }}>
                    {new Date(l.createdAt).toISOString().replace('T', ' ').slice(5, 19)}
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
                  <td className="muted">{l.worker}</td>
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

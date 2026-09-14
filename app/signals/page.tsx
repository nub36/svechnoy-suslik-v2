'use client';

import { useCallback, useEffect, useState } from 'react';

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

const STATES = ['', 'WAITING_ENTRY', 'ACTIVE', 'CLOSED_TP', 'CLOSED_SL', 'CLOSED_TIMEOUT'];

function statePill(s: string): string {
  if (s === 'CLOSED_TP') return 'pill-ok';
  if (s === 'CLOSED_SL') return 'pill-err';
  if (s === 'ACTIVE') return 'pill-warn';
  return 'pill-idle';
}

function ts(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

function fmt(v: number | null, dp = 6): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return v.toFixed(dp).replace(/\.?0+$/, '');
}

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
      setError(e instanceof Error ? e.message : 'Failed to load signals');
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
      <h1>Signals</h1>
      <p className="subtitle">
        Every signal is produced from a CLOSED candle (N) and entered at the OPEN of N+1. Entry
        fields stay empty while a signal is in WAITING_ENTRY.
      </p>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        {[
          ['Total', summary['total'] ?? 0],
          ['Waiting entry', summary['waiting'] ?? 0],
          ['Active', summary['active'] ?? 0],
          ['TP', summary['tp'] ?? 0],
          ['SL', summary['sl'] ?? 0],
          ['Timeout', summary['timeout'] ?? 0],
        ].map(([label, value]) => (
          <div className="stat" key={String(label)}>
            <div className="label">{label}</div>
            <div className="value">{value}</div>
          </div>
        ))}
      </div>

      <div className="toolbar">
        <span className="muted">State:</span>
        {STATES.map((s) => (
          <button key={s || 'ALL'} className={filter === s ? 'active' : ''} onClick={() => setFilter(s)}>
            {s || 'ALL'}
          </button>
        ))}
        <button onClick={() => void load()}>Refresh</button>
      </div>

      <div className="panel">
        {loading ? (
          <div className="loading">Loading…</div>
        ) : signals.length === 0 ? (
          <div className="muted" style={{ padding: 20, textAlign: 'center' }}>
            No signals yet. The strategy worker emits one only on a rising edge
            (IDLE → WAITING_ENTRY) when the score clears the threshold.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Symbol</th>
                <th>TF</th>
                <th>Dir</th>
                <th>State</th>
                <th>Mode</th>
                <th className="num">Score</th>
                <th>Setup candle (N)</th>
                <th>Entry candle (N+1)</th>
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
                      <b>{s.symbol}</b>
                    </td>
                    <td>{s.timeframe}</td>
                    <td>
                      <span className={`pill ${s.direction === 'LONG' ? 'pill-long' : 'pill-short'}`}>
                        {s.direction}
                      </span>
                    </td>
                    <td>
                      <span className={`pill ${statePill(s.state)}`}>{s.state}</span>
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
                        <span className="muted">pending N+1</span>
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
                            <h3>Score breakdown (transparent)</h3>
                            <table>
                              <thead>
                                <tr>
                                  <th>Detector</th>
                                  <th className="num">Strength</th>
                                  <th className="num">Weight</th>
                                  <th className="num">Contribution</th>
                                  <th>Counted</th>
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
                                        <span className="pill pill-ok">YES</span>
                                      ) : (
                                        <span className="pill pill-idle" title={c.skippedReason}>
                                          SKIPPED
                                        </span>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                              raw {s.breakdown?.rawScore?.toFixed(3) ?? '—'} / weight{' '}
                              {s.breakdown?.totalWeight?.toFixed(1) ?? '—'} × 100 ={' '}
                              <b>{s.breakdown?.score?.toFixed(2) ?? '—'}</b>
                              {(s.breakdown?.duplicatesRemoved ?? 0) > 0 &&
                                ` · ${s.breakdown?.duplicatesRemoved} duplicate(s) removed (anti-double-counting)`}
                            </div>
                          </div>
                          <div>
                            <h3>Execution & outcome</h3>
                            <table>
                              <tbody>
                                <tr>
                                  <td className="muted">Setup close (N)</td>
                                  <td className="mono num">{fmt(s.setupClose)}</td>
                                </tr>
                                <tr>
                                  <td className="muted">Entry (OPEN of N+1)</td>
                                  <td className="mono num">{fmt(s.entryPrice)}</td>
                                </tr>
                                <tr>
                                  <td className="muted">Stop loss</td>
                                  <td className="mono num">{fmt(s.stopLoss)}</td>
                                </tr>
                                <tr>
                                  <td className="muted">Take profits</td>
                                  <td className="mono num">
                                    {(s.takeProfits ?? []).map((t) => fmt(t)).join(' · ') || '—'}
                                  </td>
                                </tr>
                                <tr>
                                  <td className="muted">ATR (risk only)</td>
                                  <td className="mono num">{fmt(s.atr)}</td>
                                </tr>
                                <tr>
                                  <td className="muted">R:R to TP1</td>
                                  <td className="mono num">{fmt(s.rrTp1, 2)}</td>
                                </tr>
                                {s.outcome && (
                                  <>
                                    <tr>
                                      <td className="muted">Result</td>
                                      <td>
                                        <span
                                          className={`pill ${
                                            s.outcome.result === 'TP' ? 'pill-ok' : s.outcome.result === 'SL' ? 'pill-err' : 'pill-idle'
                                          }`}
                                        >
                                          {s.outcome.result}
                                        </span>
                                      </td>
                                    </tr>
                                    <tr>
                                      <td className="muted">Exit price</td>
                                      <td className="mono num">{fmt(s.outcome.exitPrice)}</td>
                                    </tr>
                                    <tr>
                                      <td className="muted">Bars held</td>
                                      <td className="mono num">{s.outcome.barsHeld}</td>
                                    </tr>
                                    <tr>
                                      <td className="muted">PnL %</td>
                                      <td className={`mono num ${s.outcome.pnlPct >= 0 ? 'up' : 'down'}`}>
                                        {s.outcome.pnlPct.toFixed(3)}%
                                      </td>
                                    </tr>
                                    <tr>
                                      <td className="muted">R multiple</td>
                                      <td className={`mono num ${s.outcome.rMultiple >= 0 ? 'up' : 'down'}`}>
                                        {s.outcome.rMultiple.toFixed(3)}
                                      </td>
                                    </tr>
                                    <tr>
                                      <td className="muted">MFE / MAE</td>
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

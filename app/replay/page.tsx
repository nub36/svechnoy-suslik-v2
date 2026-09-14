'use client';

import { useCallback, useEffect, useState } from 'react';

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
        throw new Error('Replay requires admin sign-in (see the Admin page).');
      }
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      setResults(json.data.results);
      await loadRuns();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Replay failed');
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
      <h1>Historical replay</h1>
      <p className="subtitle">
        Walk-forward replay using <b>the same Smart Money engine</b> as the live path — same
        detectors, same scoring, same state machine, same N+1 entry rule, same outcome tracker.
      </p>

      {error && <div className="alert alert-error">{error}</div>}
      {!authed && (
        <div className="alert alert-info">
          Sign in on the Admin page first — running a replay is a protected operation.
        </div>
      )}

      <div className="panel">
        <h3>Symbols</h3>
        <div className="row" style={{ marginBottom: 12 }}>
          {symbols.length === 0 && <span className="muted">No symbols available.</span>}
          {symbols.map((s) => (
            <button
              key={s}
              className={picked.includes(s) ? 'active' : ''}
              onClick={() => toggle(picked, s, setPicked)}
            >
              {s}
            </button>
          ))}
        </div>
        <h3>Timeframes</h3>
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
          {running ? 'Replaying…' : `Run replay (${picked.length} × ${tfs.length})`}
        </button>
      </div>

      {results.length > 0 && (
        <>
          <div className="grid grid-4" style={{ marginBottom: 16 }}>
            <div className="stat">
              <div className="label">Candles replayed</div>
              <div className="value">{agg.candles.toLocaleString()}</div>
            </div>
            <div className="stat">
              <div className="label">Evaluations</div>
              <div className="value">{agg.evaluations.toLocaleString()}</div>
            </div>
            <div className="stat">
              <div className="label">Closed trades</div>
              <div className="value">{agg.total}</div>
              <div className="sub">
                {agg.wins}W / {agg.losses}L / {agg.timeouts}T
              </div>
            </div>
            <div className="stat">
              <div className="label">Win rate</div>
              <div className="value">
                {agg.total > 0 ? ((agg.wins / agg.total) * 100).toFixed(1) : '0.0'}%
              </div>
            </div>
            <div className="stat">
              <div className="label">Total R</div>
              <div className={`value ${agg.totalR >= 0 ? 'up' : 'down'}`}>{agg.totalR.toFixed(2)}</div>
            </div>
            <div className="stat">
              <div className="label">Avg R</div>
              <div className={`value ${agg.totalR >= 0 ? 'up' : 'down'}`}>
                {agg.total > 0 ? (agg.totalR / agg.total).toFixed(3) : '0'}
              </div>
            </div>
          </div>

          <div className="panel">
            <h2>Per series</h2>
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>TF</th>
                  <th className="num">Candles</th>
                  <th className="num">Evals</th>
                  <th className="num">Trades</th>
                  <th className="num">W/L/T</th>
                  <th className="num">Win %</th>
                  <th className="num">Total R</th>
                  <th className="num">Avg R</th>
                  <th className="num">PF</th>
                  <th className="num">Max DD</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={`${r.symbol}-${r.timeframe}`}>
                    <td>
                      <b>{r.symbol}</b>
                    </td>
                    <td>{r.timeframe}</td>
                    <td className="num mono">{r.candlesSeen}</td>
                    <td className="num mono">{r.evaluations}</td>
                    <td className="num mono">{r.tradeCount}</td>
                    <td className="num mono">
                      {r.stats.wins}/{r.stats.losses}/{r.stats.timeouts}
                    </td>
                    <td className="num mono">{r.stats.winRate.toFixed(1)}%</td>
                    <td className={`num mono ${r.stats.totalR >= 0 ? 'up' : 'down'}`}>
                      {r.stats.totalR.toFixed(2)}
                    </td>
                    <td className={`num mono ${r.stats.avgR >= 0 ? 'up' : 'down'}`}>
                      {r.stats.avgR.toFixed(3)}
                    </td>
                    <td className="num mono">
                      {Number.isFinite(r.stats.profitFactor) ? r.stats.profitFactor.toFixed(2) : '∞'}
                    </td>
                    <td className="num mono down">{r.stats.maxDrawdownR.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h2>Sample trades (N+1 entries)</h2>
            <p className="muted small">
              Preview only — the statistics above are computed over all{' '}
              {results.reduce((a, r) => a + r.tradeCount, 0)} trade(s) of the run.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>TF</th>
                  <th>Dir</th>
                  <th className="num">Score</th>
                  <th>Setup candle (N)</th>
                  <th>Entry candle (N+1)</th>
                  <th className="num">Entry</th>
                  <th className="num">SL</th>
                  <th>Result</th>
                  <th className="num">Bars</th>
                  <th className="num">R</th>
                </tr>
              </thead>
              <tbody>
                {results.flatMap((r) => r.trades.slice(0, 12)).slice(0, 60).map((t, i) => (
                  <tr key={i}>
                    <td>{t.symbol}</td>
                    <td>{t.timeframe}</td>
                    <td>
                      <span className={`pill ${t.direction === 'LONG' ? 'pill-long' : 'pill-short'}`}>
                        {t.direction}
                      </span>
                    </td>
                    <td className="num mono">{t.score.toFixed(1)}</td>
                    <td className="mono">
                      {new Date(t.setupCandleTime).toISOString().replace('T', ' ').slice(0, 16)}
                    </td>
                    <td className="mono">
                      {new Date(t.entryCandleTime).toISOString().replace('T', ' ').slice(0, 16)}
                    </td>
                    <td className="num mono">{t.entryPrice}</td>
                    <td className="num mono">{t.stopLoss.toFixed(6).replace(/\.?0+$/, '')}</td>
                    <td>
                      <span
                        className={`pill ${
                          t.result === 'TP' ? 'pill-ok' : t.result === 'SL' ? 'pill-err' : 'pill-idle'
                        }`}
                      >
                        {t.result}
                      </span>
                    </td>
                    <td className="num mono">{t.barsHeld}</td>
                    <td className={`num mono ${t.rMultiple >= 0 ? 'up' : 'down'}`}>
                      {t.rMultiple.toFixed(3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="panel">
        <h2>Saved runs</h2>
        {runs.length === 0 ? (
          <div className="muted">No saved replay runs yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Label</th>
                <th>Symbols</th>
                <th>TFs</th>
                <th className="num">Trades</th>
                <th className="num">Win %</th>
                <th className="num">Total R</th>
                <th className="num">PF</th>
                <th>Created</th>
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
                  <td className="num mono">{r.winRate.toFixed(1)}%</td>
                  <td className={`num mono ${r.totalR >= 0 ? 'up' : 'down'}`}>{r.totalR.toFixed(2)}</td>
                  <td className="num mono">{r.profitFactor.toFixed(2)}</td>
                  <td className="mono muted" style={{ fontSize: 11 }}>
                    {new Date(r.createdAt).toISOString().replace('T', ' ').slice(0, 16)}
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

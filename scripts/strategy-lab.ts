/**
 * STRATEGY LAB — reproducible walk-forward measurement harness.
 *
 * Runs the PRODUCTION trading logic (`replaySeries`, which shares evaluate() /
 * step() / buildRiskPlan() / trackOutcome() with the live worker) over a
 * candle series and reports the full metric set: per symbol, per timeframe,
 * per score bucket, per confirmation count, per factor, and split LONG/SHORT.
 *
 * It also supports a chronological TRAIN / VALIDATION / TEST split so that
 * parameter candidates can be chosen on TRAIN+VALIDATION and judged once on
 * unseen TEST.
 *
 * IMPORTANT — this harness does not define any trading rules of its own. It
 * only calls the engine and aggregates what comes back. A second, simplified
 * backtest implementation would make the numbers meaningless.
 *
 * Usage:
 *   npx tsx scripts/strategy-lab.ts --source=fixtures
 *   npx tsx scripts/strategy-lab.ts --source=db --json=out.json
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Settings } from '../src/core/settings';
import { replaySeries, type ReplayTrade } from '../src/replay/runner';
import type { Candle, Timeframe } from '../src/core/types';

export const LAB_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT',
] as const;

/* ------------------------------------------------------------------ */
/* Candle loading                                                      */
/* ------------------------------------------------------------------ */

/** Binance REST kline tuple -> internal Candle. */
function fromKline(row: unknown[]): Candle {
  return {
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: Number(row[7]),
    trades: Number(row[8]),
    isClosed: true,
  };
}

export function loadFixtureCandles(
  dir: string,
  symbol: string,
  timeframe: Timeframe,
): Candle[] {
  const f = join(dir, `klines_${symbol}_${timeframe}.json`);
  if (!existsSync(f)) return [];
  const raw = JSON.parse(readFileSync(f, 'utf8')) as unknown[][];
  return raw
    .map(fromKline)
    .sort((a, b) => a.openTime - b.openTime);
}

/* ------------------------------------------------------------------ */
/* Metrics                                                             */
/* ------------------------------------------------------------------ */

export interface Metrics {
  /** Number of CLOSED trades. OPEN trades are excluded from every metric here. */
  n: number;
  long: number;
  short: number;
  wins: number;
  losses: number;
  timeouts: number;
  open: number;
  /**
   * DEPRECATED NAME — kept so existing callers keep compiling.
   * Equals `tpExitRate`: the share of closed trades whose exit reason was TP.
   * Do NOT present this as "win rate" next to `positiveRRate`; they measure
   * different things and differed by 4x in the b8825d1 audit.
   */
  winRatePct: number;
  /** TP exits / closed trades, in %. */
  tpExitRate: number;
  /** Trades with R > 0 / closed trades, in %. Includes profitable TIMEOUTs. */
  positiveRRate: number;
  /** SL exits / closed trades, in %. */
  slRate: number;
  /** TIMEOUT exits / closed trades, in %. */
  timeoutRate: number;
  /** Count of trades still OPEN at the end of the window (not in `n`). */
  openCount: number;
  /**
   * Expectancy over closed trades EXCLUDING time exits. Diagnostic only: it
   * answers "does the edge survive without mark-to-market at the bar limit?".
   */
  expectancyExTimeout: number;
  /** Sample size behind `expectancyExTimeout`. */
  nExTimeout: number;
  stopRatePct: number;
  expiredRatePct: number;
  avgR: number;
  medianR: number;
  totalR: number;
  profitFactor: number;
  maxDrawdownR: number;
  expectancy: number;
  avgBarsHeld: number;
  tp1Rate: number;
  tp2Rate: number;
  tp3Rate: number;
}

const EMPTY: Metrics = {
  n: 0, long: 0, short: 0, wins: 0, losses: 0, timeouts: 0, open: 0,
  winRatePct: 0, tpExitRate: 0, positiveRRate: 0, slRate: 0, timeoutRate: 0,
  openCount: 0, expectancyExTimeout: 0, nExTimeout: 0,
  stopRatePct: 0, expiredRatePct: 0, avgR: 0, medianR: 0,
  totalR: 0, profitFactor: 0, maxDrawdownR: 0, expectancy: 0, avgBarsHeld: 0,
  tp1Rate: 0, tp2Rate: 0, tp3Rate: 0,
};

const r2 = (x: number): number => Math.round(x * 10000) / 10000;

/**
 * Did this trade ever reach TP level k? Derived from the recorded excursion
 * against the planned ladder, so it counts milestones that were later given
 * back — the same "historical fact" semantics the UI uses.
 */
function reachedTp(t: ReplayTrade, k: number): boolean {
  const tp = t.takeProfits[k];
  if (tp === undefined) return false;
  if (t.exitPrice === null) return false;
  // A finished trade reached rung k if its best excursion got there.
  const best = t.direction === 'LONG'
    ? t.entryPrice * (1 + Math.max(t.pnlPct, 0) / 100)
    : t.entryPrice * (1 - Math.max(t.pnlPct, 0) / 100);
  return t.direction === 'LONG' ? best >= tp : best <= tp;
}

export function computeMetrics(trades: readonly ReplayTrade[]): Metrics {
  const finished = trades.filter((t) => t.result !== 'OPEN');
  const openCount = trades.length - finished.length;
  const n = finished.length;
  if (n === 0) return { ...EMPTY, open: openCount, openCount };

  const rs = finished.map((t) => t.rMultiple).sort((a, b) => a - b);
  const wins = finished.filter((t) => t.result === 'TP').length;
  const losses = finished.filter((t) => t.result === 'SL').length;
  const timeouts = finished.filter((t) => t.result === 'TIMEOUT').length;
  const totalR = rs.reduce((s, x) => s + x, 0);
  const gross = rs.filter((x) => x > 0).reduce((s, x) => s + x, 0);
  const grossLoss = Math.abs(rs.filter((x) => x < 0).reduce((s, x) => s + x, 0));

  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of finished) {
    equity += t.rMultiple;
    if (equity > peak) peak = equity;
    if (equity - peak < maxDd) maxDd = equity - peak;
  }

  const mid = Math.floor(n / 2);
  const medianR = n % 2 === 0 ? ((rs[mid - 1] ?? 0) + (rs[mid] ?? 0)) / 2 : (rs[mid] ?? 0);
  const exTimeout = finished.filter((t) => t.result !== 'TIMEOUT');

  return {
    n,
    long: finished.filter((t) => t.direction === 'LONG').length,
    short: finished.filter((t) => t.direction === 'SHORT').length,
    wins,
    losses,
    timeouts,
    open: openCount,
    openCount,
    winRatePct: r2((wins / n) * 100),
    tpExitRate: r2((wins / n) * 100),
    positiveRRate: r2((finished.filter((t) => t.rMultiple > 0).length / n) * 100),
    slRate: r2((losses / n) * 100),
    timeoutRate: r2((timeouts / n) * 100),
    expectancyExTimeout: exTimeout.length > 0
      ? r2(exTimeout.reduce((s2, t) => s2 + t.rMultiple, 0) / exTimeout.length)
      : 0,
    nExTimeout: exTimeout.length,
    stopRatePct: r2((losses / n) * 100),
    expiredRatePct: r2((timeouts / n) * 100),
    avgR: r2(totalR / n),
    medianR: r2(medianR),
    totalR: r2(totalR),
    profitFactor: grossLoss > 0 ? r2(gross / grossLoss) : gross > 0 ? Infinity : 0,
    maxDrawdownR: r2(maxDd),
    // Expectancy per trade in R (same as avgR, stated explicitly).
    expectancy: r2(totalR / n),
    avgBarsHeld: r2(finished.reduce((s, t) => s + t.barsHeld, 0) / n),
    tp1Rate: r2((finished.filter((t) => reachedTp(t, 0)).length / n) * 100),
    tp2Rate: r2((finished.filter((t) => reachedTp(t, 1)).length / n) * 100),
    tp3Rate: r2((finished.filter((t) => reachedTp(t, 2)).length / n) * 100),
  };
}

export function groupBy<K extends string | number>(
  trades: readonly ReplayTrade[],
  key: (t: ReplayTrade) => K,
): Map<K, ReplayTrade[]> {
  const m = new Map<K, ReplayTrade[]>();
  for (const t of trades) {
    const k = key(t);
    const arr = m.get(k);
    if (arr) arr.push(t);
    else m.set(k, [t]);
  }
  return m;
}

/** Score buckets for monotonicity analysis. */
export function scoreBucket(score: number): string {
  if (score < 60) return '55-60';
  if (score < 70) return '60-70';
  if (score < 80) return '70-80';
  if (score < 90) return '80-90';
  if (score < 100) return '90-100';
  return '100';
}

interface Breakdown {
  confirmations?: number;
  components?: Array<{ detector: string; counted: boolean }>;
}

export function confirmationsOf(t: ReplayTrade): number {
  const b = t.breakdown as Breakdown | null;
  if (b && typeof b.confirmations === 'number') return b.confirmations;
  const c = b?.components?.filter((x) => x.counted).length;
  return c ?? 0;
}

export function factorsOf(t: ReplayTrade): string[] {
  const b = t.breakdown as Breakdown | null;
  return (b?.components ?? []).filter((c) => c.counted).map((c) => c.detector);
}

/* ------------------------------------------------------------------ */
/* Walk-forward run                                                    */
/* ------------------------------------------------------------------ */

export interface RunArgs {
  settings: Settings;
  timeframes: readonly Timeframe[];
  symbols?: readonly string[];
  fixturesDir?: string;
  /** Restrict to a time window (chronological split). */
  from?: number;
  to?: number;
}

export function runLab(args: RunArgs): ReplayTrade[] {
  const dir = args.fixturesDir ?? join(process.cwd(), 'fixtures');
  const symbols = args.symbols ?? LAB_SYMBOLS;
  const out: ReplayTrade[] = [];

  for (const symbol of symbols) {
    for (const timeframe of args.timeframes) {
      const candles = loadFixtureCandles(dir, symbol, timeframe);
      if (candles.length < 60) continue;
      const res = replaySeries({
        symbol,
        timeframe,
        candles,
        settings: args.settings,
        ...(args.from === undefined ? {} : { from: args.from }),
        ...(args.to === undefined ? {} : { to: args.to }),
      });
      out.push(...res.trades);
    }
  }
  // Chronological order across the whole population, so the equity curve and
  // drawdown are computed in the order the trades actually happened.
  return out.sort((a, b) => a.entryCandleTime - b.entryCandleTime);
}

/**
 * Chronological split boundaries for a candle series.
 * TRAIN 60% / VALIDATION 20% / TEST 20% by TIME, never by shuffling.
 */
export function splitPoints(
  candles: readonly Candle[],
): { trainEnd: number; validEnd: number } {
  const first = candles[0]?.openTime ?? 0;
  const last = candles[candles.length - 1]?.openTime ?? 0;
  const span = last - first;
  return {
    trainEnd: first + Math.floor(span * 0.6),
    validEnd: first + Math.floor(span * 0.8),
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function fmt(m: Metrics): string {
  return [
    `n=${String(m.n).padStart(4)}`,
    `L/S=${String(m.long).padStart(3)}/${String(m.short).padEnd(3)}`,
    `win=${String(m.winRatePct).padStart(6)}%`,
    `avgR=${String(m.avgR).padStart(8)}`,
    `medR=${String(m.medianR).padStart(7)}`,
    `totR=${String(m.totalR).padStart(9)}`,
    `PF=${String(m.profitFactor).padStart(6)}`,
    `maxDD=${String(m.maxDrawdownR).padStart(9)}`,
  ].join('  ');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonOut = argv.find((a) => a.startsWith('--json='))?.split('=')[1];
  const tfArg = argv.find((a) => a.startsWith('--tf='))?.split('=')[1];

  const settings = Settings.fromDefaults();
  const timeframes = (tfArg ? tfArg.split(',') : settings.timeframes()) as Timeframe[];

  console.log('STRATEGY LAB — walk-forward over the production engine');
  console.log('symbols   :', LAB_SYMBOLS.join(', '));
  console.log('timeframes:', timeframes.join(', '));
  console.log('');

  const trades = runLab({ settings, timeframes });
  const overall = computeMetrics(trades);

  console.log('=== OVERALL ===');
  console.log(fmt(overall));
  console.log(
    `stopRate=${overall.stopRatePct}%  expiredRate=${overall.expiredRatePct}%  ` +
      `expectancy=${overall.expectancy}R  avgBars=${overall.avgBarsHeld}`,
  );
  console.log(
    `TP1=${overall.tp1Rate}%  TP2=${overall.tp2Rate}%  TP3=${overall.tp3Rate}%`,
  );
  console.log('');

  console.log('=== LONG vs SHORT ===');
  for (const d of ['LONG', 'SHORT'] as const) {
    console.log(d.padEnd(6), fmt(computeMetrics(trades.filter((t) => t.direction === d))));
  }
  console.log('');

  console.log('=== BY SYMBOL ===');
  for (const [k, v] of [...groupBy(trades, (t) => t.symbol)].sort()) {
    console.log(k.padEnd(10), fmt(computeMetrics(v)));
  }
  console.log('');

  console.log('=== BY TIMEFRAME ===');
  for (const [k, v] of [...groupBy(trades, (t) => t.timeframe)].sort()) {
    console.log(k.padEnd(10), fmt(computeMetrics(v)));
  }
  console.log('');

  console.log('=== BY SCORE BUCKET (monotonicity check) ===');
  for (const [k, v] of [...groupBy(trades, (t) => scoreBucket(t.score))].sort()) {
    console.log(k.padEnd(10), fmt(computeMetrics(v)));
  }
  console.log('');

  console.log('=== BY CONFIRMATIONS ===');
  for (const [k, v] of [...groupBy(trades, (t) => confirmationsOf(t))].sort(
    (a, b) => a[0] - b[0],
  )) {
    console.log(String(k).padEnd(10), fmt(computeMetrics(v)));
  }
  console.log('');

  console.log('=== FACTOR MARGINAL CONTRIBUTION ===');
  const allFactors = new Set<string>();
  for (const t of trades) for (const f of factorsOf(t)) allFactors.add(f);
  for (const f of [...allFactors].sort()) {
    const withF = trades.filter((t) => factorsOf(t).includes(f));
    const without = trades.filter((t) => !factorsOf(t).includes(f));
    const a = computeMetrics(withF);
    const b = computeMetrics(without);
    console.log(
      f.padEnd(20),
      `present=${String(a.n).padStart(4)}  avgR_with=${String(a.avgR).padStart(8)}`,
      ` avgR_without=${String(b.avgR).padStart(8)}`,
      ` marginal=${String(r2(a.avgR - b.avgR)).padStart(8)}`,
    );
  }

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ overall, trades }, null, 2));
    console.log('\nwrote', jsonOut);
  }
}

if (process.argv[1] && process.argv[1].endsWith('strategy-lab.ts')) {
  void main();
}

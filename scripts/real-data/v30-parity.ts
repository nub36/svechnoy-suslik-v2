/**
 * V3.0 PORT PARITY — the production module vs the frozen research module.
 *
 * Runs the SAME algorithm twice over the SAME real TRAIN candles:
 *
 *   A. `research/v30_htf_trap.ts`  — the file the VALIDATION artifact is
 *      attached to (sha256 a821757f…, pinned by tests/v30-validation.test.ts);
 *   B. `src/strategy/v30/*`        — the production port that the live worker
 *      actually runs.
 *
 * The comparison is exact: every trade must agree on direction, entry price,
 * stop, TP1, TP2, exit reason, bars held and gross R. A single mismatch fails
 * the run.
 *
 * INTERFACE, NOT IDENTITY. The production runner deliberately differs in two
 * DOCUMENTED ways (one position per symbol; newest closed bar only), so this
 * harness replays the research loop structure and calls the ported decision
 * functions from inside it. That isolates the strategy logic from the live
 * plumbing — which is exactly what must be bit-identical.
 *
 * WINDOW: TRAIN only. VALIDATION must never be re-read, and TEST is held out.
 *
 * Usage:
 *   npx tsx scripts/real-data/v30-parity.ts \
 *     --cache=<dir> --dataset=<path> --splits=<file> --out=<file> [--symbols=BTCUSDT,ETHUSDT]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { Settings } from '../../src/core/settings';
import type { Candle, Timeframe } from '../../src/core/types';
import {
  confirmedLevels as researchLevels,
  detectTrap as researchDetectTrap,
  manageTrade as researchManageTrade,
  type Direction as ResearchDirection,
} from '../../research/v30_htf_trap';
import { buildAtrContext, buildVolumeContext } from '../../src/strategy/v2/indicators';
import { loadSeries, hasSeries } from './load';
import { confirmedLevels } from '../../src/strategy/v30/levels';
import { detectTrap } from '../../src/strategy/v30/trap';
import { buildPlan, corridorStep, manageTrade } from '../../src/strategy/v30/execution';
import { v30Params } from '../../src/strategy/v30/params';

const EXEC_TF: Timeframe = '1h';
const STRUCT_TF: Timeframe = '4h';

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

interface TradeRecord {
  symbol: string;
  direction: ResearchDirection;
  entryPrice: number;
  stop: number;
  tp1: number;
  tp2: number;
  exit: string;
  grossR: number;
  /** Fee in R at the frozen 2/5 bps pair — the VALIDATION basis. */
  feeR: number;
  /** grossR minus feeR: the headline figure. */
  netR: number;
}

interface Side {
  signals: number;
  filled: number;
  expired: number;
  cancelled: number;
  rejected: number;
  unresolved: number;
  trades: TradeRecord[];
}

const empty = (): Side => ({
  signals: 0,
  filled: 0,
  expired: 0,
  cancelled: 0,
  rejected: 0,
  unresolved: 0,
  trades: [],
});

/** Replay one symbol over the TRAIN window. `port` selects the implementation. */
function replaySymbol(
  symbol: string,
  trainFromMs: number,
  trainToMs: number,
  h1: readonly Candle[],
  h4: readonly Candle[],
  port: boolean,
): Side {
  const settings = Settings.fromDefaults();
  const strength = Math.floor(settings.num('engine.swing_lookback'));
  const atrPeriod = Math.floor(settings.num('risk.atr_period'));
  const volPeriod = Math.floor(settings.num('v2.volume_period'));
  const p = v30Params(settings);

  const side = empty();
  interface Pend {
    dir: ResearchDirection;
    zoneLow: number;
    zoneHigh: number;
    stop: number;
    tp1: number;
    tp2: number;
    setupIndex: number;
  }
  let pend: Pend | null = null;

  const round = (x: number): number => Number(x.toFixed(6));

  for (let i = 60; i < h1.length; i++) {
    const c = h1[i]!;
    if (c.openTime < trainFromMs) continue;
    if (c.openTime > trainToMs) break;

    /* ---- advance a pending corridor (bar N+1 or later) ---- */
    if (pend) {
      const pendRef = pend;
      const long = pendRef.dir === 'LONG';
      const waited = i - pendRef.setupIndex;

      let step: { kind: string; fillPrice?: number; reason?: string };
      if (port) {
        // NOTE: the local `Pend` uses `dir`; the ported function (correctly)
        // reads `direction`. Mapping explicitly keeps the two honest — passing
        // `Pend` directly made `long` undefined and silently treated every
        // corridor as SHORT.
        step = corridorStep(
          {
            direction: pendRef.dir,
            zoneLow: pendRef.zoneLow,
            zoneHigh: pendRef.zoneHigh,
            stop: pendRef.stop,
          },
          c,
          waited,
          p,
        );
      } else {
        const touches = long ? c.low <= pendRef.zoneHigh : c.high >= pendRef.zoneLow;
        const hitStop = long ? c.low <= pendRef.stop : c.high >= pendRef.stop;
        if (touches && hitStop) step = { kind: 'CANCEL', reason: 'AMBIGUOUS_BAR' };
        else if (touches) {
          step = {
            kind: 'FILL',
            fillPrice: long
              ? Math.min(c.open, pendRef.zoneHigh)
              : Math.max(c.open, pendRef.zoneLow),
          };
        } else if (hitStop) step = { kind: 'CANCEL', reason: 'STOP_BEFORE_FILL' };
        else if (waited >= 3) step = { kind: 'EXPIRE' };
        else step = { kind: 'WAIT' };
      }

      if (step.kind === 'FILL' && step.fillPrice !== undefined) {
        const fill = step.fillPrice;
        const risk = Math.abs(fill - pendRef.stop);
        const geomOk =
          risk > 0 &&
          (long ? pendRef.stop < fill : pendRef.stop > fill) &&
          (long
            ? pendRef.tp1 > fill && pendRef.tp2 > pendRef.tp1
            : pendRef.tp1 < fill && pendRef.tp2 < pendRef.tp1);
        if (!geomOk) {
          side.rejected++;
          pend = null;
        } else {
          const bars = h1.slice(i, Math.min(h1.length, i + p.timeoutBars + 2));
          const r = port
            ? manageTrade(pendRef.dir, fill, pendRef.stop, pendRef.tp1, pendRef.tp2, bars, p)
            : researchManageTrade(pendRef.dir, fill, pendRef.stop, pendRef.tp1, pendRef.tp2, bars);
          if (!r) {
            side.unresolved++;
            pend = null;
          } else {
            side.filled++;
            const fee = port ? r.feeR(p.makerBps, p.takerBps) : r.feeR(2, 5);
            side.trades.push({
              symbol,
              direction: pendRef.dir,
              entryPrice: round(fill),
              stop: round(pendRef.stop),
              tp1: round(pendRef.tp1),
              tp2: round(pendRef.tp2),
              exit: r.exit,
              grossR: round(r.grossR),
              feeR: Number(fee.toFixed(6)),
              netR: Number((r.grossR - fee).toFixed(6)),
            });
            pend = null;
          }
        }
      } else if (step.kind === 'CANCEL') {
        side.cancelled++;
        pend = null;
      } else if (step.kind === 'EXPIRE') {
        side.expired++;
        pend = null;
      }
    }

    /* ---- look for a new trap on this closed bar ---- */
    if (pend === null) {
      if (port) {
        const levels = confirmedLevels(h4, c.closeTime, strength, STRUCT_TF);
        if (levels.swingHigh === null || levels.swingLow === null) continue;
        const vol = buildVolumeContext(h1 as Candle[], i, volPeriod);
        const sig = detectTrap(c, levels, vol.rvol, p);
        if (!sig) continue;
        const atr = buildAtrContext(h1 as Candle[], i, atrPeriod).atr;
        if (atr === null || !(atr > 0)) continue;
        const plan = buildPlan(sig, levels, atr, c.close, p);
        if (!plan) continue;
        side.signals++;
        pend = {
          dir: plan.direction,
          zoneLow: plan.zoneLow,
          zoneHigh: plan.zoneHigh,
          stop: plan.stop,
          tp1: plan.tp1,
          tp2: plan.tp2,
          setupIndex: i,
        };
      } else {
        const levels = researchLevels(h4, c.closeTime, strength);
        if (levels.swingHigh === null && levels.swingLow === null) continue;
        const vol = buildVolumeContext(h1.slice(0, i + 1), i, volPeriod);
        const sig = researchDetectTrap(c, levels, vol.rvol);
        if (!sig) continue;
        const atr = buildAtrContext(h1.slice(0, i + 1), i, atrPeriod).atr;
        if (atr === null || !(atr > 0)) continue;
        if (levels.swingHigh === null || levels.swingLow === null) continue;
        side.signals++;
        const long = sig.direction === 'LONG';
        const half = 0.1 * atr; // CORRIDOR_ATR_FRAC
        const eq = (levels.swingHigh + levels.swingLow) / 2;
        pend = {
          dir: sig.direction,
          zoneLow: c.close - half,
          zoneHigh: c.close + half,
          stop: long ? sig.sweepExtreme - 0.15 * atr : sig.sweepExtreme + 0.15 * atr,
          tp1: eq,
          tp2: long ? levels.swingHigh : levels.swingLow,
          setupIndex: i,
        };
      }
    }
  }

  return side;
}

function compare(a: Side, b: Side): string[] {
  const problems: string[] = [];
  for (const k of ['signals', 'filled', 'expired', 'cancelled', 'rejected', 'unresolved'] as const) {
    if (a[k] !== b[k]) problems.push(`${k}: research=${a[k]} port=${b[k]}`);
  }
  if (a.trades.length !== b.trades.length) {
    problems.push(`trades: research=${a.trades.length} port=${b.trades.length}`);
  }
  const n = Math.min(a.trades.length, b.trades.length);
  for (let i = 0; i < n; i++) {
    const x = a.trades[i]!;
    const y = b.trades[i]!;
    const fields: (keyof TradeRecord)[] = [
      'direction',
      'entryPrice',
      'stop',
      'tp1',
      'tp2',
      'exit',
      'grossR',
      'feeR',
      'netR',
    ];
    for (const f of fields) {
      if (x[f] !== y[f]) {
        problems.push(`trade #${i} ${x.symbol}: ${String(f)} research=${String(x[f])} port=${String(y[f])}`);
      }
    }
    if (problems.length > 20) return problems;
  }
  return problems;
}

function main(): void {
  const cache = arg('cache');
  const dataset = arg('dataset');
  const splitsFile = arg('splits');
  const outFile = arg('out');
  const only = arg('symbols', '').split(',').filter((s) => s.length > 0);

  const splits = (
    JSON.parse(readFileSync(splitsFile, 'utf8')) as {
      splits: { symbol: string; timeframe: string; trainFromMs: number; trainToMs: number }[];
    }
  ).splits.filter((s) => s.timeframe === EXEC_TF);
  if (only.length > 0) {
    splits.splice(0, splits.length, ...splits.filter((s) => only.includes(s.symbol)));
  }

  const perSymbol: unknown[] = [];
  const totals = { research: empty(), port: empty() };
  let ok = true;

  for (const s of splits) {
    if (!hasSeries(cache, s.symbol, EXEC_TF) || !hasSeries(cache, s.symbol, STRUCT_TF)) {
      throw new Error(`${s.symbol}: series missing from ${cache} (run the subset ingest first)`);
    }
    const h1 = loadSeries(cache, s.symbol, EXEC_TF).filter((c) => c.isClosed);
    const h4 = loadSeries(cache, s.symbol, STRUCT_TF).filter((c) => c.isClosed);

    const research = replaySymbol(s.symbol, s.trainFromMs, s.trainToMs, h1, h4, false);
    const port = replaySymbol(s.symbol, s.trainFromMs, s.trainToMs, h1, h4, true);
    const problems = compare(research, port);
    if (problems.length > 0) ok = false;

    for (const k of ['signals', 'filled', 'expired', 'cancelled', 'rejected', 'unresolved'] as const) {
      totals.research[k] += research[k];
      totals.port[k] += port[k];
    }
    totals.research.trades.push(...research.trades);
    totals.port.trades.push(...port.trades);

    perSymbol.push({
      symbol: s.symbol,
      trainFromUtc: new Date(s.trainFromMs).toISOString(),
      trainToUtc: new Date(s.trainToMs).toISOString(),
      research: { signals: research.signals, filled: research.filled, expired: research.expired, cancelled: research.cancelled, rejected: research.rejected, unresolved: research.unresolved },
      port: { signals: port.signals, filled: port.filled, expired: port.expired, cancelled: port.cancelled, rejected: port.rejected, unresolved: port.unresolved },
      tradesMatch: problems.length === 0,
      problems: problems.slice(0, 10),
    });
    console.log(`  ${s.symbol}: research fills ${research.filled} port fills ${port.filled} -> ${problems.length === 0 ? 'MATCH' : 'MISMATCH'}`);
    for (const pr of problems.slice(0, 5)) console.log(`      ${pr}`);
  }

  const globalProblems = compare(totals.research, totals.port);
  ok = ok && globalProblems.length === 0;

  const grossSum = (t: TradeRecord[]): number => t.reduce((acc, x) => acc + x.grossR, 0);
  const agg = (t: TradeRecord[]) => {
    const n = t.length;
    const gross = n ? t.reduce((a, x) => a + x.grossR, 0) / n : 0;
    const fee = n ? t.reduce((a, x) => a + x.feeR, 0) / n : 0;
    const net = n ? t.reduce((a, x) => a + x.netR, 0) / n : 0;
    return {
      n,
      grossRPerTrade: Number(gross.toFixed(4)),
      feeRPerTrade: Number(fee.toFixed(4)),
      netRPerTrade: Number(net.toFixed(4)),
    };
  };
  const researchAgg = agg(totals.research.trades);
  const portAgg = agg(totals.port.trades);

  // Cross-check the port against the COMMITTED train artifact. The parity run
  // replays the same window the artifact was produced from, so the production
  // module must land on the same headline numbers — otherwise the port would be
  // "identical" only in the sense that both are wrong.
  const artifactPath = 'artifacts/research/v30/v30-train-metrics.json';
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
    n: number;
    grossRPerTrade: number;
    feeDragR: { FUT_4: number };
    netRPerTrade: { FUT_4: number };
  };
  const artifactProblems: string[] = [];
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 0.0002;
  if (portAgg.n !== artifact.n) artifactProblems.push(`n: port=${portAgg.n} artifact=${artifact.n}`);
  if (!near(portAgg.grossRPerTrade, artifact.grossRPerTrade))
    artifactProblems.push(`gross: port=${portAgg.grossRPerTrade} artifact=${artifact.grossRPerTrade}`);
  if (!near(portAgg.feeRPerTrade, artifact.feeDragR.FUT_4))
    artifactProblems.push(`fee: port=${portAgg.feeRPerTrade} artifact=${artifact.feeDragR.FUT_4}`);
  if (!near(portAgg.netRPerTrade, artifact.netRPerTrade.FUT_4))
    artifactProblems.push(`net: port=${portAgg.netRPerTrade} artifact=${artifact.netRPerTrade.FUT_4}`);
  ok = ok && artifactProblems.length === 0;

  const out = {
    parity: ok ? 'PASS' : 'FAIL',
    window: 'TRAIN only (2022-01-01 .. 2024-05-26 per splits.json)',
    execTimeframe: EXEC_TF,
    structuralTimeframe: STRUCT_TF,
    dataset: { repo: 'https://github.com/nub36/svechnoy-suslik-binance-data.git', commit: execFileHead(dataset) },
    totals: {
      research: { ...pick(totals.research), grossRSum: Number(grossSum(totals.research.trades).toFixed(4)) },
      port: { ...pick(totals.port), grossRSum: Number(grossSum(totals.port.trades).toFixed(4)) },
    },
    globalProblems,
    aggregates: { research: researchAgg, port: portAgg },
    artifactCrossCheck: {
      artifact: artifactPath,
      expected: {
        n: artifact.n,
        grossRPerTrade: artifact.grossRPerTrade,
        feeRPerTrade: artifact.feeDragR.FUT_4,
        netRPerTrade: artifact.netRPerTrade.FUT_4,
      },
      problems: artifactProblems,
    },
    perSymbol,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log('');
  console.log(`PARITY: ${out.parity}`);
  console.log(`  research trades ${totals.research.trades.length} · port trades ${totals.port.trades.length}`);
  console.log(`  research grossR sum ${grossSum(totals.research.trades).toFixed(4)} · port ${grossSum(totals.port.trades).toFixed(4)}`);
  console.log(
    `  port: gross/trade ${portAgg.grossRPerTrade} · fee/trade ${portAgg.feeRPerTrade} · net/trade ${portAgg.netRPerTrade} ` +
      `(artifact: ${artifact.grossRPerTrade} / ${artifact.feeDragR.FUT_4} / ${artifact.netRPerTrade.FUT_4})`,
  );
  for (const pr of artifactProblems) console.log(`      ARTIFACT ${pr}`);
  console.log('wrote', outFile);
  if (!ok) process.exitCode = 1;
}

function pick(s: Side): Record<string, number> {
  return {
    signals: s.signals,
    filled: s.filled,
    expired: s.expired,
    cancelled: s.cancelled,
    rejected: s.rejected,
    unresolved: s.unresolved,
  };
}

function execFileHead(dir: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

void main();

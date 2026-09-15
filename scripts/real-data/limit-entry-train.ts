/**
 * V2.1 LIMIT ENTRY — TRAIN driver for models A/B/C/D.
 *
 * TRAIN ONLY. Per-series boundaries come from the frozen splits.json; the
 * validation and test windows are never touched.
 *
 * Streams results to disk and aggregates incrementally (no multi-million-object
 * retention), using the performance fixes established earlier: binary-search
 * HTF bounding and streaming aggregation.
 */

import { appendFileSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { Settings } from '../../src/core/settings';
import { replayLimitEntry, type ModelId, type LimitTrade }
  from './limit-entry-replay';
import { replayV2Windowed, emptyDiagnostics } from './windowed-replay';
import { loadSeries, hasSeries } from './load';
import { HTF_MAP } from '../../src/strategy/v2/htf';
import { quantileSorted } from './audit-fee-readonly';
import type { Candle, Timeframe } from '../../src/core/types';

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

const BPS = [2, 5, 10, 20];
const RES = 40000;

interface Acc {
  actionable: number; pending: number;
  terminal: Record<string, number>;
  ambiguous: number;
  cancelReason: Record<string, number>;
  closed: number; open: number;
  tp: number; sl: number; timeout: number;
  sumR: number; pos: number; neg: number; nPos: number;
  rs: number[];                       // reservoir for median / drawdown proxy
  seq: number[];                      // chronological R for drawdown
  riskPct: number[]; riskAtr: number[];
  invSum: number;                     // sum(entry/riskPerUnit) for fee sensitivity
  improvePct: number[]; improveAtr: number[];
  improvePctLong: number[]; improvePctShort: number[];
  missedTp1: number; missedBars: number[];
  byKind: Map<string, { n: number; sum: number }>;
  byDir: Map<string, { n: number; sum: number }>;
  byTf: Map<string, { n: number; sum: number; filled: number; pending: number }>;
  riskUnder10: number; riskUnder20: number; riskUnder50: number;
}

const mk = (): Acc => ({
  actionable: 0, pending: 0, terminal: {}, ambiguous: 0, cancelReason: {},
  closed: 0, open: 0, tp: 0, sl: 0, timeout: 0,
  sumR: 0, pos: 0, neg: 0, nPos: 0, rs: [], seq: [],
  riskPct: [], riskAtr: [], invSum: 0,
  improvePct: [], improveAtr: [], improvePctLong: [], improvePctShort: [],
  missedTp1: 0, missedBars: [],
  byKind: new Map(), byDir: new Map(), byTf: new Map(),
  riskUnder10: 0, riskUnder20: 0, riskUnder50: 0,
});

const push = (a: number[], v: number): void => {
  if (a.length < RES) a.push(v);
  else { const j = Math.floor(Math.random() * a.length); if (j < RES) a[j] = v; }
};
const bump = (m: Map<string, { n: number; sum: number }>, k: string, r: number): void => {
  const e = m.get(k) ?? { n: 0, sum: 0 }; e.n++; e.sum += r; m.set(k, e);
};

function addTrade(a: Acc, t: LimitTrade, tf: string): void {
  a.terminal[t.terminal] = (a.terminal[t.terminal] ?? 0) + 1;
  if (t.ambiguous) a.ambiguous++;
  if (t.cancelReason) a.cancelReason[t.cancelReason] = (a.cancelReason[t.cancelReason] ?? 0) + 1;

  const tfe = a.byTf.get(tf) ?? { n: 0, sum: 0, filled: 0, pending: 0 };
  tfe.pending++;
  if (t.terminal === 'MISSED') {
    a.missedTp1++;
    push(a.missedBars, t.barsWaited);
  }
  if (t.terminal !== 'FILLED') { a.byTf.set(tf, tfe); return; }

  // entry improvement vs the frozen OPEN N+1 reference
  if (t.entryPrice !== undefined) {
    const imp = t.direction === 'LONG'
      ? (t.referencePrice - t.entryPrice) : (t.entryPrice - t.referencePrice);
    const pct = (imp / t.referencePrice) * 100;
    push(a.improvePct, pct);
    if (t.atrAtSetup && t.atrAtSetup > 0) push(a.improveAtr, imp / t.atrAtSetup);
    if (t.direction === 'LONG') push(a.improvePctLong, pct); else push(a.improvePctShort, pct);
  }

  if (t.result === undefined || t.result === 'OPEN') { a.open++; a.byTf.set(tf, tfe); return; }

  const r = t.rMultiple ?? 0;
  a.closed++; a.sumR += r; a.seq.push(r); push(a.rs, r);
  if (r > 0) { a.pos += r; a.nPos++; } else a.neg += -r;
  if (t.result === 'TP') a.tp++;
  else if (t.result === 'SL') a.sl++;
  else if (t.result === 'TIMEOUT') a.timeout++;

  if (t.riskPerUnit && t.entryPrice) {
    const rp = (t.riskPerUnit / t.entryPrice) * 100;
    push(a.riskPct, rp);
    if (rp < 0.10) a.riskUnder10++;
    if (rp < 0.20) a.riskUnder20++;
    if (rp < 0.50) a.riskUnder50++;
    a.invSum += t.entryPrice / t.riskPerUnit;
  }
  if (t.riskAtr != null) push(a.riskAtr, t.riskAtr);

  bump(a.byKind, t.setupKind, r);
  bump(a.byDir, t.direction, r);
  tfe.n++; tfe.sum += r; tfe.filled++;
  a.byTf.set(tf, tfe);
}

const med = (x: number[]): number => {
  if (!x.length) return NaN;
  const s = x.slice().sort((p, q) => p - q); return quantileSorted(s, .5);
};
const qq = (x: number[], f: number): number => {
  if (!x.length) return NaN;
  const s = x.slice().sort((p, q) => p - q); return quantileSorted(s, f);
};
const maxDD = (seq: number[]): number => {
  let peak = 0, eq = 0, dd = 0;
  for (const r of seq) { eq += r; if (eq > peak) peak = eq; if (eq - peak < dd) dd = eq - peak; }
  return dd;
};

async function main(): Promise<void> {
  const cache = arg('cache');
  const splitsPath = arg('splits');
  const outDir = arg('out');
  const models = arg('models', 'A,B,C,D').split(',') as (ModelId | 'A')[];

  const splits = (JSON.parse(readFileSync(splitsPath, 'utf8')) as {
    splits: { symbol: string; timeframe: Timeframe; trainFromMs: number; trainToMs: number }[];
  }).splits;
  const settings = Settings.fromDefaults();

  const acc = new Map<string, Acc>();
  for (const m of models) acc.set(m, mk());

  const tradePath = (m: string): string => `${outDir}/limit-${m}-train.jsonl`;
  for (const m of models) { const p = tradePath(m); if (existsSync(p)) rmSync(p); }

  for (const b of splits) {
    if (!hasSeries(cache, b.symbol, b.timeframe)) continue;
    const candles = loadSeries(cache, b.symbol, b.timeframe);
    const htf: Partial<Record<Timeframe, readonly Candle[]>> = {};
    for (const h of HTF_MAP[b.timeframe] ?? []) {
      if (hasSeries(cache, b.symbol, h)) htf[h] = loadSeries(cache, b.symbol, h);
    }

    for (const m of models) {
      const a = acc.get(m)!;
      if (m === 'A') {
        // Baseline: the FROZEN harness, unmodified.
        const d = emptyDiagnostics();
        const r = replayV2Windowed({
          symbol: b.symbol, timeframe: b.timeframe, candles, settings,
          htfCandles: htf, from: b.trainFromMs, to: b.trainToMs, diagnostics: d,
        });
        a.actionable += r.trades.length;
        a.pending += r.trades.length;
        const tfe0 = a.byTf.get(b.timeframe) ?? { n: 0, sum: 0, filled: 0, pending: 0 };
        for (const t of r.trades) {
          a.terminal['FILLED'] = (a.terminal['FILLED'] ?? 0) + 1;
          tfe0.pending++; tfe0.filled++;
          if (t.result === 'OPEN') { a.open++; continue; }
          const rr = t.rMultiple;
          a.closed++; a.sumR += rr; a.seq.push(rr); push(a.rs, rr);
          if (rr > 0) { a.pos += rr; a.nPos++; } else a.neg += -rr;
          if (t.result === 'TP') a.tp++;
          else if (t.result === 'SL') a.sl++;
          else if (t.result === 'TIMEOUT') a.timeout++;
          const risk = Math.abs(t.entryPrice - t.stopLoss);
          if (risk > 0) {
            const rp = (risk / t.entryPrice) * 100;
            push(a.riskPct, rp);
            if (rp < 0.10) a.riskUnder10++;
            if (rp < 0.20) a.riskUnder20++;
            if (rp < 0.50) a.riskUnder50++;
            a.invSum += t.entryPrice / risk;
            if (t.atrAtSetup && t.atrAtSetup > 0) push(a.riskAtr, risk / t.atrAtSetup);
          }
          bump(a.byKind, t.setupKind ?? 'NA', rr);
          bump(a.byDir, t.direction, rr);
          tfe0.n++; tfe0.sum += rr;
          appendFileSync(tradePath('A'), JSON.stringify({
            symbol: t.symbol, timeframe: t.timeframe, direction: t.direction,
            setupKind: t.setupKind, entryCandleTime: t.entryCandleTime,
            entryPrice: t.entryPrice, stopLoss: t.stopLoss, result: t.result,
            exitPrice: t.exitPrice, rMultiple: t.rMultiple, barsHeld: t.barsHeld,
          }) + '\n');
        }
        a.byTf.set(b.timeframe, tfe0);
      } else {
        const r = replayLimitEntry({
          symbol: b.symbol, timeframe: b.timeframe, candles, settings,
          htfCandles: htf, from: b.trainFromMs, to: b.trainToMs, model: m as ModelId,
        });
        a.actionable += r.actionableSetups;
        a.pending += r.pendingCreated;
        for (const t of r.trades) {
          addTrade(a, t, b.timeframe);
          appendFileSync(tradePath(m), JSON.stringify(t) + '\n');
        }
      }
    }
    console.error(`  ${b.symbol} ${b.timeframe} done`);
  }

  /* ---------------- emit ---------------- */
  const out: Record<string, unknown> = { slice: 'train', models: {} };
  const M = out['models'] as Record<string, unknown>;
  for (const m of models) {
    const a = acc.get(m)!;
    const filled = a.terminal['FILLED'] ?? 0;
    const expFilled = a.closed ? a.sumR / a.closed : 0;
    const expSetup = a.actionable ? a.sumR / a.actionable : 0;
    const meanInv = a.closed ? a.invSum / a.closed : 0;
    M[m] = {
      actionableSetups: a.actionable,
      pendingCreated: a.pending,
      terminal: a.terminal,
      fillRate: a.pending ? (filled / a.pending) * 100 : 0,
      fillRateOfActionable: a.actionable ? (filled / a.actionable) * 100 : 0,
      ambiguous: a.ambiguous,
      cancelReasons: a.cancelReason,
      closed: a.closed, open: a.open,
      tp: a.tp, sl: a.sl, timeout: a.timeout,
      grossExpectancyPerFilled: +expFilled.toFixed(4),
      grossExpectancyPerActionableSetup: +expSetup.toFixed(4),
      grossMedianR: +med(a.rs).toFixed(4),
      grossTotalR: +a.sumR.toFixed(2),
      grossPF: a.neg > 0 ? +(a.pos / a.neg).toFixed(4) : null,
      maxDrawdownR: +maxDD(a.seq).toFixed(2),
      positiveRRate: a.closed ? +((a.nPos / a.closed) * 100).toFixed(2) : 0,
      tpRate: a.closed ? +((a.tp / a.closed) * 100).toFixed(2) : 0,
      slRate: a.closed ? +((a.sl / a.closed) * 100).toFixed(2) : 0,
      timeoutRate: a.closed ? +((a.timeout / a.closed) * 100).toFixed(2) : 0,
      riskPct: {
        p25: +qq(a.riskPct, .25).toFixed(4), median: +med(a.riskPct).toFixed(4),
        p75: +qq(a.riskPct, .75).toFixed(4),
      },
      riskAtrMedian: +med(a.riskAtr).toFixed(4),
      riskUnder0_10pct: a.closed ? +((a.riskUnder10 / a.closed) * 100).toFixed(2) : 0,
      riskUnder0_20pct: a.closed ? +((a.riskUnder20 / a.closed) * 100).toFixed(2) : 0,
      riskUnder0_50pct: a.closed ? +((a.riskUnder50 / a.closed) * 100).toFixed(2) : 0,
      netExpectancyPerFilled: Object.fromEntries(
        BPS.map((b) => [`${b}bps`, +(expFilled - (b / 10000) * meanInv).toFixed(4)])),
      entryImprovement: {
        medianPct: +med(a.improvePct).toFixed(5),
        medianAtr: +med(a.improveAtr).toFixed(4),
        medianPctLong: +med(a.improvePctLong).toFixed(5),
        medianPctShort: +med(a.improvePctShort).toFixed(5),
      },
      missed: {
        n: a.terminal['MISSED'] ?? 0,
        medianBarsToMiss: +med(a.missedBars).toFixed(2),
      },
      bySetupKind: Object.fromEntries([...a.byKind].map(([k, v]) =>
        [k, { n: v.n, expectancy: +(v.sum / v.n).toFixed(4) }])),
      byDirection: Object.fromEntries([...a.byDir].map(([k, v]) =>
        [k, { n: v.n, expectancy: +(v.sum / v.n).toFixed(4) }])),
      byTimeframe: Object.fromEntries([...a.byTf].map(([k, v]) =>
        [k, {
          pending: v.pending, filled: v.filled, n: v.n,
          expectancy: v.n ? +(v.sum / v.n).toFixed(4) : null,
          fillRate: v.pending ? +((v.filled / v.pending) * 100).toFixed(2) : 0,
        }])),
    };
  }

  writeFileSync(`${outDir}/limit-entry-train-metrics.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

void main();

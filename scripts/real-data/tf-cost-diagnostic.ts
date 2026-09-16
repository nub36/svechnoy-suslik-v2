/**
 * TIMEFRAME x COST DIAGNOSTIC (TRAIN only).
 *
 * Answers one question quantitatively: at which timeframe does a 0.1 % Binance
 * Spot round-trip fee stop destroying the gross edge?
 *
 * Runs two arms per series and reports, per timeframe:
 *   a) natural stop-distance distribution (median % of price, p25/p75, ATR)
 *   b) gross R expectancy
 *   c) net R expectancy at 0.1 % (and 2/5/20 bps for context)
 *   d) fee drag in R
 *   e) the break-even fee, i.e. the round-trip cost at which net expectancy = 0
 *
 * Arms:
 *   A    = frozen baseline (OPEN N+1, no gates)   -- the natural stop geometry
 *   FULL = confirmed-extreme + fee guard + confluence + corridor
 *
 * No strategy code is modified. Gross is reconstructed exactly as
 * grossR = storedR + (fee_pct/100) * entry / riskPerUnit, because trackOutcome
 * returns an R already net of the frozen fee.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { Settings } from '../../src/core/settings';
import { replayCorridor, ARMS_A_FULL } from './corridor-tf-arms';
import { loadSeries, hasSeries } from './load';
import { HTF_MAP } from '../../src/strategy/v2/htf';
import { quantileSorted } from './audit-fee-readonly';
import type { Candle, Timeframe } from '../../src/core/types';

const FEE_PCT = 0.1;
const TFS: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const BPS = [0, 2, 5, 10, 20];

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

interface TfAcc {
  n: number; sumG: number; pos: number; neg: number; nPos: number;
  riskPct: number[]; riskAtr: number[]; feeR: number[]; invSum: number;
  gs: number[];
}
const mk = (): TfAcc => ({
  n: 0, sumG: 0, pos: 0, neg: 0, nPos: 0,
  riskPct: [], riskAtr: [], feeR: [], invSum: 0, gs: [],
});
const RES = 60000;
const push = (a: number[], v: number): void => {
  if (a.length < RES) a.push(v);
  else { const j = Math.floor(Math.random() * a.length); if (j < RES) a[j] = v; }
};
const med = (x: number[]): number =>
  x.length ? quantileSorted(x.slice().sort((a, b) => a - b), .5) : NaN;
const qq = (x: number[], f: number): number =>
  x.length ? quantileSorted(x.slice().sort((a, b) => a - b), f) : NaN;

async function main(): Promise<void> {
  const cache = arg('cache');
  const outFile = arg('out');
  const splits = (JSON.parse(readFileSync(arg('splits'), 'utf8')) as {
    splits: { symbol: string; timeframe: Timeframe; trainFromMs: number; trainToMs: number }[];
  }).splits;
  const settings = Settings.fromDefaults();

  const acc = new Map<string, Map<string, TfAcc>>();
  for (const armName of Object.keys(ARMS_A_FULL)) acc.set(armName, new Map());

  for (const b of splits) {
    if (!hasSeries(cache, b.symbol, b.timeframe)) continue;
    const candles = loadSeries(cache, b.symbol, b.timeframe);
    const htf: Partial<Record<Timeframe, readonly Candle[]>> = {};
    for (const h of HTF_MAP[b.timeframe] ?? []) {
      if (hasSeries(cache, b.symbol, h)) htf[h] = loadSeries(cache, b.symbol, h);
    }
    for (const [armName, gates] of Object.entries(ARMS_A_FULL)) {
      const r = replayCorridor({
        symbol: b.symbol, timeframe: b.timeframe, candles, settings,
        htfCandles: htf, from: b.trainFromMs, to: b.trainToMs, gates,
      });
      const byTf = acc.get(armName)!;
      let a = byTf.get(b.timeframe);
      if (!a) { a = mk(); byTf.set(b.timeframe, a); }
      for (const t of r.trades) {
        if (t.terminal !== 'FILLED') continue;
        if (t.result === undefined || t.result === 'OPEN') continue;
        const e = t.entryPrice!, risk = t.riskPerUnit!;
        if (!(risk > 0)) continue;
        const fee = (FEE_PCT / 100) * e / risk;
        const g = (t.rMultiple ?? 0) + fee;
        a.n++; a.sumG += g; push(a.gs, g);
        if (g > 0) { a.pos += g; a.nPos++; } else a.neg += -g;
        push(a.riskPct, (risk / e) * 100);
        if (t.riskAtr != null) push(a.riskAtr, t.riskAtr);
        push(a.feeR, fee);
        a.invSum += e / risk;
      }
    }
    console.error(`  ${b.symbol} ${b.timeframe} done`);
  }

  const out: Record<string, unknown> = { slice: 'train', feePct: FEE_PCT, arms: {} };
  const M = out['arms'] as Record<string, unknown>;
  for (const [armName, byTf] of acc) {
    const rows: Record<string, unknown> = {};
    for (const tf of TFS) {
      const a = byTf.get(tf);
      if (!a || a.n === 0) continue;
      const gross = a.sumG / a.n;
      const meanInv = a.invSum / a.n;
      // break-even round-trip cost in bps: gross = (bps/1e4)*meanInv
      const beBps = meanInv > 0 ? (gross / meanInv) * 10000 : NaN;
      rows[tf] = {
        n: a.n,
        stopPctP25: +qq(a.riskPct, .25).toFixed(4),
        stopPctMedian: +med(a.riskPct).toFixed(4),
        stopPctP75: +qq(a.riskPct, .75).toFixed(4),
        stopAtrMedian: +med(a.riskAtr).toFixed(4),
        grossExpectancy: +gross.toFixed(4),
        grossMedianR: +med(a.gs).toFixed(4),
        grossPF: a.neg > 0 ? +(a.pos / a.neg).toFixed(4) : null,
        positiveRRate: +((a.nPos / a.n) * 100).toFixed(2),
        feeDragR_at_0_1pct: +med(a.feeR).toFixed(4),
        meanFeeDragR_at_0_1pct: +(a.invSum / a.n * (FEE_PCT / 100)).toFixed(4),
        netExpectancy: Object.fromEntries(
          BPS.map((b) => [`${b}bps`, +(gross - (b / 10000) * meanInv).toFixed(4)])),
        breakEvenRoundTripBps: Number.isFinite(beBps) ? +beBps.toFixed(3) : null,
        survivesSpot10bps: gross - (10 / 10000) * meanInv > 0,
      };
    }
    M[armName] = rows;
  }

  writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log('wrote', outFile);
}

void main();

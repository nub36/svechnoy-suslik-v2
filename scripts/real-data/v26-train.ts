/**
 * V2.6 TRAIN driver — sniper entry x trailing exit, 2x2 ablation.
 *
 * TRAIN ONLY. Per-series boundaries from the frozen splits.json; the validation
 * and test windows are never read.
 *
 * ONE chronological walk produces the entry universe (frozen signal, frozen
 * entry at OPEN N+1, frozen structural stop). Each entry is tagged with whether
 * it passes the sniper filter, then resolved TWICE — by the FROZEN
 * `trackOutcome` and by the research trailing simulator. The four arms are then
 * projections of that single universe:
 *
 *   A                = all entries,    frozen exits
 *   V25              = all entries,    trailing exits
 *   V26              = sniper entries, trailing exits   <- the candidate
 *   V26-frozen-exit  = sniper entries, frozen exits
 *
 * This guarantees the same-universe invariant by construction: the arms cannot
 * diverge in their entry set except through the sniper flag itself.
 *
 * The frozen `src/outcome/tracker.ts` is NOT modified.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { Settings } from '../../src/core/settings';
import { evaluateV2 } from '../../src/strategy/v2';
import { HTF_MAP } from '../../src/strategy/v2/htf';
import { resolveEntry } from '../../src/strategy/state-machine';
import { trackOutcome } from '../../src/outcome/tracker';
import { executableLadder } from '../../src/replay/v2-runner';
import { loadSeries, hasSeries } from './load';
import { quantileSorted } from './audit-fee-readonly';
import { baseSniper } from './v24-engine';
import { extremePoolKind, type PoolKind } from './corridor-entry';
import { V25_FEE_ENVS, feeR, simulateTrailing } from './v25-trailing';
import type { Candle, Timeframe } from '../../src/core/types';
import { TF_MS } from '../../src/core/types';
import type { V2Setup } from '../../src/strategy/v2/types';

const SCOPE: Timeframe[] = ['15m', '30m', '1h', '4h'];
const FROZEN_FEE_PCT = 0.1;
const WINDOW_MARGIN = 60;
/** From the pre-registration §0. */
const NAIVE_ADDITIVE_GROSS = 0.1057;

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

interface Sub { n: number; sum: number }
interface Acc {
  closed: number;
  sumG: number; pos: number; neg: number; nPos: number; nNeg: number;
  winSum: number; lossSum: number;
  seq: number[]; gs: number[];
  feeSum: Record<string, number>;
  reasons: Record<string, number>;
  barsHeld: number[]; never1R: number;
  byDir: Map<string, Sub>; byTf: Map<string, Sub>; bySym: Map<string, Sub>;
}
const mk = (): Acc => ({
  closed: 0, sumG: 0, pos: 0, neg: 0, nPos: 0, nNeg: 0,
  winSum: 0, lossSum: 0, seq: [], gs: [],
  feeSum: Object.fromEntries(V25_FEE_ENVS.map((e) => [e.label, 0])),
  reasons: {}, barsHeld: [], never1R: 0,
  byDir: new Map(), byTf: new Map(), bySym: new Map(),
});
const bump = (m: Map<string, Sub>, k: string, r: number): void => {
  const e = m.get(k) ?? { n: 0, sum: 0 }; e.n++; e.sum += r; m.set(k, e);
};
const med = (x: number[]): number =>
  x.length ? quantileSorted(x.slice().sort((a, b) => a - b), .5) : NaN;
const maxDD = (s: number[]): number => {
  let peak = 0, eq = 0, dd = 0;
  for (const r of s) { eq += r; if (eq > peak) peak = eq; if (eq - peak < dd) dd = eq - peak; }
  return dd;
};
const sub = (m: Map<string, Sub>): Record<string, unknown> =>
  Object.fromEntries([...m].map(([k, v]) =>
    [k, { n: v.n, grossExpectancy: +(v.sum / v.n).toFixed(4) }]));

function add(
  a: Acc, grossR: number, entry: number, exit: number, risk: number,
  reason: string, barsHeld: number, mfeR: number,
  symbol: string, tf: string, dir: string,
): void {
  a.closed++; a.sumG += grossR; a.seq.push(grossR); a.gs.push(grossR);
  if (grossR > 0) { a.pos += grossR; a.nPos++; a.winSum += grossR; }
  else { a.neg += -grossR; a.nNeg++; a.lossSum += -grossR; }
  a.reasons[reason] = (a.reasons[reason] ?? 0) + 1;
  a.barsHeld.push(barsHeld);
  if (mfeR < 1.0) a.never1R++;
  for (const e of V25_FEE_ENVS) {
    a.feeSum[e.label] = (a.feeSum[e.label] ?? 0)
      + feeR(entry, exit, risk, e.makerBps, e.takerBps);
  }
  bump(a.byDir, dir, grossR);
  bump(a.byTf, tf, grossR);
  bump(a.bySym, symbol, grossR);
}

function htfUpperBound(c: readonly Candle[], asOf: number, span: number): number {
  let lo = 0, hi = c.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c[mid]!.openTime + span <= asOf) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

async function main(): Promise<void> {
  const cache = arg('cache');
  const outFile = arg('out');
  const splits = (JSON.parse(readFileSync(arg('splits'), 'utf8')) as {
    splits: { symbol: string; timeframe: Timeframe; trainFromMs: number; trainToMs: number }[];
  }).splits.filter((s) => SCOPE.includes(s.timeframe));
  const settings = Settings.fromDefaults();

  const minRr = settings.num('risk.min_rr');
  const timeoutBars = Math.floor(settings.num('outcome.timeout_bars'));
  const swing = Math.floor(settings.num('engine.swing_lookback'));
  const lookback = Math.floor(settings.num('engine.lookback_candles'));
  const minBars = Math.max(80, swing * 6 + 40);
  const winLen = lookback + WINDOW_MARGIN;

  const accA = mk(), accV25 = mk(), accV26 = mk(), accV26F = mk();
  let actionable = 0, sniperEntries = 0;
  let entriesA = 0, entriesV25 = 0, entriesV26 = 0, entriesV26F = 0;
  let unresolvedTrail = 0;

  for (const b of splits) {
    if (!hasSeries(cache, b.symbol, b.timeframe)) continue;
    const all = loadSeries(cache, b.symbol, b.timeframe);
    const closed = all.filter((c) => c.isClosed);
    const htf: Partial<Record<Timeframe, readonly Candle[]>> = {};
    for (const h of HTF_MAP[b.timeframe] ?? []) {
      if (hasSeries(cache, b.symbol, h)) htf[h] = loadSeries(cache, b.symbol, h);
    }
    const htfSpans = new Map<Timeframe, number>();
    for (const h of HTF_MAP[b.timeframe] ?? []) htfSpans.set(h, TF_MS[h]);
    const tfMs = TF_MS[b.timeframe];

    let open: {
      entryIndex: number; entryPrice: number; stop: number; tps: number[];
      entryCandleTime: number; direction: 'LONG' | 'SHORT'; sniper: boolean;
    } | null = null;

    for (let i = minBars; i < closed.length; i++) {
      const candle = closed[i]!;
      if (candle.openTime < b.trainFromMs) continue;
      if (candle.openTime > b.trainToMs) break;

      /* ---- resolve the open position ---- */
      if (open) {
        const slice = closed.slice(open.entryIndex, i + 1);
        const out = trackOutcome({
          direction: open.direction, entryPrice: open.entryPrice,
          stopLoss: open.stop, takeProfits: open.tps,
          entryCandleTime: open.entryCandleTime, candles: slice,
          settings, qty: 0,
        });
        if (out) {
          const risk = Math.abs(open.entryPrice - open.stop);
          const grossFrozen = out.rMultiple
            + (FROZEN_FEE_PCT / 100) * open.entryPrice / risk;
          let maxFav = -Infinity;
          for (let k = 0; k < out.barsHeld && open.entryIndex + k < closed.length; k++) {
            const c = closed[open.entryIndex + k]!;
            const fav = open.direction === 'LONG'
              ? c.high - open.entryPrice : open.entryPrice - c.low;
            if (fav / risk > maxFav) maxFav = fav / risk;
          }
          const mfeFrozen = Math.max(0, maxFav);

          // arm A — all entries, frozen exits
          add(accA, grossFrozen, open.entryPrice, out.exitPrice, risk,
            out.result, out.barsHeld, mfeFrozen, b.symbol, b.timeframe, open.direction);
          entriesA++;
          // arm V26-frozen-exit — sniper entries, frozen exits
          if (open.sniper) {
            add(accV26F, grossFrozen, open.entryPrice, out.exitPrice, risk,
              out.result, out.barsHeld, mfeFrozen, b.symbol, b.timeframe, open.direction);
            entriesV26F++;
          }

          // trailing resolution of the SAME entry
          const bars = closed.slice(open.entryIndex,
            Math.min(closed.length, open.entryIndex + timeoutBars + 64));
          const v = simulateTrailing({
            direction: open.direction, entryPrice: open.entryPrice,
            stopLoss: open.stop, bars,
          });
          if (v) {
            add(accV25, v.grossR, open.entryPrice, v.exitPrice, risk,
              v.reason, v.barsHeld, v.mfeR, b.symbol, b.timeframe, open.direction);
            entriesV25++;
            if (open.sniper) {
              add(accV26, v.grossR, open.entryPrice, v.exitPrice, risk,
                v.reason, v.barsHeld, v.mfeR, b.symbol, b.timeframe, open.direction);
              entriesV26++;
            }
          } else unresolvedTrail++;

          open = null;
        }
      }

      /* ---- evaluate for a new setup ---- */
      if (open === null) {
        const start = Math.max(0, i - winLen + 1);
        const visible = closed.slice(start, i + 1);
        let htfArg: Partial<Record<Timeframe, readonly Candle[]>> | undefined;
        if (Object.keys(htf).length > 0) {
          const bounded: Partial<Record<Timeframe, readonly Candle[]>> = {};
          const asOf = candle.closeTime;
          for (const [h, span] of htfSpans) {
            const hc = htf[h]; if (!hc || hc.length === 0) continue;
            const ub = htfUpperBound(hc, asOf, span);
            if (ub < 0) continue;
            bounded[h] = hc.slice(Math.max(0, ub - 200 + 1), ub + 1);
          }
          htfArg = bounded;
        }
        const s: V2Setup | null = evaluateV2({
          symbol: b.symbol, timeframe: b.timeframe, candles: visible,
          settings, htfCandles: htfArg,
        });
        if (s !== null && s.direction !== 'WAIT' && s.stop !== null
          && s.entry !== null && s.targets.length > 0) {
          const next = closed[i + 1];
          const ent = resolveEntry(candle.openTime, tfMs, next);
          if (ent) {
            actionable++;
            const shift = ent.entryPrice - s.entry;
            const stopPrice = s.stop.price + shift;
            const tps = s.targets.map((t) => t.price + shift);
            const lad = executableLadder(s.direction, ent.entryPrice, stopPrice, tps);
            const risk = Math.abs(ent.entryPrice - stopPrice);
            const valid = risk > 0 && lad.targets.length > 0 && lad.rr1 >= minRr
              && (s.direction === 'LONG'
                ? stopPrice < ent.entryPrice : stopPrice > ent.entryPrice);
            if (valid) {
              // Sniper flag — pool kind only computed when it can matter.
              let sniper = false;
              if (s.kind === 'REVERSAL') {
                const pk: PoolKind = extremePoolKind(s, visible, settings);
                sniper = baseSniper(s, pk).ok;
              }
              if (sniper) sniperEntries++;
              open = {
                entryIndex: i + 1, entryPrice: ent.entryPrice, stop: stopPrice,
                tps: lad.targets, entryCandleTime: ent.entryCandleTime,
                direction: s.direction, sniper,
              };
            }
          }
        }
      }
    }
    console.error(`  ${b.symbol} ${b.timeframe} done`);
  }

  const summarise = (a: Acc, label: string, denom: number): Record<string, unknown> => {
    const exp = a.closed ? a.sumG / a.closed : 0;
    const sorted = a.gs.slice().sort((x, y) => y - x);
    const drop = (k: number): number => {
      const rest = sorted.slice(Math.min(k, sorted.length));
      return rest.length ? rest.reduce((p, q) => p + q, 0) / rest.length : 0;
    };
    const k1 = Math.max(1, Math.ceil(sorted.length * 0.01));
    const net = (lab: string): { perFilled: number; perSetup: number; meanFeeDragR: number } => {
      const fee = a.feeSum[lab] ?? 0;
      return {
        perFilled: a.closed ? +((a.sumG - fee) / a.closed).toFixed(4) : 0,
        perSetup: +((a.sumG - fee) / (denom || 1)).toFixed(4),
        meanFeeDragR: a.closed ? +(fee / a.closed).toFixed(4) : 0,
      };
    };
    return {
      arm: label, closed: a.closed,
      grossExpectancyPerTrade: +exp.toFixed(4),
      grossExpectancyPerActionableSetup: +(a.sumG / (denom || 1)).toFixed(4),
      grossMedianR: +med(a.gs).toFixed(4),
      grossTotalR: +a.sumG.toFixed(2),
      grossPF: a.neg > 0 ? +(a.pos / a.neg).toFixed(4) : null,
      winRate: a.closed ? +((a.nPos / a.closed) * 100).toFixed(2) : 0,
      avgWin: a.nPos ? +(a.winSum / a.nPos).toFixed(4) : 0,
      avgLoss: a.nNeg ? +(-a.lossSum / a.nNeg).toFixed(4) : 0,
      payoffRatio: a.nNeg && a.nPos
        ? +((a.winSum / a.nPos) / (a.lossSum / a.nNeg)).toFixed(4) : null,
      maxDrawdownR: +maxDD(a.seq).toFixed(2),
      medianBarsHeld: +med(a.barsHeld).toFixed(2),
      shareNeverReached1R: a.closed ? +((a.never1R / a.closed) * 100).toFixed(2) : 0,
      exitReasons: a.reasons,
      netByFeeEnv: Object.fromEntries(V25_FEE_ENVS.map((e) => [e.label, net(e.label)])),
      outlierDependence: {
        grossExpectancy: +exp.toFixed(4),
        exTop1: +drop(1).toFixed(4), exTop5: +drop(5).toFixed(4),
        exTop1Pct: +drop(k1).toFixed(4), removedForTop1Pct: k1,
      },
      byDirection: sub(a.byDir), byTimeframe: sub(a.byTf), bySymbol: sub(a.bySym),
    };
  };

  const A = summarise(accA, 'A', actionable);
  const V25 = summarise(accV25, 'V25', actionable);
  const V26 = summarise(accV26, 'V26', sniperEntries);
  const V26F = summarise(accV26F, 'V26-frozen-exit', sniperEntries);

  const headV26 = (V26['netByFeeEnv'] as Record<string, { perFilled: number }>)['FUT_4']!.perFilled;
  const grossV26 = V26['grossExpectancyPerTrade'] as number;

  const out = {
    slice: 'train', scope: SCOPE,
    feeEnvironments: V25_FEE_ENVS,
    headlineLabel: 'FUT_4 = 2 bps maker entry + 5 bps taker exit',
    actionableSetups: actionable,
    sniperEntries,
    sameUniverseInvariant: {
      entriesA, entriesV25, entriesV26, entriesV26F,
      unresolvedTrailingAtBoundary: unresolvedTrail,
      allArmsFromOneWalk: true,
      ok: entriesA - entriesV25 === unresolvedTrail,
    },
    criterion: {
      rule: 'V2.6 net expectancy per trade > 0, headline 2/5 bps',
      value: headV26, passed: headV26 > 0,
    },
    additivityTest: {
      naiveAdditiveGrossProjection: NAIVE_ADDITIVE_GROSS,
      measuredV26Gross: grossV26,
      shortfall: +(grossV26 - NAIVE_ADDITIVE_GROSS).toFixed(4),
      note: 'Negative shortfall confirms the overlap hypothesis in §0 — the '
        + 'entry-filter and exit-rule gains do not stack.',
    },
    arms: { A, V25, V26, 'V26-frozen-exit': V26F },
  };
  writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log('wrote', outFile);
}

void main();

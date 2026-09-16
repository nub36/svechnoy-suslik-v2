/**
 * V2.8 — ZERO-FEE SNIPER + TRAILING — VALIDATION RUN.
 *
 * Question: ignoring transaction costs entirely, which exit strategy extracts
 * the most gross R from the sniper entry population?
 *
 * Seven exit arms on ONE shared set of sniper entries:
 *   SMC    frozen `trackOutcome` — structural ladder + structural SL + timeout
 *   Trail  V2.5 trailing (breakeven at +1R, trail 1R from peak MFE, 10-bar TO)
 *   RR15..RR40  fixed take-profit at 1.5 / 2.0 / 2.5 / 3.0 / 4.0 x risk
 *
 * FEES ARE ZERO EVERYWHERE. Every figure below is gross R.
 *
 * FROZEN SURFACE: nothing under `src/` is modified. The frozen engine supplies
 * the signal, the structural stop and the N+1 entry; the frozen `trackOutcome`
 * is called unmodified for the SMC arm.
 *
 * GROSS RECONSTRUCTION for the SMC arm: `trackOutcome` returns an R already net
 * of the frozen 0.1 % lump fee, so gross is recovered exactly as
 *   grossR = storedR + (0.1/100) * entry / risk
 * (the identity verified across 1.69M trades in the earlier fee audit).
 *
 * ENTRIES: identical to V2.6/V2.7 — the 8-condition sniper filter, reversals
 * only, entry at OPEN of N+1. Not modified here.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { Settings } from '../src/core/settings';
import { evaluateV2 } from '../src/strategy/v2';
import { HTF_MAP } from '../src/strategy/v2/htf';
import { resolveEntry } from '../src/strategy/state-machine';
import { trackOutcome } from '../src/outcome/tracker';
import { executableLadder } from '../src/replay/v2-runner';
import { loadSeries, hasSeries } from '../scripts/real-data/load';
import { quantileSorted } from '../scripts/real-data/audit-fee-readonly';
import { baseSniper } from '../scripts/real-data/v24-engine';
import { extremePoolKind, type PoolKind } from '../scripts/real-data/corridor-entry';
import { simulateTrailing } from '../scripts/real-data/v25-trailing';
import { simulateFixedRr } from './v27_rr_test';
import type { Candle, Timeframe } from '../src/core/types';
import { TF_MS } from '../src/core/types';
import type { V2Setup } from '../src/strategy/v2/types';

/** The frozen lump fee that `trackOutcome` subtracts; removed to recover gross. */
const FROZEN_FEE_PCT = 0.1;
/** Horizon for the fixed-RR arms, matching V2.7. */
const RR_MAX_BARS = 50;

const SCOPE: Timeframe[] = ['15m', '30m', '1h', '4h'];
/** Frozen candidate = the Trail arm; SMC kept only as a comparison anchor. */
const VALIDATION_ARMS = ['SMC', 'Trail'] as const;
const WINDOW_MARGIN = 60;

export const ARM_ORDER = ['SMC', 'Trail', 'RR15', 'RR20', 'RR25', 'RR30', 'RR40'] as const;
export const RR_MULTS: Readonly<Record<string, number>> = {
  RR15: 1.5, RR20: 2.0, RR25: 2.5, RR30: 3.0, RR40: 4.0,
};

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

/* ---------------- accumulation (gross only) ---------------- */

interface Sub { n: number; sum: number }
interface Acc {
  n: number; sumG: number;
  nWinTarget: number;          // hit TP (fixed arms) / TP result (SMC)
  nPos: number;                // gross R > 0
  pos: number; neg: number;
  wins: number[]; losses: number[];
  gs: number[]; seq: number[]; bars: number[];
  exits: Record<string, number>;
  byDir: Map<string, Sub>; byTf: Map<string, Sub>; bySym: Map<string, Sub>;
}
const mk = (): Acc => ({
  n: 0, sumG: 0, nWinTarget: 0, nPos: 0, pos: 0, neg: 0,
  wins: [], losses: [], gs: [], seq: [], bars: [], exits: {},
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

function record(
  a: Acc, grossR: number, exit: string, hitTarget: boolean, barsHeld: number,
  symbol: string, tf: string, dir: string,
): void {
  a.n++; a.sumG += grossR; a.gs.push(grossR); a.seq.push(grossR); a.bars.push(barsHeld);
  a.exits[exit] = (a.exits[exit] ?? 0) + 1;
  if (hitTarget) a.nWinTarget++;
  if (grossR > 0) { a.pos += grossR; a.nPos++; a.wins.push(grossR); }
  else { a.neg += -grossR; a.losses.push(grossR); }
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
    splits: {
      symbol: string; timeframe: Timeframe;
      validFromMs: number; validToMs: number; testFromMs: number;
    }[];
  }).splits.filter((s) => SCOPE.includes(s.timeframe));

  // TEST-SAFETY GUARD (pre-registration §5). Every window handed to the replay
  // must end strictly before that series' testFromMs, or the run aborts rather
  // than silently reading TEST data.
  for (const b of splits) {
    if (!(b.validToMs < b.testFromMs)) {
      throw new Error(`TEST-SAFETY: ${b.symbol} ${b.timeframe} `
        + `validTo ${b.validToMs} >= testFrom ${b.testFromMs}`);
    }
  }
  const settings = Settings.fromDefaults();

  const minRr = settings.num('risk.min_rr');
  const timeoutBars = Math.floor(settings.num('outcome.timeout_bars'));
  const swing = Math.floor(settings.num('engine.swing_lookback'));
  const lookback = Math.floor(settings.num('engine.lookback_candles'));
  const minBars = Math.max(80, swing * 6 + 40);
  const winLen = lookback + WINDOW_MARGIN;

  const acc = new Map<string, Acc>();
  for (const k of VALIDATION_ARMS) acc.set(k, mk());
  const entryKeys = new Map<string, Set<string>>();
  for (const k of VALIDATION_ARMS) entryKeys.set(k, new Set());

  let actionable = 0, sniperEntries = 0;

  for (const b of splits) {
    if (!hasSeries(cache, b.symbol, b.timeframe)) continue;
    const closed = loadSeries(cache, b.symbol, b.timeframe).filter((c) => c.isClosed);
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
      if (candle.openTime < b.validFromMs) continue;
      if (candle.openTime > b.validToMs) break;

      /* ---- the frozen tracker governs the slot (as in V2.6/V2.7) ---- */
      if (open) {
        const slice = closed.slice(open.entryIndex, i + 1);
        const out = trackOutcome({
          direction: open.direction, entryPrice: open.entryPrice,
          stopLoss: open.stop, takeProfits: open.tps,
          entryCandleTime: open.entryCandleTime, candles: slice, settings, qty: 0,
        });
        if (out) {
          if (open.sniper) {
            const risk = Math.abs(open.entryPrice - open.stop);
            const key = `${b.symbol}|${b.timeframe}|${open.entryCandleTime}`;
            const dir = open.direction;

            // --- SMC arm: frozen tracker, fee removed to recover GROSS.
            const grossSmc = out.rMultiple
              + (FROZEN_FEE_PCT / 100) * open.entryPrice / risk;
            record(acc.get('SMC')!, grossSmc, out.result, out.result === 'TP',
              out.barsHeld, b.symbol, b.timeframe, dir);
            entryKeys.get('SMC')!.add(key);

            // --- Trail arm.
            const trailBars = closed.slice(open.entryIndex,
              Math.min(closed.length, open.entryIndex + timeoutBars + 64));
            const tr = simulateTrailing({
              direction: dir, entryPrice: open.entryPrice,
              stopLoss: open.stop, bars: trailBars,
            });
            if (tr) {
              record(acc.get('Trail')!, tr.grossR, tr.reason,
                tr.grossR > 0, tr.barsHeld, b.symbol, b.timeframe, dir);
              entryKeys.get('Trail')!.add(key);
            }

          }
          open = null;
        }
      }

      /* ---- new setup ---- */
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

  /* ---- same-entry invariant ---- */
  const ref = entryKeys.get('SMC')!;
  const perArm = Object.fromEntries(
    VALIDATION_ARMS.map((k) => [k, entryKeys.get(k)!.size]));
  const identical = VALIDATION_ARMS.every((k) => {
    const s = entryKeys.get(k)!;
    return s.size === ref.size && [...s].every((x) => ref.has(x));
  });

  const summarise = (label: string): Record<string, unknown> => {
    const a = acc.get(label)!;
    const gross = a.n ? a.sumG / a.n : 0;
    const sorted = a.gs.slice().sort((x, y) => y - x);
    const drop = (k: number): number => {
      const rest = sorted.slice(Math.min(k, sorted.length));
      return rest.length ? rest.reduce((p, q) => p + q, 0) / rest.length : 0;
    };
    const k1 = Math.max(1, Math.ceil(sorted.length * 0.01));
    return {
      arm: label, n: a.n,
      winRateTargetPct: a.n ? +((a.nWinTarget / a.n) * 100).toFixed(2) : 0,
      positiveRRatePct: a.n ? +((a.nPos / a.n) * 100).toFixed(2) : 0,
      grossRPerTrade: +gross.toFixed(4),
      grossTotalR: +a.sumG.toFixed(2),
      profitFactor: a.neg > 0 ? +(a.pos / a.neg).toFixed(4) : null,
      maxDrawdownR: +maxDD(a.seq).toFixed(2),
      grossMedianR: +med(a.gs).toFixed(4),
      avgWinR: a.wins.length
        ? +(a.wins.reduce((p, q) => p + q, 0) / a.wins.length).toFixed(4) : 0,
      avgLossR: a.losses.length
        ? +(a.losses.reduce((p, q) => p + q, 0) / a.losses.length).toFixed(4) : 0,
      medianBarsHeld: +med(a.bars).toFixed(2),
      exits: a.exits,
      outlierDependence: {
        grossExpectancy: +gross.toFixed(4),
        exTop1: +drop(1).toFixed(4), exTop5: +drop(5).toFixed(4),
        exTop1Pct: +drop(k1).toFixed(4), removedForTop1Pct: k1,
      },
      byDirection: sub(a.byDir), byTimeframe: sub(a.byTf), bySymbol: sub(a.bySym),
    };
  };

  const arms = VALIDATION_ARMS.map((k) => summarise(k));
  const best = arms.reduce((p, c) =>
    (c['grossRPerTrade'] as number) > (p['grossRPerTrade'] as number) ? c : p);
  const bestRobust = arms.reduce((p, c) => {
    const cv = (c['outlierDependence'] as { exTop1Pct: number }).exTop1Pct;
    const pv = (p['outlierDependence'] as { exTop1Pct: number }).exTop1Pct;
    return cv > pv ? c : p;
  });

  const out = {
    slice: 'validation', scope: SCOPE,
    candidate: 'Trail (sniper entry + V2.5 trailing, zero fees)',
    freezeCommit: '852167c',
    feesDisabled: true,
    feeNote: 'ALL fees set to ZERO. Every figure is gross R. The SMC arm '
      + 'recovers gross by adding back the frozen 0.1% lump fee that '
      + 'trackOutcome subtracts.',
    entryFilter: 'V2.6/V2.7 sniper (bodyRatio >= 0.35, rvol > 1.2), reversals only',
    rrMaxBars: RR_MAX_BARS,
    actionableSetups: actionable,
    sniperEntries,
    sameEntryInvariant: { perArmEntryCounts: perArm, identicalAcrossArms: identical },
    best: { byGross: best['arm'], grossRPerTrade: best['grossRPerTrade'] },
    bestAfterOutlierRemoval: {
      arm: bestRobust['arm'],
      exTop1Pct: (bestRobust['outlierDependence'] as { exTop1Pct: number }).exTop1Pct,
    },
    arms,
  };
  writeFileSync(outFile, JSON.stringify(out, null, 2));

  console.log('');
  console.log('ZERO-FEE (PURE ALPHA) EXIT COMPARISON — TRAIN, sniper entries');
  console.log('');
  console.log('| Arm   |   n | Win Rate % | Gross R/trade | Profit Factor | Max Drawdown R |');
  console.log('|-------|-----|------------|---------------|---------------|----------------|');
  for (const a of arms) {
    console.log(`| ${String(a['arm']).padEnd(5)} | ${String(a['n']).padStart(3)} | `
      + `${String(a['winRateTargetPct']).padStart(10)} | ${String(a['grossRPerTrade']).padStart(13)} | `
      + `${String(a['profitFactor']).padStart(13)} | ${String(a['maxDrawdownR']).padStart(14)} |`);
  }
  console.log('');
  console.log(`BEST by gross R/trade      : ${best['arm']} (${best['grossRPerTrade']})`);
  console.log(`BEST after removing top 1% : ${bestRobust['arm']} `
    + `(${(bestRobust['outlierDependence'] as { exTop1Pct: number }).exTop1Pct})`);
  console.log('wrote', outFile);
}

const invokedDirectly = process.argv.some((a) => a.includes('v28_validate'));
if (invokedDirectly) void main();

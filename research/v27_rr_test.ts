/**
 * V2.7 — TARGET RR OPTIMIZATION.
 *
 * Implements docs/V2_7_RR_OPTIMIZATION_PREREGISTRATION.md exactly.
 *
 * Five fixed take-profit arms (1.5R / 2.0R / 2.5R / 3.0R / 4.0R) evaluated on
 * ONE shared set of sniper entries. No trailing, no partials, no breakeven —
 * this isolates pure RR.
 *
 * FROZEN SURFACE: nothing under `src/` is modified. The frozen engine supplies
 * the signal, the structural stop and the N+1 entry; this file only decides
 * where the take-profit sits and walks the bars forward.
 *
 * STOP BUFFER: the frozen 0.25 ATR structural stop is used, NOT the 0.05 ATR
 * mentioned in the task brief. See §0.1 of the pre-registration — the task also
 * requires "the SAME entry signals as V2.6", the stop defines R, and a tighter
 * stop would mechanically inflate fee-in-R and bias the study toward the
 * hypothesis under test.
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
import type { Candle, Timeframe } from '../src/core/types';
import { TF_MS } from '../src/core/types';
import type { V2Setup } from '../src/strategy/v2/types';

/* ---------------- preregistered constants ---------------- */

export const RR_ARMS: readonly { label: string; mult: number }[] = [
  { label: 'RR15', mult: 1.5 },
  { label: 'RR20', mult: 2.0 },
  { label: 'RR25', mult: 2.5 },
  { label: 'RR30', mult: 3.0 },
  { label: 'RR40', mult: 4.0 },
];
/** Task-specified horizon (frozen default is 48; the 2-bar deviation is logged). */
export const MAX_BARS = 50;
export const MAKER_BPS = 2;
export const TAKER_BPS = 5;

const SCOPE: Timeframe[] = ['15m', '30m', '1h', '4h'];
const WINDOW_MARGIN = 60;

export type RrExit = 'TP' | 'SL' | 'TIMEOUT';

export interface RrResult {
  exit: RrExit; exitPrice: number; barsHeld: number; grossR: number;
}

/**
 * Walk bars forward for one fixed-target arm.
 *
 * Same-bar TP and SL resolves as SL (conservative; mirrors the frozen
 * `outcome.sl_priority_on_ambiguous_bar = true`). Registered in advance because
 * it slightly disadvantages the higher-RR arms.
 */
export function simulateFixedRr(
  direction: 'LONG' | 'SHORT', entry: number, stop: number,
  mult: number, bars: readonly Candle[],
): RrResult | null {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || bars.length === 0) return null;
  const long = direction === 'LONG';
  const tp = long ? entry + mult * risk : entry - mult * risk;
  const rOf = (p: number): number => (long ? p - entry : entry - p) / risk;

  for (let i = 0; i < bars.length && i < MAX_BARS; i++) {
    const c = bars[i]!;
    const hitSl = long ? c.low <= stop : c.high >= stop;
    const hitTp = long ? c.high >= tp : c.low <= tp;
    if (hitSl) {
      return { exit: 'SL', exitPrice: stop, barsHeld: i + 1, grossR: rOf(stop) };
    }
    if (hitTp) {
      return { exit: 'TP', exitPrice: tp, barsHeld: i + 1, grossR: rOf(tp) };
    }
    if (i + 1 >= MAX_BARS) {
      return { exit: 'TIMEOUT', exitPrice: c.close, barsHeld: i + 1, grossR: rOf(c.close) };
    }
  }
  const last = bars[Math.min(bars.length, MAX_BARS) - 1]!;
  return {
    exit: 'TIMEOUT', exitPrice: last.close,
    barsHeld: Math.min(bars.length, MAX_BARS), grossR: rOf(last.close),
  };
}

/** Per-leg fee in R: maker entry, taker exit. No rebate. */
export function feeR(
  entry: number, exit: number, risk: number,
  makerBps = MAKER_BPS, takerBps = TAKER_BPS,
): number {
  if (!(risk > 0)) return 0;
  return ((makerBps / 10000) * entry + (takerBps / 10000) * Math.abs(exit)) / risk;
}

/* ---------------- accumulation ---------------- */

interface Sub { n: number; sum: number }
interface Acc {
  n: number; sumG: number; sumFee: number; sumFeeStress: number;
  nTp: number; nSl: number; nTo: number;
  pos: number; neg: number; nPos: number;
  wins: number[]; losses: number[]; gs: number[]; seq: number[]; bars: number[];
  byDir: Map<string, Sub>; byTf: Map<string, Sub>; bySym: Map<string, Sub>;
}
const mk = (): Acc => ({
  n: 0, sumG: 0, sumFee: 0, sumFeeStress: 0, nTp: 0, nSl: 0, nTo: 0,
  pos: 0, neg: 0, nPos: 0, wins: [], losses: [], gs: [], seq: [], bars: [],
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

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
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
  const swing = Math.floor(settings.num('engine.swing_lookback'));
  const lookback = Math.floor(settings.num('engine.lookback_candles'));
  const minBars = Math.max(80, swing * 6 + 40);
  const winLen = lookback + WINDOW_MARGIN;

  const acc = new Map<string, Acc>();
  for (const a of RR_ARMS) acc.set(a.label, mk());
  /** Entry fingerprints, to prove the same-entry invariant. */
  const entryKeys = new Map<string, Set<string>>();
  for (const a of RR_ARMS) entryKeys.set(a.label, new Set());

  let actionable = 0, sniperEntries = 0, unresolved = 0;

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
      if (candle.openTime < b.trainFromMs) continue;
      if (candle.openTime > b.trainToMs) break;

      /* ---- the frozen tracker governs the position slot (as in V2.6) ---- */
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
            const bars = closed.slice(open.entryIndex,
              Math.min(closed.length, open.entryIndex + MAX_BARS + 2));
            const key = `${b.symbol}|${b.timeframe}|${open.entryCandleTime}`;
            let anyResolved = false;
            for (const armSpec of RR_ARMS) {
              const r = simulateFixedRr(open.direction, open.entryPrice,
                open.stop, armSpec.mult, bars);
              if (!r) continue;
              anyResolved = true;
              const a = acc.get(armSpec.label)!;
              entryKeys.get(armSpec.label)!.add(key);
              const f = feeR(open.entryPrice, r.exitPrice, risk);
              const fStress = feeR(open.entryPrice, r.exitPrice, risk, 5, 5);
              a.n++; a.sumG += r.grossR; a.sumFee += f; a.sumFeeStress += fStress;
              a.gs.push(r.grossR); a.seq.push(r.grossR); a.bars.push(r.barsHeld);
              if (r.exit === 'TP') a.nTp++;
              else if (r.exit === 'SL') a.nSl++; else a.nTo++;
              if (r.grossR > 0) { a.pos += r.grossR; a.nPos++; a.wins.push(r.grossR); }
              else { a.neg += -r.grossR; a.losses.push(r.grossR); }
              bump(a.byDir, open.direction, r.grossR);
              bump(a.byTf, b.timeframe, r.grossR);
              bump(a.bySym, b.symbol, r.grossR);
            }
            if (!anyResolved) unresolved++;
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
            const stopPrice = s.stop.price + shift;   // frozen 0.25 ATR buffer
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
  const sets = RR_ARMS.map((a) => entryKeys.get(a.label)!);
  const ref = sets[0]!;
  const identical = sets.every((s) =>
    s.size === ref.size && [...s].every((k) => ref.has(k)));

  const summarise = (label: string, mult: number): Record<string, unknown> => {
    const a = acc.get(label)!;
    const gross = a.n ? a.sumG / a.n : 0;
    const fee = a.n ? a.sumFee / a.n : 0;
    const feeStress = a.n ? a.sumFeeStress / a.n : 0;
    const sorted = a.gs.slice().sort((x, y) => y - x);
    const drop = (k: number): number => {
      const rest = sorted.slice(Math.min(k, sorted.length));
      return rest.length ? rest.reduce((p, q) => p + q, 0) / rest.length : 0;
    };
    const k1 = Math.max(1, Math.ceil(sorted.length * 0.01));
    const netFee = (f: number): number => gross - f;
    return {
      arm: label, rrMultiple: mult, n: a.n,
      winRatePct: a.n ? +((a.nTp / a.n) * 100).toFixed(2) : 0,
      positiveRRatePct: a.n ? +((a.nPos / a.n) * 100).toFixed(2) : 0,
      grossRPerTrade: +gross.toFixed(4),
      feeRPerTrade: +fee.toFixed(4),
      netRPerTrade: +netFee(fee).toFixed(4),
      netRPerSetup: +((a.sumG - a.sumFee) / (sniperEntries || 1)).toFixed(4),
      netRPerTradeStress55: +netFee(feeStress).toFixed(4),
      grossTotalR: +a.sumG.toFixed(2),
      grossPF: a.neg > 0 ? +(a.pos / a.neg).toFixed(4) : null,
      grossMedianR: +med(a.gs).toFixed(4),
      avgWinR: a.wins.length
        ? +(a.wins.reduce((p, q) => p + q, 0) / a.wins.length).toFixed(4) : 0,
      avgLossR: a.losses.length
        ? +(a.losses.reduce((p, q) => p + q, 0) / a.losses.length).toFixed(4) : 0,
      maxDrawdownR: +maxDD(a.seq).toFixed(2),
      medianBarsHeld: +med(a.bars).toFixed(2),
      exits: { TP: a.nTp, SL: a.nSl, TIMEOUT: a.nTo },
      outlierDependence: {
        grossExpectancy: +gross.toFixed(4),
        exTop1: +drop(1).toFixed(4), exTop5: +drop(5).toFixed(4),
        exTop1Pct: +drop(k1).toFixed(4), removedForTop1Pct: k1,
      },
      byDirection: sub(a.byDir), byTimeframe: sub(a.byTf), bySymbol: sub(a.bySym),
    };
  };

  const arms = RR_ARMS.map((a) => summarise(a.label, a.mult));
  const best = arms.reduce((p, c) =>
    (c['netRPerTrade'] as number) > (p['netRPerTrade'] as number) ? c : p);
  const feeDrags = arms.map((a) => a['feeRPerTrade'] as number);

  const out = {
    slice: 'train', scope: SCOPE,
    stopBufferAtr: settings.num('v2.stop_buffer_atr'),
    stopBufferNote: 'Frozen 0.25 ATR used, NOT the 0.05 ATR in the task brief. '
      + 'See pre-registration §0.1 — the same-entries-as-V2.6 requirement '
      + 'controls, and a tighter stop would inflate fee-in-R.',
    maxBars: MAX_BARS,
    maxBarsNote: 'Task specified 50; frozen outcome.timeout_bars is 48. '
      + 'Applied identically to all arms.',
    fees: { makerBps: MAKER_BPS, takerBps: TAKER_BPS },
    actionableSetups: actionable,
    sniperEntries,
    unresolvedAtBoundary: unresolved,
    sameEntryInvariant: {
      perArmEntryCounts: Object.fromEntries(
        RR_ARMS.map((a) => [a.label, entryKeys.get(a.label)!.size])),
      identicalAcrossArms: identical,
    },
    feeDragInvariance: {
      min: Math.min(...feeDrags), max: Math.max(...feeDrags),
      spread: +(Math.max(...feeDrags) - Math.min(...feeDrags)).toFixed(4),
      note: 'Pre-registration §1 predicted fee drag is independent of the TP '
        + 'level. A near-zero spread confirms it.',
    },
    best: { arm: best['arm'], netRPerTrade: best['netRPerTrade'],
      positive: (best['netRPerTrade'] as number) > 0 },
    arms,
  };
  writeFileSync(outFile, JSON.stringify(out, null, 2));

  /* ---- console table ---- */
  console.log('');
  console.log('| Arm  |   n | Win Rate % | Gross R/trade | Fee R/trade | Net R/trade | Net R/setup |');
  console.log('|------|-----|------------|---------------|-------------|-------------|-------------|');
  for (const a of arms) {
    console.log(`| ${String(a['arm']).padEnd(4)} | ${String(a['n']).padStart(3)} | `
      + `${String(a['winRatePct']).padStart(10)} | ${String(a['grossRPerTrade']).padStart(13)} | `
      + `${String(a['feeRPerTrade']).padStart(11)} | ${String(a['netRPerTrade']).padStart(11)} | `
      + `${String(a['netRPerSetup']).padStart(11)} |`);
  }
  console.log('');
  console.log(`BEST: ${best['arm']} at net ${best['netRPerTrade']} R/trade `
    + `(${(best['netRPerTrade'] as number) > 0 ? 'POSITIVE' : 'NEGATIVE'})`);
  console.log('wrote', outFile);
}

// Only run when executed directly. Importing this module (e.g. from tests to
// reuse `simulateFixedRr`/`feeR`) must not kick off a full replay.
const invokedDirectly = process.argv.some((a) => a.includes('v27_rr_test'));
if (invokedDirectly) void main();

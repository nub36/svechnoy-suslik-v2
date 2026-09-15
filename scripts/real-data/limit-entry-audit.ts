/**
 * STAGE 1 — STRUCTURAL ENTRY AUDIT (TRAIN only, descriptive).
 *
 * Re-evaluates V2 on TRAIN candles to recover the structural levels the replay
 * harness never persisted (orderBlock.high/low, fvg.top/bottom, displacement,
 * sweep.level, breakout.level). It does NOT change the strategy, does not
 * produce trades, and does not simulate any entry: it only measures, for each
 * confirmed directional setup, WHICH causal anchors exist at CLOSED N, where
 * they sit relative to the baseline OPEN N+1 fill, and whether they are on the
 * correct side for a LIMIT order.
 *
 * Causality: every level used here comes from the V2Setup produced at bar i
 * (CLOSED N). The only future information touched is candle N+1's OPEN, which
 * is the baseline entry the frozen engine already uses. No N+1 high/low, no
 * future pivot, no future FVG.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { Settings } from '../../src/core/settings';
import { evaluateV2 } from '../../src/strategy/v2';
import { HTF_MAP } from '../../src/strategy/v2/htf';
import { loadSeries, hasSeries } from './load';
import { resolveEntry } from '../../src/strategy/state-machine';
import { quantileSorted } from './audit-fee-readonly';
import type { Candle, Timeframe } from '../../src/core/types';
import { TF_MS } from '../../src/core/types';

const SYMBOLS = (process.env['LE_SYMS'] ?? 'BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT').split(',');
const TFS = (process.env['LE_TFS'] ?? '1m,5m,15m,30m,1h,4h,1d').split(',') as Timeframe[];
const WINDOW_MARGIN = 60;

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

/** One observation: a confirmed setup with its causal anchors. */
interface Obs {
  symbol: string; timeframe: Timeframe; direction: 'LONG' | 'SHORT';
  kind: string; baseEntry: number; atr: number; stop: number;
  // anchor -> [low, high] of the structural area, or null when unavailable
  areas: Record<string, [number, number] | null>;
}

const ANCHORS = ['OB_FVG_OVERLAP', 'OB', 'FVG', 'DISPLACEMENT_50', 'RETEST', 'SWEEP_RECLAIM'];

async function main(): Promise<void> {
  const cache = arg('cache');
  const outFile = arg('out');
  // Per-series split boundaries from the FROZEN splits.json — never a single
  // global cutoff, because each timeframe has its own calendar boundary.
  const splitsDoc = JSON.parse(
    readFileSync(arg('splits'), 'utf8'),
  ) as { splits: { symbol: string; timeframe: string; trainToMs: number }[] };
  const trainTo = new Map<string, number>();
  for (const sp of splitsDoc.splits) trainTo.set(`${sp.symbol}|${sp.timeframe}`, sp.trainToMs);
  const settings = Settings.fromDefaults();
  const swing = Math.floor(settings.num('engine.swing_lookback'));
  const lookback = Math.floor(settings.num('engine.lookback_candles'));
  const minBars = Math.max(80, swing * 6 + 40);
  const winLen = lookback + WINDOW_MARGIN;

  /**
   * STREAMING AGGREGATION.
   *
   * Retaining every observation exhausted the heap (OOM at ~3.4M setups), so
   * nothing is stored per-setup. Distances are summarised with a bounded
   * reservoir; everything else is a counter.
   */
  interface Agg {
    n: number;
    exists: Record<string, number>;
    usable: Record<string, number>;
    distAtr: Record<string, number[]>;   // reservoir
    distPct: Record<string, number[]>;   // reservoir
    widthAtr: Record<string, number[]>;  // reservoir
    anyUsable: number;
  }
  const RES = 20000;
  const mkAgg = (): Agg => ({
    n: 0,
    exists: Object.fromEntries(ANCHORS.map((a) => [a, 0])),
    usable: Object.fromEntries(ANCHORS.map((a) => [a, 0])),
    distAtr: Object.fromEntries(ANCHORS.map((a) => [a, [] as number[]])),
    distPct: Object.fromEntries(ANCHORS.map((a) => [a, [] as number[]])),
    widthAtr: Object.fromEntries(ANCHORS.map((a) => [a, [] as number[]])),
    anyUsable: 0,
  });
  const push = (arr: number[], v: number, seen: number): void => {
    if (arr.length < RES) arr.push(v);
    else { const j = Math.floor(Math.random() * seen); if (j < RES) arr[j] = v; }
  };
  const global = mkAgg();
  const byDir = new Map<string, Agg>();
  const byKind = new Map<string, Agg>();
  const byTf = new Map<string, Agg>();
  const get = (m: Map<string, Agg>, k: string): Agg => {
    let a = m.get(k); if (!a) { a = mkAgg(); m.set(k, a); } return a;
  };
  let totalObs = 0;

  for (const symbol of SYMBOLS) {
    for (const timeframe of TFS) {
      if (!hasSeries(cache, symbol, timeframe)) continue;
      const cutoff = trainTo.get(`${symbol}|${timeframe}`);
      if (cutoff === undefined) continue;
      const all = loadSeries(cache, symbol, timeframe);
      const closed = all.filter((c) => c.isClosed);
      const htf: Partial<Record<Timeframe, readonly Candle[]>> = {};
      for (const h of HTF_MAP[timeframe] ?? []) {
        if (hasSeries(cache, symbol, h)) htf[h] = loadSeries(cache, symbol, h);
      }

      for (let i = minBars; i < closed.length; i++) {
        const bar = closed[i]!;
        if (bar.openTime > cutoff) break; // TRAIN ONLY (per-series boundary)
        const visible = closed.slice(Math.max(0, i + 1 - winLen), i + 1);

        // Binary search, mirroring windowed-replay's htfUpperBound. A backward
        // linear scan from the end is O(n) PER BAR and made this script ~50x
        // slower than the original replay on 1m series.
        const bounded: Partial<Record<Timeframe, readonly Candle[]>> = {};
        const asOf = bar.closeTime;
        for (const h of HTF_MAP[timeframe] ?? []) {
          const hc = htf[h]; if (!hc || hc.length === 0) continue;
          const span = TF_MS[h];
          let lo = 0, hi = hc.length - 1, ub = -1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (hc[mid]!.openTime + span <= asOf) { ub = mid; lo = mid + 1; }
            else hi = mid - 1;
          }
          if (ub >= 0) bounded[h] = hc.slice(Math.max(0, ub - 200 + 1), ub + 1);
        }

        const s = evaluateV2({
          symbol, timeframe, candles: visible, settings, htfCandles: bounded,
        });
        if (s.direction === 'WAIT' || s.stop === null || s.entry === null) continue;

        const next = closed[i + 1];
        const ent = resolveEntry(bar.openTime, TF_MS[timeframe], next);
        if (!ent) continue;

        const atr = s.atr.atr;
        if (!atr || atr <= 0) continue;

        const dir = s.direction;
        const areas: Record<string, [number, number] | null> = {};

        const ob = s.orderBlock && s.orderBlock.state !== 'INVALIDATED'
          && s.orderBlock.direction === dir
          ? [s.orderBlock.low, s.orderBlock.high] as [number, number] : null;
        const fv = s.fvg && s.fvg.state !== 'FILLED' && s.fvg.direction === dir
          ? [s.fvg.bottom, s.fvg.top] as [number, number] : null;

        areas['OB'] = ob;
        areas['FVG'] = fv;
        // overlap only when the two genuinely intersect
        if (ob && fv) {
          const lo = Math.max(ob[0], fv[0]), hi = Math.min(ob[1], fv[1]);
          areas['OB_FVG_OVERLAP'] = hi > lo ? [lo, hi] : null;
        } else areas['OB_FVG_OVERLAP'] = null;

        // 50% of the displacement candle body
        if (s.displacement && s.displacement.direction === dir) {
          const dc = visible[s.displacement.index - (i + 1 - visible.length)];
          if (dc) {
            const lo = Math.min(dc.open, dc.close), hi = Math.max(dc.open, dc.close);
            const mid = (lo + hi) / 2;
            areas['DISPLACEMENT_50'] = [Math.min(mid, hi), Math.max(mid, hi)];
            // band from midpoint toward the body extreme in the retrace direction
            areas['DISPLACEMENT_50'] = dir === 'LONG' ? [lo, mid] : [mid, hi];
          } else areas['DISPLACEMENT_50'] = null;
        } else areas['DISPLACEMENT_50'] = null;

        // broken level retest: a band of +/-0.25 ATR around the level
        areas['RETEST'] = s.breakout && s.breakout.direction === dir
          ? [s.breakout.level - 0.25 * atr, s.breakout.level + 0.25 * atr] : null;
        // sweep reclaim: band between the swept level and 0.5 ATR back inside
        areas['SWEEP_RECLAIM'] = s.sweep && s.sweep.direction === dir
          ? (dir === 'LONG'
            ? [s.sweep.level, s.sweep.level + 0.5 * atr]
            : [s.sweep.level - 0.5 * atr, s.sweep.level])
          : null;

        const o: Obs = {
          symbol, timeframe, direction: dir, kind: s.kind ?? 'NA',
          baseEntry: ent.entryPrice, atr, stop: s.stop.price, areas,
        };
        totalObs++;

        const targets = [global, get(byDir, dir), get(byKind, o.kind), get(byTf, timeframe)];
        for (const t of targets) t.n++;
        let any = false;
        for (const a of ANCHORS) {
          const ar = areas[a];
          if (!ar) continue;
          for (const t of targets) t.exists[a] = (t.exists[a] ?? 0) + 1;
          const ok = dir === 'LONG' ? ar[1] < o.baseEntry : ar[0] > o.baseEntry;
          if (!ok) continue;
          any = true;
          const edge = dir === 'LONG' ? ar[1] : ar[0];
          const d = Math.abs(o.baseEntry - edge);
          for (const t of targets) {
            t.usable[a] = (t.usable[a] ?? 0) + 1;
            push(t.distAtr[a]!, d / atr, t.usable[a]!);
            push(t.distPct[a]!, (d / o.baseEntry) * 100, t.usable[a]!);
            push(t.widthAtr[a]!, (ar[1] - ar[0]) / atr, t.usable[a]!);
          }
        }
        if (any) for (const t of targets) t.anyUsable++;
      }
    }
    console.error(`  ${symbol}: cumulative observations = ${totalObs}`);
  }

  /* ---------------- report ---------------- */
  const L: string[] = [];
  const say = (s = ''): void => { console.log(s); L.push(s); };
  const f4 = (x: number): string => Number.isFinite(x) ? x.toFixed(4) : 'n/a';
  const f2 = (x: number): string => Number.isFinite(x) ? x.toFixed(2) : 'n/a';
  const int = (x: number): string => x.toLocaleString('en-US');
  const med = (a: number[]): number => {
    if (!a.length) return NaN;
    const t = a.slice().sort((x, y) => x - y);
    return quantileSorted(t, .5);
  };

  say('# Structural entry audit — TRAIN');
  say('');
  say(`Confirmed directional setups examined: **${int(global.n)}**`);
  say('');
  say('Distance quantiles come from a bounded reservoir (20,000 samples per');
  say('anchor); counts and rates are exact.');
  say('');

  say('## Anchor availability and side-of-price validity');
  say('');
  say('| anchor | exists | share | correct side (usable for LIMIT) | share | median dist (ATR) | median dist (%) | median width (ATR) |');
  say('|---|---|---|---|---|---|---|---|');
  for (const a of ANCHORS) {
    const ex = global.exists[a] ?? 0, us = global.usable[a] ?? 0;
    say(`| ${a} | ${int(ex)} | ${f2((ex / global.n) * 100)}% | ${int(us)} | ` +
      `${f2((us / global.n) * 100)}% | ${f4(med(global.distAtr[a]!))} | ` +
      `${f4(med(global.distPct[a]!))}% | ${f4(med(global.widthAtr[a]!))} |`);
  }
  say('');

  const breakdown = (label: string, m: Map<string, Agg>): void => {
    say(`### Usable-for-LIMIT rate by ${label}`);
    say('');
    say(`| ${label} | n | ` + ANCHORS.join(' | ') + ' |');
    say('|---|---|' + ANCHORS.map(() => '---').join('|') + '|');
    for (const k of [...m.keys()].sort()) {
      const a = m.get(k)!;
      if (a.n < 50) continue;
      say(`| ${k} | ${int(a.n)} | ` +
        ANCHORS.map((an) => `${f2(((a.usable[an] ?? 0) / a.n) * 100)}%`).join(' | ') + ' |');
    }
    say('');
  };
  breakdown('direction', byDir);
  breakdown('setup kind', byKind);
  breakdown('timeframe', byTf);

  say('## Any usable anchor at all');
  say('');
  say(`Setups with at least one correct-side structural area: **${int(global.anyUsable)}** ` +
    `(${f2((global.anyUsable / global.n) * 100)}% of confirmed setups)`);
  say('');

  writeFileSync(outFile, L.join('\n') + '\n');
  writeFileSync(outFile.replace(/\.md$/, '.json'), JSON.stringify({
    observations: global.n,
    anchors: Object.fromEntries(ANCHORS.map((a) => [a, {
      exists: global.exists[a], usable: global.usable[a],
      medianDistAtr: med(global.distAtr[a]!),
      medianDistPct: med(global.distPct[a]!),
      medianWidthAtr: med(global.widthAtr[a]!),
    }])),
    anyUsable: global.anyUsable,
    byTimeframe: Object.fromEntries([...byTf].map(([k, v]) => [k, {
      n: v.n, usable: v.usable, anyUsable: v.anyUsable,
    }])),
  }, null, 2));
  console.error('wrote', outFile);
}

void main();

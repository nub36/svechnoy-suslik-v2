/**
 * V2.1 RESEARCH ANALYSIS — TRAIN + VALIDATION ONLY.
 *
 * ===========================================================================
 * WHAT THIS DOES AND DOES NOT DO
 * ===========================================================================
 * - It NEVER reads, aggregates, or reports a `test` row. Every loop filters to
 *   slice === 'train' || slice === 'validation'. The 2022-2025 TEST split is
 *   USED and is out of bounds for hypothesis generation.
 * - It NEVER calls evaluateV2, the state machine, or trackOutcome. No signal is
 *   regenerated and no decision is recomputed.
 * - Sections 6/7/8 need forward price paths, which are not in the trade rows.
 *   Those are read from the candle CACHE and measured with pure arithmetic on
 *   OHLC (max high / min low after entry). Measuring what price did after an
 *   already-fixed entry is not a replay: no setup is re-evaluated, no entry is
 *   re-chosen, no stop or target is recomputed.
 * - Gross R is reconstructed with the verified identity grossR = netR + feeR,
 *   feeR = (fee_pct/100) * entry / |entry - stop|, fee_pct = 0.1 frozen.
 *
 * LIMITATION recorded for section 5: the harness never persisted the
 * per-component evidence profile (longProfile/shortProfile exist on the V2
 * decision but were not written to the artifacts). Component-level Spearman is
 * therefore NOT computable from saved data, and this script does not run a
 * replay to obtain it. It instead analyses the categorical OBSERVABLES that
 * were saved, each of which proxies one component, and labels them as proxies.
 */

import { writeFileSync } from 'node:fs';
import { streamTrades, spearman, quantileSorted, type AuditTrade }
  from './audit-fee-readonly';
import { loadSeries, hasSeries } from './load';
import type { Candle, Timeframe } from '../../src/core/types';

const TFS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const SLICES = ['train', 'validation'] as const;
const BPS = [2, 5, 10, 20];

const f4 = (x: number): string =>
  Number.isFinite(x) ? x.toFixed(4) : (x > 0 ? 'Inf' : 'n/a');
const f2 = (x: number): string =>
  Number.isFinite(x) ? x.toFixed(2) : (x > 0 ? 'Inf' : 'n/a');
const int = (x: number): string => x.toLocaleString('en-US');

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

/* ------------------------------------------------------------------ */
/* Bucket definitions — FIXED IN ADVANCE, not searched                 */
/* ------------------------------------------------------------------ */
const ATR_BUCKETS: [string, number, number][] = [
  ['<0.5', -Infinity, 0.5], ['0.5-0.75', 0.5, 0.75], ['0.75-1.0', 0.75, 1.0],
  ['1.0-1.5', 1.0, 1.5], ['1.5-2.0', 1.5, 2.0], ['>2.0', 2.0, Infinity],
];
const PCT_BUCKETS: [string, number, number][] = [
  ['<0.10%', -Infinity, 0.10], ['0.10-0.20%', 0.10, 0.20],
  ['0.20-0.30%', 0.20, 0.30], ['0.30-0.50%', 0.30, 0.50],
  ['0.50-1.00%', 0.50, 1.00], ['>1.00%', 1.00, Infinity],
];
const bucketOf = (v: number, bs: [string, number, number][]): string => {
  for (const [l, lo, hi] of bs) if (v >= lo && v < hi) return l;
  return bs[bs.length - 1]![0];
};

/** Accumulator over GROSS R plus fee-sensitivity terms. */
class G {
  n = 0; sumG = 0; pos = 0; neg = 0; nPos = 0;
  nTp = 0; nTo = 0; sumInv = 0;
  gs: number[] = []; atr: number[] = []; pct: number[] = [];
  add(t: AuditTrade, riskAtr: number): void {
    this.n++; this.sumG += t.grossR;
    if (t.grossR > 0) { this.pos += t.grossR; this.nPos++; } else this.neg += -t.grossR;
    if (t.result === 'TP') this.nTp++;
    if (t.result === 'TIMEOUT') this.nTo++;
    this.sumInv += t.riskPerUnit > 0 ? t.entryPrice / t.riskPerUnit : 0;
    this.gs.push(t.grossR);
    if (Number.isFinite(riskAtr)) this.atr.push(riskAtr);
    this.pct.push(t.riskPercent);
  }
  get exp(): number { return this.n ? this.sumG / this.n : 0; }
  get pf(): number { return this.neg > 0 ? this.pos / this.neg : (this.pos > 0 ? Infinity : 0); }
  get posRate(): number { return this.n ? (this.nPos / this.n) * 100 : 0; }
  get tpRate(): number { return this.n ? (this.nTp / this.n) * 100 : 0; }
  get toRate(): number { return this.n ? (this.nTo / this.n) * 100 : 0; }
  med(): number { const s = this.gs.slice().sort((a, b) => a - b); return quantileSorted(s, .5); }
  medAtr(): number { const s = this.atr.slice().sort((a, b) => a - b); return quantileSorted(s, .5); }
  medPct(): number { const s = this.pct.slice().sort((a, b) => a - b); return quantileSorted(s, .5); }
  /** expectancy at B bps round-trip: gross - (B/1e4)*mean(entry/risk) */
  at(b: number): number { return this.n ? this.exp - (b / 10000) * (this.sumInv / this.n) : 0; }
}

type Row = AuditTrade & {
  riskAtr: number; atrAtSetup: number; setupKind: string; htf: string;
  location: string; entryCandleTime: number; takeProfits: number[];
  tp1Source: string; finalTargetR: number; roomR: number;
  adxRegime: string; rsiBucket: string; emaAlignment: string; macdState: string;
  rvolBucket: string; fibZone: string; hasOb: boolean; hasFvg: boolean;
  sweepQuality: number | null; breakoutQuality: number | null; stopAnchor: string;
};

async function main(): Promise<void> {
  const v2File = arg('v2');
  const cache = arg('cache');
  const outFile = arg('out');
  const L: string[] = [];
  const say = (s = ''): void => { console.log(s); L.push(s); };

  /* ---------------- load TRAIN+VALIDATION rows ---------------- */
  const rows: Row[] = [];
  for await (const t of streamTrades(v2File)) {
    if (t.result === 'OPEN') continue;
    if (t.slice !== 'train' && t.slice !== 'validation') continue; // TEST EXCLUDED
    rows.push(t as Row);
  }
  // re-read raw for the extra fields streamTrades drops
  const { createReadStream } = await import('node:fs');
  const { createInterface } = await import('node:readline');
  const rl = createInterface({
    input: createReadStream(v2File, { encoding: 'utf8' }), crlfDelay: Infinity,
  });
  let i = 0;
  for await (const line of rl) {
    if (line.trim() === '') continue;
    const o = JSON.parse(line) as Record<string, unknown>;
    if (o['result'] === 'OPEN') continue;
    if (o['slice'] !== 'train' && o['slice'] !== 'validation') continue;
    const r = rows[i++]!;
    r.riskAtr = o['riskAtr'] as number;
    r.atrAtSetup = o['atrAtSetup'] as number;
    r.setupKind = (o['setupKind'] as string) ?? 'NA';
    r.htf = (o['htfAlignment'] as string) ?? 'UNKNOWN';
    r.location = (o['location'] as string) ?? 'NA';
    r.entryCandleTime = o['entryCandleTime'] as number;
    r.takeProfits = (o['takeProfits'] as number[]) ?? [];
    r.tp1Source = (o['tp1Source'] as string) ?? 'NA';
    r.finalTargetR = (o['finalTargetR'] as number) ?? 0;
    r.roomR = (o['roomR'] as number) ?? 0;
    r.adxRegime = (o['adxRegime'] as string) ?? 'NA';
    r.rsiBucket = (o['rsiBucket'] as string) ?? 'NA';
    r.emaAlignment = (o['emaAlignment'] as string) ?? 'NA';
    r.macdState = (o['macdState'] as string) ?? 'NA';
    r.rvolBucket = (o['rvolBucket'] as string) ?? 'NA';
    r.fibZone = (o['fibZone'] as string) ?? 'NA';
    r.hasOb = (o['hasOb'] as boolean) ?? false;
    r.hasFvg = (o['hasFvg'] as boolean) ?? false;
    r.sweepQuality = (o['sweepQuality'] as number | null) ?? null;
    r.breakoutQuality = (o['breakoutQuality'] as number | null) ?? null;
    r.stopAnchor = (o['stopAnchor'] as string) ?? 'NA';
  }
  say(`TRAIN+VALIDATION V2 closed trades loaded: **${int(rows.length)}** (TEST rows excluded by construction)`);
  say('');

  const bySlice = (s: string): Row[] => rows.filter((r) => r.slice === s);

  const table = (
    title: string, hdr: string[], groups: [string, Row[]][],
    extra?: (g: G) => string[],
  ): void => {
    say(`**${title}**`); say('');
    say('| group | n | gross exp | gross med R | gross PF | posR% | TP% | TIMEOUT% |' +
      (extra ? ' ' + hdr.join(' | ') + ' |' : ''));
    say('|---|---|---|---|---|---|---|---|' + (extra ? hdr.map(() => '---').join('|') + '|' : ''));
    for (const [name, rs] of groups) {
      if (rs.length === 0) continue;
      const g = new G(); for (const r of rs) g.add(r, r.riskAtr);
      say(`| ${name} | ${int(g.n)} | ${f4(g.exp)} | ${f4(g.med())} | ${f4(g.pf)} | ` +
        `${f2(g.posRate)} | ${f2(g.tpRate)} | ${f2(g.toRate)} |` +
        (extra ? ' ' + extra(g).join(' | ') + ' |' : ''));
    }
    say('');
  };

  const feeCols = (g: G): string[] => BPS.map((b) => f4(g.at(b)));

  /* =================== §1 STOP GEOMETRY =================== */
  say('## §1. STOP GEOMETRY (V2, TRAIN and VALIDATION)');
  say('');
  say('Buckets fixed in advance. Fee columns are analytic: `exp(B) = grossExp - (B/1e4) * mean(entry/riskPerUnit)`.');
  say('');
  for (const s of SLICES) {
    const rs = bySlice(s);
    table(`${s.toUpperCase()} — risk distance in ATR`,
      BPS.map((b) => `${b}bps`),
      ATR_BUCKETS.map(([l]) => [l, rs.filter((r) => bucketOf(r.riskAtr, ATR_BUCKETS) === l)] as [string, Row[]]),
      feeCols);
    table(`${s.toUpperCase()} — risk distance in % of price`,
      BPS.map((b) => `${b}bps`),
      PCT_BUCKETS.map(([l]) => [l, rs.filter((r) => bucketOf(r.riskPercent, PCT_BUCKETS) === l)] as [string, Row[]]),
      feeCols);
  }

  /* =================== §2 SETUP TYPE =================== */
  say('## §2. SETUP TYPE x DIRECTION');
  say('');
  for (const s of SLICES) {
    const rs = bySlice(s);
    const combos: [string, Row[]][] = [];
    for (const k of ['REVERSAL', 'CONTINUATION']) {
      for (const d of ['LONG', 'SHORT']) {
        combos.push([`${k} ${d}`, rs.filter((r) => r.setupKind === k && r.direction === d)]);
      }
    }
    say(`**${s.toUpperCase()}**`); say('');
    say('| group | n | gross exp | med gross R | gross PF | posR% | TP% | TO% | med stop ATR | med stop % | ' +
      BPS.map((b) => `${b}bps`).join(' | ') + ' |');
    say('|---|---|---|---|---|---|---|---|---|---|' + BPS.map(() => '---').join('|') + '|');
    for (const [name, g0] of combos) {
      if (!g0.length) continue;
      const g = new G(); for (const r of g0) g.add(r, r.riskAtr);
      say(`| ${name} | ${int(g.n)} | ${f4(g.exp)} | ${f4(g.med())} | ${f4(g.pf)} | ${f2(g.posRate)} | ` +
        `${f2(g.tpRate)} | ${f2(g.toRate)} | ${f4(g.medAtr())} | ${f4(g.medPct())}% | ${feeCols(g).join(' | ')} |`);
    }
    say('');
  }

  /* =================== §3 TIMEFRAME x SETUP =================== */
  say('## §3. TIMEFRAME x SETUP');
  say('');
  for (const s of SLICES) {
    say(`**${s.toUpperCase()}**`); say('');
    say('| tf | REVERSAL n | REV gross exp | REV PF | CONT n | CONT gross exp | CONT PF |');
    say('|---|---|---|---|---|---|---|');
    const rs = bySlice(s);
    for (const tf of TFS) {
      const mk = (k: string): G => {
        const g = new G();
        for (const r of rs) if (r.timeframe === tf && r.setupKind === k) g.add(r, r.riskAtr);
        return g;
      };
      const rev = mk('REVERSAL'), con = mk('CONTINUATION');
      if (rev.n + con.n === 0) continue;
      say(`| ${tf} | ${int(rev.n)} | ${f4(rev.exp)} | ${f4(rev.pf)} | ${int(con.n)} | ${f4(con.exp)} | ${f4(con.pf)} |`);
    }
    say('');
  }

  /* =================== §4 HTF CONTEXT =================== */
  say('## §4. HTF CONTEXT');
  say('');
  for (const s of SLICES) {
    const rs = bySlice(s);
    table(`${s.toUpperCase()} — HTF state`, [],
      ['ALIGNED', 'COUNTER_TREND', 'NEUTRAL', 'UNKNOWN']
        .map((h) => [h, rs.filter((r) => r.htf === h)] as [string, Row[]]));
    for (const k of ['REVERSAL', 'CONTINUATION']) {
      table(`${s.toUpperCase()} — ${k} x HTF`, [],
        ['ALIGNED', 'COUNTER_TREND', 'NEUTRAL', 'UNKNOWN']
          .map((h) => [`${k} / ${h}`, rs.filter((r) => r.setupKind === k && r.htf === h)] as [string, Row[]]));
    }
  }

  /* =================== §5 EVIDENCE PROXIES =================== */
  say('## §5. EVIDENCE COMPONENTS — LIMITATION + OBSERVABLE PROXIES');
  say('');
  say('> **Limitation.** The replay harness never persisted the per-component evidence');
  say('> profile. `ComponentProfile` (structure, liquidity, displacement, obFvg, volume,');
  say('> htf, trend, momentum, volatility, roomToTarget) exists on the V2 decision as');
  say('> `longProfile`/`shortProfile`, but `v2-trades.jsonl` stores only the aggregates');
  say('> `evidence`, `conflict`, `netEvidence`. Component-level Spearman is therefore');
  say('> **not computable from saved artifacts**, and no replay was run to obtain it.');
  say('> The table below uses the categorical observables that WERE saved. Each proxies');
  say('> one component; they are proxies, not the component scores themselves.');
  say('');
  const proxies: [string, string, (r: Row) => string | null][] = [
    ['liquidity', 'sweepQuality', (r) => r.sweepQuality == null ? 'none'
      : r.sweepQuality < 0.4 ? '<0.4' : r.sweepQuality < 0.7 ? '0.4-0.7' : '>=0.7'],
    ['displacement', 'breakoutQuality', (r) => r.breakoutQuality == null ? 'none'
      : r.breakoutQuality < 0.4 ? '<0.4' : r.breakoutQuality < 0.7 ? '0.4-0.7' : '>=0.7'],
    ['obFvg', 'hasOb/hasFvg', (r) => `ob=${r.hasOb ? 'Y' : 'N'} fvg=${r.hasFvg ? 'Y' : 'N'}`],
    ['volume', 'rvolBucket', (r) => r.rvolBucket],
    ['htf', 'htfAlignment', (r) => r.htf],
    ['trend', 'emaAlignment', (r) => r.emaAlignment],
    ['momentum', 'macdState', (r) => r.macdState],
    ['momentum', 'rsiBucket', (r) => r.rsiBucket],
    ['volatility', 'adxRegime', (r) => r.adxRegime],
    ['roomToTarget', 'roomR (bucketed)', (r) => {
      // roomR is CONTINUOUS (~215k distinct values in TRAIN+VALIDATION), not
      // categorical. It must be bucketed or the group-by explodes.
      const v = r.roomR;
      if (!Number.isFinite(v)) return null;
      return v < 2 ? '<2' : v < 3 ? '2-3' : v < 5 ? '3-5'
        : v < 8 ? '5-8' : v < 15 ? '8-15' : '>=15';
    }],
    ['structure', 'stopAnchor', (r) => r.stopAnchor],
    ['location', 'fibZone', (r) => r.fibZone],
  ];
  for (const s of SLICES) {
    say(`### ${s.toUpperCase()}`); say('');
    const rs = bySlice(s);
    for (const [comp, field, fn] of proxies) {
      // Single pass: value -> accumulator. The previous form rescanned all
      // rows once per distinct key, which is O(distinctKeys * n) and hangs on
      // any continuous field.
      const acc = new Map<string, G>();
      for (const r of rs) {
        const k = fn(r);
        if (k === null) continue;
        let g = acc.get(k);
        if (!g) { g = new G(); acc.set(k, g); }
        g.add(r, r.riskAtr);
      }
      if (acc.size < 2 || acc.size > 40) continue;
      say(`*${comp}* via \`${field}\``); say('');
      say('| value | n | gross exp | gross PF | posR% |');
      say('|---|---|---|---|---|');
      for (const k of [...acc.keys()].sort()) {
        const g = acc.get(k)!;
        if (g.n < 30) continue;
        say(`| ${k} | ${int(g.n)} | ${f4(g.exp)} | ${f4(g.pf)} | ${f2(g.posRate)} |`);
      }
      say('');
    }
    // numeric Spearman where a continuous proxy exists
    const sw = rs.filter((r) => r.sweepQuality != null);
    const bq = rs.filter((r) => r.breakoutQuality != null);
    say('Spearman vs GROSS R (continuous proxies only):');
    say('');
    say(`- sweepQuality (liquidity): **${f4(spearman(sw.map((r) => r.sweepQuality!), sw.map((r) => r.grossR)))}** (n=${int(sw.length)})`);
    say(`- breakoutQuality (displacement): **${f4(spearman(bq.map((r) => r.breakoutQuality!), bq.map((r) => r.grossR)))}** (n=${int(bq.length)})`);
    say(`- roomR (room-to-target): **${f4(spearman(rs.map((r) => r.roomR), rs.map((r) => r.grossR)))}** (n=${int(rs.length)})`);
    say(`- evidence (aggregate): **${f4(spearman(rs.map((r) => r.evidence ?? 0), rs.map((r) => r.grossR)))}**`);
    say(`- riskAtr: **${f4(spearman(rs.map((r) => r.riskAtr), rs.map((r) => r.grossR)))}**`);
    say('');
    for (const k of ['REVERSAL', 'CONTINUATION']) {
      const sub = rs.filter((r) => r.setupKind === k);
      const s2 = sub.filter((r) => r.sweepQuality != null);
      const b2 = sub.filter((r) => r.breakoutQuality != null);
      say(`  ${k}: evidence **${f4(spearman(sub.map((r) => r.evidence ?? 0), sub.map((r) => r.grossR)))}** ` +
        `| sweepQuality **${s2.length > 30 ? f4(spearman(s2.map((r) => r.sweepQuality!), s2.map((r) => r.grossR))) : 'n/a'}** ` +
        `| breakoutQuality **${b2.length > 30 ? f4(spearman(b2.map((r) => r.breakoutQuality!), b2.map((r) => r.grossR))) : 'n/a'}** (n=${int(sub.length)})`);
    }
    say('');
  }

  /* =================== §6/§7/§8 price-path measures =================== */
  say('## §6-8. PRICE-PATH MEASURES (MFE / MAE / excursion / target reach)');
  say('');
  say('Computed from the candle cache by pure OHLC arithmetic on already-fixed entries.');
  say('No signal was regenerated and no target/stop was recomputed.');
  say('');

  interface PathAgg {
    n: number; mfe: number[]; mae: number[];
    exc: Record<number, number[]>; excAtr: Record<number, number[]>;
  }
  const mkPath = (): PathAgg => ({ n: 0, mfe: [], mae: [], exc: { 1: [], 3: [], 5: [], 10: [] }, excAtr: { 1: [], 3: [], 5: [], 10: [] } });
  const pathBy = new Map<string, PathAgg>();
  const getP = (k: string): PathAgg => {
    let a = pathBy.get(k); if (!a) { a = mkPath(); pathBy.set(k, a); } return a;
  };
  // target reach: per tp1Source
  interface Reach { n: number; reached: number; bars: number[]; gross: number[] }
  const reachBy = new Map<string, Reach>();
  const getR = (k: string): Reach => {
    let a = reachBy.get(k); if (!a) { a = { n: 0, reached: 0, bars: [], gross: [] }; reachBy.set(k, a); } return a;
  };

  // group trades by series so each series is loaded once
  const bySeries = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.symbol}|${r.timeframe}`;
    const a = bySeries.get(k) ?? []; a.push(r); bySeries.set(k, a);
  }

  for (const [key, trades] of bySeries) {
    const [sym, tf] = key.split('|') as [string, Timeframe];
    if (!hasSeries(cache, sym, tf)) continue;
    const candles: Candle[] = loadSeries(cache, sym, tf);
    const idx = new Map<number, number>();
    for (let j = 0; j < candles.length; j++) idx.set(candles[j]!.openTime, j);

    for (const t of trades) {
      const start = idx.get(t.entryCandleTime);
      if (start === undefined) continue;
      const risk = t.riskPerUnit; if (!(risk > 0)) continue;
      const atr = t.atrAtSetup > 0 ? t.atrAtSetup : NaN;
      const long = t.direction === 'LONG';
      const held = Math.max(1, t.barsHeld);

      let bestFav = -Infinity, worstAdv = Infinity;
      const marks: Record<number, number> = {};
      for (let b = 0; b < held && start + b < candles.length; b++) {
        const c = candles[start + b]!;
        const fav = long ? c.high - t.entryPrice : t.entryPrice - c.low;
        const adv = long ? c.low - t.entryPrice : t.entryPrice - c.high;
        if (fav > bestFav) bestFav = fav;
        if (adv < worstAdv) worstAdv = adv;
        const bi = b + 1;
        if (bi === 1 || bi === 3 || bi === 5 || bi === 10) {
          marks[bi] = long ? c.close - t.entryPrice : t.entryPrice - c.close;
        }
      }
      if (!Number.isFinite(bestFav)) continue;

      for (const k of [`ALL`, `kind:${t.setupKind}`, `tf:${t.timeframe}`, `slice:${t.slice}`]) {
        const a = getP(k);
        a.n++; a.mfe.push(bestFav / risk); a.mae.push(worstAdv / risk);
        for (const bi of [1, 3, 5, 10]) {
          const m = marks[bi];
          if (m !== undefined) {
            a.exc[bi]!.push(m / risk);
            if (Number.isFinite(atr)) a.excAtr[bi]!.push(m / atr);
          }
        }
      }

      // §8 TP1 reach by source
      const tp1 = t.takeProfits[0];
      if (tp1 !== undefined) {
        const rr = getR(t.tp1Source);
        rr.n++; rr.gross.push(t.grossR);
        for (let b = 0; b < held && start + b < candles.length; b++) {
          const c = candles[start + b]!;
          const hit = long ? c.high >= tp1 : c.low <= tp1;
          if (hit) { rr.reached++; rr.bars.push(b + 1); break; }
        }
      }
    }
  }

  const med = (a: number[]): number => {
    if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return quantileSorted(s, .5);
  };
  const mean = (a: number[]): number => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

  say('### §6. MFE / MAE in R (to exit)');
  say('');
  say('| group | n | mean MFE R | median MFE R | mean MAE R | median MAE R |');
  say('|---|---|---|---|---|---|');
  const pkeys = ['ALL', 'slice:train', 'slice:validation', 'kind:REVERSAL', 'kind:CONTINUATION',
    ...TFS.map((t) => `tf:${t}`)];
  for (const k of pkeys) {
    const a = pathBy.get(k); if (!a || a.n === 0) continue;
    say(`| ${k} | ${int(a.n)} | ${f4(mean(a.mfe))} | ${f4(med(a.mfe))} | ${f4(mean(a.mae))} | ${f4(med(a.mae))} |`);
  }
  say('');

  say('### §7. Directional excursion after entry (close-based)');
  say('');
  say('| group | n | 1 bar R | 3 bars R | 5 bars R | 10 bars R | 1 bar ATR | 3 ATR | 5 ATR | 10 ATR |');
  say('|---|---|---|---|---|---|---|---|---|---|');
  for (const k of pkeys) {
    const a = pathBy.get(k); if (!a || a.n === 0) continue;
    say(`| ${k} | ${int(a.n)} | ` +
      [1, 3, 5, 10].map((b) => f4(mean(a.exc[b]!))).join(' | ') + ' | ' +
      [1, 3, 5, 10].map((b) => f4(mean(a.excAtr[b]!))).join(' | ') + ' |');
  }
  say('');

  say('### §8. TP1 target source quality');
  say('');
  say('| tp1Source | n | reach rate | median bars to reach | mean gross R | median gross R |');
  say('|---|---|---|---|---|---|');
  for (const [k, a] of [...reachBy].sort((x, y) => y[1].n - x[1].n)) {
    say(`| ${k} | ${int(a.n)} | ${f2((a.reached / a.n) * 100)}% | ${a.bars.length ? f2(med(a.bars)) : 'n/a'} | ` +
      `${f4(mean(a.gross))} | ${f4(med(a.gross))} |`);
  }
  say('');

  writeFileSync(outFile, L.join('\n') + '\n');
  console.log('\nwrote', outFile);
}

void main();

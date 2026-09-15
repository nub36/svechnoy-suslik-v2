/**
 * H1 driver. TRAIN first; VALIDATION only when --slice=validation is passed
 * explicitly, after the candidate has been registered.
 *
 * Reads saved trades + candle cache. Never calls the strategy.
 */

import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadSeries, hasSeries } from './load';
import { simulate, feeRFor, type ModelId, type TradeSpec, type ModelOutcome }
  from './h1-exit-models';
import { quantileSorted } from './audit-fee-readonly';
import type { Candle, Timeframe } from '../../src/core/types';

const MODELS: ModelId[] = ['A', 'B', 'C', 'D'];
const BPS = [0, 2, 5, 10, 20];
const TIMEOUT_BARS = 48;

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

interface Raw {
  symbol: string; timeframe: Timeframe; direction: 'LONG' | 'SHORT';
  entryPrice: number; stopLoss: number; takeProfits: number[];
  entryCandleTime: number; rMultiple: number; result: string;
  setupKind: string; slice: string;
}

class Stat {
  rs: number[] = [];
  nTp1 = 0; nTp1Neg = 0; tp1RSum = 0;
  giveback: number[] = [];
  nTimeout = 0;
  resCount = new Map<string, number>();
  add(r: number, o: ModelOutcome, mfeAtTp1: number | null): void {
    this.rs.push(r);
    if (o.reachedTp1) {
      this.nTp1++; this.tp1RSum += r;
      if (r < 0) this.nTp1Neg++;
      if (mfeAtTp1 !== null) this.giveback.push(Math.max(0, mfeAtTp1 - r));
    }
    if (o.result.includes('TIMEOUT')) this.nTimeout++;
    this.resCount.set(o.result, (this.resCount.get(o.result) ?? 0) + 1);
  }
  get n(): number { return this.rs.length; }
  get sum(): number { return this.rs.reduce((a, b) => a + b, 0); }
  get exp(): number { return this.n ? this.sum / this.n : 0; }
  get med(): number { const s = this.rs.slice().sort((a, b) => a - b); return quantileSorted(s, .5); }
  get pf(): number {
    let p = 0, l = 0;
    for (const r of this.rs) { if (r > 0) p += r; else l += -r; }
    return l > 0 ? p / l : (p > 0 ? Infinity : 0);
  }
  get posRate(): number {
    return this.n ? (this.rs.filter((r) => r > 0).length / this.n) * 100 : 0;
  }
  /** max drawdown in R over the trade sequence (chronological as stored) */
  get maxDD(): number {
    let peak = 0, eq = 0, dd = 0;
    for (const r of this.rs) {
      eq += r; if (eq > peak) peak = eq;
      const d = eq - peak; if (d < dd) dd = d;
    }
    return dd;
  }
  get timeoutRate(): number { return this.n ? (this.nTimeout / this.n) * 100 : 0; }
}

async function main(): Promise<void> {
  const tradesFile = arg('trades');
  const cache = arg('cache');
  const wantSlice = arg('slice');
  const outFile = arg('out');
  const onlyModels = (arg('models', 'A,B,C,D').split(',') as ModelId[]);

  const L: string[] = [];
  const say = (s = ''): void => { console.log(s); L.push(s); };

  /* ---- load trades for the requested slice ---- */
  const bySeries = new Map<string, Raw[]>();
  let total = 0;
  const rl = createInterface({
    input: createReadStream(tradesFile, { encoding: 'utf8' }), crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    const d = JSON.parse(line) as Record<string, unknown>;
    if (d['slice'] !== wantSlice) continue;
    if (d['result'] === 'OPEN') continue;
    const r: Raw = {
      symbol: d['symbol'] as string, timeframe: d['timeframe'] as Timeframe,
      direction: d['direction'] as 'LONG' | 'SHORT',
      entryPrice: d['entryPrice'] as number, stopLoss: d['stopLoss'] as number,
      takeProfits: d['takeProfits'] as number[],
      entryCandleTime: d['entryCandleTime'] as number,
      rMultiple: d['rMultiple'] as number, result: d['result'] as string,
      setupKind: (d['setupKind'] as string) ?? 'NA', slice: d['slice'] as string,
    };
    const k = `${r.symbol}|${r.timeframe}`;
    const a = bySeries.get(k) ?? []; a.push(r); bySeries.set(k, a);
    total++;
  }
  say(`## Slice: \`${wantSlice}\` — ${int(total)} closed V2 trades`);
  say('');

  /* ---- accumulators ---- */
  const stats = new Map<ModelId, Stat>();
  const statsKind = new Map<string, Stat>();
  const netSums = new Map<string, number>(); // model|bps -> sum netR
  for (const m of onlyModels) stats.set(m, new Stat());

  // path groups (model-independent classification by how far price got)
  const pathGroups = ['never TP1', 'TP1 only', 'reached TP2', 'reached final'];
  const pathN = new Map<string, number>();
  const pathMfe = new Map<string, number[]>();
  const pathMae = new Map<string, number[]>();
  const pathR = new Map<string, number[]>(); // `${group}|${model}`

  // Model A fidelity check against stored rMultiple
  let chk = 0, chkBad = 0, chkMax = 0;

  for (const [key, trades] of bySeries) {
    const [sym, tf] = key.split('|') as [string, Timeframe];
    if (!hasSeries(cache, sym, tf)) continue;
    const candles: Candle[] = loadSeries(cache, sym, tf);
    const idx = new Map<number, number>();
    for (let j = 0; j < candles.length; j++) idx.set(candles[j]!.openTime, j);

    for (const r of trades) {
      const start = idx.get(r.entryCandleTime);
      if (start === undefined) continue;
      const risk = Math.abs(r.entryPrice - r.stopLoss);
      if (!(risk > 0)) continue;
      const window = candles.slice(start, start + TIMEOUT_BARS + 2);
      const spec: TradeSpec = {
        direction: r.direction, entryPrice: r.entryPrice, stopLoss: r.stopLoss,
        takeProfits: r.takeProfits, timeoutBars: TIMEOUT_BARS,
      };

      const outs = new Map<ModelId, ModelOutcome>();
      for (const m of onlyModels) {
        const o = simulate(spec, window, m);
        if (o) outs.set(m, o);
      }
      const oA = outs.get('A');
      if (!oA) continue;

      // ---- fidelity: Model A gross must equal stored net + its fee ----
      // stored rMultiple is NET under the frozen one-lump fee:
      //   stored = grossA - (0.1/100)*entry/risk
      const impliedGrossA = r.rMultiple + (0.1 / 100) * r.entryPrice / risk;
      const dA = Math.abs(impliedGrossA - oA.grossR);
      if (dA > chkMax) chkMax = dA;
      if (dA > 1e-4) chkBad++;
      chk++;

      // ---- path classification (how far price actually travelled) ----
      const tps = [...r.takeProfits].filter(Number.isFinite)
        .sort((a, b) => Math.abs(a - r.entryPrice) - Math.abs(b - r.entryPrice));
      const long = r.direction === 'LONG';
      let maxFav = -Infinity, maxAdv = Infinity;
      const held = Math.max(1, oA.barsHeld);
      for (let b = 0; b < held && b < window.length; b++) {
        const c = window[b]!;
        const fav = long ? c.high - r.entryPrice : r.entryPrice - c.low;
        const adv = long ? c.low - r.entryPrice : r.entryPrice - c.high;
        if (fav > maxFav) maxFav = fav;
        if (adv < maxAdv) maxAdv = adv;
      }
      const mfeR = maxFav / risk, maeR = maxAdv / risk;
      const reachedN = tps.filter((p) =>
        long ? maxFav >= p - r.entryPrice : maxFav >= r.entryPrice - p).length;
      const grp = reachedN === 0 ? 'never TP1'
        : reachedN >= tps.length ? 'reached final'
          : reachedN >= 2 ? 'reached TP2' : 'TP1 only';

      pathN.set(grp, (pathN.get(grp) ?? 0) + 1);
      (pathMfe.get(grp) ?? pathMfe.set(grp, []).get(grp)!).push(mfeR);
      (pathMae.get(grp) ?? pathMae.set(grp, []).get(grp)!).push(maeR);

      // MFE measured up to the TP1 bar's end, for the giveback metric
      for (const m of onlyModels) {
        const o = outs.get(m); if (!o) continue;
        stats.get(m)!.add(o.grossR, o, o.reachedTp1 ? mfeR : null);
        const kk = `${r.setupKind}|${m}`;
        let sk = statsKind.get(kk);
        if (!sk) { sk = new Stat(); statsKind.set(kk, sk); }
        sk.add(o.grossR, o, null);
        for (const b of BPS) {
          const nk = `${m}|${b}`;
          netSums.set(nk, (netSums.get(nk) ?? 0) + o.grossR - feeRFor(spec, o, b));
        }
        const pk = `${grp}|${m}`;
        (pathR.get(pk) ?? pathR.set(pk, []).get(pk)!).push(o.grossR);
      }
    }
  }

  /* ---- fidelity report BEFORE any comparison ---- */
  say('### Model A fidelity check (must pass before B/C/D are trusted)');
  say('');
  say(`Recomputed Model A gross vs \`storedRMultiple + frozenFeeR\` on ${int(chk)} trades:`);
  say(`- max absolute difference: **${chkMax.toExponential(3)}**`);
  say(`- mismatches > 1e-4: **${chkBad}**`);
  say(`- verdict: **${chkBad === 0 ? 'A REPRODUCES THE FROZEN TRACKER' : 'MISMATCH — results below are NOT trustworthy'}**`);
  say('');

  /* ---- §5 main table ---- */
  say('### Exit-model comparison (GROSS first, then leg-based net)');
  say('');
  say('| model | n | gross exp | gross med R | gross PF | posR% | maxDD R | TIMEOUT% | ' +
    BPS.filter((b) => b > 0).map((b) => `net@${b}bps`).join(' | ') + ' |');
  say('|---|---|---|---|---|---|---|---|' + BPS.filter((b) => b > 0).map(() => '---').join('|') + '|');
  for (const m of onlyModels) {
    const s = stats.get(m)!;
    say(`| ${m} | ${int(s.n)} | ${f4(s.exp)} | ${f4(s.med)} | ${f4(s.pf)} | ${f2(s.posRate)} | ` +
      `${f2(s.maxDD)} | ${f2(s.timeoutRate)} | ` +
      BPS.filter((b) => b > 0).map((b) => f4((netSums.get(`${m}|${b}`) ?? 0) / s.n)).join(' | ') + ' |');
  }
  say('');

  say('### TP1-conditional behaviour');
  say('');
  say('| model | TP1 reached n | avg realized R on TP1 trades | TP1-reached but negative | share | avg giveback after TP1 |');
  say('|---|---|---|---|---|---|');
  for (const m of onlyModels) {
    const s = stats.get(m)!;
    const gb = s.giveback.length
      ? s.giveback.reduce((a, b) => a + b, 0) / s.giveback.length : NaN;
    say(`| ${m} | ${int(s.nTp1)} | ${f4(s.nTp1 ? s.tp1RSum / s.nTp1 : 0)} | ${int(s.nTp1Neg)} | ` +
      `${f2(s.nTp1 ? (s.nTp1Neg / s.nTp1) * 100 : 0)}% | ${f4(gb)} |`);
  }
  say('');

  say('### Exit-reason mix');
  say('');
  for (const m of onlyModels) {
    const s = stats.get(m)!;
    const parts = [...s.resCount.entries()].sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${f2((v / s.n) * 100)}%`).join(' · ');
    say(`- **${m}**: ${parts}`);
  }
  say('');

  /* ---- §6 path analysis ---- */
  say('### Path analysis — where favourable excursion is lost');
  say('');
  say('| path group | n | mean MFE R | mean MAE R | ' +
    onlyModels.map((m) => `${m} exp`).join(' | ') + ' |');
  say('|---|---|---|---|' + onlyModels.map(() => '---').join('|') + '|');
  const mean = (a: number[] | undefined): number =>
    a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  for (const g of pathGroups) {
    const n = pathN.get(g) ?? 0; if (!n) continue;
    say(`| ${g} | ${int(n)} | ${f4(mean(pathMfe.get(g)))} | ${f4(mean(pathMae.get(g)))} | ` +
      onlyModels.map((m) => f4(mean(pathR.get(`${g}|${m}`)))).join(' | ') + ' |');
  }
  say('');

  /* ---- §7 reversal vs continuation ---- */
  say('### REVERSAL vs CONTINUATION (gross)');
  say('');
  say('| setup | model | n | gross exp | PF | posR% |');
  say('|---|---|---|---|---|---|');
  for (const kind of ['REVERSAL', 'CONTINUATION']) {
    for (const m of onlyModels) {
      const s = statsKind.get(`${kind}|${m}`); if (!s || !s.n) continue;
      say(`| ${kind} | ${m} | ${int(s.n)} | ${f4(s.exp)} | ${f4(s.pf)} | ${f2(s.posRate)} |`);
    }
  }
  say('');

  /* ---- outlier dependence (robustness input for candidate choice) ---- */
  say('### Outlier dependence (gross)');
  say('');
  say('| model | exp | ex top1 | ex top5 | ex top 1% | top1% share of positive R |');
  say('|---|---|---|---|---|---|');
  for (const m of onlyModels) {
    const s = stats.get(m)!;
    const sorted = s.rs.slice().sort((a, b) => b - a);
    const n = sorted.length;
    const drop = (k: number): number => {
      const rest = sorted.slice(Math.min(k, n));
      return rest.length ? rest.reduce((a, b) => a + b, 0) / rest.length : 0;
    };
    const k1 = Math.max(1, Math.ceil(n * 0.01));
    const pos = sorted.filter((x) => x > 0).reduce((a, b) => a + b, 0);
    const top = sorted.slice(0, k1).filter((x) => x > 0).reduce((a, b) => a + b, 0);
    say(`| ${m} | ${f4(s.exp)} | ${f4(drop(1))} | ${f4(drop(5))} | ${f4(drop(k1))} | ` +
      `${f2(pos > 0 ? (top / pos) * 100 : 0)}% |`);
  }
  say('');

  writeFileSync(outFile, L.join('\n') + '\n');
  console.log('\nwrote', outFile);
}

void main();

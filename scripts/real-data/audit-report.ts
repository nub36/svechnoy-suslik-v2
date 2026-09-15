/**
 * READ-ONLY audit report generator (sections 2-11).
 *
 * Streams the saved trade artifacts twice (V1, V2) and prints every requested
 * table. Writes ONE new file outside the frozen run directory; it does not
 * touch any existing artifact, setting, or strategy file.
 */

import { writeFileSync } from 'node:fs';
import {
  Acc, EVIDENCE_BUCKETS, evidenceBucket, quantileSorted, r4, spearman,
  streamTrades, type AuditTrade,
} from './audit-fee-readonly';

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

const TFS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const SYMS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];
const SLICES = ['train', 'validation', 'test'];

const f4 = (x: number): string =>
  Number.isFinite(x) ? x.toFixed(4) : (x > 0 ? 'Inf' : 'n/a');
const f2 = (x: number): string =>
  Number.isFinite(x) ? x.toFixed(2) : (x > 0 ? 'Inf' : 'n/a');
const int = (x: number): string => x.toLocaleString('en-US');

interface Out { lines: string[] }
const say = (o: Out, s = ''): void => { console.log(s); o.lines.push(s); };

/** Reservoir-free exact quantiles need the sample; we keep only riskPercent. */
async function main(): Promise<void> {
  const v1File = arg('v1');
  const v2File = arg('v2');
  const outFile = arg('out');
  const o: Out = { lines: [] };

  /* =============== pass over V2 =============== */
  const v2Slice = new Map<string, Acc>();
  const v2TfTest = new Map<string, Acc>();
  const v2SymTest = new Map<string, Acc>();
  const v2DirTest = new Map<string, Acc>();
  const v2KindTest = new Map<string, Acc>();
  const v2EvTest = new Map<string, Acc>();
  const v2TimeoutTest = new Acc();
  const v2ExTimeoutTest = new Acc();
  // riskPercent samples (TEST) overall + per tf
  const riskAll: number[] = [];
  const riskTf = new Map<string, number[]>();
  // evidence/R pairs for Spearman + medians per bucket
  const evPairs: { e: number; g: number; nr: number }[] = [];
  const bucketGross = new Map<string, number[]>();
  const bucketNet = new Map<string, number[]>();
  // fee-sensitivity: need per-trade (grossR, entry/riskPerUnit ratio)
  // feeR(bps) = (bps/10000) * entry / riskPerUnit = (bps/10000) * (1/riskFrac)
  // where riskFrac = riskPerUnit/entry. Store 1/riskFrac = entry/riskPerUnit.
  let v2SensN = 0;
  const v2SensSumGross: number[] = [];   // per-tf handled separately
  const v2InvRiskFracSum = new Map<string, { n: number; sumGross: number; sumInv: number }>();
  let v2InvRiskFracTotal = 0;
  let v2GrossTotalTest = 0;
  // gross outlier sensitivity (TEST) — keep gross R array
  const v2GrossTest: number[] = [];
  // example trades, one per timeframe
  const v2Examples = new Map<string, AuditTrade>();

  for await (const t of streamTrades(v2File)) {
    if (t.result === 'OPEN') continue;
    const sAcc = v2Slice.get(t.slice) ?? new Acc();
    sAcc.add(t); v2Slice.set(t.slice, sAcc);

    if (t.slice !== 'test') continue;

    const a1 = v2TfTest.get(t.timeframe) ?? new Acc(); a1.add(t); v2TfTest.set(t.timeframe, a1);
    const a2 = v2SymTest.get(t.symbol) ?? new Acc(); a2.add(t); v2SymTest.set(t.symbol, a2);
    const a3 = v2DirTest.get(t.direction) ?? new Acc(); a3.add(t); v2DirTest.set(t.direction, a3);
    const kind = t.setupKind ?? 'NA';
    const a4 = v2KindTest.get(kind) ?? new Acc(); a4.add(t); v2KindTest.set(kind, a4);

    if (t.result === 'TIMEOUT') v2TimeoutTest.add(t); else v2ExTimeoutTest.add(t);

    riskAll.push(t.riskPercent);
    const rl = riskTf.get(t.timeframe) ?? []; rl.push(t.riskPercent); riskTf.set(t.timeframe, rl);

    if (t.evidence !== undefined) {
      const b = evidenceBucket(t.evidence);
      if (b) {
        const a5 = v2EvTest.get(b) ?? new Acc(); a5.add(t); v2EvTest.set(b, a5);
        const bg = bucketGross.get(b) ?? []; bg.push(t.grossR); bucketGross.set(b, bg);
        const bn = bucketNet.get(b) ?? []; bn.push(t.netR); bucketNet.set(b, bn);
      }
      evPairs.push({ e: t.evidence, g: t.grossR, nr: t.netR });
    }

    const inv = t.riskPerUnit > 0 ? t.entryPrice / t.riskPerUnit : 0;
    v2InvRiskFracTotal += inv;
    v2GrossTotalTest += t.grossR;
    v2SensN++;
    v2GrossTest.push(t.grossR);
    const st = v2InvRiskFracSum.get(t.timeframe) ?? { n: 0, sumGross: 0, sumInv: 0 };
    st.n++; st.sumGross += t.grossR; st.sumInv += inv;
    v2InvRiskFracSum.set(t.timeframe, st);

    if (!v2Examples.has(t.timeframe)) v2Examples.set(t.timeframe, t);
  }

  /* =============== pass over V1 =============== */
  const v1Slice = new Map<string, Acc>();
  const v1TfTest = new Map<string, Acc>();
  let v1SensN = 0, v1InvRiskFracTotal = 0, v1GrossTotalTest = 0;
  const v1InvRiskFracTf = new Map<string, { n: number; sumGross: number; sumInv: number }>();
  const v1GrossTest: number[] = [];
  // V1 score matrix
  const cellAcc = new Map<string, Acc>();
  const cellGross = new Map<string, number[]>();
  const cellNet = new Map<string, number[]>();
  const v1Pairs: { norm: number; raw: number; w: number; g: number }[] = [];

  const wBucket = (w: number): string => (w < 30 ? '<30' : w < 50 ? '30-50' : '>50');
  const sBucket = (s: number): string => (s < 70 ? '<70' : s < 90 ? '70-90' : '90-100');

  for await (const t of streamTrades(v1File)) {
    if (t.result === 'OPEN') continue;
    const sAcc = v1Slice.get(t.slice) ?? new Acc();
    sAcc.add(t); v1Slice.set(t.slice, sAcc);
    if (t.slice !== 'test') continue;

    const a = v1TfTest.get(t.timeframe) ?? new Acc(); a.add(t); v1TfTest.set(t.timeframe, a);
    const inv = t.riskPerUnit > 0 ? t.entryPrice / t.riskPerUnit : 0;
    v1InvRiskFracTotal += inv; v1GrossTotalTest += t.grossR; v1SensN++;
    v1GrossTest.push(t.grossR);
    const st = v1InvRiskFracTf.get(t.timeframe) ?? { n: 0, sumGross: 0, sumInv: 0 };
    st.n++; st.sumGross += t.grossR; st.sumInv += inv; v1InvRiskFracTf.set(t.timeframe, st);

    if (t.v1AvailableWeight != null && t.v1NormalizedScore != null) {
      const key = `${wBucket(t.v1AvailableWeight)}|${sBucket(t.v1NormalizedScore)}`;
      const ca = cellAcc.get(key) ?? new Acc(); ca.add(t); cellAcc.set(key, ca);
      const cg = cellGross.get(key) ?? []; cg.push(t.grossR); cellGross.set(key, cg);
      const cn = cellNet.get(key) ?? []; cn.push(t.netR); cellNet.set(key, cn);
      v1Pairs.push({
        norm: t.v1NormalizedScore, raw: t.v1RawScore ?? NaN,
        w: t.v1AvailableWeight, g: t.grossR,
      });
    }
  }

  /* =============== §2 examples =============== */
  say(o, '## §2. REAL TRADE FEE EXAMPLES (V2 TEST, one per timeframe)');
  say(o, '');
  say(o, '| tf | symbol | dir | entry | exit | SL | riskPerUnit | risk% | fee_pct | gross R | fee R | net R | exit |');
  say(o, '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const tf of TFS) {
    const t = v2Examples.get(tf);
    if (!t) continue;
    say(o, `| ${tf} | ${t.symbol} | ${t.direction} | ${t.entryPrice} | ${t.exitPrice} | ${t.stopLoss} | ` +
      `${r4(t.riskPerUnit)} | ${f4(t.riskPercent)}% | 0.1 | ${f4(t.grossR)} | ${f4(t.feeR)} | ${f4(t.netR)} | ${t.result} |`);
  }

  /* =============== §3 stop geometry =============== */
  say(o, '');
  say(o, '## §3. STOP GEOMETRY — riskPercent = |entry-SL|/entry*100 (V2 TEST)');
  say(o, '');
  riskAll.sort((a, b) => a - b);
  const qs: [string, number][] = [['min', 0], ['p10', .10], ['p25', .25], ['median', .50],
    ['p75', .75], ['p90', .90], ['p95', .95], ['p99', .99], ['max', 1]];
  say(o, '| scope | n | ' + qs.map((q) => q[0]).join(' | ') + ' |');
  say(o, '|---|---|' + qs.map(() => '---').join('|') + '|');
  say(o, `| ALL | ${int(riskAll.length)} | ` +
    qs.map(([, f]) => f4(quantileSorted(riskAll, f))).join(' | ') + ' |');
  for (const tf of TFS) {
    const a = riskTf.get(tf); if (!a) continue;
    a.sort((x, y) => x - y);
    say(o, `| ${tf} | ${int(a.length)} | ` + qs.map(([, f]) => f4(quantileSorted(a, f))).join(' | ') + ' |');
  }
  say(o, '');
  const thresholds = [0.05, 0.10, 0.20, 0.50, 1.00];
  say(o, '| scope | ' + thresholds.map((t) => `<${t.toFixed(2)}%`).join(' | ') + ' |');
  say(o, '|---|' + thresholds.map(() => '---').join('|') + '|');
  const shares = (arr: number[]): string =>
    thresholds.map((th) => {
      const c = arr.filter((x) => x < th).length;
      return `${((c / arr.length) * 100).toFixed(2)}%`;
    }).join(' | ');
  say(o, `| ALL | ${shares(riskAll)} |`);
  for (const tf of TFS) { const a = riskTf.get(tf); if (a) say(o, `| ${tf} | ${shares(a)} |`); }

  /* =============== §4 gross vs net per slice =============== */
  say(o, '');
  say(o, '## §4. GROSS VS NET per slice');
  say(o, '');
  say(o, '| slice | engine | n | gross exp | fee drag | net exp | gross totalR | net totalR | gross PF | net PF |');
  say(o, '|---|---|---|---|---|---|---|---|---|---|');
  for (const s of SLICES) {
    for (const [name, m] of [['V1', v1Slice], ['V2', v2Slice]] as const) {
      const a = m.get(s); if (!a) continue;
      say(o, `| ${s} | ${name} | ${int(a.n)} | ${f4(a.grossExp)} | ${f4(a.feeDrag)} | ${f4(a.netExp)} | ` +
        `${f2(a.sumGross)} | ${f2(a.sumNet)} | ${f4(a.grossPf)} | ${f4(a.netPf)} |`);
    }
  }

  /* =============== §5 by timeframe =============== */
  say(o, '');
  say(o, '## §5. GROSS VS NET BY TIMEFRAME (TEST)');
  say(o, '');
  say(o, '| tf | engine | n | gross exp | fee drag | net exp | gross PF | net PF |');
  say(o, '|---|---|---|---|---|---|---|---|');
  for (const tf of TFS) {
    for (const [name, m] of [['V1', v1TfTest], ['V2', v2TfTest]] as const) {
      const a = m.get(tf); if (!a) continue;
      say(o, `| ${tf} | ${name} | ${int(a.n)} | ${f4(a.grossExp)} | ${f4(a.feeDrag)} | ${f4(a.netExp)} | ` +
        `${f4(a.grossPf)} | ${f4(a.netPf)} |`);
    }
  }

  /* =============== §6 fee sensitivity =============== */
  say(o, '');
  say(o, '## §6. ANALYTIC FEE SENSITIVITY (TEST)');
  say(o, '');
  say(o, 'Formula. A round-trip cost of `B` bps on notional converts to R per trade as:');
  say(o, '');
  say(o, '```');
  say(o, 'feeR_i(B) = (B / 10000) * entryPrice_i / riskPerUnit_i');
  say(o, 'netR_i(B) = grossR_i - feeR_i(B)');
  say(o, 'expectancy(B) = mean_i(grossR_i) - (B/10000) * mean_i(entryPrice_i / riskPerUnit_i)');
  say(o, '```');
  say(o, '');
  say(o, 'The frozen setting `outcome.fee_pct = 0.1` (%) equals **10 bps**.');
  say(o, '');
  const bpsList = [0, 2, 5, 10, 20];
  const meanInvV1 = v1SensN > 0 ? v1InvRiskFracTotal / v1SensN : 0;
  const meanInvV2 = v2SensN > 0 ? v2InvRiskFracTotal / v2SensN : 0;
  const gV1 = v1SensN > 0 ? v1GrossTotalTest / v1SensN : 0;
  const gV2 = v2SensN > 0 ? v2GrossTotalTest / v2SensN : 0;
  say(o, '| round-trip | V1 expectancy | V2 expectancy |');
  say(o, '|---|---|---|');
  for (const b of bpsList) {
    say(o, `| ${b} bps | ${f4(gV1 - (b / 10000) * meanInvV1)} | ${f4(gV2 - (b / 10000) * meanInvV2)} |`);
  }
  say(o, '');
  say(o, 'V2 by timeframe:');
  say(o, '');
  say(o, '| tf | n | ' + bpsList.map((b) => `${b} bps`).join(' | ') + ' |');
  say(o, '|---|---|' + bpsList.map(() => '---').join('|') + '|');
  for (const tf of TFS) {
    const st = v2InvRiskFracSum.get(tf); if (!st) continue;
    const g = st.sumGross / st.n, mi = st.sumInv / st.n;
    say(o, `| ${tf} | ${int(st.n)} | ` +
      bpsList.map((b) => f4(g - (b / 10000) * mi)).join(' | ') + ' |');
  }

  /* =============== §7 gross edge robustness =============== */
  say(o, '');
  say(o, '## §7. GROSS EDGE ROBUSTNESS (TEST)');
  say(o, '');
  const v1t = v1Slice.get('test')!, v2t = v2Slice.get('test')!;
  say(o, `V1 gross expectancy: **${f4(v1t.grossExp)}** (n=${int(v1t.n)})`);
  say(o, `V2 gross expectancy: **${f4(v2t.grossExp)}** (n=${int(v2t.n)})`);
  say(o, '');
  const dumpGroup = (title: string, m: Map<string, Acc>, order?: string[]): void => {
    say(o, `**${title}**`);
    say(o, '');
    say(o, '| group | n | gross exp | net exp | gross PF | gross posR% |');
    say(o, '|---|---|---|---|---|---|');
    const keys = order ?? [...m.keys()].sort();
    for (const k of keys) {
      const a = m.get(k); if (!a) continue;
      say(o, `| ${k} | ${int(a.n)} | ${f4(a.grossExp)} | ${f4(a.netExp)} | ${f4(a.grossPf)} | ${f2(a.grossPosRate)} |`);
    }
    say(o, '');
  };
  dumpGroup('V2 by direction', v2DirTest);
  dumpGroup('V2 by setup kind', v2KindTest);
  dumpGroup('V2 by symbol', v2SymTest, SYMS);
  dumpGroup('V2 by timeframe', v2TfTest, TFS);

  /* =============== §8 evidence =============== */
  say(o, '## §8. V2 EVIDENCE BUCKETS (TEST) — association only, NOT probability');
  say(o, '');
  say(o, '| bucket | n | gross exp | net exp | median gross R | median net R | gross posR% | net posR% |');
  say(o, '|---|---|---|---|---|---|---|---|');
  for (const [label] of EVIDENCE_BUCKETS) {
    const a = v2EvTest.get(label); if (!a) continue;
    const bg = (bucketGross.get(label) ?? []).slice().sort((x, y) => x - y);
    const bn = (bucketNet.get(label) ?? []).slice().sort((x, y) => x - y);
    say(o, `| ${label} | ${int(a.n)} | ${f4(a.grossExp)} | ${f4(a.netExp)} | ` +
      `${f4(quantileSorted(bg, .5))} | ${f4(quantileSorted(bn, .5))} | ` +
      `${f2(a.grossPosRate)} | ${f2(a.netPosRate)} |`);
  }
  say(o, '');
  const sE = evPairs.map((p) => p.e);
  say(o, `Spearman(evidence, GROSS R) = **${f4(spearman(sE, evPairs.map((p) => p.g)))}**  (n=${int(evPairs.length)})`);
  say(o, `Spearman(evidence, NET R)   = **${f4(spearman(sE, evPairs.map((p) => p.nr)))}**`);

  /* =============== §9 V1 matrix =============== */
  say(o, '');
  say(o, '## §9. V1 SCORE NORMALIZATION MATRIX (TEST)');
  say(o, '');
  say(o, '| availableWeight | score | n | gross avg R | net avg R | gross med R | net med R | posR% | TP exit% | gross PF | net PF |');
  say(o, '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const w of ['<30', '30-50', '>50']) {
    for (const s of ['<70', '70-90', '90-100']) {
      const key = `${w}|${s}`;
      const a = cellAcc.get(key); if (!a) continue;
      const cg = (cellGross.get(key) ?? []).slice().sort((x, y) => x - y);
      const cn = (cellNet.get(key) ?? []).slice().sort((x, y) => x - y);
      say(o, `| ${w} | ${s} | ${int(a.n)} | ${f4(a.grossExp)} | ${f4(a.netExp)} | ` +
        `${f4(quantileSorted(cg, .5))} | ${f4(quantileSorted(cn, .5))} | ` +
        `${f2(a.grossPosRate)} | ${f2(a.tpRate)} | ${f4(a.grossPf)} | ${f4(a.netPf)} |`);
    }
  }
  say(o, '');
  const lo = cellAcc.get('<30|90-100'), hi = cellAcc.get('>50|90-100');
  if (lo && hi) {
    say(o, `**Head-to-head (the 25/25=100 test), on GROSS R:**`);
    say(o, '');
    say(o, `- score 90-100 AND availableWeight <30 : n=${int(lo.n)}, gross exp **${f4(lo.grossExp)}**, gross PF ${f4(lo.grossPf)}`);
    say(o, `- score 90-100 AND availableWeight >50 : n=${int(hi.n)}, gross exp **${f4(hi.grossExp)}**, gross PF ${f4(hi.grossPf)}`);
  }
  say(o, '');
  const validRaw = v1Pairs.filter((p) => Number.isFinite(p.raw));
  say(o, `Spearman(normalized score, GROSS R) = **${f4(spearman(v1Pairs.map((p) => p.norm), v1Pairs.map((p) => p.g)))}**  (n=${int(v1Pairs.length)})`);
  say(o, `Spearman(raw score, GROSS R)        = **${f4(spearman(validRaw.map((p) => p.raw), validRaw.map((p) => p.g)))}**  (n=${int(validRaw.length)})`);
  say(o, `Spearman(availableWeight, GROSS R)  = **${f4(spearman(v1Pairs.map((p) => p.w), v1Pairs.map((p) => p.g)))}**`);

  /* =============== §10 timeout =============== */
  say(o, '');
  say(o, '## §10. TIMEOUT GROSS/NET (V2 TEST)');
  say(o, '');
  const to = v2TimeoutTest, ex = v2ExTimeoutTest, all = v2t;
  say(o, '| set | n | gross avg R | net avg R | gross total R | net total R |');
  say(o, '|---|---|---|---|---|---|');
  say(o, `| TIMEOUT only | ${int(to.n)} | ${f4(to.grossExp)} | ${f4(to.netExp)} | ${f2(to.sumGross)} | ${f2(to.sumNet)} |`);
  say(o, `| all CLOSED | ${int(all.n)} | ${f4(all.grossExp)} | ${f4(all.netExp)} | ${f2(all.sumGross)} | ${f2(all.sumNet)} |`);
  say(o, `| excluding TIMEOUT | ${int(ex.n)} | ${f4(ex.grossExp)} | ${f4(ex.netExp)} | ${f2(ex.sumGross)} | ${f2(ex.sumNet)} |`);

  /* =============== §11 outlier sensitivity on GROSS =============== */
  say(o, '');
  say(o, '## §11. OUTLIER SENSITIVITY on GROSS R (TEST)');
  say(o, '');
  say(o, '| engine | n | gross totalR | gross exp | ex top1 exp | ex top5 exp | ex top1% exp | top1% share of gross positive |');
  say(o, '|---|---|---|---|---|---|---|---|');
  for (const [name, arr] of [['V1', v1GrossTest], ['V2', v2GrossTest]] as const) {
    const s = arr.slice().sort((a, b) => b - a);
    const n = s.length, tot = s.reduce((a, b) => a + b, 0);
    const drop = (k: number): number => {
      const rest = s.slice(Math.min(k, n));
      return rest.length ? rest.reduce((a, b) => a + b, 0) / rest.length : 0;
    };
    const k1 = Math.max(1, Math.ceil(n * 0.01));
    const gp = s.filter((x) => x > 0).reduce((a, b) => a + b, 0);
    const top = s.slice(0, k1).filter((x) => x > 0).reduce((a, b) => a + b, 0);
    say(o, `| ${name} | ${int(n)} | ${f2(tot)} | ${f4(tot / n)} | ${f4(drop(1))} | ${f4(drop(5))} | ` +
      `${f4(drop(k1))} (−${int(k1)}) | ${f2(gp > 0 ? (top / gp) * 100 : 0)}% |`);
  }

  writeFileSync(outFile, o.lines.join('\n') + '\n');
  console.log('\nwrote', outFile);
}

void main();

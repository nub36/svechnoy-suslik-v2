/**
 * RUN THE STRATEGY PORTFOLIO — one command, real Binance data, no re-implemented logic.
 *
 * This file does NOT contain a second copy of any strategy. Each strategy below is
 * executed through the exact research module that produced its published artifact
 * (the modules are hash-pinned by the test suite), and the numbers this runner
 * prints are read back out of those artifacts. If a module and this table ever
 * disagreed, the module would win — a test asserts the registry hashes.
 *
 *   npx tsx scripts/run-strategies.ts --cache=/home/user/.cache/v30parity \
 *     --splits=artifacts/research/v2-real-20260915-080338/splits.json
 *
 * Add `--only=v33` to run a single strategy, `--quick` for BTCUSDT only,
 * `--out=<file>` to choose the JSON report path.
 *
 * WHAT "WORKS" MEANS HERE — read this before trusting any row:
 *
 *   V3.0  The only strategy that has been net-positive at REAL Binance futures
 *         fees on data it was never fitted to (pre-registered VALIDATION,
 *         +0.0600 R/trade @2/5 bps, n = 536). It is ported into the site engine
 *         (src/strategy/v30/) and runs in paper forward test. This is the row to
 *         use. Its known weakness: 3 of 6 validation symbols were negative, and
 *         removing the best 5 trades turns the net negative.
 *
 *   V3.3  Passed its pre-registered TRAIN criteria (+0.0267 R/trade @2/5 bps,
 *         n = 6,957) and is the first hypothesis since V3.0 to do so — but it has
 *         NEVER been validated: TRAIN is burned data, the single VALIDATION
 *         window was spent on V3.0, and the 2026 TEST window must stay unread.
 *         Its edge sits in the top 1 % of trades (ex-top-1 % gross +0.0264 is
 *         BELOW its 0.0511 R fee). NOT ported into the engine. Research only.
 *
 *   V3.1  FALSIFIED on TRAIN — negative before fees (−0.0838 gross). Do not run
 *   V3.2  it. Kept so the falsification can be reproduced, not because it earns.
 *
 * Fees everywhere: FUT_MAKER_TAKER 2 bps maker entry / 5 bps taker exit, charged
 * per leg on that leg's own notional. Every `net` figure below is after those
 * fees; `--fees=spot` figures (10/10 bps) are shown in the report when present.
 *
 * SAFETY: nothing here trades, places an order, or talks to an exchange. It reads
 * local cached candles and writes JSON. LIVE_TRADING_ENABLED stays false and no
 * strategy in this repository is approved for live capital (PRODUCTION_READY is
 * forbidden for all of them).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/* ------------------------------------------------------------------ CLI ---- */

const arg = (name: string, fallback?: string): string | undefined => {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  return v ?? fallback;
};
const flag = (name: string): boolean => process.argv.slice(2).includes(`--${name}`);

const REPO = resolve(__dirname, '..');
const CACHE = arg('cache', '/home/user/.cache/v30parity')!;
const CACHE_V28 = arg('cache28', '/home/user/.cache/v28parity')!;
const SPLITS = arg('splits', 'artifacts/research/v2-real-20260915-080338/splits.json')!;
const ONLY = arg('only');
const QUICK = flag('quick');
const OUT = arg('out', 'artifacts/research/portfolio-comparison.json')!;
const REPORT_DIR = 'artifacts/research/portfolio-runs';

/* ------------------------------------------------------------ registry ---- */

interface StrategyRun {
  /** Selector key used by --only. */
  id: string;
  name: string;
  /** Research module that produced the published artifact. */
  module: string;
  /** sha256 prefix of that module, as pinned by the test suite. */
  sha256Prefix: string;
  /** Extra CLI flags for the registered (primary) configuration. */
  flags: string[];
  /** Where the run writes its metrics. */
  artifact: string;
  /** Committed artifact of the same configuration, used to detect drift. */
  published: string;
  /** Set when the module needs a wider cache than the 1h/4h one (V2.8 reads 15m/30m/1h/4h/1d). */
  cache?: 'v28';
  status: string;
  /** One line for the operator. */
  verdict: string;
}

const STRATEGIES: StrategyRun[] = [
  {
    id: 'v30',
    name: 'V3.0 HTF Liquidation Trap',
    module: 'research/v30_htf_trap.ts',
    sha256Prefix: 'a821757f',
    flags: [],
    artifact: `${REPORT_DIR}/v30-train-metrics.json`,
    published: 'artifacts/research/v30/v30-train-metrics.json',
    status: 'V3_0_VALIDATED_FOR_RESEARCH',
    verdict: 'USE THIS. Validated out of sample (+0.0600 R/trade @2/5 bps, n=536). Ported into the engine.',
  },
  {
    id: 'v33',
    name: 'V3.3 HTF Zone Mitigation & LTF Squeeze',
    module: 'research/v33_zone_mitigation.ts',
    sha256Prefix: '3f5b1478',
    flags: ['--window=while', '--stop=protective', '--leg=displacement'],
    artifact: `${REPORT_DIR}/v33-train-metrics.json`,
    published: 'artifacts/research/v33/v33-train-metrics-while-protective-displacement.json',
    status: 'V3_3_TRAIN_ONLY',
    verdict: 'RESEARCH ONLY. TRAIN pass, never validated, tail-dependent, not ported. Do not trade live.',
  },
  {
    id: 'v31',
    name: 'V3.1 HTF Trend Pullback & Mitigation',
    module: 'research/v31_trend_pullback.ts',
    sha256Prefix: '',
    flags: [],
    artifact: `${REPORT_DIR}/v31-train-metrics.json`,
    published: 'artifacts/research/v31/v31-train-metrics.json',
    status: 'V3_1_FALSIFIED_ON_TRAIN',
    verdict: 'FALSIFIED. Negative before fees (−0.0838 gross). Reproducible only.',
  },
  {
    id: 'v28',
    name: 'V2.8 Zero-Fee Sniper + Trailing (Trail arm)',
    module: 'research/v28_gross_only.ts',
    sha256Prefix: '',
    flags: [],
    cache: 'v28',
    artifact: `${REPORT_DIR}/v28-train-metrics.json`,
    published: 'artifacts/research/v28/v28-train-metrics.json',
    status: 'V2_8_VALIDATED_FOR_RESEARCH (ZERO FEES ONLY)',
    verdict: 'ZERO-FEE ACCOUNT ONLY. Validated gross of fees (+0.0488 R/trade, n=98) — at real ' +
      'fees it is negative, and even at zero fees the validation edge is negative once its best ' +
      '1 % of trades is removed (ex-top-1 % = −0.0143).',
  },
  {
    id: 'v32',
    name: 'V3.2 Volume Climax & Absorption',
    module: 'research/v32_volume_climax.ts',
    sha256Prefix: '',
    flags: [],
    artifact: `${REPORT_DIR}/v32-train-metrics.json`,
    published: 'artifacts/research/v32/v32-train-metrics.json',
    status: 'V3_2_FALSIFIED_ON_TRAIN',
    verdict: 'FALSIFIED. Zero expectancy before fees (−0.0082 gross). Reproducible only.',
  },
];

/* ------------------------------------------------------------- helpers ---- */

interface Metrics {
  n: number;
  tp1HitRatePct: number;
  tp2HitRatePct: number | null;
  stopDistancePct: { median: number } | null;
  feeDragR: Record<string, number> | null;
  grossRPerTrade: number;
  netRPerTrade: Record<string, number> | null;
  profitFactor: number;
  maxDrawdownR: number;
  outlierDependence?: { exTop1Pct?: number };
  /** V2.8 runs with every fee set to zero, by design — not comparable to the net columns. */
  zeroFee?: boolean;
}

interface V28Artifact {
  sniperEntries: number;
  feesDisabled: boolean;
  arms: {
    arm: string; n: number; winRateTargetPct: number;
    grossRPerTrade: number; profitFactor: number; maxDrawdownR: number;
    outlierDependence?: { exTop1Pct?: number };
  }[];
}

/** Normalise either artifact shape onto one row. V2.8 reports arms; we show the Trail arm. */
const extractMetrics = (run: StrategyRun, raw: unknown): Metrics => {
  if (run.id === 'v28') {
    const a = raw as V28Artifact;
    const arm = a.arms.find((x) => x.arm === 'Trail')!;
    return {
      n: arm.n,
      tp1HitRatePct: arm.winRateTargetPct,
      tp2HitRatePct: null,
      stopDistancePct: null,
      feeDragR: null,
      grossRPerTrade: arm.grossRPerTrade,
      netRPerTrade: null,
      profitFactor: arm.profitFactor,
      maxDrawdownR: arm.maxDrawdownR,
      outlierDependence: arm.outlierDependence,
      zeroFee: a.feesDisabled,
    };
  }
  return raw as Metrics;
};

const readJson = <T>(p: string): T => JSON.parse(readFileSync(resolve(REPO, p), 'utf8')) as T;

const sha256Prefix = (p: string): string => {
  const out = execFileSync('sha256sum', [resolve(REPO, p)], { encoding: 'utf8' });
  return out.slice(0, 8);
};

const fmt = (x: number, digits = 4): string => (Number.isFinite(x) ? x.toFixed(digits) : '—');
const pad = (s: string, w: number): string => s.padEnd(w);

/* ---------------------------------------------------------------- run ----- */

const problems: string[] = [];
const rows: { run: StrategyRun; m: Metrics; drift: boolean; exTop1?: number }[] = [];

console.log('STRATEGY PORTFOLIO — reproduction on real Binance klines');
console.log(`module:  ${REPO}`);
console.log(`cache:   ${CACHE}`);
console.log(`splits:  ${SPLITS}`);
console.log(`fees:    2 bps maker entry / 5 bps taker exit (FUT_MAKER_TAKER), per leg`);
console.log(`scope:   TRAIN window only — no VALIDATION re-read, no 2026 TEST data\n`);

if (!existsSync(CACHE)) {
  console.error(`cache not found: ${CACHE}\nBuild it first:\n` +
    `  git clone --filter=blob:none --no-checkout https://github.com/nub36/svechnoy-suslik-binance-data.git ~/.cache/binance-data\n` +
    `  (cd ~/.cache/binance-data && git sparse-checkout set --no-cone '/*/1h/*' '/*/4h/*' && git checkout)\n` +
    `  npx tsx scripts/real-data/v30-parity-ingest.ts --dataset=~/.cache/binance-data --cache=${CACHE}`);
  process.exit(1);
}

mkdirSync(resolve(REPO, REPORT_DIR), { recursive: true });

for (const run of STRATEGIES) {
  if (ONLY && run.id !== ONLY) continue;
  if (!existsSync(resolve(REPO, run.module))) {
    problems.push(`${run.id}: module missing (${run.module})`);
    continue;
  }
  if (run.cache === 'v28' && !existsSync(CACHE_V28)) {
    console.log(`${pad(run.id, 5)} ${pad(run.name, 42)} skipped — needs its own cache (see the footer)`);
    continue;
  }

  // integrity: the module must be the version that produced the published table
  if (run.sha256Prefix) {
    const actual = sha256Prefix(run.module);
    if (!actual.startsWith(run.sha256Prefix)) {
      problems.push(`${run.id}: ${run.module} sha256 ${actual}… does not start with the pinned ${run.sha256Prefix}… — results below are NOT the published ones`);
    }
  }

  const argv = [
    'tsx', run.module,
    `--cache=${run.cache === 'v28' ? CACHE_V28 : CACHE}`,
    `--splits=${SPLITS}`,
    ...run.flags,
    `--out=${run.artifact}`,
  ];
  if (QUICK) argv.push('--symbols=BTCUSDT');

  process.stdout.write(`${pad(run.id, 5)} ${pad(run.name, 42)} running… `);
  const t0 = Date.now();
  try {
    execFileSync('npx', argv, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as { stderr?: Buffer; message?: string };
    console.log('FAILED');
    problems.push(`${run.id}: run failed — ${(e.stderr?.toString() || e.message || '').split('\n').slice(-3).join(' ')}`);
    continue;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const m = extractMetrics(run, readJson<unknown>(run.artifact));
  let drift = false;
  if (existsSync(resolve(REPO, run.published)) && !QUICK) {
    const pub = extractMetrics(run, readJson<unknown>(run.published));
    drift = pub.n !== m.n || Math.abs(pub.grossRPerTrade - m.grossRPerTrade) > 1e-9;
    if (drift) {
      problems.push(`${run.id}: fresh run (n=${m.n}, gross ${fmt(m.grossRPerTrade)}) differs from the published artifact (n=${pub.n}, gross ${fmt(pub.grossRPerTrade)})`);
    }
  }
  console.log(`done in ${secs}s  n=${m.n}${drift ? '  ⚠ DRIFT' : ''}`);
  rows.push({ run, m, drift, exTop1: m.outlierDependence?.exTop1Pct });
}

/* -------------------------------------------------------------- report ---- */

if (rows.length) {
  console.log('\n' + '='.repeat(118));
  console.log('RESULTS — TRAIN window, real Binance klines, fees charged per leg');
  console.log('='.repeat(118));
  console.log([
    pad('strategy', 10), pad('n', 8), pad('TP1 %', 8), pad('stop %', 9),
    pad('fee R', 8), pad('gross R', 9), pad('net@2/5 R', 11), pad('PF', 8),
    pad('MaxDD R', 10), pad('ex-top-1 %', 12),
  ].join(''));
  console.log('-'.repeat(118));
  const sign = (x: number): string => (x >= 0 ? '+' : '') + fmt(x, 4);
  for (const { m, run, exTop1 } of rows) {
    const zero = m.zeroFee === true;
    console.log([
      pad(run.id, 10),
      pad(String(m.n), 8),
      pad(fmt(m.tp1HitRatePct, 2), 8),
      pad(m.stopDistancePct ? fmt(m.stopDistancePct.median, 4) : '—', 9),
      pad(zero ? 'ZERO*' : fmt(m.feeDragR?.FUT_4 ?? NaN, 4), 8),
      pad(sign(m.grossRPerTrade), 9),
      pad(zero ? 'n/a*' : m.netRPerTrade ? sign(m.netRPerTrade.FUT_4!) : '—', 11),
      pad(fmt(m.profitFactor, 4), 8),
      pad(fmt(m.maxDrawdownR, 2), 10),
      pad(exTop1 === undefined ? '—' : sign(exTop1), 12),
    ].join(''));
  }
  console.log('-'.repeat(118));
  console.log('ex-top-1 % = gross R/trade after deleting the best 1 % of trades — the honest fragility test.');
  console.log('A row whose ex-top-1 % sits below its fee column is a row that loses money without its tail.');
  if (rows.some((r) => r.m.zeroFee)) {
    console.log('* V2.8 was run with ALL FEES SET TO ZERO, which is how it was validated — it only');
    console.log('  ever worked on a zero-fee / cashback account. Its gross is therefore not comparable');
    console.log('  to the net column of the other rows. At Binance futures 2/5 bps it is negative.');
  }
  console.log('');

  console.log('STATUS / what each row may be used for');
  console.log('-'.repeat(118));
  for (const { run } of rows) console.log(`${pad(run.id, 5)} ${run.status}\n      ${run.verdict}`);
  console.log('-'.repeat(118));

  const report = {
    generatedAt: new Date().toISOString(),
    scope: 'TRAIN only',
    fees: { model: 'FUT_MAKER_TAKER', makerBps: 2, takerBps: 5, perLeg: true },
    cache: CACHE,
    splits: SPLITS,
    quick: QUICK,
    strategies: rows.map(({ run, m, drift }) => ({
      id: run.id,
      name: run.name,
      module: run.module,
      moduleSha256Prefix: sha256Prefix(run.module),
      status: run.status,
      verdict: run.verdict,
      driftFromPublished: drift,
      zeroFee: m.zeroFee === true,
      metrics: {
        n: m.n,
        tp1HitRatePct: m.tp1HitRatePct,
        tp2HitRatePct: m.tp2HitRatePct,
        stopMedianPct: m.stopDistancePct?.median ?? null,
        feeDragR: m.feeDragR,
        grossRPerTrade: m.grossRPerTrade,
        netRPerTrade: m.netRPerTrade,
        profitFactor: m.profitFactor,
        maxDrawdownR: m.maxDrawdownR,
        exTop1Pct: m.outlierDependence?.exTop1Pct ?? null,
      },
    })),
    problems,
  };
  writeFileSync(resolve(REPO, OUT), JSON.stringify(report, null, 1) + '\n');
  console.log(`\nJSON report: ${OUT}`);
}

if (problems.length) {
  console.log('\n⚠ PROBLEMS');
  for (const p of problems) console.log(`  - ${p}`);
  process.exitCode = 1;
} else if (rows.length && !ONLY) {
  console.log('\n✓ every run reproduced its published artifact exactly (no drift)');
}

if (!ONLY) {
  console.log(`\nHOW TO BUILD THE CACHES
  V3.x (1h execution + 4h structure):
    git clone --filter=blob:none --no-checkout https://github.com/nub36/svechnoy-suslik-binance-data.git ~/.cache/binance-data
    (cd ~/.cache/binance-data && git sparse-checkout set --no-cone '/*/1h/*' '/*/4h/*' && git checkout)
    npx tsx scripts/real-data/v30-parity-ingest.ts --dataset=~/.cache/binance-data --cache=${CACHE}
  V2.8 (15m/30m/1h/4h/1d — the 1d series is REQUIRED: without it the 1h rows lose their
        higher-timeframe context and the harness silently finds 315 trades instead of 317):
    (cd ~/.cache/binance-data && git sparse-checkout set --no-cone '/*/15m/*' '/*/30m/*' '/*/1h/*' '/*/4h/*' '/*/1d/*' && git checkout)
    npx tsx scripts/real-data/v30-parity-ingest.ts --dataset=~/.cache/binance-data --cache=${CACHE_V28} --timeframes=15m,30m,1h,4h,1d`);
}

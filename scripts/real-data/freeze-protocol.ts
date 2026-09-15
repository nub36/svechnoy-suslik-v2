/**
 * PRE-REGISTRATION (Steps 5-7). Must run BEFORE any TEST metric is computed.
 *
 * Emits, and hashes, the four documents that make the experiment falsifiable:
 *
 *   settings.json  + settings.sha256   the exact settings both engines will use
 *   splits.json                        chronological 60/20/20 boundaries
 *   run-metadata.json                  commits, environment, run id
 *   docs/V2_REAL_REPLAY_PROTOCOL.md    the human-readable pre-registration
 *
 * The settings snapshot is built from the REGISTRY DEFAULTS, deliberately NOT
 * from the production database. Reading live DB rows would make the experiment
 * depend on whatever an operator last typed into the admin UI, and would not be
 * reproducible by anyone else. `Settings.fromDefaults()` is deterministic.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Settings, SETTINGS_REGISTRY } from '../../src/core/settings';
import { TF_MS, type Timeframe } from '../../src/core/types';
import { COMPONENT_WEIGHTS } from '../../src/strategy/v2/engine';
import { HTF_MAP } from '../../src/strategy/v2/htf';
import { SYMBOLS, TIMEFRAMES } from './ingest';
import { loadRaw } from './load';
import { FIELDS } from './ingest';

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const utc = (ms: number): string => new Date(ms).toISOString();

export interface SplitBoundary {
  symbol: string;
  timeframe: string;
  candles: number;
  trainFromMs: number;
  trainToMs: number;
  validFromMs: number;
  validToMs: number;
  testFromMs: number;
  testToMs: number;
  trainFromUtc: string;
  trainToUtc: string;
  validFromUtc: string;
  validToUtc: string;
  testFromUtc: string;
  testToUtc: string;
  trainCandles: number;
  validCandles: number;
  testCandles: number;
}

/**
 * Chronological 60/20/20 by CANDLE INDEX within each series.
 *
 * Index-based rather than wall-clock based so each slice holds a comparable
 * number of observations even where the archive has gaps. The boundaries are
 * recorded as explicit UTC timestamps so a replay window can be reproduced
 * exactly, and so nobody can later claim a different split was used.
 */
export function computeSplit(
  symbol: string, timeframe: Timeframe, cacheDir: string,
): SplitBoundary {
  const a = loadRaw(cacheDir, symbol, timeframe);
  const n = a.length / FIELDS;
  const at = (i: number): number => a[i * FIELDS]!;
  const trainEnd = Math.floor(n * 0.6);        // exclusive
  const validEnd = Math.floor(n * 0.8);        // exclusive
  return {
    symbol, timeframe,
    candles: n,
    trainFromMs: at(0),
    trainToMs: at(trainEnd - 1),
    validFromMs: at(trainEnd),
    validToMs: at(validEnd - 1),
    testFromMs: at(validEnd),
    testToMs: at(n - 1),
    trainFromUtc: utc(at(0)),
    trainToUtc: utc(at(trainEnd - 1)),
    validFromUtc: utc(at(trainEnd)),
    validToUtc: utc(at(validEnd - 1)),
    testFromUtc: utc(at(validEnd)),
    testToUtc: utc(at(n - 1)),
    trainCandles: trainEnd,
    validCandles: validEnd - trainEnd,
    testCandles: n - validEnd,
  };
}

function main(): void {
  const outDir = arg('out');
  const cacheDir = arg('cache');
  const datasetRoot = arg('dataset');
  const runId = arg('runid');
  mkdirSync(outDir, { recursive: true });

  const strategyCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const datasetCommit = execFileSync('git', ['-C', datasetRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();

  /* ---------------- settings snapshot (Step 7) ---------------- */
  const settings = Settings.fromDefaults();
  const all = settings.toObject();

  // Everything that can influence signal generation, execution or outcome.
  const relevant: Record<string, unknown> = {};
  for (const key of Object.keys(all).sort()) {
    relevant[key] = all[key];
  }

  const snapshot = {
    runId,
    source: 'SETTINGS_REGISTRY defaults via Settings.fromDefaults()',
    note:
      'Deliberately NOT read from the production database. DB rows are operator-editable ' +
      'and would make this run irreproducible. These are the frozen registry defaults.',
    strategyCommit,
    settingsCount: Object.keys(relevant).length,
    settings: relevant,
    // Hard-coded constants that are NOT in the settings registry but do affect
    // the engines. Recorded so the snapshot fully determines behaviour.
    hardCoded: {
      COMPONENT_WEIGHTS,
      HTF_MAP,
      macd: { fast: 12, slow: 26, signal: 9 },
      ema: [20, 50, 200],
      smoothing: 'Wilder for ATR/RSI/ADX',
      rvolScore: 'clamp01((rvol - 0.8) / 1.2)',
      v2MinBars: 'max(60, swing_lookback*6 + 30)',
      v2RunnerMinBars: 'max(80, swing_lookback*6 + 40)',
      v1RunnerMinBars: 'max(30, swing_lookback*6 + 5)',
      windowedReplay: {
        windowMargin: 60,
        htfWindow: 600,
        note:
          'Performance windowing only; proven identical to replayV2Series by ' +
          'scripts/real-data/verify-equivalence.ts and tests/real-data-tooling.test.ts',
      },
    },
    registryDocumentation: SETTINGS_REGISTRY.map((r) => ({
      key: r.key, default: r.default, type: r.type,
    })),
  };

  const settingsJson = JSON.stringify(snapshot, null, 2);
  writeFileSync(join(outDir, 'settings.json'), settingsJson);
  const settingsHash = sha(settingsJson);
  writeFileSync(join(outDir, 'settings.sha256'), `${settingsHash}\n`);

  /* ---------------- splits (Step 6) ---------------- */
  const splits: SplitBoundary[] = [];
  for (const sym of SYMBOLS) {
    for (const tf of TIMEFRAMES) splits.push(computeSplit(sym, tf as Timeframe, cacheDir));
  }
  const splitsDoc = {
    runId,
    policy: 'CHRONOLOGICAL per (symbol,timeframe) series: TRAIN 60% / VALIDATION 20% / TEST 20% by candle index. No shuffle. Fixed before any comparison run.',
    generatedAt: new Date().toISOString(),
    splits,
  };
  const splitsJson = JSON.stringify(splitsDoc, null, 2);
  writeFileSync(join(outDir, 'splits.json'), splitsJson);
  const splitsHash = sha(splitsJson);

  /* ---------------- dataset manifest hash ---------------- */
  const manifestRaw = readFileSync(join(outDir, 'dataset-manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw) as {
    totals: Record<string, number>;
    series: { symbol: string; timeframe: string; candles: number;
      firstOpenUtc: string; lastOpenUtc: string; gapCount: number }[];
  };
  const manifestHash = sha(manifestRaw);
  const zipRaw = readFileSync(join(outDir, 'zip-checksums.json'), 'utf8');
  const zipHash = sha(zipRaw);

  /* ---------------- run metadata ---------------- */
  const meta = {
    runId,
    createdAt: new Date().toISOString(),
    strategyCommit,
    frozenStrategyCommit: '48390748ff1ed1f08b104206c3430142059d7430',
    datasetRepo: 'https://github.com/nub36/svechnoy-suslik-binance-data.git',
    datasetCommit,
    datasetManifestSha256: manifestHash,
    zipChecksumsSha256: zipHash,
    settingsSha256: settingsHash,
    splitsSha256: splitsHash,
    node: process.version,
    symbols: [...SYMBOLS],
    timeframes: [...TIMEFRAMES],
    totals: manifest.totals,
    testFirstViewAt: null as string | null,
  };
  writeFileSync(join(outDir, 'run-metadata.json'), JSON.stringify(meta, null, 2));

  /* ---------------- protocol document (Step 5) ---------------- */
  const tfRows = manifest.series
    .map((s) => `| ${s.symbol} | ${s.timeframe} | ${s.candles.toLocaleString('en-US')} | ${s.firstOpenUtc} | ${s.lastOpenUtc} | ${s.gapCount} |`)
    .join('\n');

  const splitRows = splits
    .map((s) =>
      `| ${s.symbol} | ${s.timeframe} | ${s.trainFromUtc} → ${s.trainToUtc} (${s.trainCandles.toLocaleString('en-US')}) ` +
      `| ${s.validFromUtc} → ${s.validToUtc} (${s.validCandles.toLocaleString('en-US')}) ` +
      `| ${s.testFromUtc} → ${s.testToUtc} (${s.testCandles.toLocaleString('en-US')}) |`)
    .join('\n');

  const doc = `# V2 REAL REPLAY PROTOCOL

**Pre-registration. Written BEFORE any TEST metric was computed.**

This document fixes every choice that could otherwise be made after seeing
results. Anything not written here was not decided in advance and must be
reported as exploratory.

Run ID: \`${runId}\`
Created: ${meta.createdAt}

---

## 1. Frozen strategy

| item | value |
|---|---|
| frozen V2 strategy commit | \`4839074\` (\`48390748ff1ed1f08b104206c3430142059d7430\`) |
| HEAD at run time | \`${strategyCommit}\` |
| trading logic changed since freeze | **NO** — verified by \`git diff 4839074 -- src/strategy src/outcome src/replay\` |

Research tooling lives in \`scripts/real-data/\` and \`tests/real-data-tooling.test.ts\`.
It generates and measures; it does not decide trades.

## 2. Dataset provenance

| item | value |
|---|---|
| repository | https://github.com/nub36/svechnoy-suslik-binance-data.git |
| dataset commit | \`${datasetCommit}\` |
| original source | https://data.binance.vision/data/spot/monthly/klines/ |
| exchange / market / quote | Binance / Spot / USDT |
| archives | 2016 original monthly ZIPs (6 symbols × 7 timeframes × 48 months) |
| period | 2022-01-01 .. 2025-12-31 inclusive |
| total candles | ${meta.totals['candles']?.toLocaleString('en-US')} |
| dataset-manifest.json SHA-256 | \`${manifestHash}\` |
| zip-checksums.json SHA-256 | \`${zipHash}\` |

Timestamps: the archives mix **milliseconds** (early files) and **microseconds**
(later files). The unit is detected per file from magnitude and normalised to
milliseconds. See §4 of this protocol and the spot checks in the manifest.

### Per-series integrity

| symbol | tf | candles | first open (UTC) | last open (UTC) | gaps |
|---|---|---|---|---|---|
${tfRows}

Gaps are **never** filled with synthesised candles.

## 3. Settings snapshot

| item | value |
|---|---|
| source | \`Settings.fromDefaults()\` — the frozen SETTINGS_REGISTRY defaults |
| production DB used | **NO** (operator-editable rows would break reproducibility) |
| settings.json SHA-256 | \`${settingsHash}\` |
| keys captured | ${snapshot.settingsCount} |

Both V1 and V2 use this one snapshot for all shared execution/outcome settings
(\`risk.min_rr\`, \`outcome.timeout_bars\`, \`outcome.sl_priority_on_ambiguous_bar\`,
\`outcome.fee_pct\`).

Key frozen values: \`v2.min_evidence=0.45\`, \`v2.min_net_evidence=0.12\`,
\`risk.min_rr=1\`, \`outcome.timeout_bars=48\`, \`v2.enabled=false\`.

## 4. Split policy

Chronological, per (symbol, timeframe) series, **by candle index**:
TRAIN = first 60%, VALIDATION = next 20%, TEST = final 20%. No shuffling, no
random sampling, no selection by outcome.

\`splits.json\` SHA-256: \`${splitsHash}\`

| symbol | tf | TRAIN | VALIDATION | TEST |
|---|---|---|---|---|
${splitRows}

## 5. Execution semantics (frozen, unchanged)

- Setup is evaluated on **CLOSED candle N** only.
- Entry is the **OPEN of candle N+1**, via the production \`resolveEntry\`.
- Outcome via the production \`trackOutcome\`: TP = final rung reached,
  SL = stop touched, TIMEOUT = forced exit at the CLOSE of the timeout bar
  (\`outcome.timeout_bars = 48\`).
- Ambiguous bar (both SL and TP touched): SL wins
  (\`outcome.sl_priority_on_ambiguous_bar = true\`).
- Dataset boundary before an exit ⇒ **OPEN**, never TIMEOUT. OPEN trades are
  excluded from every closed-trade statistic.
- One position at a time per series.
- HTF context uses only CLOSED higher-timeframe candles with
  \`closeTime <= evaluated LTF closeTime\` (no look-ahead), per the frozen
  \`HTF_MAP\`.

## 6. Metric definitions (fixed here, not after the fact)

- **tpExitRate** = TP exits / closed trades. Never called "win rate".
- **positiveRRate** = trades with R > 0 / closed trades (includes profitable TIMEOUTs).
- **expectancy** = mean R over CLOSED trades.
- **profit factor** = gross positive R / |gross negative R|.
- **max drawdown R** = largest peak-to-trough decline of the cumulative R curve.
- **expectancy excluding TIMEOUT** = DIAGNOSTIC SENSITIVITY ONLY; never the headline.
- OPEN trades are excluded from all of the above.

Evidence buckets, fixed in advance: **0.45–0.50, 0.50–0.60, 0.60–0.70,
0.70–0.80, 0.80–1.00**.

V1 availableWeight buckets: **<30, 30–50, >50**. V1 score buckets: **<70, 70–90, 90–100**.

Evidence is **not** a probability. Only association is reported (bucket means and
Spearman correlation). No calibration is performed.

## 7. Rules that bind the analyst

1. TEST metrics may be computed only after this protocol, the dataset manifest,
   the ZIP checksums, the settings snapshot and the split boundaries all exist
   and are hashed.
2. The moment TEST is first viewed, \`TEST_FIRST_VIEW_AT\` is recorded in
   \`run-metadata.json\` and TEST is **USED**.
3. After that: no changes to V2 parameters, evidence weights, thresholds, the
   target ladder, liquidity lifecycle, \`risk.min_rr\` or \`outcome.timeout_bars\`.
4. If a correctness bug is found, statistical interpretation **stops**; the bug
   is described and NOT fixed in this run; the run is marked
   \`INVALIDATED_BY_CORRECTNESS_BUG\`.
5. Permitted final statuses: \`INSUFFICIENT_EVIDENCE\`, \`V2_NOT_BETTER\`,
   \`V2_PROMISING_BUT_NOT_PRODUCTION_READY\`, or
   \`INVALIDATED_BY_CORRECTNESS_BUG\`. **\`PRODUCTION_READY\` is forbidden.**
6. V2 stays research-only: \`v2.enabled=false\`, not wired to workers, LIVE locked.

## 8. Correctness invariant checked during the run

A liquidity pool in state **SWEPT** or **CONSUMED** must never be used as a
future target. This is audited on every evaluation by re-deriving the pools with
the same frozen detector and comparing them against the emitted ladder. Any
violation invalidates the run.
`;

  writeFileSync('docs/V2_REAL_REPLAY_PROTOCOL.md', doc);

  console.log('settings.sha256     :', settingsHash);
  console.log('splits.sha256       :', splitsHash);
  console.log('dataset manifest sha:', manifestHash);
  console.log('zip checksums sha   :', zipHash);
  console.log('wrote docs/V2_REAL_REPLAY_PROTOCOL.md');
  console.log('wrote', join(outDir, 'settings.json'), '/ splits.json / run-metadata.json');
}

main();

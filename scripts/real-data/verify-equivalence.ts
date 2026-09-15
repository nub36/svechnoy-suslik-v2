/**
 * EQUIVALENCE PROOF — windowed replay vs the frozen `replayV2Series`.
 *
 * The windowed replay exists only to make the run tractable (367x faster). It
 * is worthless if it changes even one trade, so this compares the two engines
 * trade-for-trade on REAL Binance candles and exits non-zero on any divergence.
 *
 * Every field that could affect a statistic is compared exactly: direction,
 * times, prices, stop, the whole target ladder, result, R, bars held, evidence,
 * setup kind, HTF alignment, and the evaluation/WAIT counters.
 *
 * Usage:
 *   npx tsx scripts/real-data/verify-equivalence.ts --cache=<dir> [--bars=4000]
 */

import { Settings } from '../../src/core/settings';
import type { Timeframe } from '../../src/core/types';
import { replayV2Series, type V2Trade } from '../../src/replay/v2-runner';
import { HTF_MAP } from '../../src/strategy/v2/htf';
import { loadSeries, hasSeries } from './load';
import { replayV2Windowed } from './windowed-replay';

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

const KEYS: (keyof V2Trade)[] = [
  'symbol', 'timeframe', 'direction', 'score', 'setupCandleTime', 'entryCandleTime',
  'entryPrice', 'stopLoss', 'result', 'exitPrice', 'exitCandleTime', 'barsHeld',
  'rMultiple', 'pnlPct', 'setupKind', 'location', 'htfAlignment', 'evidence',
  'conflict', 'netEvidence', 'adxRegime', 'rsiBucket', 'emaAlignment', 'macdState',
  'rvolBucket', 'fibZone', 'hasOb', 'hasFvg', 'sweepQuality', 'breakoutQuality',
  'roomR', 'atrAtSetup', 'riskDistance', 'riskAtr', 'stopAnchor',
  'tp1Price', 'tp1R', 'tp2Price', 'tp2R', 'tp3Price', 'tp3R',
  'firstTargetR', 'nextStructuralR', 'finalTargetR', 'rangeBrokenSide',
];

function diffTrade(a: V2Trade, b: V2Trade): string[] {
  const out: string[] = [];
  for (const k of KEYS) {
    const x = a[k], y = b[k];
    if (typeof x === 'number' && typeof y === 'number') {
      if (!(Object.is(x, y) || Math.abs(x - y) < 1e-9)) out.push(`${String(k)}: ${x} vs ${y}`);
    } else if (x !== y) {
      out.push(`${String(k)}: ${String(x)} vs ${String(y)}`);
    }
  }
  const ta = a.takeProfits, tb = b.takeProfits;
  if (ta.length !== tb.length) out.push(`takeProfits.length: ${ta.length} vs ${tb.length}`);
  else {
    for (let i = 0; i < ta.length; i++) {
      if (Math.abs(ta[i]! - tb[i]!) > 1e-9) out.push(`takeProfits[${i}]: ${ta[i]} vs ${tb[i]}`);
    }
  }
  return out;
}

function main(): void {
  const cache = arg('cache');
  const bars = Number(arg('bars', '4000'));
  const settings = Settings.fromDefaults();

  // Deliberately spans several symbols, both timestamp-unit eras, and every
  // timeframe class (including 1m, where windowing matters most).
  const cases: { sym: string; tf: Timeframe }[] = [
    { sym: 'BTCUSDT', tf: '1m' },
    { sym: 'BTCUSDT', tf: '15m' },
    { sym: 'ETHUSDT', tf: '5m' },
    { sym: 'ETHUSDT', tf: '1h' },
    { sym: 'SOLUSDT', tf: '30m' },
    { sym: 'XRPUSDT', tf: '4h' },
    { sym: 'DOGEUSDT', tf: '1d' },
    { sym: 'BNBUSDT', tf: '1h' },
  ];

  let failures = 0;
  let comparedTrades = 0;

  for (const c of cases) {
    if (!hasSeries(cache, c.sym, c.tf)) { console.log(`skip ${c.sym} ${c.tf}`); continue; }
    const full = loadSeries(cache, c.sym, c.tf);
    // Use a trailing slab: enough bars to exercise real behaviour, small enough
    // that the O(n^2) reference implementation finishes.
    const candles = full.slice(Math.max(0, full.length - bars));

    const htf: Partial<Record<Timeframe, ReturnType<typeof loadSeries>>> = {};
    for (const h of HTF_MAP[c.tf] ?? []) {
      if (!hasSeries(cache, c.sym, h)) continue;
      const hc = loadSeries(cache, c.sym, h);
      // Keep only HTF bars overlapping the tested window (plus history).
      const firstOpen = candles[0]!.openTime;
      const start = hc.findIndex((x) => x.openTime >= firstOpen);
      htf[h] = hc.slice(Math.max(0, (start < 0 ? hc.length : start) - 700));
    }

    const t0 = Date.now();
    const ref = replayV2Series({
      symbol: c.sym, timeframe: c.tf, candles, settings, htfCandles: htf,
    });
    const t1 = Date.now();
    const win = replayV2Windowed({
      symbol: c.sym, timeframe: c.tf, candles, settings, htfCandles: htf,
    });
    const t2 = Date.now();

    const problems: string[] = [];
    if (ref.evaluations !== win.evaluations) {
      problems.push(`evaluations ${ref.evaluations} vs ${win.evaluations}`);
    }
    if (ref.waits !== win.waits) problems.push(`waits ${ref.waits} vs ${win.waits}`);
    if (ref.trades.length !== win.trades.length) {
      problems.push(`trades ${ref.trades.length} vs ${win.trades.length}`);
    } else {
      for (let i = 0; i < ref.trades.length; i++) {
        const d = diffTrade(ref.trades[i]!, win.trades[i]!);
        if (d.length > 0) problems.push(`trade[${i}]: ${d.join('; ')}`);
      }
    }
    comparedTrades += ref.trades.length;

    const ok = problems.length === 0;
    if (!ok) failures++;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${c.sym.padEnd(8)} ${String(c.tf).padEnd(4)} ` +
      `bars=${candles.length} trades=${ref.trades.length} ` +
      `evals=${ref.evaluations} waits=${ref.waits} ` +
      `ref=${t1 - t0}ms win=${t2 - t1}ms speedup=${((t1 - t0) / Math.max(1, t2 - t1)).toFixed(0)}x`,
    );
    for (const p of problems.slice(0, 10)) console.log('      ! ' + p);
  }

  console.log('');
  console.log(`compared ${comparedTrades} trades across ${cases.length} series`);
  if (failures > 0) {
    console.log(`EQUIVALENCE FAILED in ${failures} series — windowed replay is NOT usable.`);
    process.exit(1);
  }
  console.log('EQUIVALENCE PROVEN: windowed replay is identical to replayV2Series.');
}

main();

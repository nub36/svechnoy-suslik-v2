/**
 * DEFINITIVE liquidity-lifecycle invariant audit.
 *
 * The invariant: a liquidity pool that is SWEPT or CONSUMED must never be used
 * as a future target.
 *
 * The first audit attempt produced 312,866 "violations" and was WRONG. Two
 * defects, both in the audit rather than in the strategy:
 *
 *   1. It recomputed pools over the wrong window. `evaluateV2` builds pools
 *      from `visible.slice(-lookback)` (300 bars); the audit passed the whole
 *      360-bar evaluation slice, so it saw a DIFFERENT pool set than the engine
 *      and compared apples to oranges.
 *
 *   2. It flagged any target lying merely NEAR a taken pool. EQUILIBRIUM and
 *      RANGE_EDGE rungs are geometric levels (range mid / far edge) and are not
 *      sourced from pools at all, so their proximity to a swept pool is not a
 *      lifecycle breach — those two bases accounted for 245,783 of the flags.
 *
 * This version reproduces the engine's window EXACTLY and tests the only thing
 * the invariant actually claims: that no INTERNAL_LIQUIDITY target was sourced
 * from a pool whose state is SWEPT or CONSUMED. It re-derives pools with the
 * frozen detector and checks each liquidity-derived target against the pool it
 * must have come from (exact price identity, since buildTargets copies
 * `p.price` verbatim).
 *
 * Usage:
 *   npx tsx scripts/real-data/audit-liquidity-invariant.ts --cache=<dir> --out=<file> [--bars=60000]
 */

import { writeFileSync } from 'node:fs';
import { Settings } from '../../src/core/settings';
import type { Candle, Timeframe } from '../../src/core/types';
import { evaluateV2 } from '../../src/strategy/v2/engine';
import { findSwingsV2, findLiquidityPools } from '../../src/strategy/v2/structure';
import { HTF_MAP } from '../../src/strategy/v2/htf';
import { hasSeries, loadSeries } from './load';
import { SYMBOLS, TIMEFRAMES } from './ingest';

function arg(name: string, def?: string): string {
  const v = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (v === undefined && def === undefined) throw new Error(`missing --${name}`);
  return v ?? def!;
}

interface Violation {
  symbol: string; timeframe: string; timeUtc: string; detail: string;
}

function main(): void {
  const cache = arg('cache');
  const outFile = arg('out');
  const bars = Number(arg('bars', '60000'));
  const settings = Settings.fromDefaults();

  const swingStrength = Math.floor(settings.num('engine.swing_lookback'));
  const lookback = Math.floor(settings.num('engine.lookback_candles'));
  const tolAtr = settings.num('v2.liquidity_tol_atr');
  const sweepPen = settings.num('v2.sweep_min_penetration_atr');
  const acceptance = settings.num('v2.breakout_min_close_atr');

  const census: Record<string, number> = { FRESH: 0, TOUCHED: 0, SWEPT: 0, CONSUMED: 0 };
  let evaluations = 0;
  let targetsTotal = 0;
  let targetsFromLiquidity = 0;
  let targetsFromRestingPool = 0;
  let liquidityTargetsUnmatched = 0;
  const violations: Violation[] = [];

  for (const symbol of SYMBOLS) {
    for (const tf of TIMEFRAMES as Timeframe[]) {
      if (!hasSeries(cache, symbol, tf)) continue;
      const full = loadSeries(cache, symbol, tf);
      const candles = full.slice(Math.max(0, full.length - bars));

      const htf: Partial<Record<Timeframe, readonly Candle[]>> = {};
      for (const h of HTF_MAP[tf] ?? []) {
        if (hasSeries(cache, symbol, h)) htf[h] = loadSeries(cache, symbol, h);
      }

      const minBars = Math.max(80, swingStrength * 6 + 40);
      for (let i = minBars; i < candles.length; i++) {
        const setup = evaluateV2({
          symbol, timeframe: tf, candles, atIndex: i, settings, htfCandles: htf,
        });
        if (!setup) continue;
        evaluations++;
        const atr = setup.atr.atr;
        if (atr === null || atr <= 0) continue;

        // Reproduce the engine's window EXACTLY: evaluateV2 uses
        // visible.slice(visible.length - lookback) where visible = [0..i].
        const visible = candles.slice(0, i + 1);
        const window = visible.slice(Math.max(0, visible.length - lookback));
        const wi = window.length - 1;
        const swings = findSwingsV2(window, swingStrength);
        const pools = findLiquidityPools(window, swings, wi, atr, tolAtr, lookback, {
          sweepPenetrationAtr: sweepPen, acceptanceAtr: acceptance,
        });
        for (const p of pools) census[p.state] = (census[p.state] ?? 0) + 1;

        for (const t of setup.targets) {
          targetsTotal++;
          if (t.basis !== 'INTERNAL_LIQUIDITY') continue;
          targetsFromLiquidity++;
          // buildTargets copies the pool price verbatim, so the source pool is
          // identifiable by exact price equality.
          const src = pools.filter((p) => p.price === t.price);
          if (src.length === 0) { liquidityTargetsUnmatched++; continue; }
          // If ANY pool at that exact price is still resting, the target is
          // legitimately sourced.
          if (src.some((p) => p.resting)) { targetsFromRestingPool++; continue; }
          violations.push({
            symbol, timeframe: tf,
            timeUtc: new Date(setup.time).toISOString(),
            detail:
              `INTERNAL_LIQUIDITY target @${t.price} matched only non-resting pools ` +
              `[${src.map((p) => p.state).join(',')}]`,
          });
        }
      }
      console.log(
        `${symbol.padEnd(8)} ${String(tf).padEnd(4)} evals=${evaluations} ` +
        `liqTargets=${targetsFromLiquidity} violations=${violations.length}`,
      );
    }
  }

  const doc = {
    invariant: 'A SWEPT or CONSUMED liquidity pool must never be used as a future target.',
    method:
      'Re-derives pools with the frozen findLiquidityPools over the EXACT window ' +
      'evaluateV2 uses (visible.slice(-lookback)), then checks every ' +
      'INTERNAL_LIQUIDITY target against the pool it was copied from. ' +
      'EQUILIBRIUM / RANGE_EDGE / R_MULTIPLE rungs are geometric levels, not ' +
      'pool-sourced, and are correctly out of scope.',
    barsPerSeries: bars,
    evaluations,
    poolStateCensus: census,
    targetsTotal,
    targetsFromLiquidity,
    targetsFromRestingPool,
    liquidityTargetsUnmatched,
    violations: violations.length,
    verdict: violations.length === 0 ? 'INVARIANT_HELD' : 'INVARIANT_VIOLATED',
    violationSamples: violations.slice(0, 25),
  };
  writeFileSync(outFile, JSON.stringify(doc, null, 2));
  console.log('');
  console.log('pool census        :', JSON.stringify(census));
  console.log('liquidity targets  :', targetsFromLiquidity,
    '(resting-matched', targetsFromRestingPool, ', unmatched', liquidityTargetsUnmatched, ')');
  console.log('VERDICT            :', doc.verdict, `(${violations.length} violations)`);
  writeFileSync(outFile, JSON.stringify(doc, null, 2));
}

main();

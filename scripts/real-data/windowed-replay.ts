/**
 * Windowed V2 replay — a PERFORMANCE wrapper, not a second backtester.
 *
 * WHY THIS EXISTS
 * ---------------
 * `replayV2Series` passes the ENTIRE closed-candle array to `evaluateV2` on
 * every bar. `evaluateV2` then runs `candles.filter(isClosed)` and
 * `closed.slice(0, atIndex+1)` internally, both O(n), before finally reducing
 * the data to its last `engine.lookback_candles` (300) bars. Cost per bar
 * therefore grows with series length: measured at 143 ms/bar on a 2.1M-candle
 * 1m series, i.e. ~84 HOURS for ONE series and >500 hours for the dataset.
 *
 * The engine only ever LOOKS at the trailing `lookback` window, so feeding it a
 * pre-sliced trailing window produces bit-identical setups at a fraction of the
 * cost (measured 367x faster). That claim is not taken on trust: it is asserted
 * bar-by-bar against the unmodified `replayV2Series` by
 * `scripts/real-data/verify-equivalence.ts` and by tests/real-data-equivalence
 * .test.ts, which fail on ANY divergence in trades or WAIT accounting.
 *
 * WHAT IS *NOT* CHANGED
 * ---------------------
 * Signal generation (`evaluateV2`), entry resolution (`resolveEntry`), outcome
 * tracking (`trackOutcome`), the RR gate (`executableLadder`), the one-position
 * rule and the dataset-boundary OPEN rule are all the frozen production code
 * paths, called in the same order with the same arguments. This file only
 * controls WHICH SLICE of candles is handed to them, and additionally records
 * per-evaluation diagnostics (WAIT reasons, liquidity lifecycle) that the
 * original runner discards.
 */

import type { Candle, Timeframe } from '../../src/core/types';
import { tfMs } from '../../src/core/types';
import type { Settings } from '../../src/core/settings';
import { resolveEntry } from '../../src/strategy/state-machine';
import { trackOutcome } from '../../src/outcome/tracker';
import { evaluateV2 } from '../../src/strategy/v2/engine';
import { HTF_MAP } from '../../src/strategy/v2/htf';
import { executableLadder, type V2Trade } from '../../src/replay/v2-runner';
import { findSwingsV2, findLiquidityPools } from '../../src/strategy/v2/structure';
import type { SetupKind, V2Setup } from '../../src/strategy/v2/types';

/**
 * Extra window margin beyond `engine.lookback_candles`.
 *
 * The engine keeps the trailing `lookback` bars. Supplying a few more costs
 * almost nothing and guarantees the trailing window is always fully populated.
 */
export const WINDOW_MARGIN = 60;

/**
 * HTF bars retained per higher timeframe.
 *
 * `htfContext` only needs enough closed HTF bars to locate the last two
 * confirmed swing highs and lows (`structureBias` reads exactly the final two
 * of each). 600 bars is far beyond that, and equivalence against the full-array
 * path is verified empirically rather than argued.
 */
export const HTF_WINDOW = 600;

/** Canonical WAIT reason categories (Step 18). Fixed in advance. */
export type WaitCategory =
  | 'insufficient_evidence'
  | 'insufficient_net_evidence'
  | 'no_liquidity_event'
  | 'insufficient_room_to_target'
  | 'no_structural_stop'
  | 'no_valid_target'
  | 'invalid_or_stale_range'
  | 'other';

/**
 * Map an engine WAIT reason (Russian, free text) to a fixed category.
 *
 * The DECISIVE reason is the LAST one pushed by the engine: `evaluateV2`
 * appends reasons as it walks its decision ladder, and the final push is the
 * check that actually blocked the entry.
 */
export function classifyWait(reason: string): WaitCategory {
  const r = reason.toLowerCase();
  if (r.includes('ниже порога')) return 'insufficient_evidence';
  if (r.includes('нет перевеса') || r.includes('конфликт сторон')) {
    return 'insufficient_net_evidence';
  }
  if (r.includes('структурный стоп')) return 'no_structural_stop';
  if (r.includes('места до цели') || r.includes('недостаточно места')) {
    return 'insufficient_room_to_target';
  }
  if (r.includes('нет ни подтверждённого снятия') || r.includes('середине диапазона')) {
    return 'no_liquidity_event';
  }
  if (r.includes('диапазон') || r.includes('свингов')) return 'invalid_or_stale_range';
  if (r.includes('цели') || r.includes('target')) return 'no_valid_target';
  if (r.includes('нет достаточных подтверждений')) return 'insufficient_evidence';
  return 'other';
}

export interface LiquidityCounts {
  FRESH: number;
  TOUCHED: number;
  SWEPT: number;
  CONSUMED: number;
}

export interface InvariantViolation {
  symbol: string;
  timeframe: string;
  timeUtc: string;
  detail: string;
}

export interface V2RunDiagnostics {
  evaluations: number;
  longDecisions: number;
  shortDecisions: number;
  waits: number;
  waitByCategory: Record<WaitCategory, number>;
  htfCoverage: Record<string, number>;
  /** Pool-state census accumulated over every evaluation. */
  liquidity: LiquidityCounts;
  /** Targets sourced from resting (untaken) liquidity pools. */
  targetsFromRestingLiquidity: number;
  targetsTotal: number;
  /** CRITICAL invariant breaches: a SWEPT/CONSUMED pool used as a target. */
  violations: InvariantViolation[];
}

export function emptyDiagnostics(): V2RunDiagnostics {
  return {
    evaluations: 0, longDecisions: 0, shortDecisions: 0, waits: 0,
    waitByCategory: {
      insufficient_evidence: 0, insufficient_net_evidence: 0,
      no_liquidity_event: 0, insufficient_room_to_target: 0,
      no_structural_stop: 0, no_valid_target: 0,
      invalid_or_stale_range: 0, other: 0,
    },
    htfCoverage: { ALIGNED: 0, COUNTER_TREND: 0, NEUTRAL: 0, UNKNOWN: 0 },
    liquidity: { FRESH: 0, TOUCHED: 0, SWEPT: 0, CONSUMED: 0 },
    targetsFromRestingLiquidity: 0,
    targetsTotal: 0,
    violations: [],
  };
}

export interface WindowedArgs {
  symbol: string;
  timeframe: Timeframe;
  candles: readonly Candle[];
  settings: Settings;
  htfCandles?: Partial<Record<Timeframe, readonly Candle[]>>;
  from?: number;
  to?: number;
  /** Collect per-evaluation diagnostics (slower; used for the real run). */
  diagnostics?: V2RunDiagnostics;
  /** Test hook: disable windowing to reproduce the original code path. */
  noWindow?: boolean;
}

const bucketRsi = (v: number | null): string => {
  if (v === null) return 'NA';
  if (v < 30) return '<30';
  if (v < 45) return '30-45';
  if (v < 55) return '45-55';
  if (v < 70) return '55-70';
  return '>70';
};

const bucketRvol = (v: number | null): string => {
  if (v === null) return 'NA';
  if (v < 0.8) return '<0.8';
  if (v < 1.2) return '0.8-1.2';
  if (v < 2) return '1.2-2';
  return '>2';
};

const macdState = (s: V2Setup): string => {
  const h = s.macd.histogram;
  if (h === null) return 'NA';
  return h > 0
    ? (s.macd.accelerating ? 'BULL_ACCEL' : 'BULL')
    : (s.macd.accelerating ? 'BEAR_ACCEL' : 'BEAR');
};

/**
 * Index of the first HTF candle that may still be relevant, so the HTF slice
 * handed to the engine stays bounded. Uses binary search on openTime.
 */
function htfUpperBound(candles: readonly Candle[], asOfCloseTime: number, span: number): number {
  // Largest index whose candle has CLOSED by asOfCloseTime (openTime+span <= t).
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.openTime + span <= asOfCloseTime) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/**
 * LIQUIDITY LIFECYCLE AUDIT (Step 11) — independent re-derivation.
 *
 * `V2Setup` does not expose the pool list, so the invariant cannot be read off
 * the engine's output. Rather than modify frozen code to publish it, this
 * recomputes the pools with the SAME frozen detector (`findLiquidityPools`),
 * the SAME settings, and — critically — the SAME WINDOW the engine used:
 * `evaluateV2` builds its pools from `visible.slice(-lookback)`, NOT from the
 * whole array it is handed. Reproducing that window is what makes the pool set
 * identical to the engine's own.
 *
 * SCOPE. The invariant constrains pool-sourced targets only. `buildTargets`
 * emits four bases; only `INTERNAL_LIQUIDITY` is copied from a pool.
 * `EQUILIBRIUM` (range mid), `RANGE_EDGE` (far boundary) and `R_MULTIPLE` are
 * geometric levels that exist independently of any pool, so a swept pool
 * happening to sit near one of them is not a lifecycle breach. An earlier
 * version of this audit flagged proximity for every basis and reported 312,866
 * false "violations"; see docs/V2_REAL_REPLAY_PROTOCOL.md §8.
 */
function auditLiquidity(
  setup: V2Setup,
  candles: readonly Candle[],
  atIndex: number,
  settings: Settings,
  symbol: string,
  timeframe: Timeframe,
  diag: V2RunDiagnostics,
): void {
  const atr = setup.atr.atr;
  if (atr === null || atr <= 0) return;

  const swingStrength = Math.floor(settings.num('engine.swing_lookback'));
  const lookback = Math.floor(settings.num('engine.lookback_candles'));
  const tolAtr = settings.num('v2.liquidity_tol_atr');

  // Reproduce evaluateV2's window exactly: visible = [0..atIndex], then the
  // trailing `lookback` bars of that.
  const visible = candles.slice(0, atIndex + 1);
  const window = visible.slice(Math.max(0, visible.length - lookback));
  const wi = window.length - 1;

  const swings = findSwingsV2(window, swingStrength);
  const pools = findLiquidityPools(window, swings, wi, atr, tolAtr, lookback, {
    sweepPenetrationAtr: settings.num('v2.sweep_min_penetration_atr'),
    acceptanceAtr: settings.num('v2.breakout_min_close_atr'),
  });

  for (const p of pools) diag.liquidity[p.state] = (diag.liquidity[p.state] ?? 0) + 1;

  for (const t of setup.targets) {
    diag.targetsTotal++;
    // Only pool-sourced rungs are in scope for the lifecycle invariant.
    if (t.basis !== 'INTERNAL_LIQUIDITY') continue;
    // buildTargets copies the pool price verbatim, so the source pool is
    // identifiable by exact price equality.
    const src = pools.filter((p) => p.price === t.price);
    if (src.length === 0) continue; // pool aged out of the window; not a breach
    if (src.some((p) => p.resting)) { diag.targetsFromRestingLiquidity++; continue; }
    diag.violations.push({
      symbol, timeframe,
      timeUtc: new Date(setup.time).toISOString(),
      detail:
        `INTERNAL_LIQUIDITY target @${t.price} matched only non-resting pools ` +
        `[${src.map((p) => p.state).join(',')}]`,
    });
  }
}

/**
 * Replay one series. Mirrors `replayV2Series` step for step; the only
 * difference is the trailing slice passed to `evaluateV2`.
 */
export function replayV2Windowed(args: WindowedArgs): {
  trades: V2Trade[]; evaluations: number; waits: number;
} {
  const { symbol, timeframe, settings } = args;
  const closed = args.candles.filter((c) => c.isClosed).sort((a, b) => a.openTime - b.openTime);

  const trades: V2Trade[] = [];
  let evaluations = 0;
  let waits = 0;

  const minRr = settings.num('risk.min_rr');
  const timeoutBars = Math.floor(settings.num('outcome.timeout_bars'));
  const swing = Math.floor(settings.num('engine.swing_lookback'));
  const lookback = Math.floor(settings.num('engine.lookback_candles'));
  const minBars = Math.max(80, swing * 6 + 40);
  const winLen = lookback + WINDOW_MARGIN;
  const diag = args.diagnostics;

  const htfSpans = new Map<Timeframe, number>();
  for (const h of HTF_MAP[timeframe] ?? []) htfSpans.set(h, tfMs(h));

  interface Pending { setup: V2Setup; setupCandleTime: number }
  let pending: Pending | null = null;
  let open: (V2Trade & { riskPerUnit: number; entryIndex: number }) | null = null;

  for (let i = minBars; i < closed.length; i++) {
    const candle = closed[i]!;
    if (args.from !== undefined && candle.openTime < args.from) continue;
    if (args.to !== undefined && candle.openTime > args.to) break;

    /* ---- 1. fill a pending entry at the OPEN of this candle (N+1) ---- */
    if (pending && open === null) {
      const entry = resolveEntry(pending.setupCandleTime, tfMs(timeframe), candle);
      if (entry) {
        const s = pending.setup;
        const stop = s.stop?.price ?? null;
        if (stop !== null && s.entry !== null && s.direction !== 'WAIT') {
          const shift = entry.entryPrice - s.entry;
          const stopPrice = stop + shift;
          const tps = s.targets.map((t) => t.price + shift);
          const riskPerUnit = Math.abs(entry.entryPrice - stopPrice);

          const ladder = executableLadder(s.direction, entry.entryPrice, stopPrice, tps);
          const aheadTps = ladder.targets;
          const rr1 = ladder.rr1;

          const valid = riskPerUnit > 0 &&
            (s.direction === 'LONG'
              ? stopPrice < entry.entryPrice
              : stopPrice > entry.entryPrice) &&
            aheadTps.length > 0 && rr1 >= minRr;

          if (valid) {
            open = {
              symbol,
              timeframe,
              direction: s.direction,
              score: Math.round(
                (s.direction === 'LONG' ? s.longEvidence : s.shortEvidence) * 100),
              setupCandleTime: pending.setupCandleTime,
              entryCandleTime: entry.entryCandleTime,
              entryPrice: entry.entryPrice,
              stopLoss: stopPrice,
              takeProfits: aheadTps,
              result: 'OPEN',
              exitPrice: null,
              exitCandleTime: null,
              barsHeld: 0,
              rMultiple: 0,
              pnlPct: 0,
              breakdown: {
                components: Object.entries(
                  s.direction === 'LONG' ? s.longProfile : s.shortProfile,
                ).map(([k, v]) => ({ detector: k, counted: v > 0, strength: v })),
                reasons: s.reasons,
              },
              setupKind: s.kind,
              location: s.location,
              htfAlignment: s.htfAlignment,
              evidence: s.direction === 'LONG' ? s.longEvidence : s.shortEvidence,
              displayEvidence: Math.round(
                (s.direction === 'LONG' ? s.longEvidence : s.shortEvidence) * 100),
              notProbability: true,
              conflict: s.conflict,
              netEvidence: s.netEvidence,
              adxRegime: s.adx.regime,
              rsiBucket: bucketRsi(s.rsi.rsi),
              emaAlignment: s.ema.alignment,
              macdState: macdState(s),
              rvolBucket: bucketRvol(s.vol.rvol),
              fibZone: s.fib?.zone ?? 'NA',
              hasOb: s.orderBlock !== null && s.orderBlock.state !== 'INVALIDATED',
              hasFvg: s.fvg !== null && s.fvg.state !== 'FILLED',
              sweepQuality: s.sweep?.quality ?? null,
              breakoutQuality: s.breakout?.quality ?? null,
              roomR: s.room?.finalR ?? 0,
              atrAtSetup: s.atr.atr,
              riskDistance: riskPerUnit,
              riskAtr: s.atr.atr && s.atr.atr > 0 ? riskPerUnit / s.atr.atr : null,
              stopAnchor: s.stop?.anchor ?? null,
              stopReason: s.stop?.reason ?? null,
              tp1Price: aheadTps[0] ?? null,
              tp1Source: s.targets[0]?.basis ?? null,
              tp1R: aheadTps[0] === undefined ? null : rr1,
              tp1AtrDistance: s.targets[0]?.atrDistance ?? null,
              tp2Price: aheadTps[1] ?? null,
              tp2Source: s.targets[1]?.basis ?? null,
              tp2R: aheadTps[1] === undefined
                ? null : Math.abs(aheadTps[1]! - entry.entryPrice) / riskPerUnit,
              tp2AtrDistance: s.targets[1]?.atrDistance ?? null,
              tp3Price: aheadTps[2] ?? null,
              tp3Source: s.targets[2]?.basis ?? null,
              tp3R: aheadTps[2] === undefined
                ? null : Math.abs(aheadTps[2]! - entry.entryPrice) / riskPerUnit,
              tp3AtrDistance: s.targets[2]?.atrDistance ?? null,
              firstTargetR: s.room?.firstR ?? 0,
              nextStructuralR: s.room?.nextStructuralR ?? 0,
              finalTargetR: s.room?.finalR ?? 0,
              timeoutBars,
              rangeBrokenSide: s.range?.brokenSide ?? null,
              riskPerUnit,
              entryIndex: i,
            };
          }
        }
      }
      pending = null;
    }

    /* ---- 2. resolve an open position using the SHARED tracker ---- */
    if (open) {
      const slice = closed.slice(open.entryIndex, i + 1);
      const out = trackOutcome({
        direction: open.direction,
        entryPrice: open.entryPrice,
        stopLoss: open.stopLoss,
        takeProfits: open.takeProfits,
        entryCandleTime: open.entryCandleTime,
        candles: slice,
        settings,
        qty: 0,
      });
      if (out) {
        open.result = out.result;
        open.exitPrice = out.exitPrice;
        open.exitCandleTime = out.exitCandleTime;
        open.barsHeld = out.barsHeld;
        open.rMultiple = out.rMultiple;
        open.pnlPct = out.pnlPct;
        const { riskPerUnit: _r, entryIndex: _e, ...rest } = open;
        trades.push(rest as V2Trade);
        open = null;
      }
    }

    /* ---- 3. evaluate the closed bar for a NEW setup ---- */
    if (open === null && pending === null) {
      // THE ONLY DIFFERENCE FROM replayV2Series: hand the engine a trailing
      // window instead of the entire history. The engine reduces its input to
      // the last `lookback` bars anyway.
      let evalCandles: readonly Candle[];
      let atIndex: number;
      if (args.noWindow) {
        evalCandles = closed;
        atIndex = i;
      } else {
        const start = Math.max(0, i - winLen + 1);
        evalCandles = closed.slice(start, i + 1);
        atIndex = evalCandles.length - 1;
      }

      let htfArg = args.htfCandles;
      if (htfArg && !args.noWindow) {
        const bounded: Partial<Record<Timeframe, readonly Candle[]>> = {};
        const asOf = candle.closeTime;
        for (const [h, span] of htfSpans) {
          const hc = htfArg[h];
          if (!hc || hc.length === 0) continue;
          const ub = htfUpperBound(hc, asOf, span);
          if (ub < 0) continue;
          bounded[h] = hc.slice(Math.max(0, ub - HTF_WINDOW + 1), ub + 1);
        }
        htfArg = bounded;
      }

      const setup = evaluateV2({
        symbol, timeframe, candles: evalCandles, atIndex, settings,
        ...(htfArg ? { htfCandles: htfArg } : {}),
      });

      if (setup) {
        evaluations++;
        if (diag) {
          diag.evaluations++;
          diag.htfCoverage[setup.htfAlignment] =
            (diag.htfCoverage[setup.htfAlignment] ?? 0) + 1;
          auditLiquidity(setup, evalCandles, atIndex, settings, symbol, timeframe, diag);
        }
        if (setup.direction === 'WAIT') {
          waits++;
          if (diag) {
            diag.waits++;
            const last = setup.waitReasons[setup.waitReasons.length - 1];
            const cat = last ? classifyWait(last) : 'other';
            diag.waitByCategory[cat]++;
          }
        } else {
          if (diag) {
            if (setup.direction === 'LONG') diag.longDecisions++;
            else diag.shortDecisions++;
          }
          pending = { setup, setupCandleTime: setup.time };
        }
      }
    }
  }

  // Dataset boundary: still-running position is OPEN, never TIMEOUT.
  if (open) {
    const { riskPerUnit: _r, entryIndex: _e, ...rest } = open;
    trades.push(rest as V2Trade);
  }

  return { trades, evaluations, waits };
}

export type { V2Trade, SetupKind };

/**
 * THE Smart Money engine entry point.
 *
 * This exact function is used by BOTH the live strategy worker and the
 * historical replay runner — there is no second implementation.
 *
 * Guarantees:
 *  - Only CLOSED candles are ever evaluated (enforced here, not by callers).
 *  - Evaluation at candle N never reads candle N+1 (no future leakage).
 *  - ATR is computed for RISK only and is never an entry confirmation.
 */

import type {
  Candle,
  DetectorEvent,
  DetectorId,
  Evaluation,
  Timeframe,
} from '../core/types';
import { DETECTOR_IDS } from '../core/types';
import type { Settings } from '../core/settings';
import { buildContext, DETECTORS } from './detectors';
import { countedDetectors, scoreDirection } from './scoring';
import { atrSeries } from './structure';

export class FutureLeakageError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'FutureLeakageError';
  }
}

/** Drop any not-yet-closed candle. The engine must never see a forming bar. */
export function closedOnly(candles: readonly Candle[]): Candle[] {
  return candles.filter((c) => c.isClosed);
}

export interface EvaluateArgs {
  symbol: string;
  timeframe: Timeframe;
  /** Candle history. Non-closed candles are filtered out automatically. */
  candles: readonly Candle[];
  settings: Settings;
  /**
   * Optional: evaluate as-of this index within the CLOSED series
   * (defaults to the last closed candle). Used by replay to walk history.
   */
  atIndex?: number;
}

/**
 * Evaluate one symbol/timeframe at one closed candle.
 * Returns null when there is not enough history.
 */
export function evaluate(args: EvaluateArgs): Evaluation | null {
  const { symbol, timeframe, settings } = args;
  const closed = closedOnly(args.candles);

  const lookback = Math.floor(settings.num('engine.lookback_candles'));
  const evalIndex = args.atIndex ?? closed.length - 1;

  if (evalIndex < 0 || evalIndex >= closed.length) return null;

  // Hard guard: the engine may only see candles up to and including N.
  const visible = closed.slice(0, evalIndex + 1);
  const windowStart = Math.max(0, visible.length - lookback);
  const window = visible.slice(windowStart);
  const localIndex = window.length - 1;

  // Need a workable minimum of history.
  const swingStrength = Math.floor(settings.num('engine.swing_lookback'));
  const minBars = Math.max(30, swingStrength * 6 + 5);
  if (window.length < minBars) return null;

  const candleN = window[localIndex];
  if (!candleN) return null;
  if (!candleN.isClosed) {
    throw new FutureLeakageError(
      `evaluate() reached a non-closed candle for ${symbol} ${timeframe} @ ${candleN.openTime}`,
    );
  }

  const ctx = buildContext(window, localIndex, settings);

  // Run every ENABLED detector.
  const events: DetectorEvent[] = [];
  for (const id of DETECTOR_IDS) {
    if (!settings.detectorEnabled(id)) continue;
    const fn = DETECTORS[id];
    if (!fn) continue;
    for (const ev of fn(ctx)) {
      // Defensive: a detector must never reference a future bar.
      if (ev.index > localIndex) {
        throw new FutureLeakageError(
          `Detector ${id} emitted an event at index ${ev.index} > evaluation index ${localIndex}`,
        );
      }
      events.push(ev);
    }
  }

  // Freshness filter — stale events must not keep re-triggering.
  const ttl = Math.floor(settings.num('detectors.event_ttl_bars'));
  const fresh = events.filter((e) => localIndex - e.index < ttl);

  const long = scoreDirection(fresh, 'LONG', settings);
  const short = scoreDirection(fresh, 'SHORT', settings);

  // ATR — RISK ONLY. Never gates the decision below.
  const atrPeriod = Math.floor(settings.num('risk.atr_period'));
  const atrs = atrSeries(window, atrPeriod);
  const atr = atrs[localIndex] ?? null;

  const threshold = settings.num('engine.score_threshold');
  const minComponents = Math.floor(settings.num('engine.min_components'));

  const best = long.score >= short.score ? long : short;
  const bestComponents = countedDetectors(best);
  const passed =
    best.score >= threshold && bestComponents >= minComponents && best.totalWeight > 0;

  return {
    symbol,
    timeframe,
    candleTime: candleN.openTime,
    closePrice: candleN.close,
    atr,
    events: fresh,
    long,
    short,
    decision: {
      direction: best.direction,
      score: best.score,
      threshold,
      passed,
    },
  };
}

/** Map of detector -> whether it is enabled, for the UI. */
export function detectorStatus(settings: Settings): Record<DetectorId, boolean> {
  const out = {} as Record<DetectorId, boolean>;
  for (const id of DETECTOR_IDS) out[id] = settings.detectorEnabled(id);
  return out;
}

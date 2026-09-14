/**
 * V2 replay — walk-forward backtest for the SMC V2 research engine.
 *
 * CRITICAL DESIGN CONSTRAINT: this is NOT a second trading implementation.
 * Only SIGNAL GENERATION differs between V1 and V2. Everything downstream —
 * N+1 entry resolution, TP/SL walking, the ambiguous-bar policy, R accounting
 * — is the SAME production code V1 uses:
 *
 *     resolveEntry()  from src/strategy/state-machine.ts
 *     trackOutcome()  from src/outcome/tracker.ts
 *
 * That is what makes a V1-vs-V2 comparison meaningful: any difference in the
 * results is attributable to the strategy, not to two different backtesters.
 */

import type { Candle, Timeframe } from '../core/types';
import { tfMs } from '../core/types';
import type { Settings } from '../core/settings';
import { resolveEntry } from '../strategy/state-machine';
import { trackOutcome } from '../outcome/tracker';
import { evaluateV2 } from '../strategy/v2/engine';
import type { SetupKind, V2Setup } from '../strategy/v2/types';
import type { ReplayTrade } from './runner';

/** A V2 trade carries the extra research dimensions the spec asks to slice by. */
export interface V2Trade extends ReplayTrade {
  setupKind: SetupKind | null;
  location: 'HIGH' | 'LOW' | 'MID';
  htfAlignment: string;
  evidence: number;
  conflict: number;
  netEvidence: number;
  adxRegime: string;
  rsiBucket: string;
  emaAlignment: string;
  macdState: string;
  rvolBucket: string;
  fibZone: string;
  hasOb: boolean;
  hasFvg: boolean;
  sweepQuality: number | null;
  breakoutQuality: number | null;
  roomR: number;
}

export interface V2ReplayArgs {
  symbol: string;
  timeframe: Timeframe;
  candles: readonly Candle[];
  settings: Settings;
  htfCandles?: Partial<Record<Timeframe, readonly Candle[]>>;
  from?: number;
  to?: number;
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
  return h > 0 ? (s.macd.accelerating ? 'BULL_ACCEL' : 'BULL') : (s.macd.accelerating ? 'BEAR_ACCEL' : 'BEAR');
};

/**
 * Walk one series chronologically. One position at a time, mirroring the live
 * engine's single-slot behaviour.
 */
export function replayV2Series(args: V2ReplayArgs): { trades: V2Trade[]; evaluations: number; waits: number } {
  const { symbol, timeframe, settings } = args;
  const closed = args.candles
    .filter((c) => c.isClosed)
    .sort((a, b) => a.openTime - b.openTime);

  const trades: V2Trade[] = [];
  let evaluations = 0;
  let waits = 0;

  const minRr = settings.num('risk.min_rr');
  const swing = Math.floor(settings.num('engine.swing_lookback'));
  const minBars = Math.max(80, swing * 6 + 40);

  interface Pending {
    setup: V2Setup;
    setupCandleTime: number;
  }
  let pending: Pending | null = null;
  let open:
    | (V2Trade & { riskPerUnit: number; entryIndex: number })
    | null = null;

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
        // Re-anchor the structural stop and targets to the ACTUAL fill price,
        // preserving the structural distances the engine derived at N.
        if (stop !== null && s.entry !== null && s.direction !== 'WAIT') {
          const shift = entry.entryPrice - s.entry;
          const stopPrice = stop + shift;
          const tps = s.targets.map((t) => t.price + shift);
          const riskPerUnit = Math.abs(entry.entryPrice - stopPrice);
          const rr1 = tps.length > 0
            ? Math.abs(tps[0]! - entry.entryPrice) / (riskPerUnit || 1)
            : 0;
          const valid = riskPerUnit > 0 &&
            (s.direction === 'LONG' ? stopPrice < entry.entryPrice : stopPrice > entry.entryPrice) &&
            tps.length > 0 && rr1 >= minRr;

          if (valid) {
            open = {
              symbol,
              timeframe,
              direction: s.direction,
              // "score" is kept for interface compatibility with V1 tooling,
              // but for V2 it carries EVIDENCE (0..100), not a probability.
              score: Math.round((s.direction === 'LONG' ? s.longEvidence : s.shortEvidence) * 100),
              setupCandleTime: pending.setupCandleTime,
              entryCandleTime: entry.entryCandleTime,
              entryPrice: entry.entryPrice,
              stopLoss: stopPrice,
              takeProfits: tps,
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
      const setup = evaluateV2({
        symbol,
        timeframe,
        candles: closed,
        atIndex: i,
        settings,
        ...(args.htfCandles ? { htfCandles: args.htfCandles } : {}),
      });
      if (setup) {
        evaluations++;
        if (setup.direction === 'WAIT') waits++;
        else pending = { setup, setupCandleTime: setup.time };
      }
    }
  }

  return { trades, evaluations, waits };
}

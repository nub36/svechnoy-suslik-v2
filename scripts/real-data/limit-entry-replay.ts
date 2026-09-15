/**
 * V2.1 STRUCTURAL LIMIT ENTRY — RESEARCH REPLAY (models B/C/D).
 *
 * A SEPARATE research path. Frozen V2 is not modified and not imported for
 * anything other than `evaluateV2` (signal generation) and `trackOutcome`
 * (post-fill outcome), both used exactly as-is. Signal direction, stop level,
 * target ladder and exit model all come from the frozen engine untouched; the
 * ONLY thing this file changes is WHEN AND AT WHAT PRICE the position is
 * entered.
 *
 * Implements the models fixed in docs/V2_1_LIMIT_ENTRY_PREREGISTRATION.md
 * (commit e3750fc) with no deviation:
 *
 *   B RETEST  anchor breakout.level, area = level +/- 0.25 ATR, zone at proximal edge
 *   C FVG     anchor fresh FVG,      area = [bottom, top],      zone at proximal edge
 *   D OB_FVG  anchor OB∩FVG else OB, area = overlap (or OB),    zone at MIDPOINT
 *
 * Shared, preregistered:
 *   halfWidth = clamp(0.05*ATR, 1 tick, structuralArea/2), tick-rounded,
 *               zone clipped inside the structural area
 *   side-of-price: LONG zone entirely BELOW the N+1 reference, SHORT above,
 *               otherwise NO pending order is created (never a market order)
 *   expiry 12 bars after N -> EXPIRED
 *   structural SL breached before fill -> CANCELLED
 *   fill only when the candle trades THROUGH the zone, at the FAR (worse) edge
 *   frozen TP1 reached before fill -> MISSED (never chased)
 *   same bar fills and breaches SL -> CANCELLED (ambiguous, unfavourable)
 *   same bar fills and reaches TP1 -> FILLED, then tracked normally
 *   post-fill: SL level unchanged, risk/R recomputed, trade skipped when the
 *               geometry is invalid or rr1 < risk.min_rr
 *   exit model CURRENT, one position at a time
 *
 * CAUSALITY. The zone is built from the V2Setup at CLOSED N. Only candles at
 * index >= N+1 can fill, expire, cancel or miss it. No future OB/FVG, no future
 * swing, no look-ahead of any kind.
 */

import { Settings } from '../../src/core/settings';
import { evaluateV2 } from '../../src/strategy/v2';
import { HTF_MAP } from '../../src/strategy/v2/htf';
import { resolveEntry } from '../../src/strategy/state-machine';
import { trackOutcome } from '../../src/outcome/tracker';
import { executableLadder } from '../../src/replay/v2-runner';
import type { Candle, Timeframe } from '../../src/core/types';
import { TF_MS } from '../../src/core/types';
import type { V2Setup } from '../../src/strategy/v2/types';

export type ModelId = 'B' | 'C' | 'D';

/** Empirically measured Binance Spot tick sizes (see the design audit). */
export const TICK_SIZE: Readonly<Record<string, number>> = {
  BTCUSDT: 0.01, ETHUSDT: 0.01, BNBUSDT: 0.01, SOLUSDT: 0.01,
  XRPUSDT: 0.0001, DOGEUSDT: 0.00001,
};

export const EXPIRY_BARS = 12;
export const ZONE_ATR_FRACTION = 0.05;
export const WINDOW_MARGIN = 60;

export type Terminal =
  | 'FILLED' | 'MISSED' | 'EXPIRED' | 'CANCELLED' | 'NO_ZONE' | 'REJECTED_GEOMETRY';

export interface Zone { low: number; high: number; areaLow: number; areaHigh: number }

const roundTo = (v: number, tick: number): number =>
  tick > 0 ? Math.round(v / tick) * tick : v;

/**
 * Build the structural area for a model, or null when the anchor is absent.
 * Uses ONLY fields present on the setup at CLOSED N.
 */
export function structuralArea(
  model: ModelId, s: V2Setup, atr: number,
): [number, number] | null {
  const dir = s.direction;
  if (dir === 'WAIT') return null;

  if (model === 'B') {
    if (!s.breakout || s.breakout.direction !== dir) return null;
    return [s.breakout.level - 0.25 * atr, s.breakout.level + 0.25 * atr];
  }
  if (model === 'C') {
    if (!s.fvg || s.fvg.state === 'FILLED' || s.fvg.direction !== dir) return null;
    return [s.fvg.bottom, s.fvg.top];
  }
  // D: OB ∩ FVG overlap, else fresh OB (fallback declared in advance)
  const ob = s.orderBlock && s.orderBlock.state !== 'INVALIDATED'
    && s.orderBlock.direction === dir ? s.orderBlock : null;
  const fv = s.fvg && s.fvg.state !== 'FILLED' && s.fvg.direction === dir ? s.fvg : null;
  if (ob && fv) {
    const lo = Math.max(ob.low, fv.bottom), hi = Math.min(ob.high, fv.top);
    if (hi > lo) return [lo, hi];
  }
  if (ob) return [ob.low, ob.high];
  return null;
}

/**
 * Construct the executable entry zone inside the structural area.
 *
 * B and C place it at the PROXIMAL edge (the side price retraces toward);
 * D places it at the MIDPOINT. Returns null when the zone is not entirely on
 * the correct side of the reference fill.
 */
export function buildZone(
  model: ModelId, direction: 'LONG' | 'SHORT', area: [number, number],
  atr: number, tick: number, reference: number,
): Zone | null {
  const [areaLow, areaHigh] = area;
  if (!(areaHigh > areaLow)) return null;

  const half = Math.min(
    Math.max(ZONE_ATR_FRACTION * atr, tick),
    (areaHigh - areaLow) / 2,
  );

  // Anchor point inside the area.
  let centre: number;
  if (model === 'D') {
    centre = (areaLow + areaHigh) / 2;
  } else {
    // Proximal edge = the boundary price meets first when retracing.
    // LONG retraces DOWN, so it meets the area's HIGH first.
    centre = direction === 'LONG' ? areaHigh - half : areaLow + half;
  }

  let low = roundTo(centre - half, tick);
  let high = roundTo(centre + half, tick);
  // Clip strictly inside the structural area.
  low = Math.max(low, areaLow);
  high = Math.min(high, areaHigh);
  if (!(high > low)) return null;

  // Side-of-price rule: the WHOLE zone must be on the retracement side.
  if (direction === 'LONG' ? !(high < reference) : !(low > reference)) return null;

  return { low, high, areaLow, areaHigh };
}

export interface LimitTrade {
  symbol: string; timeframe: Timeframe; direction: 'LONG' | 'SHORT';
  setupKind: string; setupCandleTime: number;
  terminal: Terminal;
  referencePrice: number;           // frozen OPEN N+1, for entry-improvement
  zoneLow: number; zoneHigh: number;
  areaLow: number; areaHigh: number;
  barsWaited: number;
  ambiguous: boolean;
  cancelReason: string | null;
  // present only when FILLED and geometry accepted
  entryCandleTime?: number; entryPrice?: number; stopLoss?: number;
  takeProfits?: number[];
  result?: string; exitPrice?: number | null; barsHeld?: number;
  rMultiple?: number; riskPerUnit?: number; riskAtr?: number | null;
  atrAtSetup?: number;
}

export interface ReplayArgs {
  symbol: string; timeframe: Timeframe; candles: readonly Candle[];
  settings: Settings; htfCandles?: Partial<Record<Timeframe, readonly Candle[]>>;
  from?: number; to?: number; model: ModelId;
}

export interface ReplayResult {
  trades: LimitTrade[];
  evaluations: number;
  actionableSetups: number;   // frozen engine produced a directional setup with stop+targets
  pendingCreated: number;
}

function htfUpperBound(c: readonly Candle[], asOf: number, span: number): number {
  let lo = 0, hi = c.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c[mid]!.openTime + span <= asOf) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/**
 * Chronological replay for ONE model on ONE series.
 *
 * Mirrors windowed-replay's loop: same minBars, same trailing window, same HTF
 * bounding, same one-position-at-a-time slot. The pending-entry state machine
 * replaces the unconditional OPEN N+1 fill.
 */
export function replayLimitEntry(args: ReplayArgs): ReplayResult {
  const { symbol, timeframe, settings, model } = args;
  const closed = args.candles.filter((c) => c.isClosed)
    .sort((a, b) => a.openTime - b.openTime);

  const minRr = settings.num('risk.min_rr');
  const timeoutBars = Math.floor(settings.num('outcome.timeout_bars'));
  const swing = Math.floor(settings.num('engine.swing_lookback'));
  const lookback = Math.floor(settings.num('engine.lookback_candles'));
  const minBars = Math.max(80, swing * 6 + 40);
  const winLen = lookback + WINDOW_MARGIN;
  const tick = TICK_SIZE[symbol] ?? 0.01;
  const tfMs = TF_MS[timeframe];

  const trades: LimitTrade[] = [];
  let evaluations = 0, actionableSetups = 0, pendingCreated = 0;

  interface Pending {
    setup: V2Setup; setupCandleTime: number; setupIndex: number;
    zone: Zone; reference: number; tp1: number; stop: number;
    direction: 'LONG' | 'SHORT'; atr: number;
  }
  let pending: Pending | null = null;
  let open: {
    entryIndex: number; rec: LimitTrade; stop: number; tps: number[];
    entryPrice: number; entryCandleTime: number; direction: 'LONG' | 'SHORT';
  } | null = null;

  const htfSpans = new Map<Timeframe, number>();
  for (const h of HTF_MAP[timeframe] ?? []) htfSpans.set(h, TF_MS[h]);

  for (let i = minBars; i < closed.length; i++) {
    const candle = closed[i]!;
    if (args.from !== undefined && candle.openTime < args.from) continue;
    if (args.to !== undefined && candle.openTime > args.to) break;

    /* ---- 1. advance a PENDING limit order on this candle (N+1 or later) ---- */
    if (pending && open === null) {
      const p = pending;
      const long = p.direction === 'LONG';
      const barsWaited = i - p.setupIndex;

      const fills = long ? candle.low <= p.zone.low : candle.high >= p.zone.high;
      const hitSl = long ? candle.low <= p.stop : candle.high >= p.stop;
      const hitTp1 = long ? candle.high >= p.tp1 : candle.low <= p.tp1;

      const base = (): LimitTrade => ({
        symbol, timeframe, direction: p.direction,
        setupKind: p.setup.kind ?? 'NA',
        setupCandleTime: p.setupCandleTime,
        terminal: 'EXPIRED',
        referencePrice: p.reference,
        zoneLow: p.zone.low, zoneHigh: p.zone.high,
        areaLow: p.zone.areaLow, areaHigh: p.zone.areaHigh,
        barsWaited, ambiguous: false, cancelReason: null,
      });

      if (fills && hitSl) {
        // Preregistered ambiguity rule: unfavourable reading.
        const t = base();
        t.terminal = 'CANCELLED'; t.ambiguous = true;
        t.cancelReason = 'ambiguous_same_bar_fill_and_sl';
        trades.push(t); pending = null;
      } else if (fills) {
        // FILL at the FAR (worse) edge.
        const fillPrice = long ? p.zone.low : p.zone.high;
        const shift = fillPrice - (p.setup.entry ?? fillPrice);
        const stopPrice = p.stop;
        const rawTps = p.setup.targets.map((t) => t.price);
        const ladder = executableLadder(p.direction, fillPrice, stopPrice, rawTps);
        const riskPerUnit = Math.abs(fillPrice - stopPrice);
        const valid = riskPerUnit > 0
          && (long ? stopPrice < fillPrice : stopPrice > fillPrice)
          && ladder.targets.length > 0 && ladder.rr1 >= minRr;

        const t = base();
        if (!valid) {
          t.terminal = 'REJECTED_GEOMETRY';
          t.cancelReason = riskPerUnit <= 0 ? 'zero_risk'
            : ladder.targets.length === 0 ? 'no_target_ahead'
              : ladder.rr1 < minRr ? 'rr1_below_min_rr' : 'stop_wrong_side';
          trades.push(t); pending = null;
        } else {
          t.terminal = 'FILLED';
          t.entryCandleTime = candle.openTime;
          t.entryPrice = fillPrice;
          t.stopLoss = stopPrice;
          t.takeProfits = ladder.targets;
          t.riskPerUnit = riskPerUnit;
          t.atrAtSetup = p.atr;
          t.riskAtr = p.atr > 0 ? riskPerUnit / p.atr : null;
          t.result = 'OPEN';
          void shift;
          open = {
            entryIndex: i, rec: t, stop: stopPrice, tps: ladder.targets,
            entryPrice: fillPrice, entryCandleTime: candle.openTime,
            direction: p.direction,
          };
          trades.push(t);
          pending = null;
        }
      } else if (hitSl) {
        const t = base();
        t.terminal = 'CANCELLED';
        t.cancelReason = 'structural_invalidation_before_fill';
        trades.push(t); pending = null;
      } else if (hitTp1) {
        const t = base();
        t.terminal = 'MISSED';
        t.cancelReason = 'tp1_reached_before_retracement';
        trades.push(t); pending = null;
      } else if (barsWaited >= EXPIRY_BARS) {
        const t = base();
        t.terminal = 'EXPIRED';
        t.cancelReason = 'expiry_12_bars';
        trades.push(t); pending = null;
      }
    }

    /* ---- 2. resolve an OPEN position with the FROZEN tracker ---- */
    if (open) {
      const slice = closed.slice(open.entryIndex, i + 1);
      const out = trackOutcome({
        direction: open.direction,
        entryPrice: open.entryPrice,
        stopLoss: open.stop,
        takeProfits: open.tps,
        entryCandleTime: open.entryCandleTime,
        candles: slice,
        settings,
        qty: 0,
      });
      if (out) {
        open.rec.result = out.result;
        open.rec.exitPrice = out.exitPrice;
        open.rec.barsHeld = out.barsHeld;
        open.rec.rMultiple = out.rMultiple;
        open = null;
      } else if (i - open.entryIndex > timeoutBars + 2) {
        open = null; // safety; tracker should have closed it
      }
    }

    /* ---- 3. evaluate the closed bar for a NEW setup ---- */
    if (open === null && pending === null) {
      const start = Math.max(0, i - winLen + 1);
      const visible = closed.slice(start, i + 1);

      let htfArg = args.htfCandles;
      if (htfArg) {
        const bounded: Partial<Record<Timeframe, readonly Candle[]>> = {};
        const asOf = candle.closeTime;
        for (const [h, span] of htfSpans) {
          const hc = htfArg[h]; if (!hc || hc.length === 0) continue;
          const ub = htfUpperBound(hc, asOf, span);
          if (ub < 0) continue;
          bounded[h] = hc.slice(Math.max(0, ub - 200 + 1), ub + 1);
        }
        htfArg = bounded;
      }

      const s: V2Setup | null = evaluateV2({
        symbol, timeframe, candles: visible, settings, htfCandles: htfArg,
      });
      evaluations++;

      if (s !== null && s.direction !== 'WAIT' && s.stop !== null && s.entry !== null
        && s.targets.length > 0) {
        const atr = s.atr.atr;
        const next = closed[i + 1];
        const ent = resolveEntry(candle.openTime, tfMs, next);
        if (atr !== null && atr > 0 && ent) {
          actionableSetups++;
          const reference = ent.entryPrice;
          // Shift the frozen levels to the reference fill, exactly as the
          // frozen harness does, so stop/TP1 are comparable.
          const shift = reference - s.entry;
          const stopAtRef = s.stop.price + shift;
          const tpsAtRef = s.targets.map((t) => t.price + shift);
          const refLadder = executableLadder(s.direction, reference, stopAtRef, tpsAtRef);

          const area = structuralArea(model, s, atr);
          if (area && refLadder.targets.length > 0) {
            const zone = buildZone(model, s.direction, area, atr, tick, reference);
            if (zone) {
              pending = {
                setup: s, setupCandleTime: candle.openTime, setupIndex: i,
                zone, reference, tp1: refLadder.targets[0]!,
                // The structural stop is anchored to structure, not to the
                // fill, so it is NOT shifted by the limit price.
                stop: s.stop.price, direction: s.direction, atr,
              };
              pendingCreated++;
            }
          }
        }
      }
    }
  }

  return { trades, evaluations, actionableSetups, pendingCreated };
}

/**
 * V2.1 corridor replay — chronological, one position at a time.
 *
 * Mirrors windowed-replay's loop structure (same minBars, same trailing window,
 * same HTF bounding, same single slot) so the only behavioural differences are
 * the three preregistered gates and the corridor entry.
 *
 * Ablation is supported by toggling gates independently, so the contribution of
 * each can be measured rather than asserted.
 */

import { Settings } from '../../src/core/settings';
import { evaluateV2 } from '../../src/strategy/v2';
import { HTF_MAP } from '../../src/strategy/v2/htf';
import { resolveEntry } from '../../src/strategy/state-machine';
import { trackOutcome } from '../../src/outcome/tracker';
import { executableLadder } from '../../src/replay/v2-runner';
import {
  EXPIRY_BARS, TICK_SIZE, buildCorridor, confirmedExtreme, confluence,
  extremePoolKind, feeGuardPasses, CONFLUENCE_MIN, type PoolKind,
} from './corridor-entry';
import type { Candle, Timeframe } from '../../src/core/types';
import { TF_MS } from '../../src/core/types';
import type { V2Setup } from '../../src/strategy/v2/types';

const WINDOW_MARGIN = 60;

export interface Gates {
  extreme: boolean;     // confirmed-extreme trigger
  feeGuard: boolean;    // fee drag guard
  confluence: boolean;  // >= 3 of 4
  corridor: boolean;    // corridor entry (false = frozen OPEN N+1 fill)
}

export const BASELINE_GATES: Gates =
  { extreme: false, feeGuard: false, confluence: false, corridor: false };
export const FULL_GATES: Gates =
  { extreme: true, feeGuard: true, confluence: true, corridor: true };

export type Terminal =
  | 'FILLED' | 'MISSED' | 'EXPIRED' | 'CANCELLED'
  | 'REJECTED_EXTREME' | 'REJECTED_FEE_GUARD' | 'REJECTED_CONFLUENCE'
  | 'REJECTED_GEOMETRY';

export interface CorridorTrade {
  symbol: string; timeframe: Timeframe; direction: 'LONG' | 'SHORT';
  setupKind: string; setupCandleTime: number;
  terminal: Terminal; reason: string;
  referencePrice: number;          // frozen OPEN N+1 (comparison anchor)
  corridorLow: number; corridorHigh: number;
  poolKind: PoolKind;
  confluenceVotes: number;
  barsWaited: number;
  ambiguous: boolean;
  atrAtSetup: number;
  // filled only
  entryCandleTime?: number; entryPrice?: number; stopLoss?: number;
  takeProfits?: number[]; result?: string; exitPrice?: number | null;
  barsHeld?: number; rMultiple?: number; riskPerUnit?: number;
  riskAtr?: number | null;
}

export interface CorridorArgs {
  symbol: string; timeframe: Timeframe; candles: readonly Candle[];
  settings: Settings; htfCandles?: Partial<Record<Timeframe, readonly Candle[]>>;
  from?: number; to?: number; gates: Gates;
  /** diagnostic pool-kind recovery is expensive; off by default */
  poolKinds?: boolean;
}

export interface CorridorResult {
  trades: CorridorTrade[];
  evaluations: number;
  actionableSetups: number;   // frozen engine gave a directional setup with stop+targets
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

export function replayCorridor(args: CorridorArgs): CorridorResult {
  const { symbol, timeframe, settings, gates } = args;
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

  const trades: CorridorTrade[] = [];
  let evaluations = 0, actionableSetups = 0, pendingCreated = 0;

  interface Pending {
    setup: V2Setup; setupCandleTime: number; setupIndex: number;
    corridor: { low: number; high: number };
    reference: number; tp1: number; stop: number;
    direction: 'LONG' | 'SHORT'; atr: number;
    poolKind: PoolKind; votes: number;
  }
  let pending: Pending | null = null;
  let open: {
    entryIndex: number; rec: CorridorTrade; stop: number; tps: number[];
    entryPrice: number; entryCandleTime: number; direction: 'LONG' | 'SHORT';
  } | null = null;

  const htfSpans = new Map<Timeframe, number>();
  for (const h of HTF_MAP[timeframe] ?? []) htfSpans.set(h, TF_MS[h]);

  for (let i = minBars; i < closed.length; i++) {
    const candle = closed[i]!;
    if (args.from !== undefined && candle.openTime < args.from) continue;
    if (args.to !== undefined && candle.openTime > args.to) break;

    /* ---- 1. advance a PENDING corridor order (N+1 or later) ---- */
    if (pending && open === null) {
      const p = pending;
      const long = p.direction === 'LONG';
      const barsWaited = i - p.setupIndex;

      // Corridor fill: price is INSIDE the band.
      const touches = long
        ? candle.low <= p.corridor.high
        : candle.high >= p.corridor.low;
      const hitSl = long ? candle.low <= p.stop : candle.high >= p.stop;
      const hitTp1 = long ? candle.high >= p.tp1 : candle.low <= p.tp1;

      const base = (): CorridorTrade => ({
        symbol, timeframe, direction: p.direction,
        setupKind: p.setup.kind ?? 'NA',
        setupCandleTime: p.setupCandleTime,
        terminal: 'EXPIRED', reason: '',
        referencePrice: p.reference,
        corridorLow: p.corridor.low, corridorHigh: p.corridor.high,
        poolKind: p.poolKind, confluenceVotes: p.votes,
        barsWaited, ambiguous: false, atrAtSetup: p.atr,
      });

      if (touches && hitSl) {
        const t = base();
        t.terminal = 'CANCELLED'; t.ambiguous = true;
        t.reason = 'ambiguous_same_bar_fill_and_sl';
        trades.push(t); pending = null;
      } else if (touches) {
        // Conservative fill: never better than the corridor's worse edge.
        const fill = long
          ? Math.min(candle.open, p.corridor.high)
          : Math.max(candle.open, p.corridor.low);
        const stopPrice = p.stop;
        const rawTps = p.setup.targets.map((t) => t.price);
        const ladder = executableLadder(p.direction, fill, stopPrice, rawTps);
        const riskPerUnit = Math.abs(fill - stopPrice);
        const geomOk = riskPerUnit > 0
          && (long ? stopPrice < fill : stopPrice > fill)
          && ladder.targets.length > 0 && ladder.rr1 >= minRr;

        const t = base();
        if (!geomOk) {
          t.terminal = 'REJECTED_GEOMETRY';
          t.reason = riskPerUnit <= 0 ? 'zero_risk'
            : ladder.targets.length === 0 ? 'no_target_ahead'
              : ladder.rr1 < minRr ? 'rr1_below_min_rr' : 'stop_wrong_side';
          trades.push(t); pending = null;
        } else {
          t.terminal = 'FILLED'; t.reason = 'corridor_touched';
          t.entryCandleTime = candle.openTime;
          t.entryPrice = fill; t.stopLoss = stopPrice;
          t.takeProfits = ladder.targets;
          t.riskPerUnit = riskPerUnit;
          t.riskAtr = p.atr > 0 ? riskPerUnit / p.atr : null;
          t.result = 'OPEN';
          open = {
            entryIndex: i, rec: t, stop: stopPrice, tps: ladder.targets,
            entryPrice: fill, entryCandleTime: candle.openTime,
            direction: p.direction,
          };
          trades.push(t); pending = null;
        }
      } else if (hitSl) {
        const t = base();
        t.terminal = 'CANCELLED';
        t.reason = 'structural_invalidation_before_fill';
        trades.push(t); pending = null;
      } else if (hitTp1) {
        const t = base();
        t.terminal = 'MISSED';
        t.reason = 'tp1_reached_before_fill';
        trades.push(t); pending = null;
      } else if (barsWaited >= EXPIRY_BARS) {
        const t = base();
        t.terminal = 'EXPIRED';
        t.reason = `expiry_${EXPIRY_BARS}_bars`;
        trades.push(t); pending = null;
      }
    }

    /* ---- 2. resolve an OPEN position with the FROZEN tracker ---- */
    if (open) {
      const slice = closed.slice(open.entryIndex, i + 1);
      const out = trackOutcome({
        direction: open.direction, entryPrice: open.entryPrice,
        stopLoss: open.stop, takeProfits: open.tps,
        entryCandleTime: open.entryCandleTime, candles: slice,
        settings, qty: 0,
      });
      if (out) {
        open.rec.result = out.result;
        open.rec.exitPrice = out.exitPrice;
        open.rec.barsHeld = out.barsHeld;
        open.rec.rMultiple = out.rMultiple;
        open = null;
      } else if (i - open.entryIndex > timeoutBars + 2) {
        open = null;
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

      if (s !== null && s.direction !== 'WAIT' && s.stop !== null
        && s.entry !== null && s.targets.length > 0) {
        const atr = s.atr.atr;
        const next = closed[i + 1];
        const ent = resolveEntry(candle.openTime, tfMs, next);

        if (atr !== null && atr > 0 && ent) {
          actionableSetups++;
          const reference = ent.entryPrice;
          const shift = reference - s.entry;
          const stopAtRef = s.stop.price + shift;
          const tpsAtRef = s.targets.map((t) => t.price + shift);
          const refLadder = executableLadder(s.direction, reference, stopAtRef, tpsAtRef);

          const poolKind: PoolKind = args.poolKinds
            ? extremePoolKind(s, visible, settings) : 'NONE';

          const mkReject = (term: Terminal, reason: string): CorridorTrade => ({
            symbol, timeframe, direction: s.direction as 'LONG' | 'SHORT',
            setupKind: s.kind ?? 'NA', setupCandleTime: candle.openTime,
            terminal: term, reason, referencePrice: reference,
            corridorLow: 0, corridorHigh: 0, poolKind,
            confluenceVotes: -1, barsWaited: 0, ambiguous: false,
            atrAtSetup: atr,
          });

          // --- gate 1: confirmed extreme
          if (gates.extreme) {
            const v = confirmedExtreme(s);
            if (!v.confirmed) { trades.push(mkReject('REJECTED_EXTREME', v.reason)); continue; }
          }
          // --- gate 2: fee drag guard (uses the REFERENCE fill; the corridor is
          //     centred on close(N) and is at most 0.15 % wide, so this is the
          //     honest pre-entry test. Post-fill geometry is re-checked below.)
          if (gates.feeGuard && !feeGuardPasses(reference, stopAtRef, atr)) {
            trades.push(mkReject('REJECTED_FEE_GUARD', 'stop_below_floor'));
            continue;
          }
          // --- gate 3: confluence
          const conf = confluence(s);
          if (gates.confluence && conf.votes < CONFLUENCE_MIN) {
            trades.push(mkReject('REJECTED_CONFLUENCE', `votes_${conf.votes}`));
            continue;
          }

          if (refLadder.targets.length === 0) {
            trades.push(mkReject('REJECTED_GEOMETRY', 'no_target_ahead_at_reference'));
            continue;
          }

          if (!gates.corridor) {
            // Baseline-style immediate fill at OPEN N+1, but subject to whichever
            // gates are enabled — this is what isolates filter effect from entry
            // effect in the ablation.
            const riskPerUnit = Math.abs(reference - stopAtRef);
            const ok = riskPerUnit > 0 && refLadder.rr1 >= minRr
              && (s.direction === 'LONG' ? stopAtRef < reference : stopAtRef > reference);
            if (!ok) { trades.push(mkReject('REJECTED_GEOMETRY', 'reference_geometry')); continue; }
            const t = mkReject('FILLED', 'open_n1');
            t.confluenceVotes = conf.votes;
            t.entryCandleTime = ent.entryCandleTime;
            t.entryPrice = reference;
            t.stopLoss = stopAtRef;
            t.takeProfits = refLadder.targets;
            t.riskPerUnit = riskPerUnit;
            t.riskAtr = riskPerUnit / atr;
            t.result = 'OPEN';
            t.corridorLow = reference; t.corridorHigh = reference;
            trades.push(t);
            open = {
              entryIndex: i + 1, rec: t, stop: stopAtRef, tps: refLadder.targets,
              entryPrice: reference, entryCandleTime: ent.entryCandleTime,
              direction: s.direction,
            };
            pendingCreated++;
            continue;
          }

          const corridor = buildCorridor(candle.close, atr, tick);
          if (!corridor) { trades.push(mkReject('REJECTED_GEOMETRY', 'no_corridor')); continue; }

          pending = {
            setup: s, setupCandleTime: candle.openTime, setupIndex: i,
            corridor: { low: corridor.low, high: corridor.high },
            reference, tp1: refLadder.targets[0]!,
            stop: s.stop.price,       // structural stop, never shifted to the fill
            direction: s.direction, atr, poolKind, votes: conf.votes,
          };
          pendingCreated++;
        }
      }
    }
  }

  return { trades, evaluations, actionableSetups, pendingCreated };
}

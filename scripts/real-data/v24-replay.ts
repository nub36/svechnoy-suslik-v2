/**
 * V2.4 replay — chronological, one position at a time.
 *
 * Mirrors the frozen harness loop (same minBars, trailing window, HTF bounding,
 * single slot). Differences are only the preregistered V2.4 gates: the base
 * sniper filter, the LONG confluence asymmetry, structural-only targets, and
 * the corridor entry.
 */

import { Settings } from '../../src/core/settings';
import { evaluateV2 } from '../../src/strategy/v2';
import { HTF_MAP } from '../../src/strategy/v2/htf';
import { resolveEntry } from '../../src/strategy/state-machine';
import { trackOutcome } from '../../src/outcome/tracker';
import { executableLadder } from '../../src/replay/v2-runner';
import {
  baseSniper, longAsymmetry, structuralTargetsV24,
  type LongLeg, type Tp1Basis,
} from './v24-engine';
import {
  EXPIRY_BARS, TICK_SIZE, buildCorridor, extremePoolKind, type PoolKind,
} from './corridor-entry';
import type { Candle, Timeframe } from '../../src/core/types';
import { TF_MS } from '../../src/core/types';
import type { V2Setup } from '../../src/strategy/v2/types';

const WINDOW_MARGIN = 60;

export interface V24Gates {
  sniper: boolean;      // reversals-only base filter
  structTargets: boolean; // structural-only targets (else frozen ladder)
  corridor: boolean;    // corridor entry (else OPEN N+1)
  asymmetry: boolean;   // LONG HTF-bullish confluence
}

export const V24_ARMS: Record<string, V24Gates> = {
  'A':         { sniper: false, structTargets: false, corridor: false, asymmetry: false },
  'S-base':    { sniper: true,  structTargets: false, corridor: false, asymmetry: false },
  'S-struct':  { sniper: true,  structTargets: true,  corridor: false, asymmetry: false },
  'S-cor':     { sniper: true,  structTargets: true,  corridor: true,  asymmetry: false },
  'S-asym':    { sniper: true,  structTargets: true,  corridor: true,  asymmetry: true  },
  'S-noasym':  { sniper: true,  structTargets: true,  corridor: true,  asymmetry: false },
};

export type V24Terminal =
  | 'FILLED' | 'MISSED' | 'EXPIRED' | 'CANCELLED'
  | 'REJECTED_SNIPER' | 'REJECTED_ASYMMETRY' | 'NO_STRUCTURAL_TP'
  | 'REJECTED_RR1' | 'REJECTED_GEOMETRY';

export interface V24Trade {
  symbol: string; timeframe: Timeframe; direction: 'LONG' | 'SHORT';
  setupKind: string; setupCandleTime: number;
  terminal: V24Terminal; reason: string;
  poolKind: PoolKind; tp1Basis: Tp1Basis; longLeg: LongLeg;
  referencePrice: number; corridorLow: number; corridorHigh: number;
  htfAlignment: string; barsWaited: number; ambiguous: boolean;
  atrAtSetup: number;
  entryCandleTime?: number; entryPrice?: number; stopLoss?: number;
  takeProfits?: number[]; result?: string; exitPrice?: number | null;
  barsHeld?: number; rMultiple?: number; riskPerUnit?: number;
  riskAtr?: number | null;
}

export interface V24Args {
  symbol: string; timeframe: Timeframe; candles: readonly Candle[];
  settings: Settings; htfCandles?: Partial<Record<Timeframe, readonly Candle[]>>;
  from?: number; to?: number; gates: V24Gates;
}

export interface V24Result {
  trades: V24Trade[]; evaluations: number;
  actionableSetups: number; pendingCreated: number;
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

export function replayV24(args: V24Args): V24Result {
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

  const trades: V24Trade[] = [];
  let evaluations = 0, actionableSetups = 0, pendingCreated = 0;

  interface Pending {
    setupCandleTime: number; setupIndex: number;
    corridor: { low: number; high: number };
    reference: number; tp1: number; stop: number; tps: number[];
    direction: 'LONG' | 'SHORT'; atr: number; setupKind: string;
    poolKind: PoolKind; tp1Basis: Tp1Basis; longLeg: LongLeg; htf: string;
  }
  let pending: Pending | null = null;
  let open: {
    entryIndex: number; rec: V24Trade; stop: number; tps: number[];
    entryPrice: number; entryCandleTime: number; direction: 'LONG' | 'SHORT';
  } | null = null;

  const htfSpans = new Map<Timeframe, number>();
  for (const h of HTF_MAP[timeframe] ?? []) htfSpans.set(h, TF_MS[h]);

  for (let i = minBars; i < closed.length; i++) {
    const candle = closed[i]!;
    if (args.from !== undefined && candle.openTime < args.from) continue;
    if (args.to !== undefined && candle.openTime > args.to) break;

    /* ---- 1. advance PENDING (N+1 or later only) ---- */
    if (pending && open === null) {
      const p = pending;
      const long = p.direction === 'LONG';
      const barsWaited = i - p.setupIndex;
      const touches = long ? candle.low <= p.corridor.high : candle.high >= p.corridor.low;
      const hitSl = long ? candle.low <= p.stop : candle.high >= p.stop;
      const hitTp1 = long ? candle.high >= p.tp1 : candle.low <= p.tp1;

      const base = (): V24Trade => ({
        symbol, timeframe, direction: p.direction, setupKind: p.setupKind,
        setupCandleTime: p.setupCandleTime, terminal: 'EXPIRED', reason: '',
        poolKind: p.poolKind, tp1Basis: p.tp1Basis, longLeg: p.longLeg,
        referencePrice: p.reference,
        corridorLow: p.corridor.low, corridorHigh: p.corridor.high,
        htfAlignment: p.htf, barsWaited, ambiguous: false, atrAtSetup: p.atr,
      });

      if (touches && hitSl) {
        const t = base(); t.terminal = 'CANCELLED'; t.ambiguous = true;
        t.reason = 'ambiguous_same_bar_fill_and_sl';
        trades.push(t); pending = null;
      } else if (touches) {
        const fill = long
          ? Math.min(candle.open, p.corridor.high)
          : Math.max(candle.open, p.corridor.low);
        const lad = executableLadder(p.direction, fill, p.stop, p.tps);
        const risk = Math.abs(fill - p.stop);
        const ok = risk > 0 && (long ? p.stop < fill : p.stop > fill)
          && lad.targets.length > 0 && lad.rr1 >= minRr;
        const t = base();
        if (!ok) {
          t.terminal = lad.targets.length > 0 && lad.rr1 < minRr
            ? 'REJECTED_RR1' : 'REJECTED_GEOMETRY';
          t.reason = lad.targets.length === 0 ? 'no_target_ahead'
            : lad.rr1 < minRr ? 'rr1_below_min_rr' : 'stop_wrong_side';
          trades.push(t); pending = null;
        } else {
          t.terminal = 'FILLED'; t.reason = 'corridor_touched';
          t.entryCandleTime = candle.openTime; t.entryPrice = fill;
          t.stopLoss = p.stop; t.takeProfits = lad.targets;
          t.riskPerUnit = risk; t.riskAtr = p.atr > 0 ? risk / p.atr : null;
          t.result = 'OPEN';
          open = { entryIndex: i, rec: t, stop: p.stop, tps: lad.targets,
            entryPrice: fill, entryCandleTime: candle.openTime, direction: p.direction };
          trades.push(t); pending = null;
        }
      } else if (hitSl) {
        const t = base(); t.terminal = 'CANCELLED';
        t.reason = 'structural_invalidation_before_fill';
        trades.push(t); pending = null;
      } else if (hitTp1) {
        const t = base(); t.terminal = 'MISSED';
        t.reason = 'tp1_reached_before_fill';
        trades.push(t); pending = null;
      } else if (barsWaited >= EXPIRY_BARS) {
        const t = base(); t.terminal = 'EXPIRED';
        t.reason = `expiry_${EXPIRY_BARS}_bars`;
        trades.push(t); pending = null;
      }
    }

    /* ---- 2. resolve OPEN with the FROZEN tracker ---- */
    if (open) {
      const slice = closed.slice(open.entryIndex, i + 1);
      const out = trackOutcome({
        direction: open.direction, entryPrice: open.entryPrice,
        stopLoss: open.stop, takeProfits: open.tps,
        entryCandleTime: open.entryCandleTime, candles: slice, settings, qty: 0,
      });
      if (out) {
        open.rec.result = out.result; open.rec.exitPrice = out.exitPrice;
        open.rec.barsHeld = out.barsHeld; open.rec.rMultiple = out.rMultiple;
        open = null;
      } else if (i - open.entryIndex > timeoutBars + 2) open = null;
    }

    /* ---- 3. evaluate for a NEW setup ---- */
    if (open === null && pending === null) {
      const start = Math.max(0, i - winLen + 1);
      const visible = closed.slice(start, i + 1);

      // Causally bounded HTF slices — reused for BOTH evaluateV2 and the
      // EMA200 asymmetry leg, so they cannot disagree about what was known.
      const bounded: Partial<Record<Timeframe, readonly Candle[]>> = {};
      if (args.htfCandles) {
        const asOf = candle.closeTime;
        for (const [h, span] of htfSpans) {
          const hc = args.htfCandles[h]; if (!hc || hc.length === 0) continue;
          const ub = htfUpperBound(hc, asOf, span);
          if (ub < 0) continue;
          bounded[h] = hc.slice(Math.max(0, ub - 400 + 1), ub + 1);
        }
      }

      const s: V2Setup | null = evaluateV2({
        symbol, timeframe, candles: visible, settings,
        htfCandles: args.htfCandles ? bounded : undefined,
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
          const dir = s.direction as 'LONG' | 'SHORT';
          const htfState = s.htfAlignment ?? 'UNKNOWN';

          const poolKind: PoolKind = gates.sniper
            ? extremePoolKind(s, visible, settings) : 'NONE';

          let longLeg: LongLeg = 'NONE';

          const mkRej = (
            term: V24Terminal, reason: string, basis: Tp1Basis = 'NONE',
          ): V24Trade => ({
            symbol, timeframe, direction: dir, setupKind: s.kind ?? 'NA',
            setupCandleTime: candle.openTime, terminal: term, reason,
            poolKind, tp1Basis: basis, longLeg,
            referencePrice: reference, corridorLow: 0, corridorHigh: 0,
            htfAlignment: htfState, barsWaited: 0, ambiguous: false,
            atrAtSetup: atr,
          });

          if (gates.sniper) {
            const v = baseSniper(s, poolKind);
            if (!v.ok) { trades.push(mkRej('REJECTED_SNIPER', v.reason)); continue; }
          }

          if (gates.asymmetry) {
            const a = longAsymmetry(
              s, timeframe, args.htfCandles ? bounded : undefined,
              candle.closeTime, candle.close);
            longLeg = a.leg;
            if (!a.ok) { trades.push(mkRej('REJECTED_ASYMMETRY', a.reason)); continue; }
          }

          // --- targets
          let tpsAtRef: number[]; let tp1Basis: Tp1Basis;
          if (gates.structTargets) {
            const st = structuralTargetsV24(s.targets);
            if (!st.ok) {
              trades.push(mkRej('NO_STRUCTURAL_TP', 'no_structural_target'));
              continue;
            }
            tpsAtRef = st.targets.map((p) => p + shift);
            tp1Basis = st.tp1Basis;
          } else {
            tpsAtRef = s.targets.map((t) => t.price + shift);
            tp1Basis = (s.targets[0]?.basis as Tp1Basis) ?? 'NONE';
          }

          const refLadder = executableLadder(dir, reference, stopAtRef, tpsAtRef);
          if (refLadder.targets.length === 0) {
            trades.push(mkRej('REJECTED_GEOMETRY', 'no_target_ahead', tp1Basis)); continue;
          }
          if (refLadder.rr1 < minRr) {
            trades.push(mkRej('REJECTED_RR1', 'rr1_below_min_rr', tp1Basis)); continue;
          }

          if (!gates.corridor) {
            const risk = Math.abs(reference - stopAtRef);
            const ok = risk > 0 && (dir === 'LONG' ? stopAtRef < reference : stopAtRef > reference);
            if (!ok) { trades.push(mkRej('REJECTED_GEOMETRY', 'reference_geometry', tp1Basis)); continue; }
            const t = mkRej('FILLED', 'open_n1', tp1Basis);
            t.entryCandleTime = ent.entryCandleTime; t.entryPrice = reference;
            t.stopLoss = stopAtRef; t.takeProfits = refLadder.targets;
            t.riskPerUnit = risk; t.riskAtr = risk / atr;
            t.result = 'OPEN'; t.corridorLow = reference; t.corridorHigh = reference;
            trades.push(t);
            open = { entryIndex: i + 1, rec: t, stop: stopAtRef, tps: refLadder.targets,
              entryPrice: reference, entryCandleTime: ent.entryCandleTime, direction: dir };
            pendingCreated++;
            continue;
          }

          const cor = buildCorridor(candle.close, atr, tick);
          if (!cor) { trades.push(mkRej('REJECTED_GEOMETRY', 'no_corridor', tp1Basis)); continue; }
          pending = {
            setupCandleTime: candle.openTime, setupIndex: i,
            corridor: { low: cor.low, high: cor.high }, reference,
            tp1: refLadder.targets[0]!, stop: s.stop.price, tps: tpsAtRef,
            direction: dir, atr, setupKind: s.kind ?? 'NA',
            poolKind, tp1Basis, longLeg, htf: htfState,
          };
          pendingCreated++;
        }
      }
    }
  }

  return { trades, evaluations, actionableSetups, pendingCreated };
}

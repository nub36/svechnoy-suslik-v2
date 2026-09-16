/**
 * V2.3 replay — chronological, one position at a time.
 *
 * Mirrors the frozen harness loop (same minBars, trailing window, HTF bounding,
 * single slot). Differences are only the preregistered V2.3 filter, the
 * R-multiple ladder, and the corridor entry.
 */

import { Settings } from '../../src/core/settings';
import { evaluateV2 } from '../../src/strategy/v2';
import { HTF_MAP } from '../../src/strategy/v2/htf';
import { resolveEntry } from '../../src/strategy/state-machine';
import { trackOutcome } from '../../src/outcome/tracker';
import { executableLadder } from '../../src/replay/v2-runner';
import { buildLadderV23, sniperReversal } from './v23-engine';
import {
  EXPIRY_BARS, TICK_SIZE, buildCorridor, extremePoolKind, feeGuardPasses,
  type PoolKind,
} from './corridor-entry';
import type { Candle, Timeframe } from '../../src/core/types';
import { TF_MS } from '../../src/core/types';
import type { V2Setup } from '../../src/strategy/v2/types';

const WINDOW_MARGIN = 60;

export interface V23Gates {
  sniper: boolean;    // reversals-only sweep filter
  ladder: boolean;    // R-multiple ladder (else frozen targets)
  corridor: boolean;  // corridor entry (else OPEN N+1)
  feeGuard: boolean;
}

export const V23_ARMS: Record<string, V23Gates> = {
  'A':          { sniper: false, ladder: false, corridor: false, feeGuard: false },
  'S-base':     { sniper: true,  ladder: false, corridor: false, feeGuard: false },
  'S-tgt':      { sniper: true,  ladder: true,  corridor: false, feeGuard: false },
  'S-cor':      { sniper: true,  ladder: true,  corridor: true,  feeGuard: false },
  'S-full':     { sniper: true,  ladder: true,  corridor: true,  feeGuard: true  },
  'S-noguard':  { sniper: true,  ladder: true,  corridor: true,  feeGuard: false },
};

export type V23Terminal =
  | 'FILLED' | 'MISSED' | 'EXPIRED' | 'CANCELLED'
  | 'REJECTED_SNIPER' | 'REJECTED_FEE_GUARD' | 'REJECTED_RR1' | 'REJECTED_GEOMETRY';

export interface V23Trade {
  symbol: string; timeframe: Timeframe; direction: 'LONG' | 'SHORT';
  setupKind: string; setupCandleTime: number;
  terminal: V23Terminal; reason: string;
  poolKind: PoolKind; tp2Source: string;
  referencePrice: number; corridorLow: number; corridorHigh: number;
  htfAlignment: string; barsWaited: number; ambiguous: boolean;
  atrAtSetup: number;
  entryCandleTime?: number; entryPrice?: number; stopLoss?: number;
  takeProfits?: number[]; result?: string; exitPrice?: number | null;
  barsHeld?: number; rMultiple?: number; riskPerUnit?: number;
  riskAtr?: number | null;
}

export interface V23Args {
  symbol: string; timeframe: Timeframe; candles: readonly Candle[];
  settings: Settings; htfCandles?: Partial<Record<Timeframe, readonly Candle[]>>;
  from?: number; to?: number; gates: V23Gates;
}

export interface V23Result {
  trades: V23Trade[]; evaluations: number;
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

export function replayV23(args: V23Args): V23Result {
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

  const trades: V23Trade[] = [];
  let evaluations = 0, actionableSetups = 0, pendingCreated = 0;

  interface Pending {
    setupCandleTime: number; setupIndex: number;
    corridor: { low: number; high: number };
    reference: number; tp1: number; stop: number; tps: number[];
    direction: 'LONG' | 'SHORT'; atr: number; setupKind: string;
    poolKind: PoolKind; tp2Source: string; htf: string;
  }
  let pending: Pending | null = null;
  let open: {
    entryIndex: number; rec: V23Trade; stop: number; tps: number[];
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

      const base = (): V23Trade => ({
        symbol, timeframe, direction: p.direction, setupKind: p.setupKind,
        setupCandleTime: p.setupCandleTime, terminal: 'EXPIRED', reason: '',
        poolKind: p.poolKind, tp2Source: p.tp2Source,
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
          const dir = s.direction as 'LONG' | 'SHORT';
          const htfState = s.htfAlignment ?? 'UNKNOWN';

          // Pool kind only when the sniper gate needs it (it is expensive).
          const poolKind: PoolKind = gates.sniper
            ? extremePoolKind(s, visible, settings) : 'NONE';

          const mkRej = (term: V23Terminal, reason: string, tp2src = 'NA'): V23Trade => ({
            symbol, timeframe, direction: dir, setupKind: s.kind ?? 'NA',
            setupCandleTime: candle.openTime, terminal: term, reason,
            poolKind, tp2Source: tp2src, referencePrice: reference,
            corridorLow: 0, corridorHigh: 0, htfAlignment: htfState,
            barsWaited: 0, ambiguous: false, atrAtSetup: atr,
          });

          if (gates.sniper) {
            const v = sniperReversal(s, poolKind);
            if (!v.ok) { trades.push(mkRej('REJECTED_SNIPER', v.reason)); continue; }
          }
          if (gates.feeGuard && !feeGuardPasses(reference, stopAtRef, atr)) {
            trades.push(mkRej('REJECTED_FEE_GUARD', 'stop_below_floor')); continue;
          }

          // --- ladder
          let tpsAtRef: number[]; let tp2Source = 'FROZEN';
          if (gates.ladder) {
            const lad = buildLadderV23(dir, reference, stopAtRef, s.targets);
            if (lad.targets.length === 0) {
              trades.push(mkRej('REJECTED_GEOMETRY', 'no_ladder')); continue;
            }
            tpsAtRef = lad.targets; tp2Source = lad.tp2Source;
          } else {
            tpsAtRef = s.targets.map((t) => t.price + shift);
          }

          const refLadder = executableLadder(dir, reference, stopAtRef, tpsAtRef);
          if (refLadder.targets.length === 0) {
            trades.push(mkRej('REJECTED_GEOMETRY', 'no_target_ahead', tp2Source)); continue;
          }
          if (refLadder.rr1 < minRr) {
            trades.push(mkRej('REJECTED_RR1', 'rr1_below_min_rr', tp2Source)); continue;
          }

          if (!gates.corridor) {
            const risk = Math.abs(reference - stopAtRef);
            const ok = risk > 0 && (dir === 'LONG' ? stopAtRef < reference : stopAtRef > reference);
            if (!ok) { trades.push(mkRej('REJECTED_GEOMETRY', 'reference_geometry', tp2Source)); continue; }
            const t = mkRej('FILLED', 'open_n1', tp2Source);
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
          if (!cor) { trades.push(mkRej('REJECTED_GEOMETRY', 'no_corridor', tp2Source)); continue; }
          pending = {
            setupCandleTime: candle.openTime, setupIndex: i,
            corridor: { low: cor.low, high: cor.high }, reference,
            tp1: refLadder.targets[0]!, stop: s.stop.price, tps: tpsAtRef,
            direction: dir, atr, setupKind: s.kind ?? 'NA',
            poolKind, tp2Source, htf: htfState,
          };
          pendingCreated++;
        }
      }
    }
  }

  return { trades, evaluations, actionableSetups, pendingCreated };
}

/**
 * V2.2 replay — chronological, one position at a time.
 *
 * Mirrors the frozen harness loop exactly (same minBars, trailing window, HTF
 * bounding, single slot). Differences are only the preregistered V2.2 gates,
 * the structural TP1 placement, and the corridor entry.
 */

import { Settings } from '../../src/core/settings';
import { evaluateV2 } from '../../src/strategy/v2';
import { HTF_MAP } from '../../src/strategy/v2/htf';
import { resolveEntry } from '../../src/strategy/state-machine';
import { trackOutcome } from '../../src/outcome/tracker';
import { executableLadder } from '../../src/replay/v2-runner';
import {
  confirmedExtremeV22, structuralTargets, type Tp1Basis,
} from './v22-engine';
import {
  CONFLUENCE_MIN, TICK_SIZE, buildCorridor, confluence, feeGuardPasses,
  EXPIRY_BARS,
} from './corridor-entry';
import type { Candle, Timeframe } from '../../src/core/types';
import { TF_MS } from '../../src/core/types';
import type { V2Setup } from '../../src/strategy/v2/types';

const WINDOW_MARGIN = 60;

export interface V22Gates {
  htfScope: boolean;      // restrict to the amended timeframe set (handled by caller)
  targets: boolean;       // structural TP1 placement (no R-multiple fallback)
  confirm: boolean;       // V2.2 reversal/continuation confirmation
  feeGuard: boolean;
  confluence: boolean;
  corridor: boolean;
}

export const V22_ARMS: Record<string, V22Gates> = {
  A:     { htfScope: false, targets: false, confirm: false, feeGuard: false, confluence: false, corridor: false },
  Ahtf:  { htfScope: true,  targets: false, confirm: false, feeGuard: false, confluence: false, corridor: false },
  T:     { htfScope: true,  targets: true,  confirm: false, feeGuard: false, confluence: false, corridor: false },
  R:     { htfScope: true,  targets: false, confirm: true,  feeGuard: false, confluence: false, corridor: false },
  TR:    { htfScope: true,  targets: true,  confirm: true,  feeGuard: false, confluence: false, corridor: false },
  TRG:   { htfScope: true,  targets: true,  confirm: true,  feeGuard: true,  confluence: true,  corridor: false },
  FULL:  { htfScope: true,  targets: true,  confirm: true,  feeGuard: true,  confluence: true,  corridor: true  },
};

export type V22Terminal =
  | 'FILLED' | 'MISSED' | 'EXPIRED' | 'CANCELLED'
  | 'REJECTED_CONFIRM' | 'REJECTED_FEE_GUARD' | 'REJECTED_CONFLUENCE'
  | 'NO_STRUCTURAL_TP' | 'REJECTED_RR1' | 'REJECTED_GEOMETRY';

export interface V22Trade {
  symbol: string; timeframe: Timeframe; direction: 'LONG' | 'SHORT';
  setupKind: string; setupCandleTime: number;
  terminal: V22Terminal; reason: string;
  tp1Basis: Tp1Basis;
  referencePrice: number;
  corridorLow: number; corridorHigh: number;
  htfAlignment: string;
  confluenceVotes: number;
  barsWaited: number; ambiguous: boolean;
  atrAtSetup: number;
  entryCandleTime?: number; entryPrice?: number; stopLoss?: number;
  takeProfits?: number[]; result?: string; exitPrice?: number | null;
  barsHeld?: number; rMultiple?: number; riskPerUnit?: number;
  riskAtr?: number | null;
}

export interface V22Args {
  symbol: string; timeframe: Timeframe; candles: readonly Candle[];
  settings: Settings; htfCandles?: Partial<Record<Timeframe, readonly Candle[]>>;
  from?: number; to?: number; gates: V22Gates;
}

export interface V22Result {
  trades: V22Trade[]; evaluations: number;
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

export function replayV22(args: V22Args): V22Result {
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

  const trades: V22Trade[] = [];
  let evaluations = 0, actionableSetups = 0, pendingCreated = 0;

  interface Pending {
    setup: V2Setup; setupCandleTime: number; setupIndex: number;
    corridor: { low: number; high: number };
    reference: number; tp1: number; stop: number; tps: number[];
    direction: 'LONG' | 'SHORT'; atr: number;
    tp1Basis: Tp1Basis; votes: number; htf: string;
  }
  let pending: Pending | null = null;
  let open: {
    entryIndex: number; rec: V22Trade; stop: number; tps: number[];
    entryPrice: number; entryCandleTime: number; direction: 'LONG' | 'SHORT';
  } | null = null;

  const htfSpans = new Map<Timeframe, number>();
  for (const h of HTF_MAP[timeframe] ?? []) htfSpans.set(h, TF_MS[h]);

  for (let i = minBars; i < closed.length; i++) {
    const candle = closed[i]!;
    if (args.from !== undefined && candle.openTime < args.from) continue;
    if (args.to !== undefined && candle.openTime > args.to) break;

    /* ---- 1. advance PENDING ---- */
    if (pending && open === null) {
      const p = pending;
      const long = p.direction === 'LONG';
      const barsWaited = i - p.setupIndex;
      const touches = long ? candle.low <= p.corridor.high : candle.high >= p.corridor.low;
      const hitSl = long ? candle.low <= p.stop : candle.high >= p.stop;
      const hitTp1 = long ? candle.high >= p.tp1 : candle.low <= p.tp1;

      const base = (): V22Trade => ({
        symbol, timeframe, direction: p.direction,
        setupKind: p.setup.kind ?? 'NA', setupCandleTime: p.setupCandleTime,
        terminal: 'EXPIRED', reason: '', tp1Basis: p.tp1Basis,
        referencePrice: p.reference,
        corridorLow: p.corridor.low, corridorHigh: p.corridor.high,
        htfAlignment: p.htf, confluenceVotes: p.votes,
        barsWaited, ambiguous: false, atrAtSetup: p.atr,
      });

      if (touches && hitSl) {
        const t = base(); t.terminal = 'CANCELLED'; t.ambiguous = true;
        t.reason = 'ambiguous_same_bar_fill_and_sl';
        trades.push(t); pending = null;
      } else if (touches) {
        const fill = long
          ? Math.min(candle.open, p.corridor.high)
          : Math.max(candle.open, p.corridor.low);
        const ladder = executableLadder(p.direction, fill, p.stop, p.tps);
        const risk = Math.abs(fill - p.stop);
        const ok = risk > 0 && (long ? p.stop < fill : p.stop > fill)
          && ladder.targets.length > 0 && ladder.rr1 >= minRr;
        const t = base();
        if (!ok) {
          t.terminal = ladder.targets.length > 0 && ladder.rr1 < minRr
            ? 'REJECTED_RR1' : 'REJECTED_GEOMETRY';
          t.reason = ladder.targets.length === 0 ? 'no_target_ahead'
            : ladder.rr1 < minRr ? 'rr1_below_min_rr' : 'stop_wrong_side';
          trades.push(t); pending = null;
        } else {
          t.terminal = 'FILLED'; t.reason = 'corridor_touched';
          t.entryCandleTime = candle.openTime; t.entryPrice = fill;
          t.stopLoss = p.stop; t.takeProfits = ladder.targets;
          t.riskPerUnit = risk; t.riskAtr = p.atr > 0 ? risk / p.atr : null;
          t.result = 'OPEN';
          open = { entryIndex: i, rec: t, stop: p.stop, tps: ladder.targets,
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

          // Declared BEFORE mkRej so the closure cannot read them in the
          // temporal dead zone (a hoisted `function` body referencing a later
          // `const` throws at call time, not compile time).
          const conf = confluence(s);
          const htfState = s.htfAlignment ?? 'UNKNOWN';

          const mkRej = (term: V22Terminal, reason: string, basis: Tp1Basis): V22Trade => ({
            symbol, timeframe, direction: s.direction as 'LONG' | 'SHORT',
            setupKind: s.kind ?? 'NA', setupCandleTime: candle.openTime,
            terminal: term, reason, tp1Basis: basis, referencePrice: reference,
            corridorLow: 0, corridorHigh: 0, htfAlignment: htfState,
            confluenceVotes: conf.votes, barsWaited: 0, ambiguous: false,
            atrAtSetup: atr,
          });

          // --- target placement
          let tpsAtRef: number[];
          let tp1Basis: Tp1Basis;
          if (gates.targets) {
            const st = structuralTargets(s.targets);
            if (!st.ok) {
              trades.push(mkRej('NO_STRUCTURAL_TP', 'no_structural_target', 'NONE'));
              continue;
            }
            tpsAtRef = st.targets.map((p) => p + shift);
            tp1Basis = st.tp1Basis;
          } else {
            tpsAtRef = s.targets.map((t) => t.price + shift);
            tp1Basis = (s.targets[0]?.basis as Tp1Basis) ?? 'NONE';
          }
          const refLadder = executableLadder(s.direction, reference, stopAtRef, tpsAtRef);

          if (gates.confirm) {
            const v = confirmedExtremeV22(s);
            if (!v.confirmed) { trades.push(mkRej('REJECTED_CONFIRM', v.reason, tp1Basis)); continue; }
          }
          if (gates.feeGuard && !feeGuardPasses(reference, stopAtRef, atr)) {
            trades.push(mkRej('REJECTED_FEE_GUARD', 'stop_below_floor', tp1Basis)); continue;
          }
          if (gates.confluence && conf.votes < CONFLUENCE_MIN) {
            trades.push(mkRej('REJECTED_CONFLUENCE', `votes_${conf.votes}`, tp1Basis)); continue;
          }
          if (refLadder.targets.length === 0) {
            trades.push(mkRej('REJECTED_GEOMETRY', 'no_target_ahead_at_reference', tp1Basis)); continue;
          }
          if (refLadder.rr1 < minRr) {
            trades.push(mkRej('REJECTED_RR1', 'rr1_below_min_rr', tp1Basis)); continue;
          }

          if (!gates.corridor) {
            const risk = Math.abs(reference - stopAtRef);
            const ok = risk > 0 &&
              (s.direction === 'LONG' ? stopAtRef < reference : stopAtRef > reference);
            if (!ok) { trades.push(mkRej('REJECTED_GEOMETRY', 'reference_geometry', tp1Basis)); continue; }
            const t = mkRej('FILLED', 'open_n1', tp1Basis);
            t.entryCandleTime = ent.entryCandleTime; t.entryPrice = reference;
            t.stopLoss = stopAtRef; t.takeProfits = refLadder.targets;
            t.riskPerUnit = risk; t.riskAtr = risk / atr;
            t.result = 'OPEN'; t.corridorLow = reference; t.corridorHigh = reference;
            trades.push(t);
            open = { entryIndex: i + 1, rec: t, stop: stopAtRef, tps: refLadder.targets,
              entryPrice: reference, entryCandleTime: ent.entryCandleTime, direction: s.direction };
            pendingCreated++;
            continue;
          }

          const cor = buildCorridor(candle.close, atr, tick);
          if (!cor) { trades.push(mkRej('REJECTED_GEOMETRY', 'no_corridor', tp1Basis)); continue; }
          pending = {
            setup: s, setupCandleTime: candle.openTime, setupIndex: i,
            corridor: { low: cor.low, high: cor.high }, reference,
            tp1: refLadder.targets[0]!, stop: s.stop.price, tps: tpsAtRef,
            direction: s.direction, atr, tp1Basis, votes: conf.votes, htf: htfState,
          };
          pendingCreated++;
        }
      }
    }
  }

  return { trades, evaluations, actionableSetups, pendingCreated };
}

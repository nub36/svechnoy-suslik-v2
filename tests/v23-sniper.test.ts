/**
 * Tests required by docs/V2_3_SNIPER_REVERSAL_PREREGISTRATION.md §9.
 * Research tooling only; frozen strategy untouched.
 */

import { describe, it, expect } from 'vitest';
import {
  MIN_BODY_RATIO, MIN_RVOL, TP1_R, TP2_R, buildLadderV23, sniperReversal,
} from '../scripts/real-data/v23-engine';
import { replayV23, V23_ARMS } from '../scripts/real-data/v23-replay';
import { Settings } from '../src/core/settings';
import type { TargetPlan, V2Setup } from '../src/strategy/v2/types';
import type { Candle, Timeframe } from '../src/core/types';

const H = 3_600_000;
const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  openTime: i * H, closeTime: i * H + H - 1, open: o, high: h, low: l,
  close: c, volume: 100, isClosed: true,
} as Candle);

const rev = (o: Partial<{
  kind: string; dir: string; reclaimed: boolean; reclaimBars: number | null;
  pen: number; wick: number; body: number; rvol: number;
}> = {}): V2Setup => ({
  direction: o.dir ?? 'LONG',
  kind: o.kind ?? 'REVERSAL',
  sweep: {
    direction: o.dir ?? 'LONG',
    reclaimed: o.reclaimed ?? true,
    reclaimBars: o.reclaimBars === undefined ? 1 : o.reclaimBars,
    penetrationAtr: o.pen ?? 0.2,
    wickRatio: o.wick ?? 0.4,
    bodyRatio: o.body ?? 0.5,
    rvol: o.rvol ?? 1.5,
    level: 100,
  },
} as unknown as V2Setup);

/* ---------------- filter: all 8 conditions ---------------- */

describe('V2.3 sniper reversal filter', () => {
  it('accepts a fully qualified reversal on a swept SWING extreme', () => {
    expect(sniperReversal(rev(), 'SWING')).toMatchObject({ ok: true, reason: 'sniper_reversal' });
  });

  it('accepts EQUAL and CLUSTER extremes too (kind gates, never filters)', () => {
    expect(sniperReversal(rev(), 'EQUAL').ok).toBe(true);
    expect(sniperReversal(rev(), 'CLUSTER').ok).toBe(true);
  });

  it('CONTINUATION IS DISABLED — always rejected regardless of quality', () => {
    const c = rev({ kind: 'CONTINUATION' });
    expect(sniperReversal(c, 'SWING')).toMatchObject({
      ok: false, reason: 'continuation_disabled',
    });
  });

  it('requires a real structural extreme', () => {
    expect(sniperReversal(rev(), 'NONE')).toMatchObject({
      ok: false, reason: 'no_structural_extreme',
    });
  });

  it('requires a causal reclaim, promptly', () => {
    expect(sniperReversal(rev({ reclaimed: false }), 'SWING').reason).toBe('not_reclaimed');
    expect(sniperReversal(rev({ reclaimBars: null }), 'SWING').reason).toBe('reclaim_too_slow');
    expect(sniperReversal(rev({ reclaimBars: 4 }), 'SWING').reason).toBe('reclaim_too_slow');
    expect(sniperReversal(rev({ reclaimBars: 3 }), 'SWING').ok).toBe(true);
  });

  it('enforces the frozen penetration and wick floors', () => {
    expect(sniperReversal(rev({ pen: 0.05 }), 'SWING').reason).toBe('shallow_penetration');
    expect(sniperReversal(rev({ wick: 0.1 }), 'SWING').reason).toBe('weak_rejection_wick');
  });

  it('bodyRatio boundary is >= 0.35', () => {
    expect(sniperReversal(rev({ body: MIN_BODY_RATIO }), 'SWING').ok).toBe(true);
    expect(sniperReversal(rev({ body: MIN_BODY_RATIO - 0.0001 }), 'SWING').reason)
      .toBe('weak_body_reclaim');
  });

  it('rvol boundary is STRICTLY greater than 1.2', () => {
    expect(sniperReversal(rev({ rvol: MIN_RVOL }), 'SWING').reason).toBe('low_rvol');
    expect(sniperReversal(rev({ rvol: MIN_RVOL + 0.001 }), 'SWING').ok).toBe(true);
  });

  it('rejects a sweep pointing the wrong way', () => {
    const s = rev();
    (s as unknown as { sweep: { direction: string } }).sweep.direction = 'SHORT';
    expect(sniperReversal(s, 'SWING').reason).toBe('sweep_wrong_direction');
  });
});

/* ---------------- R-multiple ladder ---------------- */

const plan = (price: number, r: number, basis: TargetPlan['basis']): TargetPlan =>
  ({ price, r, basis, reason: '', clusterId: `${basis}@${price}`, atrDistance: r } as TargetPlan);

describe('V2.3 R-multiple ladder', () => {
  it('LONG: TP1 = 1.5R and TP2 = 2.5R when no nearer structure exists', () => {
    // entry 100, stop 90 -> R = 10
    const l = buildLadderV23('LONG', 100, 90, []);
    expect(l.targets[0]).toBeCloseTo(115, 9);   // 1.5R
    expect(l.targets[1]).toBeCloseTo(125, 9);   // 2.5R
    expect(l.tp2Source).toBe('R_MULTIPLE');
  });

  it('SHORT: mirrors below entry', () => {
    const l = buildLadderV23('SHORT', 100, 110, []);
    expect(l.targets[0]).toBeCloseTo(85, 9);
    expect(l.targets[1]).toBeCloseTo(75, 9);
  });

  it('TP1 always clears risk.min_rr = 1 by construction', () => {
    const l = buildLadderV23('LONG', 100, 90, []);
    const rr1 = (l.targets[0]! - 100) / 10;
    expect(rr1).toBeCloseTo(TP1_R, 9);
    expect(rr1).toBeGreaterThan(1);
  });

  it('TP2 substitutes nearer opposing liquidity when it sits inside 2.5R', () => {
    const l = buildLadderV23('LONG', 100, 90, [plan(120, 2, 'INTERNAL_LIQUIDITY')]);
    expect(l.targets[1]).toBe(120);            // 2.0R < 2.5R
    expect(l.tp2Source).toBe('STRUCTURE');
  });

  it('ignores structure that is nearer than TP1', () => {
    const l = buildLadderV23('LONG', 100, 90, [plan(105, 0.5, 'INTERNAL_LIQUIDITY')]);
    expect(l.targets[0]).toBeCloseTo(115, 9);
    expect(l.tp2Source).toBe('R_MULTIPLE');
  });

  it('ignores R_MULTIPLE plans from the frozen builder (we generate our own)', () => {
    const l = buildLadderV23('LONG', 100, 90, [plan(118, 1.8, 'R_MULTIPLE')]);
    expect(l.tp2Source).toBe('R_MULTIPLE');
    expect(l.targets[1]).toBeCloseTo(125, 9);
  });

  it('adds a structural TP3 only beyond TP2', () => {
    const l = buildLadderV23('LONG', 100, 90, [
      plan(120, 2, 'INTERNAL_LIQUIDITY'), plan(140, 4, 'RANGE_EDGE'),
    ]);
    expect(l.targets).toHaveLength(3);
    expect(l.targets[2]).toBe(140);
  });

  it('emits only 2 rungs when no structure lies beyond TP2', () => {
    expect(buildLadderV23('LONG', 100, 90, []).targets).toHaveLength(2);
  });

  it('returns nothing when risk is zero', () => {
    expect(buildLadderV23('LONG', 100, 100, []).targets).toHaveLength(0);
  });

  it('TP2_R is the preregistered 2.5', () => {
    expect(TP2_R).toBe(2.5);
  });
});

/* ---------------- causal invariants ---------------- */

describe('V2.3 causality / anti-look-ahead', () => {
  const flat: Candle[] = Array.from({ length: 220 },
    (_, i) => bar(i, 100, 100.1, 99.9, 100));

  it('never fills at or before the setup bar (every arm)', () => {
    for (const [name, gates] of Object.entries(V23_ARMS)) {
      const r = replayV23({
        symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: flat,
        settings: Settings.fromDefaults(), gates,
      });
      const bad = r.trades.filter((t) =>
        t.entryCandleTime !== undefined && t.entryCandleTime <= t.setupCandleTime);
      expect(bad, `arm ${name} filled on/before the setup bar`).toHaveLength(0);
    }
  });

  it('never reports a fill outside the published corridor', () => {
    const r = replayV23({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: flat,
      settings: Settings.fromDefaults(), gates: V23_ARMS['S-full']!,
    });
    for (const t of r.trades) {
      if (t.terminal !== 'FILLED' || t.entryPrice === undefined) continue;
      expect(t.entryPrice).toBeGreaterThanOrEqual(t.corridorLow - 1e-9);
      expect(t.entryPrice).toBeLessThanOrEqual(t.corridorHigh + 1e-9);
    }
  });

  it('appending future candles does not change already-emitted trades', () => {
    const base = flat.slice(0, 200);
    const extended = flat.slice(0, 220);
    const run = (c: Candle[]): string => JSON.stringify(
      replayV23({
        symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: c,
        settings: Settings.fromDefaults(), gates: V23_ARMS['S-full']!,
      }).trades.filter((t) => t.setupCandleTime < base[base.length - 1]!.openTime)
        .map((t) => [t.setupCandleTime, t.terminal, t.entryPrice ?? null]));
    expect(run(extended)).toBe(run(base));
  });

  it('produces no CONTINUATION trades in any sniper arm', () => {
    for (const name of ['S-base', 'S-tgt', 'S-cor', 'S-full', 'S-noguard']) {
      const r = replayV23({
        symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: flat,
        settings: Settings.fromDefaults(), gates: V23_ARMS[name]!,
      });
      const cont = r.trades.filter((t) =>
        t.terminal === 'FILLED' && t.setupKind === 'CONTINUATION');
      expect(cont, `arm ${name} admitted a continuation`).toHaveLength(0);
    }
  });
});

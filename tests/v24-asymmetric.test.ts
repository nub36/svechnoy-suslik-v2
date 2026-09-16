/**
 * Tests required by docs/V2_4_ASYMMETRIC_SNIPER_PREREGISTRATION.md §9.
 * Research tooling only; frozen strategy untouched.
 */

import { describe, it, expect } from 'vitest';
import {
  HTF_EMA_MIN_BARS, MIN_BODY_RATIO, MIN_RVOL, baseSniper, htfEma200Bullish,
  longAsymmetry, structuralTargetsV24,
} from '../scripts/real-data/v24-engine';
import { replayV24, V24_ARMS } from '../scripts/real-data/v24-replay';
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
  direction: o.dir ?? 'LONG', kind: o.kind ?? 'REVERSAL',
  sweep: {
    direction: o.dir ?? 'LONG', reclaimed: o.reclaimed ?? true,
    reclaimBars: o.reclaimBars === undefined ? 1 : o.reclaimBars,
    penetrationAtr: o.pen ?? 0.2, wickRatio: o.wick ?? 0.4,
    bodyRatio: o.body ?? 0.5, rvol: o.rvol ?? 1.5, level: 100,
  },
} as unknown as V2Setup);

/* ---------------- base filter ---------------- */

describe('V2.4 base sniper filter (both sides)', () => {
  it('accepts a qualified reversal', () => {
    expect(baseSniper(rev(), 'SWING').ok).toBe(true);
  });
  it('CONTINUATION IS OFF', () => {
    expect(baseSniper(rev({ kind: 'CONTINUATION' }), 'SWING'))
      .toMatchObject({ ok: false, reason: 'continuation_disabled' });
  });
  it('requires a structural extreme', () => {
    expect(baseSniper(rev(), 'NONE').reason).toBe('no_structural_extreme');
  });
  it('bodyRatio boundary >= 0.35', () => {
    expect(baseSniper(rev({ body: MIN_BODY_RATIO }), 'SWING').ok).toBe(true);
    expect(baseSniper(rev({ body: MIN_BODY_RATIO - 1e-4 }), 'SWING').reason)
      .toBe('weak_body_reclaim');
  });
  it('rvol boundary strictly > 1.2', () => {
    expect(baseSniper(rev({ rvol: MIN_RVOL }), 'SWING').reason).toBe('low_rvol');
    expect(baseSniper(rev({ rvol: MIN_RVOL + 1e-3 }), 'SWING').ok).toBe(true);
  });
  it('enforces reclaim promptness and sweep quality', () => {
    expect(baseSniper(rev({ reclaimed: false }), 'SWING').reason).toBe('not_reclaimed');
    expect(baseSniper(rev({ reclaimBars: 4 }), 'SWING').reason).toBe('reclaim_too_slow');
    expect(baseSniper(rev({ pen: 0.01 }), 'SWING').reason).toBe('shallow_penetration');
    expect(baseSniper(rev({ wick: 0.05 }), 'SWING').reason).toBe('weak_rejection_wick');
  });
});

/* ---------------- LONG asymmetry ---------------- */

const withHtf = (bias: string | null, div = false): V2Setup => ({
  direction: 'LONG', kind: 'REVERSAL',
  htf: bias === null ? [] : [{ timeframe: '4h', bias, available: true, asOfTime: 0, bars: 50 }],
  rsi: { bullishDivergence: div },
} as unknown as V2Setup);

describe('V2.4 LONG confluence asymmetry', () => {
  it('SHORT is unaffected — always passes, no symmetric gate', () => {
    const s = { ...withHtf('BEARISH'), direction: 'SHORT' } as unknown as V2Setup;
    expect(longAsymmetry(s, '1h' as Timeframe, undefined, 0, 100))
      .toMatchObject({ ok: true, reason: 'short_unaffected' });
  });

  it('accepts a LONG on HTF structure alone', () => {
    expect(longAsymmetry(withHtf('BULLISH'), '1h' as Timeframe, undefined, 0, 100))
      .toMatchObject({ ok: true, leg: 'HTF_STRUCTURE' });
  });

  it('accepts a LONG on RSI divergence alone', () => {
    expect(longAsymmetry(withHtf('BEARISH', true), '1h' as Timeframe, undefined, 0, 100))
      .toMatchObject({ ok: true, leg: 'RSI_DIVERGENCE' });
  });

  it('REJECTS a LONG when all three legs fail', () => {
    expect(longAsymmetry(withHtf('BEARISH', false), '1h' as Timeframe, undefined, 0, 100))
      .toMatchObject({ ok: false, leg: 'NONE', reason: 'long_no_htf_bullish_confluence' });
  });

  it('ignores an UNAVAILABLE bullish HTF context', () => {
    const s = {
      direction: 'LONG', kind: 'REVERSAL',
      htf: [{ timeframe: '4h', bias: 'BULLISH', available: false, asOfTime: 0, bars: 1 }],
      rsi: { bullishDivergence: false },
    } as unknown as V2Setup;
    expect(longAsymmetry(s, '1h' as Timeframe, undefined, 0, 100).ok).toBe(false);
  });
});

/* ---------------- HTF EMA200 causality ---------------- */

describe('HTF EMA200 leg — causal, never leaks a future bar', () => {
  /** 4h is the primary HTF for 1h in the frozen HTF_MAP. */
  const mk4h = (n: number, price: (i: number) => number): Candle[] =>
    Array.from({ length: n }, (_, i) => ({
      openTime: i * 4 * H, closeTime: i * 4 * H + 4 * H - 1,
      open: price(i), high: price(i) + 1, low: price(i) - 1, close: price(i),
      volume: 10, isClosed: true,
    } as Candle));

  it('is FALSE when fewer than 200 closed HTF bars exist (never true-by-default)', () => {
    const htf = { '4h': mk4h(50, () => 100) } as Partial<Record<Timeframe, Candle[]>>;
    expect(htfEma200Bullish('1h' as Timeframe, htf, 1e15, 999)).toBe(false);
  });

  it('is TRUE when price is above a rising EMA200', () => {
    const htf = { '4h': mk4h(400, (i) => 100 + i) } as Partial<Record<Timeframe, Candle[]>>;
    expect(htfEma200Bullish('1h' as Timeframe, htf, 1e15, 100000)).toBe(true);
  });

  it('is FALSE when price sits below the EMA200', () => {
    const htf = { '4h': mk4h(400, (i) => 100 + i) } as Partial<Record<Timeframe, Candle[]>>;
    expect(htfEma200Bullish('1h' as Timeframe, htf, 1e15, 1)).toBe(false);
  });

  it('CAUSALITY: future HTF bars cannot change the verdict', () => {
    // Bearish history, then a violent bullish future that must be invisible.
    const past = mk4h(400, (i) => 1000 - i);
    const future = Array.from({ length: 200 }, (_, k) => ({
      openTime: (400 + k) * 4 * H, closeTime: (400 + k) * 4 * H + 4 * H - 1,
      open: 1e6, high: 1e6, low: 1e6, close: 1e6, volume: 10, isClosed: true,
    } as Candle));
    const asOf = past[past.length - 1]!.closeTime;
    const only = { '4h': past } as Partial<Record<Timeframe, Candle[]>>;
    const withFuture = { '4h': [...past, ...future] } as Partial<Record<Timeframe, Candle[]>>;
    expect(htfEma200Bullish('1h' as Timeframe, withFuture, asOf, 700))
      .toBe(htfEma200Bullish('1h' as Timeframe, only, asOf, 700));
  });

  it('requires exactly HTF_EMA_MIN_BARS closed bars', () => {
    expect(HTF_EMA_MIN_BARS).toBe(200);
    const just = { '4h': mk4h(HTF_EMA_MIN_BARS - 1, () => 100) } as Partial<Record<Timeframe, Candle[]>>;
    expect(htfEma200Bullish('1h' as Timeframe, just, 1e15, 500)).toBe(false);
  });
});

/* ---------------- structural targets ---------------- */

const plan = (price: number, r: number, basis: TargetPlan['basis']): TargetPlan =>
  ({ price, r, basis, reason: '', clusterId: `${basis}@${price}`, atrDistance: r } as TargetPlan);

describe('V2.4 structural targets — no R-multiple fallback', () => {
  it('prefers nearest liquidity', () => {
    const r = structuralTargetsV24([
      plan(101, 1, 'INTERNAL_LIQUIDITY'), plan(103, 3, 'EQUILIBRIUM')]);
    expect(r.tp1Basis).toBe('INTERNAL_LIQUIDITY');
    expect(r.targets[0]).toBe(101);
  });
  it('prefers liquidity even when equilibrium is nearer', () => {
    const r = structuralTargetsV24([
      plan(101, 1, 'EQUILIBRIUM'), plan(104, 4, 'RANGE_EDGE')]);
    expect(r.tp1Basis).toBe('RANGE_EDGE');
  });
  it('falls back to equilibrium', () => {
    expect(structuralTargetsV24([plan(102, 2, 'EQUILIBRIUM')]).tp1Basis).toBe('EQUILIBRIUM');
  });
  it('SKIPS when only R_MULTIPLE rungs exist', () => {
    const r = structuralTargetsV24([plan(101, 1, 'R_MULTIPLE'), plan(102, 2, 'R_MULTIPLE')]);
    expect(r.ok).toBe(false);
    expect(r.targets).toHaveLength(0);
  });
  it('never emits an R_MULTIPLE rung', () => {
    const r = structuralTargetsV24([
      plan(101, 1, 'INTERNAL_LIQUIDITY'), plan(102, 2, 'R_MULTIPLE'),
      plan(103, 3, 'RANGE_EDGE')]);
    expect(r.targets).toEqual([101, 103]);
  });
});

/* ---------------- causal invariants ---------------- */

describe('V2.4 causality / anti-look-ahead', () => {
  const flat: Candle[] = Array.from({ length: 220 },
    (_, i) => bar(i, 100, 100.1, 99.9, 100));

  it('never fills at or before the setup bar (every arm)', () => {
    for (const [name, gates] of Object.entries(V24_ARMS)) {
      const r = replayV24({
        symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: flat,
        settings: Settings.fromDefaults(), gates,
      });
      const bad = r.trades.filter((t) =>
        t.entryCandleTime !== undefined && t.entryCandleTime <= t.setupCandleTime);
      expect(bad, `arm ${name}`).toHaveLength(0);
    }
  });

  it('never fills outside the published corridor', () => {
    const r = replayV24({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: flat,
      settings: Settings.fromDefaults(), gates: V24_ARMS['S-asym']!,
    });
    for (const t of r.trades) {
      if (t.terminal !== 'FILLED' || t.entryPrice === undefined) continue;
      expect(t.entryPrice).toBeGreaterThanOrEqual(t.corridorLow - 1e-9);
      expect(t.entryPrice).toBeLessThanOrEqual(t.corridorHigh + 1e-9);
    }
  });

  it('appending future candles does not change emitted trades', () => {
    const run = (c: Candle[], cutoff: number): string => JSON.stringify(
      replayV24({
        symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: c,
        settings: Settings.fromDefaults(), gates: V24_ARMS['S-asym']!,
      }).trades.filter((t) => t.setupCandleTime < cutoff)
        .map((t) => [t.setupCandleTime, t.terminal, t.entryPrice ?? null]));
    const base = flat.slice(0, 200);
    const cutoff = base[base.length - 1]!.openTime;
    expect(run(flat, cutoff)).toBe(run(base, cutoff));
  });

  it('emits no CONTINUATION trade in any sniper arm', () => {
    for (const name of ['S-base', 'S-struct', 'S-cor', 'S-asym', 'S-noasym']) {
      const r = replayV24({
        symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: flat,
        settings: Settings.fromDefaults(), gates: V24_ARMS[name]!,
      });
      expect(r.trades.filter((t) =>
        t.terminal === 'FILLED' && t.setupKind === 'CONTINUATION'), name).toHaveLength(0);
    }
  });
});

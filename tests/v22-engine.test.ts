/**
 * Tests required by docs/V2_2_HTF_SPOT_ENGINE_PREREGISTRATION.md §8
 * and AMENDMENT 1. Research tooling only; frozen strategy untouched.
 */

import { describe, it, expect } from 'vitest';
import {
  FEE_ENVS, confirmedExtremeV22, feeRPerLeg, structuralTargets,
  REV_MIN_BODY_RATIO, REV_MIN_RVOL,
} from '../scripts/real-data/v22-engine';
import type { V2Setup, TargetPlan } from '../src/strategy/v2/types';

/* ---------------- reversal: sweep + body reclaim + RVOL ---------------- */

const rev = (o: Partial<{
  reclaimed: boolean; reclaimBars: number | null; pen: number;
  wick: number; body: number; rvol: number;
}> = {}): V2Setup => ({
  direction: 'LONG', kind: 'REVERSAL',
  sweep: {
    direction: 'LONG',
    reclaimed: o.reclaimed ?? true,
    reclaimBars: o.reclaimBars === undefined ? 1 : o.reclaimBars,
    penetrationAtr: o.pen ?? 0.2,
    wickRatio: o.wick ?? 0.4,
    bodyRatio: o.body ?? 0.5,
    rvol: o.rvol ?? 1.5,
    level: 100,
  },
} as unknown as V2Setup);

describe('V2.2 reversal confirmation — displacement requirement REMOVED', () => {
  it('confirms a sweep + body reclaim + rvol setup with NO displacement object', () => {
    const s = rev();
    expect((s as unknown as { displacement?: unknown }).displacement).toBeUndefined();
    expect(confirmedExtremeV22(s)).toMatchObject({
      confirmed: true, path: 'REVERSAL', reason: 'sweep_body_reclaim_rvol',
    });
  });

  it('rejects a weak body reclaim (the new gate)', () => {
    expect(confirmedExtremeV22(rev({ body: 0.20 })))
      .toMatchObject({ confirmed: false, reason: 'weak_body_reclaim' });
  });

  it('bodyRatio boundary is >= 0.35', () => {
    expect(confirmedExtremeV22(rev({ body: REV_MIN_BODY_RATIO })).confirmed).toBe(true);
    expect(confirmedExtremeV22(rev({ body: REV_MIN_BODY_RATIO - 0.001 })).confirmed).toBe(false);
  });

  it('rejects low participation and uses a strict rvol inequality', () => {
    expect(confirmedExtremeV22(rev({ rvol: 0.9 })))
      .toMatchObject({ confirmed: false, reason: 'low_rvol' });
    expect(confirmedExtremeV22(rev({ rvol: REV_MIN_RVOL })).confirmed).toBe(false);
    expect(confirmedExtremeV22(rev({ rvol: REV_MIN_RVOL + 0.01 })).confirmed).toBe(true);
  });

  it('still enforces the causal sweep conditions', () => {
    expect(confirmedExtremeV22(rev({ reclaimed: false })).reason).toBe('not_reclaimed');
    expect(confirmedExtremeV22(rev({ reclaimBars: 4 })).reason).toBe('reclaim_too_slow');
    expect(confirmedExtremeV22(rev({ pen: 0.01 })).reason).toBe('shallow_penetration');
    expect(confirmedExtremeV22(rev({ wick: 0.05 })).reason).toBe('weak_rejection_wick');
  });
});

/* ---------------- continuation: relaxed hold ---------------- */

const cont = (o: Partial<{ hold: number; reclaim: boolean; body: number; close: number }> = {}): V2Setup => ({
  direction: 'SHORT', kind: 'CONTINUATION',
  breakout: {
    direction: 'SHORT',
    closeBeyondAtr: o.close ?? 0.4,
    bodyRatio: o.body ?? 0.7,
    holdBars: o.hold ?? 0,
    immediateReclaim: o.reclaim ?? false,
    level: 100,
  },
} as unknown as V2Setup);

describe('V2.2 continuation — hold_too_short removed', () => {
  it('confirms with holdBars = 0 (would have been rejected in V2.1)', () => {
    expect(confirmedExtremeV22(cont({ hold: 0 })))
      .toMatchObject({ confirmed: true, reason: 'body_close_no_reclaim' });
  });
  it('still rejects an immediate reclaim — hold is evidenced by its absence', () => {
    expect(confirmedExtremeV22(cont({ reclaim: true })).reason).toBe('immediate_reclaim');
  });
  it('still requires a body close beyond the level', () => {
    expect(confirmedExtremeV22(cont({ body: 0.2 })).reason).toBe('wick_not_body');
    expect(confirmedExtremeV22(cont({ close: 0.05 })).reason).toBe('close_not_beyond');
  });
});

/* ---------------- structural target placement ---------------- */

const plan = (price: number, r: number, basis: TargetPlan['basis']): TargetPlan =>
  ({ price, r, basis, reason: '', clusterId: `${basis}@${price}`, atrDistance: r } as TargetPlan);

describe('V2.2 target placement — no R-multiple fallback', () => {
  it('prefers the nearest INTERNAL_LIQUIDITY rung', () => {
    const r = structuralTargets([
      plan(101, 1, 'INTERNAL_LIQUIDITY'),
      plan(103, 3, 'EQUILIBRIUM'),
    ]);
    expect(r.ok).toBe(true);
    expect(r.tp1Basis).toBe('INTERNAL_LIQUIDITY');
    expect(r.targets[0]).toBe(101);
  });

  it('prefers liquidity even when EQUILIBRIUM is nearer', () => {
    const r = structuralTargets([
      plan(101, 1, 'EQUILIBRIUM'),
      plan(104, 4, 'RANGE_EDGE'),
    ]);
    expect(r.tp1Basis).toBe('RANGE_EDGE');
    expect(r.targets[0]).toBe(104);
  });

  it('falls back to EQUILIBRIUM when no liquidity rung exists', () => {
    const r = structuralTargets([plan(102, 2, 'EQUILIBRIUM')]);
    expect(r.ok).toBe(true);
    expect(r.tp1Basis).toBe('EQUILIBRIUM');
  });

  it('SKIPS when only R_MULTIPLE rungs exist (the V2.1 failure mode)', () => {
    const r = structuralTargets([
      plan(101, 1, 'R_MULTIPLE'), plan(102, 2, 'R_MULTIPLE'), plan(103, 3, 'R_MULTIPLE'),
    ]);
    expect(r.ok).toBe(false);
    expect(r.tp1Basis).toBe('NONE');
    expect(r.targets).toHaveLength(0);
  });

  it('never emits an R_MULTIPLE rung in the ladder', () => {
    const r = structuralTargets([
      plan(101, 1, 'INTERNAL_LIQUIDITY'),
      plan(102, 2, 'R_MULTIPLE'),
      plan(103, 3, 'RANGE_EDGE'),
    ]);
    expect(r.targets).toEqual([101, 103]);
  });

  it('orders the ladder by increasing R and caps at 3', () => {
    const r = structuralTargets([
      plan(101, 1, 'INTERNAL_LIQUIDITY'), plan(102, 2, 'INTERNAL_LIQUIDITY'),
      plan(103, 3, 'RANGE_EDGE'), plan(104, 4, 'EQUILIBRIUM'),
    ]);
    expect(r.targets).toHaveLength(3);
    expect(r.targets).toEqual([101, 102, 103]);
  });
});

/* ---------------- fee environments ---------------- */

describe('fee environments (Amendment 1)', () => {
  it('defines exactly GROSS / SPOT / FUT_7 / FUT_4', () => {
    expect(FEE_ENVS.map((e) => e.label)).toEqual(['GROSS', 'SPOT', 'FUT_7', 'FUT_4']);
  });

  it('GROSS charges nothing', () => {
    expect(feeRPerLeg(100, 101, 1, FEE_ENVS[0]!)).toBe(0);
  });

  it('SPOT is 10 bps round trip on a flat round trip', () => {
    // entry 100, exit 100, risk 1 -> (5bps*100 + 5bps*100)/1 = 0.10 R
    expect(feeRPerLeg(100, 100, 1, FEE_ENVS[1]!)).toBeCloseTo(0.10, 9);
  });

  it('FUT_7 is maker entry + taker exit = 7 bps', () => {
    expect(feeRPerLeg(100, 100, 1, FEE_ENVS[2]!)).toBeCloseTo(0.07, 9);
  });

  it('FUT_4 is both maker = 4 bps', () => {
    expect(feeRPerLeg(100, 100, 1, FEE_ENVS[3]!)).toBeCloseTo(0.04, 9);
  });

  it('scales inversely with stop distance — the whole fee-drag problem', () => {
    const tight = feeRPerLeg(100, 100, 0.1, FEE_ENVS[1]!);
    const wide = feeRPerLeg(100, 100, 1.0, FEE_ENVS[1]!);
    expect(tight).toBeCloseTo(wide * 10, 9);
  });

  it('never returns a negative fee (no maker rebate assumed)', () => {
    for (const e of FEE_ENVS) expect(feeRPerLeg(100, 100, 1, e)).toBeGreaterThanOrEqual(0);
  });
});

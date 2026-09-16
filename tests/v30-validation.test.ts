/**
 * V3.0 HTF Liquidation Trap — VALIDATION freeze and TEST-guard invariants.
 *
 * These tests do not re-run the strategy. They assert, against the committed
 * run artifact, that:
 *
 *   1. the frozen module has not been edited since it was validated;
 *   2. not one candle at or beyond `testFromMs` / 2026-01-01 was read;
 *   3. the VALIDATION window really is the pre-registered one, and it sits
 *      strictly before TEST;
 *   4. the headline numbers are the ones published in
 *      docs/V3_0_VALIDATION_RESULTS.md.
 *
 * Point 4 is deliberate: if someone re-runs and overwrites the artifact with
 * different numbers, CI fails and the change has to be explained rather than
 * quietly absorbed. The VALIDATION budget is spent — exactly one run.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/** The candidate as frozen for VALIDATION. */
const FROZEN_SHA256 =
  'a821757ff0319a100a8a9087da1bdd137abb1df0785493d644ad4d87f05dc4cd';

interface SubGroup { n: number; grossExpectancy: number }
interface Artifact {
  slice: string;
  frozenModuleSha256: string;
  constants: Record<string, number>;
  funnel: Record<string, number>;
  n: number;
  tp1HitRatePct: number;
  tp2HitRatePct: number;
  stopDistancePct: { median: number };
  feeDragR: { FUT_4: number; SPOT: number };
  grossRPerTrade: number;
  netRPerTrade: { FUT_4: number; SPOT: number };
  profitFactor: number;
  maxDrawdownR: number;
  outlierDependence: { exTop1Pct: number; removedForTop1Pct: number };
  byDirection: Record<string, SubGroup>;
  bySymbol: Record<string, SubGroup>;
  criteria: {
    a_net_gt_0_at_2_5: { rule: string; value: number; passed: boolean };
    b_gross_gt_0: { rule: string; value: number; passed: boolean };
    verdict: string;
  };
  guards: {
    maxCandleOpenTimeRead: number;
    testCandlesRead: number;
    candles2026Read: number;
    perSymbolBoundaries: {
      symbol: string;
      toMs: number;
      testFromUtc: string;
      testToUtc: string;
    }[];
  };
}

const artifact: Artifact = JSON.parse(
  read('artifacts/research/v30/v30-validation-metrics.json'),
) as Artifact;

describe('V3.0 VALIDATION — freeze integrity', () => {
  it('the candidate module is byte-identical to the frozen hash', () => {
    const hash = createHash('sha256')
      .update(readFileSync(join(ROOT, 'research/v30_htf_trap.ts')))
      .digest('hex');
    expect(hash).toBe(FROZEN_SHA256);
  });

  it('the artifact records the same frozen hash it was produced from', () => {
    expect(artifact.frozenModuleSha256).toBe(FROZEN_SHA256);
  });

  it('the driver only selects a window and adds no strategy code', () => {
    const driver = read('research/v30_validate.ts');
    // it must consume the frozen module...
    expect(driver).toContain("from './v30_htf_trap'");
    // ...and must not redefine any strategy constant
    for (const forbidden of [
      'const MIN_BODY_RATIO =', 'const MIN_RVOL =',
      'const CORRIDOR_ATR_FRAC =', 'const STOP_BUFFER_ATR =',
      'const TIMEOUT_BARS =',
    ]) {
      expect(driver).not.toContain(forbidden);
    }
  });

  it('no parameter was changed: constants match the freeze record', () => {
    expect(artifact.constants).toMatchObject({
      MIN_BODY_RATIO: 0.35,
      MIN_RVOL: 1.25,
      CORRIDOR_ATR_FRAC: 0.1,
      CORRIDOR_EXPIRY_BARS: 3,
      STOP_BUFFER_ATR: 0.15,
      TIMEOUT_BARS: 50,
      MAKER_BPS: 2,
      TAKER_BPS: 5,
    });
    expect(artifact.slice).toBe('validation');
  });
});

describe('V3.0 VALIDATION — TEST guard', () => {
  it('read not a single candle at or beyond testFromMs', () => {
    expect(artifact.guards.testCandlesRead).toBe(0);
  });

  it('read not a single candle at or beyond 2026-01-01', () => {
    expect(artifact.guards.candles2026Read).toBe(0);
  });

  it('the last candle read is exactly the end of the VALIDATION window', () => {
    expect(new Date(artifact.guards.maxCandleOpenTimeRead).toISOString())
      .toBe('2025-03-14T18:00:00.000Z');
  });

  it('every symbol has VALIDATION strictly before TEST, and TEST before 2026', () => {
    expect(artifact.guards.perSymbolBoundaries).toHaveLength(6);
    for (const b of artifact.guards.perSymbolBoundaries) {
      const testFrom = Date.parse(b.testFromUtc);
      const testTo = Date.parse(b.testToUtc);
      expect(b.toMs).toBeLessThan(testFrom);
      expect(testFrom).toBeLessThan(Date.parse('2026-01-01T00:00:00Z'));
      expect(testTo).toBeLessThan(Date.parse('2026-01-01T00:00:00Z'));
      // the window actually used ends at the frozen VALIDATION boundary
      expect(new Date(b.toMs).toISOString()).toBe('2025-03-14T18:00:00.000Z');
      expect(new Date(testFrom).toISOString()).toBe('2025-03-14T19:00:00.000Z');
    }
  });
});

describe('V3.0 VALIDATION — published result is pinned', () => {
  it('both pre-registered criteria passed and the verdict is PASS', () => {
    expect(artifact.criteria.a_net_gt_0_at_2_5.rule)
      .toBe('net R/trade > 0 at 2/5 bps');
    expect(artifact.criteria.a_net_gt_0_at_2_5.passed).toBe(true);
    expect(artifact.criteria.b_gross_gt_0.passed).toBe(true);
    expect(artifact.criteria.verdict).toBe('PASS');
    expect(artifact.netRPerTrade.FUT_4).toBeGreaterThan(0);
    expect(artifact.grossRPerTrade).toBeGreaterThan(0);
  });

  it('headline metrics match docs/V3_0_VALIDATION_RESULTS.md', () => {
    expect(artifact.n).toBe(536);
    expect(artifact.tp1HitRatePct).toBe(47.39);
    expect(artifact.tp2HitRatePct).toBe(14.18);
    expect(artifact.grossRPerTrade).toBe(0.1274);
    expect(artifact.netRPerTrade.FUT_4).toBe(0.06);
    expect(artifact.netRPerTrade.SPOT).toBe(0.0312);
    expect(artifact.profitFactor).toBe(1.2484);
    expect(artifact.maxDrawdownR).toBe(-25.94);
    expect(artifact.stopDistancePct.median).toBe(1.2799);
    expect(artifact.feeDragR.FUT_4).toBe(0.0673);
    expect(artifact.outlierDependence.exTop1Pct).toBe(0.0384);
  });

  it('subgroup counts sum to n — no trade is double-counted or dropped', () => {
    const dirSum = Object.values(artifact.byDirection)
      .reduce((s, g) => s + g.n, 0);
    const symSum = Object.values(artifact.bySymbol)
      .reduce((s, g) => s + g.n, 0);
    expect(dirSum).toBe(artifact.n);
    expect(symSum).toBe(artifact.n);
    expect(artifact.funnel['filled']).toBe(artifact.n);
  });

  it('the fragility finding is preserved, not rounded away', () => {
    // ex-top-1% gross (+0.0384) is BELOW the 0.0673 R fee drag, so the trimmed
    // net is negative. If a future edit "fixes" this, the docs must move too.
    expect(artifact.outlierDependence.removedForTop1Pct).toBe(6);
    expect(artifact.outlierDependence.exTop1Pct)
      .toBeLessThan(artifact.feeDragR.FUT_4);
  });
});

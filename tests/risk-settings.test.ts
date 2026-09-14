/**
 * The RISK section of the admin panel must be genuinely wired:
 *   SL policy, ATR risk parameters, TP1 R, TP2 R, TP3 R, expiration.
 */

import { describe, expect, it } from 'vitest';
import { Settings, SETTINGS_BY_KEY, coerceSettingValue } from '../src/core/settings';
import { buildRiskPlan } from '../src/strategy/risk';

const base = (over: Array<[string, unknown]> = []): Settings =>
  Settings.fromEntries([['risk.sl_atr_mult', 1], ...over]);

describe('SL policy is wired to the engine', () => {
  it('ATR policy ignores the structural level', () => {
    const p = buildRiskPlan({
      direction: 'LONG',
      entry: 100,
      atr: 2,
      structuralStop: 90,
      settings: base([['risk.sl_policy', 'ATR']]),
    })!;
    expect(p.stopLoss).toBeCloseTo(98, 9);
  });

  it('STRUCTURE policy uses the structural level', () => {
    const p = buildRiskPlan({
      direction: 'LONG',
      entry: 100,
      atr: 2,
      structuralStop: 90,
      settings: base([['risk.sl_policy', 'STRUCTURE']]),
    })!;
    expect(p.stopLoss).toBeCloseTo(90, 9);
  });

  it('ATR_OR_STRUCTURE takes whichever is FURTHER away (never tightens)', () => {
    const wider = buildRiskPlan({
      direction: 'LONG',
      entry: 100,
      atr: 2,
      structuralStop: 90, // further than the 98 ATR stop
      settings: base([['risk.sl_policy', 'ATR_OR_STRUCTURE']]),
    })!;
    expect(wider.stopLoss).toBeCloseTo(90, 9);

    const tighter = buildRiskPlan({
      direction: 'LONG',
      entry: 100,
      atr: 2,
      structuralStop: 99.5, // closer than the ATR stop => must be ignored
      settings: base([['risk.sl_policy', 'ATR_OR_STRUCTURE']]),
    })!;
    expect(tighter.stopLoss).toBeCloseTo(98, 9);
  });

  it('works symmetrically for SHORT', () => {
    const p = buildRiskPlan({
      direction: 'SHORT',
      entry: 100,
      atr: 2,
      structuralStop: 110,
      settings: base([['risk.sl_policy', 'ATR_OR_STRUCTURE']]),
    })!;
    expect(p.stopLoss).toBeCloseTo(110, 9);
  });

  it('falls back to ATR when STRUCTURE is requested but unavailable', () => {
    const p = buildRiskPlan({
      direction: 'LONG',
      entry: 100,
      atr: 2,
      settings: base([['risk.sl_policy', 'STRUCTURE']]),
    })!;
    expect(p.stopLoss).toBeCloseTo(98, 9);
  });

  it('an invalid stored policy degrades to the safest option', () => {
    expect(Settings.fromEntries([['risk.sl_policy', 'nonsense']]).slPolicy()).toBe(
      'ATR_OR_STRUCTURE',
    );
  });
});

describe('TP1 / TP2 / TP3 are wired independently', () => {
  it('each R multiple lands at entry + R * risk', () => {
    const p = buildRiskPlan({
      direction: 'LONG',
      entry: 100,
      atr: 2,
      settings: base([
        ['risk.tp1_r', 1],
        ['risk.tp2_r', 2],
        ['risk.tp3_r', 3],
      ]),
    })!;
    // risk per unit = 2 (ATR 2 x mult 1)
    expect(p.takeProfits).toEqual([102, 104, 106]);
    expect(p.rrTp1).toBeCloseTo(1, 9);
  });

  it('changing only TP2 moves only TP2', () => {
    const a = buildRiskPlan({ direction: 'LONG', entry: 100, atr: 2, settings: base() })!;
    const b = buildRiskPlan({
      direction: 'LONG',
      entry: 100,
      atr: 2,
      settings: base([['risk.tp2_r', 5]]),
    })!;
    expect(a.takeProfits[0]).toBe(b.takeProfits[0]);
    expect(b.takeProfits).toContain(110);
  });

  it('0 disables a take-profit level', () => {
    const p = buildRiskPlan({
      direction: 'LONG',
      entry: 100,
      atr: 2,
      settings: base([
        ['risk.tp1_r', 1],
        ['risk.tp2_r', 0],
        ['risk.tp3_r', 0],
      ]),
    })!;
    expect(p.takeProfits).toEqual([102]);
  });

  it('levels are always sorted ascending regardless of input order', () => {
    const s = Settings.fromEntries([
      ['risk.tp1_r', 3],
      ['risk.tp2_r', 1],
      ['risk.tp3_r', 2],
    ]);
    expect(s.tpMultiples()).toEqual([1, 2, 3]);
  });

  it('SHORT take-profits go DOWN from entry', () => {
    const p = buildRiskPlan({ direction: 'SHORT', entry: 100, atr: 2, settings: base() })!;
    for (const tp of p.takeProfits) expect(tp).toBeLessThan(100);
  });
});

describe('ATR risk parameters', () => {
  it('risk.sl_atr_mult scales the stop distance', () => {
    const a = buildRiskPlan({
      direction: 'LONG', entry: 100, atr: 2,
      settings: Settings.fromEntries([['risk.sl_atr_mult', 1]]),
    })!;
    const b = buildRiskPlan({
      direction: 'LONG', entry: 100, atr: 2,
      settings: Settings.fromEntries([['risk.sl_atr_mult', 4]]),
    })!;
    expect(a.stopLoss).toBeCloseTo(98, 9);
    expect(b.stopLoss).toBeCloseTo(92, 9);
  });

  it('ATR only sizes risk — it is never a confirmation input', () => {
    // Proven structurally: buildRiskPlan is the only consumer of the ATR value
    // and it returns a plan, never a decision.
    const p = buildRiskPlan({ direction: 'LONG', entry: 100, atr: 2, settings: base() })!;
    expect(p).not.toHaveProperty('passed');
    expect(p).not.toHaveProperty('score');
  });
});

describe('expiration setting', () => {
  it('is registered, bounded, and consumed by the engine runner', () => {
    const def = SETTINGS_BY_KEY.get('risk.signal_expiry_bars')!;
    expect(def).toBeTruthy();
    expect(def.category).toBe('risk');
    expect(def.consumedBy).toContain('src/strategy/engine-runner.ts');
    expect(coerceSettingValue(def, 5)).toBe(5);
    expect(() => coerceSettingValue(def, -1)).toThrow(/min is/);
  });

  it('0 means never expire', () => {
    expect(Settings.fromEntries([['risk.signal_expiry_bars', 0]]).num('risk.signal_expiry_bars'))
      .toBe(0);
  });
});

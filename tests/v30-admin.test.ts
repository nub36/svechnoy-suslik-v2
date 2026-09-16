/**
 * V3.0 ADMIN PANEL + SETTINGS SURFACE — conformance with
 * docs/ADMIN_PANEL_SPEC.md §1, §2, §12, §13, §14.
 *
 * The panel is the operator's only view of the strategy, so these tests check
 * the things that would let it lie: a missing read-only result field, a
 * parameter whose registry bounds drifted from the spec, a V3.0 panel that
 * renders without its caveats, or a freeze banner that never fires.
 *
 * The numbers themselves come from `src/strategy/v30/validated.ts`, which is a
 * copy of the committed artifacts — and is checked against them here.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SETTINGS_REGISTRY,
  SETTINGS_BY_KEY,
  Settings,
  coerceSettingValue,
} from '../src/core/settings';
import {
  V30_CAVEATS,
  V30_FROZEN_SURFACE,
  V30_PARITY_ARTIFACT,
  V30_RESEARCH_SHA256,
  V30_VALIDATED_RESULTS,
  v30ConfigStatus,
} from '../src/strategy/v30';
import { ACTIVE_STRATEGIES, V30_FROZEN } from '../src/strategy/v30/params';
import { CATEGORY_RU } from '../app/lib/format';

const root = process.cwd();
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
const adminPage = read('app/admin/page.tsx');
const strategyRoute = read('app/api/admin/strategy/route.ts');
const settingsRu = read('app/lib/settings-ru.ts');

/** The V3.0 parameter table from docs/ADMIN_PANEL_SPEC.md §2. */
const SPEC_PARAMS: Record<string, { def: unknown; min?: number; max?: number }> = {
  'v30.bodyRatioMin': { def: 0.35, min: 0.1, max: 0.8 },
  'v30.rvolMin': { def: 1.25, min: 1.0, max: 3.0 },
  'v30.corridorATR': { def: 0.1, min: 0.02, max: 0.3 },
  'v30.slBufferATR': { def: 0.15, min: 0.05, max: 0.5 },
  'v30.tp1Equilibrium': { def: 0.5, min: 0.25, max: 0.75 },
  'v30.breakevenTrigger': { def: 'tp1' },
  'v30.timeoutBars': { def: 50, min: 10, max: 100 },
  'v30.positionSplitTP1': { def: 0.5, min: 0.25, max: 0.75 },
  'v30.htfTimeframe': { def: '4h' },
  'v30.ltfTimeframe': { def: '1h' },
};

describe('admin spec §2: V3.0 parameters are exposed exactly as specified', () => {
  it('every specified parameter exists with the specified default and bounds', () => {
    for (const [key, spec] of Object.entries(SPEC_PARAMS)) {
      const def = SETTINGS_BY_KEY.get(key);
      expect(def, `${key} is missing from the registry`).toBeDefined();
      expect(def!.default, key).toEqual(spec.def);
      expect(def!.category, key).toBe('v30');
      if (spec.min !== undefined) expect(def!.min, key).toBe(spec.min);
      if (spec.max !== undefined) expect(def!.max, key).toBe(spec.max);
      expect(def!.consumedBy.length, `${key} declares no consumer`).toBeGreaterThan(0);
    }
  });

  it('the enum parameters accept only the specified values', () => {
    expect(() => coerceSettingValue(SETTINGS_BY_KEY.get('v30.htfTimeframe')!, '15m')).toThrow();
    expect(() => coerceSettingValue(SETTINGS_BY_KEY.get('v30.ltfTimeframe')!, '4h')).toThrow();
    expect(() => coerceSettingValue(SETTINGS_BY_KEY.get('v30.breakevenTrigger')!, 'always')).toThrow();
    expect(coerceSettingValue(SETTINGS_BY_KEY.get('v30.htfTimeframe')!, '1d')).toBe('1d');
    expect(coerceSettingValue(SETTINGS_BY_KEY.get('v30.ltfTimeframe')!, '15m')).toBe('15m');
    expect(coerceSettingValue(SETTINGS_BY_KEY.get('v30.breakevenTrigger')!, 'never')).toBe('never');
  });

  it('numbers outside the specified range are refused', () => {
    for (const [key, spec] of Object.entries(SPEC_PARAMS)) {
      if (spec.min === undefined || spec.max === undefined) continue;
      const def = SETTINGS_BY_KEY.get(key)!;
      expect(() => coerceSettingValue(def, spec.min! - 1), `${key} below min`).toThrow();
      expect(() => coerceSettingValue(def, spec.max! + 1), `${key} above max`).toThrow();
    }
  });

  it('the traded universe cannot be emptied', () => {
    const def = SETTINGS_BY_KEY.get('v30.symbols')!;
    expect(() => coerceSettingValue(def, [])).toThrow();
    expect(coerceSettingValue(def, ['btcusdt'])).toEqual(['btcusdt']);
  });

  it('the corridor expiry is NOT exposed: it is a frozen constant', () => {
    expect(SETTINGS_BY_KEY.has('v30.corridorExpiryBars')).toBe(false);
    expect(v30ConfigStatus(Settings.fromDefaults()).params.corridorExpiryBars).toBe(3);
    expect(V30_FROZEN_SURFACE.corridorExpiryBars).toBe(3);
  });

  it('the strategy selector only offers strategies this build can run', () => {
    expect([...ACTIVE_STRATEGIES]).toEqual(['V3_0', 'V1_SMC']);
    expect(SETTINGS_BY_KEY.get('strategy.active')!.default).toBe('V3_0');
    expect(() => coerceSettingValue(SETTINGS_BY_KEY.get('strategy.active')!, 'V2_8')).toThrow();
    // The V2.x candidates are research-only and must be documented as such
    // wherever the selector is described.
    expect(strategyRoute).toContain('researchOnlyStrategies');
  });
});

describe('admin spec §2: read-only results and warnings', () => {
  it('both windows are always shown, never TRAIN alone', () => {
    expect(V30_VALIDATED_RESULTS.map((r) => r.slice)).toEqual(['TRAIN', 'VALIDATION']);
    expect(adminPage).toContain('v.results.map');
  });

  it('carries every read-only field the spec lists', () => {
    for (const r of V30_VALIDATED_RESULTS) {
      for (const field of [
        'n',
        'tp1HitRatePct',
        'tp2HitRatePct',
        'stopDistancePctMedian',
        'grossRPerTrade',
        'feeDragR',
        'netRPerTrade',
        'netRPerTradeStress',
        'profitFactor',
        'maxDrawdownR',
        'exTop1Pct',
        'edgeRetainedPct',
        'positiveRRatePct',
        'byDirection',
        'bySymbol',
      ] as const) {
        expect(r[field], `${r.slice}.${String(field)}`).toBeDefined();
      }
      expect(r.bySymbol.length).toBe(6);
      expect(r.byDirection.length).toBe(2);
    }
    // The headline figures the spec publishes.
    const validation = V30_VALIDATED_RESULTS.find((r) => r.slice === 'VALIDATION')!;
    expect(validation.n).toBe(536);
    expect(validation.netRPerTrade).toBeCloseTo(0.06, 4);
    expect(validation.grossRPerTrade).toBeCloseTo(0.1274, 4);
    const train = V30_VALIDATED_RESULTS.find((r) => r.slice === 'TRAIN')!;
    expect(train.n).toBe(1585);
  });

  it('the copies still equal the committed artifacts', () => {
    for (const file of ['v30-train-metrics.json', 'v30-validation-metrics.json']) {
      const a = JSON.parse(read(join('artifacts', 'research', 'v30', file))) as {
        slice: string;
        n: number;
        grossRPerTrade: number;
        netRPerTrade: { FUT_4: number };
        feeDragR: { FUT_4: number };
        positiveRRatePct: number;
      };
      const r = V30_VALIDATED_RESULTS.find((x) => x.slice === a.slice.toUpperCase())!;
      expect(r.n, file).toBe(a.n);
      expect(r.grossRPerTrade, file).toBeCloseTo(a.grossRPerTrade, 4);
      expect(r.netRPerTrade, file).toBeCloseTo(a.netRPerTrade.FUT_4, 4);
      expect(r.feeDragR, file).toBeCloseTo(a.feeDragR.FUT_4, 4);
      expect(r.positiveRRatePct, file).toBeCloseTo(a.positiveRRatePct, 2);
    }
  });

  it('the panel always renders the caveats and never claims PRODUCTION_READY', () => {
    expect(V30_CAVEATS.length).toBeGreaterThanOrEqual(5);
    expect(adminPage).toContain('v.caveats.map');
    expect(adminPage).toContain('PRODUCTION_READY');
    expect(adminPage).toContain('запрещено');
    // The aggregate-only warning names the symbol breakdown.
    expect(V30_CAVEATS.join(' ')).toContain('3 of 6');
  });

  it('ex-top-1 % is displayed beside the gross figure', () => {
    const grossIdx = adminPage.indexOf('<th>Gross R</th>');
    const exIdx = adminPage.indexOf('<th>Без топ-1%, R</th>');
    expect(grossIdx).toBeGreaterThan(-1);
    expect(exIdx).toBeGreaterThan(grossIdx);
    expect(exIdx - grossIdx).toBeLessThan(120); // adjacent column
  });

  it('subgroups with n < 100 are greyed out', () => {
    expect(adminPage).toContain('r.n < 100');
    expect(adminPage).toContain('nCell');
  });

  it('warns that the VALIDATION window is spent and never re-run', () => {
    expect(V30_CAVEATS.join(' ')).toContain('spent');
    expect(read('docs/ADMIN_PANEL_SPEC.md')).toContain('Never run V3.0 on the VALIDATION window again');
  });
});

describe('admin spec §14: implementation requirements', () => {
  it('pins the research module by hash and reports the parity status', () => {
    expect(V30_RESEARCH_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(strategyRoute).toContain('V30_RESEARCH_SHA256');
    expect(strategyRoute).toContain('parity');
    expect(adminPage).toContain('Проверка переноса');
  });

  it('the parity artifact it reports on is TRAIN-only', () => {
    const a = JSON.parse(read(V30_PARITY_ARTIFACT)) as {
      parity: string;
      window: string;
      artifactCrossCheck: { problems: string[] };
    };
    expect(a.parity).toBe('PASS');
    expect(a.window).toContain('TRAIN');
    expect(a.artifactCrossCheck.problems).toEqual([]);
  });

  it('every persisted V3.0 signal carries its parameter snapshot', () => {
    const runner = read('src/strategy/v30/runner.ts');
    expect(runner).toContain('planPayload');
    expect(runner).toContain('breakdown: JSON.stringify({ v30: planPayload(plan, p) })');
    const payload = read('src/strategy/v30/runner.ts');
    for (const key of ['corridorAtr', 'slBufferAtr', 'tp1Equilibrium', 'timeoutBars', 'htfTimeframe']) {
      expect(payload).toContain(key);
    }
  });

  it('the strategy API route is read-only', () => {
    expect(strategyRoute).not.toMatch(/export async function (PUT|POST|DELETE)/);
    expect(strategyRoute).toContain('requireAdmin');
  });

  it('a drifted parameter is reported by key', () => {
    const all = Settings.fromEntries([
      ['v30.corridorATR', 0.2],
      ['v30.timeoutBars', 40],
      ['v30.symbols', ['BTCUSDT']],
      ['v30.makerBps', 3],
    ]);
    const status = v30ConfigStatus(all);
    expect(status.frozen).toBe(false);
    expect(status.driftedKeys).toEqual(
      expect.arrayContaining(['v30.corridorATR', 'v30.timeoutBars', 'v30.symbols', 'v30.makerBps']),
    );
    // The frozen configuration reports no drift.
    const clean = v30ConfigStatus(Settings.fromDefaults());
    expect(clean.frozen).toBe(true);
    expect(clean.driftedKeys).toEqual([]);
  });
});

describe('Russian UI surface', () => {
  it('every V3.0 setting has a Russian label and description', () => {
    const v30Keys = SETTINGS_REGISTRY.filter((s) => s.category === 'v30').map((s) => s.key);
    expect(v30Keys.length).toBeGreaterThanOrEqual(13);
    for (const key of [...v30Keys, 'strategy.active']) {
      expect(settingsRu, `${key} missing from SETTING_RU`).toContain(`'${key}': {`);
    }
  });

  it('the new category has a Russian tab label, not the raw key', () => {
    expect((CATEGORY_RU as Record<string, string>)['v30']).toBeTruthy();
    expect((CATEGORY_RU as Record<string, string>)['v30']).not.toBe('v30');
  });

  it('the card is written for a Russian-speaking operator', () => {
    for (const needle of ['Активная стратегия', 'Готовность данных', 'Открытые сигналы']) {
      expect(settingsRu + adminPage, needle).toContain(needle);
    }
  });
});

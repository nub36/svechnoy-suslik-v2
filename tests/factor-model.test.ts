/**
 * The Smart Money FACTOR MODEL is part of the specification, so it is pinned
 * by tests:
 *
 *   INDEPENDENT  BOS, ORDER_BLOCK, FVG, LIQUIDITY_SWEEP, RANGE_POSITION
 *   CONTEXT      INTERNAL_STRUCTURE
 *   DERIVED      OB_FVG_CONFLUENCE
 *
 * Plus an ARCHITECTURE GUARD that fails if any removed factor
 * (CHOCH / EQUAL_LEVELS / VOLUME_IMBALANCE / PREMIUM_DISCOUNT) creeps back
 * into the active strategy, settings or UI code.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTEXT_FACTORS,
  DERIVED_FACTORS,
  FACTOR_IDS,
  FACTOR_KIND,
  FACTOR_LABEL,
  FORBIDDEN_FACTOR_NAMES,
  INDEPENDENT_FACTORS,
  isFactorId,
  type DetectorEvent,
  type FactorId,
} from '../src/core/types';
import { SETTINGS_REGISTRY, Settings } from '../src/core/settings';
import { DETECTORS, buildContext, deriveConfluence } from '../src/strategy/detectors';
import { scoreDirection } from '../src/strategy/scoring';
import { evaluate } from '../src/strategy/smart-money';
import { buildChartPayload } from '../src/web/overlays';
import { candle, loadFixtureCandles, hasFixtures } from './helpers';

const EXPECTED_FACTORS = [
  'BOS',
  'ORDER_BLOCK',
  'FVG',
  'LIQUIDITY_SWEEP',
  'RANGE_POSITION',
  'INTERNAL_STRUCTURE',
  'OB_FVG_CONFLUENCE',
] as const;

describe('the factor set is exactly as specified', () => {
  it('contains precisely the 7 required factors', () => {
    expect([...FACTOR_IDS].sort()).toEqual([...EXPECTED_FACTORS].sort());
    expect(FACTOR_IDS).toHaveLength(7);
  });

  it('classifies them into INDEPENDENT / CONTEXT / DERIVED correctly', () => {
    expect([...INDEPENDENT_FACTORS].sort()).toEqual(
      ['BOS', 'ORDER_BLOCK', 'FVG', 'LIQUIDITY_SWEEP', 'RANGE_POSITION'].sort(),
    );
    expect([...CONTEXT_FACTORS]).toEqual(['INTERNAL_STRUCTURE']);
    expect([...DERIVED_FACTORS]).toEqual(['OB_FVG_CONFLUENCE']);

    for (const f of INDEPENDENT_FACTORS) expect(FACTOR_KIND[f]).toBe('INDEPENDENT');
    for (const f of CONTEXT_FACTORS) expect(FACTOR_KIND[f]).toBe('CONTEXT');
    for (const f of DERIVED_FACTORS) expect(FACTOR_KIND[f]).toBe('DERIVED');
  });

  it('rejects every removed factor name', () => {
    for (const removed of FORBIDDEN_FACTOR_NAMES) {
      expect(isFactorId(removed)).toBe(false);
      expect(FACTOR_IDS as readonly string[]).not.toContain(removed);
    }
  });

  it('exposes a human label for every factor and none for removed ones', () => {
    for (const f of FACTOR_IDS) expect(FACTOR_LABEL[f]).toBeTruthy();
    expect(Object.keys(FACTOR_LABEL).sort()).toEqual([...EXPECTED_FACTORS].sort());
    expect(FACTOR_LABEL['RANGE_POSITION']).toBe('RANGE POSITION');
    expect(FACTOR_LABEL['INTERNAL_STRUCTURE']).toBe('INTERNAL STRUCTURE');
    expect(FACTOR_LABEL['OB_FVG_CONFLUENCE']).toBe('OB + FVG CONFLUENCE');
  });

  it('registers enabled+weight settings for every factor, and only those', () => {
    const keys = SETTINGS_REGISTRY.map((d) => d.key);
    for (const f of FACTOR_IDS) {
      expect(keys).toContain(`detectors.${f}.enabled`);
      expect(keys).toContain(`detectors.${f}.weight`);
    }
    const factorKeys = keys.filter((k) => /^detectors\.[A-Z_]+\.(enabled|weight)$/.test(k));
    expect(factorKeys).toHaveLength(FACTOR_IDS.length * 2);
  });

  it('has a detector implementation for every non-derived factor', () => {
    for (const f of INDEPENDENT_FACTORS) expect(typeof DETECTORS[f]).toBe('function');
    for (const f of CONTEXT_FACTORS) expect(typeof DETECTORS[f]).toBe('function');
    // DERIVED factors are produced by deriveConfluence(), not a plain detector.
    for (const f of DERIVED_FACTORS) expect(DETECTORS[f]).toBeUndefined();
  });
});

describe('ARCHITECTURE GUARD: removed factors cannot return', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(p)) out.push(p);
    }
    return out;
  }

  /**
   * Strip comments and string literals. The repo legitimately NAMES the
   * removed factors in documentation ("we removed CHOCH"), and this very test
   * file lists them. Only real identifiers/JSX text matter.
   */
  function codeOnly(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  }

  // Active strategy / settings / UI code. tests/ is excluded on purpose.
  const files = [...walk('src'), ...walk('app')];

  it.each(FORBIDDEN_FACTOR_NAMES)('%s is absent from active code', (name) => {
    const re = new RegExp(`\\b${name}\\b`);
    const hits = files.filter((f) => re.test(codeOnly(readFileSync(f, 'utf8'))));
    expect(hits).toEqual([]);
  });

  it.each(FORBIDDEN_FACTOR_NAMES)('%s is absent from JSX text and raw strings too', (name) => {
    // Second pass WITHOUT stripping strings, limited to the user-facing UI and
    // the settings registry, so a removed factor cannot survive as a label.
    const uiFiles = [...walk('app'), 'src/core/settings.ts', 'src/web/overlays.ts'];
    const re = new RegExp(`\\b${name}\\b`);
    const hits = uiFiles.filter((f) => {
      const src = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      return re.test(src);
    });
    expect(hits).toEqual([]);
  });

  it('no settings key references a removed factor', () => {
    for (const def of SETTINGS_REGISTRY) {
      for (const removed of FORBIDDEN_FACTOR_NAMES) {
        expect(def.key).not.toContain(removed);
      }
    }
  });

  it('a removed factor cannot enter scoring even if an event is forged', () => {
    const s = Settings.fromDefaults();
    const forged = {
      detector: 'CHOCH',
      kind: 'INDEPENDENT',
      direction: 'LONG',
      index: 5,
      time: 1000,
      strength: 1,
      reason: 'forged',
      dedupeKey: 'forged',
    } as unknown as DetectorEvent;

    const b = scoreDirection([forged], 'LONG', s);
    // There is no weight and no enabled flag for it => it contributes nothing.
    const counted = b.components.filter((c) => c.counted);
    expect(counted).toEqual([]);
    expect(b.rawScore).toBe(0);
    expect(b.totalWeight).toBe(0);
    expect(b.score).toBe(0);
  });
});

describe.skipIf(!hasFixtures())('the live engine only emits allowed factors', () => {
  const candles = loadFixtureCandles('BTCUSDT', '1h');
  const settings = Settings.fromDefaults();

  it('every emitted event is an allowed factor with the right kind', () => {
    const ev = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings })!;
    expect(ev).toBeTruthy();
    for (const e of ev.events) {
      expect(isFactorId(e.detector)).toBe(true);
      expect(e.kind).toBe(FACTOR_KIND[e.detector]);
    }
  });

  it('every score component is an allowed factor', () => {
    const ev = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings })!;
    for (const side of [ev.long, ev.short]) {
      for (const c of side.components) {
        expect(isFactorId(c.detector)).toBe(true);
      }
    }
  });

  it('the chart API overlay factor set is restricted to allowed factors', () => {
    const payload = buildChartPayload('BTCUSDT', '1h', candles, settings);
    const seen = new Set<string>();
    for (const b of payload.overlays.boxes) seen.add(b.detector);
    for (const l of payload.overlays.lines) seen.add(l.detector);
    for (const m of payload.overlays.markers) seen.add(m.detector);
    for (const l of payload.overlays.legend) seen.add(l.detector);

    for (const d of seen) {
      expect(isFactorId(d)).toBe(true);
      expect(FORBIDDEN_FACTOR_NAMES).not.toContain(d);
    }
  });

  it('the chart legend never advertises a removed factor', () => {
    const payload = buildChartPayload('BTCUSDT', '1h', candles, settings);
    for (const entry of payload.overlays.legend) {
      expect(FORBIDDEN_FACTOR_NAMES).not.toContain(entry.detector);
      expect(FACTOR_LABEL[entry.detector]).toBe(entry.label);
    }
  });

  it('disabling a factor removes it from the events entirely', () => {
    for (const f of FACTOR_IDS) {
      const off = evaluate({
        symbol: 'BTCUSDT',
        timeframe: '1h',
        candles,
        settings: Settings.fromEntries([[`detectors.${f}.enabled`, false]]),
      })!;
      expect(off.events.some((e) => e.detector === f)).toBe(false);
    }
  });
});

describe('INTERNAL_STRUCTURE is a distinct CONTEXT factor', () => {
  it('is declared as CONTEXT, not INDEPENDENT', () => {
    expect(FACTOR_KIND['INTERNAL_STRUCTURE']).toBe('CONTEXT');
  });

  it('has its own enabled + weight settings', () => {
    const keys = SETTINGS_REGISTRY.map((d) => d.key);
    expect(keys).toContain('detectors.INTERNAL_STRUCTURE.enabled');
    expect(keys).toContain('detectors.INTERNAL_STRUCTURE.weight');
  });

  it.skipIf(!hasFixtures())('does not simply duplicate BOS', () => {
    const candles = loadFixtureCandles('BTCUSDT', '1h');
    const settings = Settings.fromDefaults();
    const ev = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings })!;

    const is = ev.events.filter((e) => e.detector === 'INTERNAL_STRUCTURE');
    const bos = ev.events.filter((e) => e.detector === 'BOS');

    // Distinct dedupe namespaces => they can never collapse into each other.
    for (const a of is) {
      expect(a.dedupeKey.startsWith('INTSTRUCT:')).toBe(true);
      for (const b of bos) expect(a.dedupeKey).not.toBe(b.dedupeKey);
    }
    // At most ONE internal-structure event per evaluation (it is a state,
    // not a stream of break events like BOS).
    expect(is.length).toBeLessThanOrEqual(1);
  });

  it.skipIf(!hasFixtures())('contributes only via its configured context weight', () => {
    const candles = loadFixtureCandles('BTCUSDT', '1h');
    const base = evaluate({
      symbol: 'BTCUSDT',
      timeframe: '1h',
      candles,
      settings: Settings.fromDefaults(),
    })!;

    for (const side of [base.long, base.short]) {
      const c = side.components.find((x) => x.detector === 'INTERNAL_STRUCTURE' && x.counted);
      if (!c) continue;
      expect(c.kind).toBe('CONTEXT');
      expect(c.weight).toBe(Settings.fromDefaults().detectorWeight('INTERNAL_STRUCTURE'));
      expect(c.contribution).toBeCloseTo(c.strength * c.weight, 10);
    }
  });
});

describe('OB_FVG_CONFLUENCE is a DERIVED bonus, not double counting', () => {
  const settings = Settings.fromDefaults();

  /** Build an OB and an FVG whose zones overlap, in the same direction. */
  function overlappingPair(direction: 'LONG' | 'SHORT'): DetectorEvent[] {
    return [
      {
        detector: 'ORDER_BLOCK',
        kind: 'INDEPENDENT',
        direction,
        index: 10,
        time: 10_000,
        strength: 0.8,
        reason: 'ob',
        zone: { from: 0, to: 10_000, priceLow: 100, priceHigh: 110 },
        dedupeKey: 'OB:x',
      },
      {
        detector: 'FVG',
        kind: 'INDEPENDENT',
        direction,
        index: 11,
        time: 11_000,
        strength: 0.6,
        reason: 'fvg',
        zone: { from: 0, to: 11_000, priceLow: 105, priceHigh: 115 },
        dedupeKey: 'FVG:y',
      },
    ];
  }

  const ctx = buildContext(
    Array.from({ length: 60 }, (_, i) => candle(i * 1000, 100, 101, 99, 100)),
    59,
    settings,
  );

  it('is emitted when an order block overlaps an FVG', () => {
    const derived = deriveConfluence(overlappingPair('LONG'), ctx);
    expect(derived).toHaveLength(1);
    expect(derived[0]!.detector).toBe('OB_FVG_CONFLUENCE');
    expect(derived[0]!.kind).toBe('DERIVED');
    expect(derived[0]!.derivedFrom).toEqual(['OB:x', 'FVG:y']);
  });

  it('is NOT emitted when the zones do not overlap', () => {
    const events = overlappingPair('LONG');
    events[1]!.zone = { from: 0, to: 11_000, priceLow: 200, priceHigh: 210 };
    expect(deriveConfluence(events, ctx)).toEqual([]);
  });

  it('adds ONLY its own weight — parents are still counted exactly once', () => {
    const parents = overlappingPair('LONG');
    const derived = deriveConfluence(parents, ctx);
    const all = [...parents, ...derived];

    const withoutConfluence = scoreDirection(parents, 'LONG', settings);
    const withConfluence = scoreDirection(all, 'LONG', settings);

    const wOb = settings.detectorWeight('ORDER_BLOCK');
    const wFvg = settings.detectorWeight('FVG');
    const wConf = settings.detectorWeight('OB_FVG_CONFLUENCE');

    // The parents' weight appears exactly once, before AND after.
    expect(withoutConfluence.totalWeight).toBeCloseTo(wOb + wFvg, 9);
    // Adding the derived factor adds ONLY the confluence weight.
    expect(withConfluence.totalWeight).toBeCloseTo(wOb + wFvg + wConf, 9);
    expect(withConfluence.totalWeight - withoutConfluence.totalWeight).toBeCloseTo(wConf, 9);

    // And the raw score grows by exactly confluenceStrength * confluenceWeight.
    const conf = withConfluence.components.find(
      (c) => c.detector === 'OB_FVG_CONFLUENCE' && c.counted,
    )!;
    expect(conf.weight).toBe(wConf);
    expect(conf.contribution).toBeCloseTo(conf.strength * wConf, 10);
    expect(withConfluence.rawScore - withoutConfluence.rawScore).toBeCloseTo(
      conf.contribution,
      9,
    );
  });

  it('the parents each appear exactly once in the counted breakdown', () => {
    const parents = overlappingPair('LONG');
    const all = [...parents, ...deriveConfluence(parents, ctx)];
    const b = scoreDirection(all, 'LONG', settings);
    const counted = b.components.filter((c) => c.counted).map((c) => c.detector);
    expect(counted.filter((d) => d === 'ORDER_BLOCK')).toHaveLength(1);
    expect(counted.filter((d) => d === 'FVG')).toHaveLength(1);
    expect(counted.filter((d) => d === 'OB_FVG_CONFLUENCE')).toHaveLength(1);
  });

  it('emits at most one confluence per direction even with many OB/FVG pairs', () => {
    const many: DetectorEvent[] = [];
    for (let i = 0; i < 5; i++) {
      const [ob, fvg] = overlappingPair('LONG');
      many.push(
        { ...ob!, dedupeKey: `OB:${i}`, strength: 0.5 + i * 0.05 },
        { ...fvg!, dedupeKey: `FVG:${i}`, strength: 0.5 + i * 0.05 },
      );
    }
    const derived = deriveConfluence(many, ctx);
    expect(derived).toHaveLength(1);

    // And even if several were forced through, scoring would count one.
    const b = scoreDirection([...many, ...derived, ...derived], 'LONG', settings);
    const counted = b.components.filter(
      (c) => c.counted && c.detector === 'OB_FVG_CONFLUENCE',
    );
    expect(counted).toHaveLength(1);
  });

  it('can be disabled independently of its parents', () => {
    const parents = overlappingPair('LONG');
    const all = [...parents, ...deriveConfluence(parents, ctx)];
    const off = Settings.fromEntries([['detectors.OB_FVG_CONFLUENCE.enabled', false]]);
    const b = scoreDirection(all, 'LONG', off);

    const conf = b.components.find((c) => c.detector === 'OB_FVG_CONFLUENCE');
    expect(conf?.counted).toBe(false);
    // Parents still contribute.
    expect(b.components.filter((c) => c.counted).map((c) => c.detector).sort()).toEqual([
      'FVG',
      'ORDER_BLOCK',
    ]);
  });

  it('confluence weight is small relative to its parents (bonus semantics)', () => {
    const wConf = settings.detectorWeight('OB_FVG_CONFLUENCE');
    expect(wConf).toBeGreaterThan(0);
    expect(wConf).toBeLessThan(settings.detectorWeight('ORDER_BLOCK'));
    expect(wConf).toBeLessThan(settings.detectorWeight('FVG'));
  });
});

describe('one parent factor contributes at most once', () => {
  const settings = Settings.fromDefaults();

  it.each(FACTOR_IDS)('%s cannot stack weight across many events', (factor: FactorId) => {
    const events: DetectorEvent[] = Array.from({ length: 6 }, (_, i) => ({
      detector: factor,
      kind: FACTOR_KIND[factor],
      direction: 'LONG',
      index: 10 + i,
      time: 1000 + i,
      strength: 0.4 + i * 0.05,
      reason: `event ${i}`,
      dedupeKey: `${factor}:${i}`,
    }));

    const b = scoreDirection(events, 'LONG', settings);
    const counted = b.components.filter((c) => c.counted);

    expect(counted).toHaveLength(1);
    expect(b.totalWeight).toBe(settings.detectorWeight(factor));
    // The STRONGEST event is the one kept.
    expect(counted[0]!.strength).toBeCloseTo(0.65, 10);
    expect(b.duplicatesRemoved).toBe(5);
    expect(b.confirmations).toBe(1);
  });

  it('score stays within 0..100 with every factor firing at full strength', () => {
    const events: DetectorEvent[] = FACTOR_IDS.map((f, i) => ({
      detector: f,
      kind: FACTOR_KIND[f],
      direction: 'LONG',
      index: 10,
      time: 1000 + i,
      strength: 1,
      reason: 'max',
      dedupeKey: `${f}:max`,
    }));
    const b = scoreDirection(events, 'LONG', settings);
    expect(b.score).toBeCloseTo(100, 6);
    expect(b.confirmations).toBe(FACTOR_IDS.length);
  });
});

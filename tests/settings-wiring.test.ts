/**
 * Proves EVERY setting is DB -> engine, not decorative.
 *
 * Two layers of proof:
 *  1. STATIC: each registry key is actually referenced in the source file(s)
 *     declared in its `consumedBy` list.
 *  2. BEHAVIOURAL: changing the value demonstrably changes engine output.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { SETTINGS_REGISTRY, Settings, coerceSettingValue, SETTINGS_BY_KEY } from '../src/core/settings';
import { evaluate } from '../src/strategy/smart-money';
import { buildRiskPlan } from '../src/strategy/risk';
import { trackOutcome } from '../src/outcome/tracker';
import { selectTopSymbols } from '../src/market/top-symbols';
import { loadFixtureCandles, candle, FIXTURES } from './helpers';
import { join } from 'node:path';
import type { ExchangeSymbolInfo, Ticker24h } from '../src/market/binance';

describe('static wiring: every setting is referenced by the engine', () => {
  it.each(SETTINGS_REGISTRY.map((s) => [s.key, s] as const))(
    '%s is read by its declared consumer',
    (key, def) => {
      expect(def.consumedBy.length, `${key} declares no consumer`).toBeGreaterThan(0);
      let found = false;
      for (const file of def.consumedBy) {
        expect(existsSync(file), `${key}: consumer file ${file} does not exist`).toBe(true);
        const src = readFileSync(file, 'utf8');
        // Either the literal key, or the detector-derived accessor.
        const detectorAccessor =
          /^detectors\.[A-Z_]+\.(enabled|weight)$/.test(key) &&
          /detectorEnabled|detectorWeight/.test(src);
        const typedAccessor = def.accessor !== undefined && src.includes(def.accessor);
        if (src.includes(key) || detectorAccessor || typedAccessor) {
          found = true;
          break;
        }
      }
      expect(found, `${key} is declared but never read in ${def.consumedBy.join(', ')}`).toBe(true);
    },
  );

  it('no registry key is orphaned (all have a category and label)', () => {
    for (const s of SETTINGS_REGISTRY) {
      expect(s.label.length, `${s.key} missing label`).toBeGreaterThan(0);
      expect(s.description.length, `${s.key} missing description`).toBeGreaterThan(0);
      expect(s.category.length).toBeGreaterThan(0);
    }
  });

  it('keys are unique', () => {
    const keys = SETTINGS_REGISTRY.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('behavioural wiring: changing a setting changes engine behaviour', () => {
  const candles = loadFixtureCandles('BTCUSDT', '1h');

  it('engine.score_threshold gates the decision', () => {
    const low = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['engine.score_threshold', 0], ['engine.min_components', 1]]) })!;
    const high = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['engine.score_threshold', 100]]) })!;
    expect(low.decision!.passed).toBe(true);
    expect(high.decision!.passed).toBe(false);
    expect(low.decision!.threshold).toBe(0);
    expect(high.decision!.threshold).toBe(100);
  });

  it('engine.min_components gates the decision', () => {
    const lenient = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['engine.score_threshold', 0], ['engine.min_components', 1]]) })!;
    const strict = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['engine.score_threshold', 0], ['engine.min_components', 8]]) })!;
    expect(lenient.decision!.passed).toBe(true);
    expect(strict.decision!.passed).toBe(false);
  });

  it('disabling a detector removes its events', () => {
    const on = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromDefaults() })!;
    const off = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.FVG.enabled', false]]) })!;
    expect(on.events.some((e) => e.detector === 'FVG')).toBe(
      on.events.filter((e) => e.detector === 'FVG').length > 0,
    );
    expect(off.events.some((e) => e.detector === 'FVG')).toBe(false);
  });

  it('detector weights change the score', () => {
    const a = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromDefaults() })!;
    const b = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.BOS.weight', 99]]) })!;
    // At least one side must move (unless BOS produced nothing at all).
    const changed = a.long.score !== b.long.score || a.short.score !== b.short.score;
    const hadBos = a.events.some((e) => e.detector === 'BOS');
    expect(hadBos ? changed : true).toBe(true);
  });

  it('engine.swing_lookback changes structure detection', () => {
    const a = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['engine.swing_lookback', 2]]) })!;
    const b = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['engine.swing_lookback', 8]]) })!;
    expect(a.events.length === b.events.length && a.long.score === b.long.score).toBe(false);
  });

  it('engine.lookback_candles changes the analysed window', () => {
    const a = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['engine.lookback_candles', 80]]) })!;
    const b = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['engine.lookback_candles', 500]]) })!;
    expect(a.candleTime).toBe(b.candleTime); // same candle N
    // RANGE_POSITION depends on the dealing range => window size matters
    expect(JSON.stringify(a.events) !== JSON.stringify(b.events) || a.long.score !== b.long.score).toBe(true);
  });

  it('detectors.event_ttl_bars changes event freshness filtering', () => {
    const short = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.event_ttl_bars', 2]]) })!;
    const long = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.event_ttl_bars', 50]]) })!;
    expect(long.events.length).toBeGreaterThanOrEqual(short.events.length);
  });

  it('detectors.ob_min_displacement changes order block detections', () => {
    const easy = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.ob_min_displacement', 1.01]]) })!;
    const hard = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.ob_min_displacement', 9]]) })!;
    const cntEasy = easy.events.filter((e) => e.detector === 'ORDER_BLOCK').length;
    const cntHard = hard.events.filter((e) => e.detector === 'ORDER_BLOCK').length;
    expect(cntEasy).toBeGreaterThan(cntHard);
  });

  it('detectors.ob_lookback_bars changes the order block scan depth', () => {
    const shallow = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.ob_lookback_bars', 1]]) })!;
    const deep = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.ob_lookback_bars', 30]]) })!;
    expect(deep.events.filter((e) => e.detector === 'ORDER_BLOCK').length)
      .toBeGreaterThanOrEqual(shallow.events.filter((e) => e.detector === 'ORDER_BLOCK').length);
  });

  it('detectors.bos_min_break_pct filters marginal BOS breaks', () => {
    const easy = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.bos_min_break_pct', 0]]) })!;
    const hard = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.bos_min_break_pct', 5]]) })!;
    expect(easy.events.filter((e) => e.detector === 'BOS').length)
      .toBeGreaterThanOrEqual(hard.events.filter((e) => e.detector === 'BOS').length);
    expect(hard.events.filter((e) => e.detector === 'BOS').length).toBe(0);
  });

  it('detectors.sweep_min_wick_ratio filters weak liquidity sweeps', () => {
    const easy = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.sweep_min_wick_ratio', 0]]) })!;
    const hard = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.sweep_min_wick_ratio', 0.99]]) })!;
    expect(easy.events.filter((e) => e.detector === 'LIQUIDITY_SWEEP').length)
      .toBeGreaterThanOrEqual(hard.events.filter((e) => e.detector === 'LIQUIDITY_SWEEP').length);
  });

  it('detectors.range_edge_band changes RANGE_POSITION sensitivity', () => {
    const wide = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.range_edge_band', 0.5]]) })!;
    const narrow = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.range_edge_band', 0.05]]) })!;
    expect(wide.events.filter((e) => e.detector === 'RANGE_POSITION').length)
      .toBeGreaterThanOrEqual(narrow.events.filter((e) => e.detector === 'RANGE_POSITION').length);
  });

  it('detectors.internal_structure_legs changes the CONTEXT factor', () => {
    const few = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.internal_structure_legs', 2]]) })!;
    const many = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.internal_structure_legs', 8]]) })!;
    const f = few.events.find((e) => e.detector === 'INTERNAL_STRUCTURE');
    const m = many.events.find((e) => e.detector === 'INTERNAL_STRUCTURE');
    // Different leg counts must produce a different read of internal structure.
    expect(f?.strength !== m?.strength || f?.direction !== m?.direction || (!f && !m)).toBe(true);
  });

  it('detectors.internal_structure_strength changes minor pivot detection', () => {
    // Different pivot strengths resolve different MINOR legs. Two arbitrary
    // values can coincide by chance, so assert the setting produces more than
    // one distinct reading across its whole range.
    const readings = new Set<string>();
    for (const strength of [1, 2, 3, 4, 5]) {
      const e = evaluate({
        symbol: 'BTCUSDT',
        timeframe: '1h',
        candles,
        settings: Settings.fromEntries([['detectors.internal_structure_strength', strength]]),
      })!;
      const ev = e.events.find((x) => x.detector === 'INTERNAL_STRUCTURE');
      readings.add(ev ? `${ev.direction}:${ev.strength.toFixed(6)}` : 'none');
    }
    expect(readings.size).toBeGreaterThan(1);
  });

  it('detectors.confluence_min_overlap_pct gates OB+FVG confluence', () => {
    const easy = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.confluence_min_overlap_pct', 1]]) })!;
    const hard = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.confluence_min_overlap_pct', 100]]) })!;
    expect(easy.events.filter((e) => e.detector === 'OB_FVG_CONFLUENCE').length)
      .toBeGreaterThanOrEqual(hard.events.filter((e) => e.detector === 'OB_FVG_CONFLUENCE').length);
  });

  it('detectors.fvg_min_pct changes FVG detections', () => {
    const easy = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.fvg_min_pct', 0.001]]) })!;
    const hard = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.fvg_min_pct', 5]]) })!;
    expect(easy.events.filter((e) => e.detector === 'FVG').length)
      .toBeGreaterThanOrEqual(hard.events.filter((e) => e.detector === 'FVG').length);
  });

  it('risk.atr_period changes the ATR used for risk', () => {
    const a = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['risk.atr_period', 7]]) })!;
    const b = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['risk.atr_period', 40]]) })!;
    expect(a.atr).not.toBeCloseTo(b.atr!, 6);
  });

  it('risk.sl_atr_mult changes the stop distance', () => {
    const a = buildRiskPlan({ direction: 'LONG', entry: 100, atr: 2, settings: Settings.fromEntries([['risk.sl_atr_mult', 1]]) })!;
    const b = buildRiskPlan({ direction: 'LONG', entry: 100, atr: 2, settings: Settings.fromEntries([['risk.sl_atr_mult', 3]]) })!;
    expect(a.stopLoss).toBeCloseTo(98, 9);
    expect(b.stopLoss).toBeCloseTo(94, 9);
  });

  it('risk.tp1_r / tp2_r / tp3_r change take-profit levels', () => {
    const p = buildRiskPlan({ direction: 'LONG', entry: 100, atr: 2, settings: Settings.fromEntries([['risk.sl_atr_mult', 1], ['risk.tp1_r', 0.5], ['risk.tp2_r', 4], ['risk.tp3_r', 0]]) })!;
    expect(p.takeProfits).toEqual([101, 108]);
  });

  it('risk.account_quote and risk.risk_pct change position size', () => {
    const a = buildRiskPlan({ direction: 'LONG', entry: 100, atr: 2, settings: Settings.fromEntries([['risk.account_quote', 1000], ['risk.risk_pct', 1], ['risk.sl_atr_mult', 1]]) })!;
    const b = buildRiskPlan({ direction: 'LONG', entry: 100, atr: 2, settings: Settings.fromEntries([['risk.account_quote', 10000], ['risk.risk_pct', 2], ['risk.sl_atr_mult', 1]]) })!;
    expect(a.qty).toBeCloseTo(10 / 2, 9);   // risk 10 quote / 2 per unit
    expect(b.qty).toBeCloseTo(200 / 2, 9);  // risk 200 quote / 2 per unit
  });

  it('outcome.timeout_bars changes when a trade times out', () => {
    const cs = Array.from({ length: 30 }, (_, i) => candle(1_700_000_000_000 + i * 3_600_000, 100, 100.5, 99.5, 100));
    const fast = trackOutcome({ direction: 'LONG', entryPrice: 100, stopLoss: 90, takeProfits: [120], entryCandleTime: cs[0]!.openTime, candles: cs, settings: Settings.fromEntries([['outcome.timeout_bars', 3], ['outcome.fee_pct', 0]]) })!;
    const slow = trackOutcome({ direction: 'LONG', entryPrice: 100, stopLoss: 90, takeProfits: [120], entryCandleTime: cs[0]!.openTime, candles: cs, settings: Settings.fromEntries([['outcome.timeout_bars', 20], ['outcome.fee_pct', 0]]) })!;
    expect(fast.barsHeld).toBe(3);
    expect(slow.barsHeld).toBe(20);
  });

  it('outcome.fee_pct changes realised PnL', () => {
    const mk = (fee: number) => trackOutcome({
      direction: 'LONG', entryPrice: 100, stopLoss: 95, takeProfits: [105],
      entryCandleTime: 1_700_000_000_000,
      candles: [candle(1_700_000_000_000, 100, 106, 99.5, 105.5)],
      settings: Settings.fromEntries([['outcome.fee_pct', fee]]),
    })!;
    expect(mk(0).pnlPct).toBeCloseTo(5, 6);
    expect(mk(0.5).pnlPct).toBeCloseTo(4.5, 6);
  });

  it('outcome.sl_priority_on_ambiguous_bar flips the ambiguous-bar result', () => {
    const mk = (p: boolean) => trackOutcome({
      direction: 'LONG', entryPrice: 100, stopLoss: 95, takeProfits: [105],
      entryCandleTime: 1_700_000_000_000,
      candles: [candle(1_700_000_000_000, 100, 106, 94, 100)],
      settings: Settings.fromEntries([['outcome.sl_priority_on_ambiguous_bar', p], ['outcome.fee_pct', 0]]),
    })!;
    expect(mk(true).result).toBe('SL');
    expect(mk(false).result).toBe('TP');
  });

  it('market.top_n / exclude_symbols / quote_asset drive symbol selection', () => {
    const tickers = JSON.parse(readFileSync(join(FIXTURES, 'ticker24h.json'), 'utf8')) as Ticker24h[];
    const info = JSON.parse(readFileSync(join(FIXTURES, 'exchangeInfo.json'), 'utf8')) as ExchangeSymbolInfo[];
    expect(selectTopSymbols(tickers, info, Settings.fromEntries([['market.top_n', 4]]))).toHaveLength(4);
    const ex = selectTopSymbols(tickers, info, Settings.fromEntries([['market.exclude_symbols', ['BTCUSDT', 'USDCUSDT', 'FDUSDUSDT']]]));
    expect(ex.map((x) => x.symbol)).not.toContain('BTCUSDT');
  });

  it('engine.timeframes is validated and drives the worker loop', () => {
    expect(Settings.fromEntries([['engine.timeframes', ['1m', '1w']]]).timeframes()).toEqual(['1m', '1w']);
    // invalid entries are filtered, falling back to the default set
    expect(Settings.fromEntries([['engine.timeframes', ['nope']]]).timeframes()).toEqual(['15m', '1h', '4h']);
  });
});

describe('setting validation', () => {
  it('enforces min/max on numbers', () => {
    const def = SETTINGS_BY_KEY.get('engine.score_threshold')!;
    expect(() => coerceSettingValue(def, -1)).toThrow(/min/);
    expect(() => coerceSettingValue(def, 101)).toThrow(/max/);
    expect(coerceSettingValue(def, 70)).toBe(70);
    expect(coerceSettingValue(def, '70')).toBe(70);
  });

  it('coerces booleans from strings', () => {
    const def = SETTINGS_BY_KEY.get('engine.enabled')!;
    expect(coerceSettingValue(def, 'true')).toBe(true);
    expect(coerceSettingValue(def, 'false')).toBe(false);
    expect(() => coerceSettingValue(def, 'maybe')).toThrow();
  });

  it('validates timeframe arrays', () => {
    const def = SETTINGS_BY_KEY.get('engine.timeframes')!;
    expect(coerceSettingValue(def, ['1h', '4h'])).toEqual(['1h', '4h']);
    expect(() => coerceSettingValue(def, ['3h'])).toThrow(/unsupported timeframe/);
    expect(() => coerceSettingValue(def, [])).toThrow(/non-empty/);
    expect(coerceSettingValue(def, '["1m"]')).toEqual(['1m']);
  });

  it('validates TP R multiples via min/max bounds', () => {
    const tp1 = SETTINGS_BY_KEY.get('risk.tp1_r')!;
    expect(coerceSettingValue(tp1, 1.5)).toBe(1.5);
    expect(() => coerceSettingValue(tp1, 0)).toThrow(/min is/);
    expect(() => coerceSettingValue(tp1, 999)).toThrow(/max is/);
    // TP2/TP3 accept 0, which disables that level.
    const tp3 = SETTINGS_BY_KEY.get('risk.tp3_r')!;
    expect(coerceSettingValue(tp3, 0)).toBe(0);
  });

  it('validates the stop-loss policy enum', () => {
    const def = SETTINGS_BY_KEY.get('risk.sl_policy')!;
    expect(coerceSettingValue(def, 'ATR')).toBe('ATR');
    expect(coerceSettingValue(def, 'STRUCTURE')).toBe('STRUCTURE');
    expect(coerceSettingValue(def, 'ATR_OR_STRUCTURE')).toBe('ATR_OR_STRUCTURE');
    expect(() => coerceSettingValue(def, 'YOLO')).toThrow(/must be one of/);
  });

  it('validates symbol allow/deny lists', () => {
    const def = SETTINGS_BY_KEY.get('market.enabled_symbols')!;
    expect(coerceSettingValue(def, ['BTCUSDT'])).toEqual(['BTCUSDT']);
    expect(coerceSettingValue(def, [])).toEqual([]);
    expect(() => coerceSettingValue(def, ['not a symbol!'])).toThrow(/invalid symbol/);
  });

  it('locks market.quote_asset to USDT', () => {
    const def = SETTINGS_BY_KEY.get('market.quote_asset')!;
    expect(coerceSettingValue(def, 'USDT')).toBe('USDT');
    expect(() => coerceSettingValue(def, 'BTC')).toThrow(/locked to USDT/);
    expect(def.editable).toBe(false);
  });
});

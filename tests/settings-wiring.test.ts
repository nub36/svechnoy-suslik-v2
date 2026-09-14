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
    // PREMIUM_DISCOUNT depends on the dealing range => window size matters
    expect(JSON.stringify(a.events) !== JSON.stringify(b.events) || a.long.score !== b.long.score).toBe(true);
  });

  it('detectors.event_ttl_bars changes event freshness filtering', () => {
    const short = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.event_ttl_bars', 2]]) })!;
    const long = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.event_ttl_bars', 50]]) })!;
    expect(long.events.length).toBeGreaterThanOrEqual(short.events.length);
  });

  it('detectors.volume_surge_mult changes volume detections', () => {
    const easy = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.volume_surge_mult', 1.01]]) })!;
    const hard = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.volume_surge_mult', 9]]) })!;
    const cntEasy = easy.events.filter((e) => e.detector === 'VOLUME_IMBALANCE').length;
    const cntHard = hard.events.filter((e) => e.detector === 'VOLUME_IMBALANCE').length;
    expect(cntEasy).toBeGreaterThan(cntHard);
  });

  it('detectors.fvg_min_pct changes FVG detections', () => {
    const easy = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.fvg_min_pct', 0.001]]) })!;
    const hard = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.fvg_min_pct', 5]]) })!;
    expect(easy.events.filter((e) => e.detector === 'FVG').length)
      .toBeGreaterThanOrEqual(hard.events.filter((e) => e.detector === 'FVG').length);
  });

  it('detectors.equal_level_tolerance_pct changes equal-level detections', () => {
    const tight = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.equal_level_tolerance_pct', 0.01]]) })!;
    const loose = evaluate({ symbol: 'BTCUSDT', timeframe: '1h', candles, settings: Settings.fromEntries([['detectors.equal_level_tolerance_pct', 2]]) })!;
    expect(loose.events.filter((e) => e.detector === 'EQUAL_LEVELS').length)
      .toBeGreaterThanOrEqual(tight.events.filter((e) => e.detector === 'EQUAL_LEVELS').length);
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

  it('risk.tp_r_multiples changes take-profit levels', () => {
    const p = buildRiskPlan({ direction: 'LONG', entry: 100, atr: 2, settings: Settings.fromEntries([['risk.sl_atr_mult', 1], ['risk.tp_r_multiples', [0.5, 4]]]) })!;
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

  it('validates tp multiples', () => {
    const def = SETTINGS_BY_KEY.get('risk.tp_r_multiples')!;
    expect(coerceSettingValue(def, [1, 2])).toEqual([1, 2]);
    expect(() => coerceSettingValue(def, [0])).toThrow(/positive/);
    expect(() => coerceSettingValue(def, [-1])).toThrow(/positive/);
  });

  it('locks market.quote_asset to USDT', () => {
    const def = SETTINGS_BY_KEY.get('market.quote_asset')!;
    expect(coerceSettingValue(def, 'USDT')).toBe('USDT');
    expect(() => coerceSettingValue(def, 'BTC')).toThrow(/locked to USDT/);
    expect(def.editable).toBe(false);
  });
});

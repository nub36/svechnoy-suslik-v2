/**
 * V2 replay + UI diagnostics + comparison integrity (spec §25, §29, §32).
 *
 * The most important guard here: V2 must NOT contain a second trading
 * implementation. Entry resolution and outcome tracking have to be the very
 * same production functions V1 uses, otherwise a V1-vs-V2 comparison compares
 * two backtesters rather than two strategies.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Settings } from '../src/core/settings';
import type { Timeframe } from '../src/core/types';
import { replayV2Series } from '../src/replay/v2-runner';
import { buildV2Diagnostics } from '../src/web/overlays';
import { evaluateV2 } from '../src/strategy/v2/engine';
import { loadFixtureCandles, computeMetrics } from '../scripts/strategy-lab';
import { HTF_MAP } from '../src/strategy/v2/htf';
import { assertAllowedMode, LiveTradingLockedError } from '../src/core/mode';

const read = (p: string): string => readFileSync(p, 'utf8');
const settings = (over: Array<readonly [string, unknown]> = []): Settings =>
  Settings.fromEntries(over);

function run(symbol = 'BTCUSDT', tf: Timeframe = '1h') {
  const candles = loadFixtureCandles('fixtures', symbol, tf);
  const htf: Record<string, ReturnType<typeof loadFixtureCandles>> = {};
  for (const h of HTF_MAP[tf] ?? []) {
    const hc = loadFixtureCandles('fixtures', symbol, h);
    if (hc.length > 0) htf[h] = hc;
  }
  return replayV2Series({ symbol, timeframe: tf, candles, settings: settings(), htfCandles: htf });
}

describe('V2 replay — shares production exit logic, no second implementation', () => {
  it('imports resolveEntry and trackOutcome from the production modules', () => {
    const src = read('src/replay/v2-runner.ts');
    expect(src).toMatch(/import \{ resolveEntry \} from '\.\.\/strategy\/state-machine'/);
    expect(src).toMatch(/import \{ trackOutcome \} from '\.\.\/outcome\/tracker'/);
  });

  it('does NOT reimplement entry, stop-walking or R accounting', () => {
    const src = read('src/replay/v2-runner.ts');
    expect(src).not.toMatch(/function\s+(resolveEntry|trackOutcome|rMultiple)\s*\(/);
    // No hand-rolled TP/SL touch detection.
    expect(src).not.toMatch(/high\s*>=\s*takeProfit|low\s*<=\s*stopLoss/);
  });

  it('the V2 engine itself contains no order/exchange calls', () => {
    for (const f of [
      'src/strategy/v2/engine.ts',
      'src/strategy/v2/structure.ts',
      'src/strategy/v2/indicators.ts',
      'src/strategy/v2/htf.ts',
    ]) {
      const src = read(f);
      expect(src).not.toMatch(/fetch\(|axios|placeOrder|newOrder|api\.binance/i);
    }
  });
});

describe('V2 replay — chronology and lifecycle', () => {
  const res = run();

  it('produces trades over the fixture corpus', () => {
    expect(res.evaluations).toBeGreaterThan(50);
    expect(res.trades.length).toBeGreaterThan(0);
  });

  it('counts WAIT decisions as a real outcome', () => {
    expect(res.waits).toBeGreaterThan(0);
    expect(res.waits).toBeLessThanOrEqual(res.evaluations);
  });

  it('enters strictly AFTER the setup candle (N -> N+1)', () => {
    for (const t of res.trades) {
      expect(t.entryCandleTime).toBeGreaterThan(t.setupCandleTime);
    }
  });

  it('never exits before entry and processes trades chronologically', () => {
    let prev = -Infinity;
    for (const t of res.trades) {
      expect(t.entryCandleTime).toBeGreaterThanOrEqual(prev);
      prev = t.entryCandleTime;
      if (t.exitCandleTime !== null) {
        expect(t.exitCandleTime).toBeGreaterThanOrEqual(t.entryCandleTime);
      }
    }
  });

  it('holds only one position at a time', () => {
    const sorted = [...res.trades].sort((a, b) => a.entryCandleTime - b.entryCandleTime);
    for (let i = 1; i < sorted.length; i++) {
      const prevExit = sorted[i - 1]!.exitCandleTime;
      if (prevExit === null) continue;
      expect(sorted[i]!.entryCandleTime).toBeGreaterThanOrEqual(prevExit);
    }
  });

  it('every trade carries a structural stop on the correct side of entry', () => {
    for (const t of res.trades) {
      if (t.direction === 'LONG') expect(t.stopLoss).toBeLessThan(t.entryPrice);
      else expect(t.stopLoss).toBeGreaterThan(t.entryPrice);
    }
  });

  it('take-profits are ordered away from entry', () => {
    for (const t of res.trades) {
      expect(t.takeProfits.length).toBeGreaterThan(0);
      for (let i = 1; i < t.takeProfits.length; i++) {
        const d0 = Math.abs(t.takeProfits[i - 1]! - t.entryPrice);
        const d1 = Math.abs(t.takeProfits[i]! - t.entryPrice);
        expect(d1).toBeGreaterThan(d0);
      }
    }
  });

  it('records the research dimensions needed for the metric slices', () => {
    for (const t of res.trades) {
      expect(['REVERSAL', 'CONTINUATION', null]).toContain(t.setupKind);
      expect(['HIGH', 'LOW', 'MID']).toContain(t.location);
      expect(t.evidence).toBeGreaterThanOrEqual(0);
      expect(t.evidence).toBeLessThanOrEqual(1);
      expect(typeof t.hasOb).toBe('boolean');
      expect(typeof t.hasFvg).toBe('boolean');
    }
  });

  it('is deterministic across runs', () => {
    const a = run('ETHUSDT', '1h');
    const b = run('ETHUSDT', '1h');
    expect(a.trades.map((t) => [t.setupCandleTime, t.rMultiple]))
      .toEqual(b.trades.map((t) => [t.setupCandleTime, t.rMultiple]));
  });

  it('restricting the window cannot produce setups outside it', () => {
    const candles = loadFixtureCandles('fixtures', 'BTCUSDT', '1h' as Timeframe);
    const cut = candles[Math.floor(candles.length * 0.5)]!.openTime;
    const early = replayV2Series({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles, settings: settings(), to: cut,
    });
    for (const t of early.trades) {
      expect(t.setupCandleTime).toBeLessThanOrEqual(cut);
    }
  });
});

describe('V2 comparison integrity — honest reporting of where profit comes from', () => {
  it('the comparison script reports exit composition, not just expectancy', () => {
    const src = read('scripts/v1-vs-v2.ts');
    expect(src).toMatch(/exitComposition/);
    expect(src).toMatch(/TIMEOUT/);
  });

  it('the verdict rule requires the edge to survive without TIMEOUT exits', () => {
    const src = read('scripts/v1-vs-v2.ts');
    expect(src).toMatch(/nonTimeoutExp/);
    expect(src).toMatch(/targetsWork/);
    // And the failure branch must say so out loud.
    expect(src).toMatch(/NOT a basis for activation/);
  });

  it('TEST slice is never used to select parameters', () => {
    const src = read('scripts/v1-vs-v2.ts');
    expect(src).toMatch(/TEST is never used to choose parameters|never used for selection/i);
  });

  it('metrics separate win rate from expectancy so a high win rate cannot mislead', () => {
    const m = computeMetrics([
      ...Array.from({ length: 9 }, () => ({
        symbol: 'X', timeframe: '1h' as Timeframe, direction: 'LONG' as const, score: 1,
        setupCandleTime: 0, entryCandleTime: 0, entryPrice: 1, stopLoss: 0.9,
        takeProfits: [1.1], result: 'TP' as const, exitPrice: 1.1, exitCandleTime: 1,
        barsHeld: 1, rMultiple: 0.2, pnlPct: 1, breakdown: null,
      })),
      {
        symbol: 'X', timeframe: '1h' as Timeframe, direction: 'LONG' as const, score: 1,
        setupCandleTime: 0, entryCandleTime: 0, entryPrice: 1, stopLoss: 0.9,
        takeProfits: [1.1], result: 'SL' as const, exitPrice: 0.9, exitCandleTime: 1,
        barsHeld: 1, rMultiple: -5, pnlPct: -10, breakdown: null,
      },
    ]);
    expect(m.winRatePct).toBe(90);
    expect(m.expectancy).toBeLessThan(0);
  });
});

describe('V2 UI diagnostics', () => {
  const candles = loadFixtureCandles('fixtures', 'BTCUSDT', '1h' as Timeframe);
  const setup = evaluateV2({
    symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles, atIndex: 300, settings: settings(),
  })!;
  const diag = buildV2Diagnostics(setup);

  it('exposes every diagnostic row the spec asks for', () => {
    const labels = diag.rows.map((r) => r.label).join(' | ');
    for (const needle of [
      'Структура', 'Ликвидность', 'Пробой', 'Импульс', 'OB / FVG',
      'Объём', 'Старший ТФ', 'EMA', 'MACD', 'RSI', 'ADX', 'Место до цели',
    ]) {
      expect(labels, `missing row: ${needle}`).toContain(needle);
    }
  });

  it('always reports Direction, Setup and Location', () => {
    expect(['LONG', 'SHORT', 'WAIT']).toContain(diag.direction);
    expect(['REVERSAL', 'CONTINUATION', null]).toContain(diag.setup);
    expect(['HIGH', 'LOW', 'MID']).toContain(diag.location);
  });

  it('explains a WAIT in words rather than showing false confidence', () => {
    if (diag.direction === 'WAIT') {
      expect(diag.waitReasons.length).toBeGreaterThan(0);
      expect(diag.waitReasons.join(' ').length).toBeGreaterThan(15);
    }
  });

  it('never labels evidence as a percentage or probability', () => {
    const src = read('app/page.tsx');
    const block = src.slice(src.indexOf('v2-diagnostics'), src.indexOf('TOP-10 MARKET TABLE'));
    expect(block).toMatch(/не вероятность/);
    // No "%" rendered next to the evidence numbers.
    expect(block).not.toMatch(/longEvidence[^\n]*%/);
  });

  it('marks the V2 panel as research-only in the UI', () => {
    const src = read('app/page.tsx');
    expect(src).toMatch(/исследовательский режим/);
  });

  it('is omitted entirely when v2.enabled is false (the default)', () => {
    const src = read('src/web/overlays.ts');
    expect(src).toMatch(/evaluateV2IfEnabled/);
    expect(src).toMatch(/v2: v2Setup \? buildV2Diagnostics\(v2Setup\) : null/);
  });
});

describe('V2 is not wired into production signal generation', () => {
  it('the strategy worker and engine-runner do not import V2', () => {
    for (const f of ['src/workers/strategy.worker.ts', 'src/strategy/engine-runner.ts']) {
      expect(read(f)).not.toMatch(/strategy\/v2|evaluateV2/);
    }
  });

  it('v2.enabled defaults to false in the registry', () => {
    expect(settings().bool('v2.enabled')).toBe(false);
  });

  it('LIVE remains locked and V2 cannot unlock it', () => {
    expect(() => assertAllowedMode('LIVE')).toThrow(LiveTradingLockedError);
    expect(() => assertAllowedMode('live')).toThrow();
    expect(assertAllowedMode('FORWARD_TEST')).toBe('FORWARD_TEST');
    // Nothing in the V2 tree may reference a live/order path.
    for (const f of [
      'src/strategy/v2/engine.ts',
      'src/strategy/v2/index.ts',
      'src/replay/v2-runner.ts',
    ]) {
      expect(read(f)).not.toMatch(/LIVE|placeOrder|submitOrder/);
    }
  });
});

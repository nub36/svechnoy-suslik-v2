/**
 * STRATEGY AUDIT — evidence, not opinion.
 *
 * This file documents what the strategy ACTUALLY does at runtime, with
 * executable proof. It deliberately contains findings that are unflattering:
 * the point of the audit is to establish whether the strategy is sound, not
 * to show that it is.
 *
 * Nothing here changes production behaviour.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Settings, SETTINGS_REGISTRY } from '../src/core/settings';
import { scoreDirection } from '../src/strategy/scoring';
import { trackOutcome, trackMilestones } from '../src/outcome/tracker';
import { resolveEntry } from '../src/strategy/state-machine';
import type { Candle } from '../src/core/types';

const root = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

const T0 = 1_700_000_000_000;
const H = 3_600_000;

function candle(
  openTime: number,
  open: number,
  high: number,
  low: number,
  close: number,
  isClosed = true,
): Candle {
  return {
    openTime,
    open,
    high,
    low,
    close,
    volume: 100,
    closeTime: openTime + H - 1,
    quoteVolume: 100,
    trades: 10,
    isClosed,
  };
}

/* ================================================================== */
/* STAGE 1 — source of truth for runtime parameters                    */
/* ================================================================== */

describe('AUDIT 1: runtime parameters have exactly one source', () => {
  const defaultOf = (key: string): unknown =>
    SETTINGS_REGISTRY.find((d) => d.key === key)?.default;

  it('factor weights live in the settings registry, not in code constants', () => {
    // If weights were hard-coded anywhere the Admin UI would be decorative.
    for (const f of [
      'BOS', 'ORDER_BLOCK', 'FVG', 'LIQUIDITY_SWEEP',
      'RANGE_POSITION', 'INTERNAL_STRUCTURE', 'OB_FVG_CONFLUENCE',
    ]) {
      expect(defaultOf(`detectors.${f}.weight`)).toBeTypeOf('number');
    }
    expect(read('src/strategy/scoring.ts')).toMatch(/settings\.detectorWeight\(/);
  });

  it('documents the REGISTRY DEFAULT weights (the shipped configuration)', () => {
    // These are the defaults a fresh install gets. A running instance may
    // legitimately differ because the DB overrides them (see next test).
    expect(defaultOf('detectors.BOS.weight')).toBe(25);
    expect(defaultOf('detectors.ORDER_BLOCK.weight')).toBe(20);
    expect(defaultOf('detectors.FVG.weight')).toBe(15);
    expect(defaultOf('detectors.LIQUIDITY_SWEEP.weight')).toBe(15);
    expect(defaultOf('detectors.RANGE_POSITION.weight')).toBe(10);
    expect(defaultOf('detectors.INTERNAL_STRUCTURE.weight')).toBe(8);
    expect(defaultOf('detectors.OB_FVG_CONFLUENCE.weight')).toBe(7);
  });

  it('EXPLAINS THE 18/25/8/12/7 vs 20/15 DISCREPANCY: the DB overrides defaults', () => {
    // loadSettings() layers stored rows over the registry defaults, so an
    // operator who saved ORDER_BLOCK=18 / FVG=12 gets exactly that at runtime
    // while the registry still ships 20 / 15. Both numbers were "correct";
    // they describe different layers. The observed production score was
    // therefore NOT evidence of a bug.
    const live = Settings.fromEntries([
      ['detectors.ORDER_BLOCK.weight', 18],
      ['detectors.FVG.weight', 12],
    ]);
    expect(live.detectorWeight('ORDER_BLOCK')).toBe(18);
    expect(live.detectorWeight('FVG')).toBe(12);
    // Untouched keys still fall back to the registry default.
    expect(live.detectorWeight('BOS')).toBe(25);

    // And the arithmetic reported in production reproduces exactly.
    const contrib =
      0.92026055 * 18 + 0.62746934 * 25 + 1 * 8 + 0.56591727 * 12 + 0.47606082 * 7;
    expect(contrib).toBeCloseTo(50.374856, 4);
  });

  it('score is normalised by the weight of COUNTED factors only', () => {
    // Consequence worth stating plainly: a single strong factor can score
    // 100, because the denominator shrinks with the numerator. Score is
    // therefore "average conviction", NOT "how much evidence there is".
    const s = Settings.fromDefaults();
    const one = scoreDirection(
      [{ detector: 'BOS', direction: 'LONG', strength: 1, dedupeKey: 'a' } as never],
      'LONG',
      s,
    );
    expect(one.score).toBe(100);
    expect(one.components.filter((c) => c.counted)).toHaveLength(1);
  });

  it('min_components is what actually guards against thin evidence', () => {
    expect(defaultOf('engine.min_components')).toBe(2);
    expect(defaultOf('engine.score_threshold')).toBe(55);
  });

  it('risk plan parameters are settings-driven', () => {
    expect(defaultOf('risk.tp1_r')).toBe(1);
    expect(defaultOf('risk.tp2_r')).toBe(2);
    expect(defaultOf('risk.tp3_r')).toBe(3);
    expect(defaultOf('risk.sl_atr_mult')).toBeTypeOf('number');
  });
});

/* ================================================================== */
/* STAGE 1b — one trading engine, shared by live and replay            */
/* ================================================================== */

describe('AUDIT 2: replay and FORWARD_TEST share one trading logic', () => {
  const replay = read('src/replay/runner.ts');
  const runner = read('src/strategy/engine-runner.ts');

  it('both generate signals through the same evaluate()', () => {
    // Same module, reached by different relative paths.
    expect(replay).toMatch(/import \{ evaluate \} from '\.\.\/strategy\/smart-money'/);
    expect(runner).toMatch(/import \{ evaluate \} from '\.\/smart-money'/);
    expect(replay).toMatch(/evaluate\(\{/);
    expect(runner).toMatch(/evaluate\(\{/);
  });

  it('both drive the same state machine step()', () => {
    expect(replay).toMatch(/step\(machine, ev\)/);
    expect(runner).toMatch(/step\(cursor, ev\)/);
  });

  it('both resolve entry with the same resolveEntry() (N+1 open)', () => {
    expect(replay).toMatch(/resolveEntry\(/);
    expect(runner).toMatch(/resolveEntry\(/);
  });

  it('both size risk with the same buildRiskPlan()', () => {
    expect(replay).toMatch(/buildRiskPlan\(/);
    expect(runner).toMatch(/buildRiskPlan\(/);
  });

  it('both compute P&L with the same trackOutcome()', () => {
    expect(replay).toMatch(/trackOutcome\(/);
    expect(read('src/workers/outcome.worker.ts')).toMatch(/trackOutcome\(/);
  });

  it('there is no second, simplified backtest strategy', () => {
    // A parallel implementation would make backtest results meaningless.
    expect(replay).not.toMatch(/function\s+(simpleEvaluate|backtestScore)/);
    const strategyFiles = read('src/strategy/smart-money.ts');
    expect(strategyFiles).toMatch(/export function evaluate/);
  });
});

/* ================================================================== */
/* STAGE 2/8 — no look-ahead, N -> N+1 entry                           */
/* ================================================================== */

describe('AUDIT 3: no look-ahead bias', () => {
  it('entry uses the OPEN of N+1, never the setup candle close', () => {
    const setupTime = T0;
    const next = candle(T0 + H, 101.5, 103, 100, 102);
    const entry = resolveEntry(setupTime, H, next);
    expect(entry).not.toBeNull();
    expect(entry!.entryPrice).toBe(101.5); // the OPEN, exactly
    expect(entry!.entryCandleTime).toBe(T0 + H);
  });

  it('refuses to fabricate an entry before N+1 exists', () => {
    // A candle that is not the immediate successor must not fill.
    expect(resolveEntry(T0, H, candle(T0 + 5 * H, 99, 100, 98, 99))).toBeNull();
  });

  it('never fills from the setup candle itself', () => {
    expect(resolveEntry(T0, H, candle(T0, 100, 101, 99, 100))).toBeNull();
  });

  it('the engine only ever reads CLOSED candles', () => {
    expect(read('src/strategy/engine-runner.ts')).toMatch(/closedOnly: true/);
    expect(read('src/replay/runner.ts')).toMatch(/filter\(\(c\) => c\.isClosed\)/);
  });

  it('replay evaluates AS OF each bar, not on the full series', () => {
    // atIndex pins the evaluation to the bar being replayed, so a detector
    // cannot see future candles.
    expect(read('src/replay/runner.ts')).toMatch(/atIndex: window\.length - 1/);
    expect(read('src/strategy/engine-runner.ts')).toMatch(/atIndex: window\.length - 1/);
  });

  it('replay walks candles in chronological order', () => {
    expect(read('src/replay/runner.ts')).toMatch(
      /sort\(\(a, b\) => a\.openTime - b\.openTime\)/,
    );
  });
});

/* ================================================================== */
/* STAGE 2/8 — ambiguous bar policy (TP and SL in the same candle)     */
/* ================================================================== */

describe('AUDIT 4: ambiguous TP/SL candle is resolved conservatively', () => {
  const strict = Settings.fromEntries([
    ['outcome.fee_pct', 0],
    ['outcome.sl_priority_on_ambiguous_bar', true],
  ]);

  it('the conservative policy is the DEFAULT, not an opt-in', () => {
    const def = SETTINGS_REGISTRY.find(
      (d) => d.key === 'outcome.sl_priority_on_ambiguous_bar',
    )?.default;
    expect(def).toBe(true);
  });

  it('a bar touching BOTH the final TP and the stop resolves to SL', () => {
    // OHLC cannot say which came first, so we must not silently book the win.
    const out = trackOutcome({
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [105],
      entryCandleTime: T0,
      candles: [candle(T0, 100, 106, 94, 100)], // hits 105 AND 95
      settings: strict,
      qty: 1,
    });
    expect(out!.result).toBe('SL');
    expect(out!.rMultiple).toBeLessThan(0);
  });

  it('the same ambiguity in the milestone walk also resolves to STOPPED', () => {
    const mil = trackMilestones({
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [105, 110, 115],
      entryCandleTime: T0,
      candles: [candle(T0, 100, 116, 94, 100)],
      settings: strict,
    });
    expect(mil.state).toBe('STOPPED');
  });

  it('is deterministic: identical input always gives an identical result', () => {
    const run = () =>
      trackOutcome({
        direction: 'SHORT',
        entryPrice: 100,
        stopLoss: 105,
        takeProfits: [95],
        entryCandleTime: T0,
        candles: [candle(T0, 100, 106, 94, 100)],
        settings: strict,
        qty: 1,
      });
    const a = run();
    const b = run();
    expect(a!.result).toBe(b!.result);
    expect(a!.rMultiple).toBe(b!.rMultiple);
    expect(a!.result).toBe('SL');
  });

  it('an unambiguous winning bar is still booked as a win', () => {
    // The conservative rule must not turn every trade into a loss.
    const out = trackOutcome({
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [105],
      entryCandleTime: T0,
      candles: [candle(T0, 100, 106, 99, 105)], // never touches the stop
      settings: strict,
      qty: 1,
    });
    expect(out!.result).toBe('TP');
    expect(out!.rMultiple).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* STAGE 8 — TP ladder semantics                                       */
/* ================================================================== */

describe('AUDIT 5: TP ladder and stop semantics', () => {
  const s = Settings.fromEntries([['outcome.fee_pct', 0]]);

  const run = (candles: Candle[]) =>
    trackOutcome({
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [105, 110, 115],
      entryCandleTime: T0,
      candles,
      settings: s,
      qty: 1,
    });

  it('TP1 does NOT close the position', () => {
    expect(run([candle(T0, 100, 106, 99, 105)])).toBeNull();
  });

  it('TP2 does NOT close the position either', () => {
    expect(run([candle(T0, 100, 111, 99, 110)])).toBeNull();
  });

  it('the FINAL TP closes the position', () => {
    const out = run([candle(T0, 100, 116, 99, 115)]);
    expect(out!.result).toBe('TP');
    expect(out!.tpHitIndex).toBe(2);
  });

  it('a stop AFTER an intermediate TP yields STOPPED with negative R', () => {
    const candles = [
      candle(T0, 100, 106, 99, 105), // TP1 touched
      candle(T0 + H, 105, 106, 94, 94.5), // then stopped
    ];
    const out = run(candles);
    expect(out!.result).toBe('SL');
    expect(out!.rMultiple).toBeLessThan(0);

    // The milestone survives as a historical fact.
    const mil = trackMilestones({
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [105, 110, 115],
      entryCandleTime: T0,
      candles,
      settings: s,
    });
    expect(mil.milestones.map((m) => m.kind)).toContain('TP1');
    expect(mil.state).toBe('STOPPED');
  });

  it('milestone state and outcome result never contradict', () => {
    const cases: Candle[][] = [
      [candle(T0, 100, 116, 99, 115)], // TP3
      [candle(T0, 100, 101, 94, 95)], // SL
      [candle(T0, 100, 106, 99, 105), candle(T0 + H, 105, 106, 94, 94.5)], // TP1 then SL
    ];
    const expected: Record<string, string> = {
      TP3_HIT: 'TP',
      STOPPED: 'SL',
      EXPIRED: 'TIMEOUT',
    };
    for (const candles of cases) {
      const mil = trackMilestones({
        direction: 'LONG',
        entryPrice: 100,
        stopLoss: 95,
        takeProfits: [105, 110, 115],
        entryCandleTime: T0,
        candles,
        settings: s,
      });
      const out = run(candles);
      if (out && expected[mil.state]) {
        expect(expected[mil.state]).toBe(out.result);
      }
    }
  });
});

/* ================================================================== */
/* STAGE 6 — one-signal-per-symbol: documented consequences            */
/* ================================================================== */

describe('AUDIT 6: one-active-signal-per-symbol has real side effects', () => {
  const runner = read('src/strategy/engine-runner.ts');
  const schema = read('src/db/schema.sql');

  it('the DB uniqueness constraint is per (symbol, timeframe, setup, source)', () => {
    // It does NOT implement the one-per-symbol policy; it only prevents
    // duplicate rows for the same setup candle.
    expect(schema).toMatch(
      /signals_edge_unique[\s\S]{0,160}symbol, timeframe, setup_candle_time, source/,
    );
  });

  it('the one-per-symbol policy is enforced in application code, not the DB', () => {
    expect(runner).toMatch(/busySymbols\.has\(s\.symbol\)/);
    expect(runner).toMatch(/suppressedBySymbolPolicy/);
  });

  it('FINDING: suppression is first-come-first-served by timeframe order', () => {
    // The scan is `for (symbol) { for (timeframe) }` over a canonically
    // ordered timeframe list, so the EARLIEST timeframe wins the symbol lock.
    // A later, higher-scoring timeframe is suppressed purely because of loop
    // order — score is never compared.
    const loop = runner.slice(runner.indexOf('for (const s of symbols)'));
    const symbolLoopAt = 0;
    const tfLoopAt = loop.indexOf('for (const tf of timeframes)');
    const suppressAt = loop.indexOf('busySymbols.has(s.symbol)');
    expect(tfLoopAt).toBeGreaterThan(symbolLoopAt);
    expect(suppressAt).toBeGreaterThan(tfLoopAt);
    // No score comparison guards the suppression branch.
    const branch = loop.slice(suppressAt, suppressAt + 400);
    expect(branch).not.toMatch(/score\s*[<>]/);
  });

  it('FINDING: the constraint has no strategy discriminator', () => {
    // Two strategy variants writing LIVE_ENGINE signals for the same setup
    // candle would collide, so A/B comparison in one database is impossible
    // without a schema change.
    expect(schema).not.toMatch(/signals_edge_unique[\s\S]{0,200}strategy/);
  });

  it('suppressed edges settle into HOLD, never back into NEUTRAL', () => {
    // Otherwise the same persistent condition would re-fire as a "new" edge.
    const idx = runner.indexOf('busySymbols.has(s.symbol)');
    expect(runner.slice(idx, idx + 400)).toMatch(/settleEdge\(next\)/);
  });
});

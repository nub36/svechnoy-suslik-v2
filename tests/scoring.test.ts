import { describe, expect, it } from 'vitest';
import { scoreDirection, countedDetectors, explain } from '../src/strategy/scoring';
import { Settings } from '../src/core/settings';
import type { DetectorEvent } from '../src/core/types';
import { FACTOR_KIND } from '../src/core/types';

function ev(p: Partial<DetectorEvent> & Pick<DetectorEvent, 'detector' | 'dedupeKey'>): DetectorEvent {
  return {
    direction: 'LONG',
    kind: FACTOR_KIND[p.detector],
    index: 10,
    time: 1000,
    strength: 0.5,
    reason: 'test',
    ...p,
  } as DetectorEvent;
}

// Read weights from the registry rather than hardcoding them, so retuning a
// default weight can never silently invalidate these assertions.
const DEFAULTS = Settings.fromDefaults();
const W_BOS = DEFAULTS.detectorWeight('BOS');
const W_FVG = DEFAULTS.detectorWeight('FVG');

describe('scoring arithmetic', () => {
  const s = Settings.fromDefaults();

  it('contribution = strength * weight, and score = 100 * raw / totalWeight', () => {
    const events = [
      ev({ detector: 'BOS', dedupeKey: 'a', strength: 0.8 }),
      ev({ detector: 'FVG', dedupeKey: 'b', strength: 0.5 }),
    ];
    const b = scoreDirection(events, 'LONG', s);

    const bos = b.components.find((c) => c.detector === 'BOS')!;
    const fvg = b.components.find((c) => c.detector === 'FVG')!;
    expect(bos.contribution).toBeCloseTo(0.8 * W_BOS, 10);
    expect(fvg.contribution).toBeCloseTo(0.5 * W_FVG, 10);

    const expectedRaw = 0.8 * W_BOS + 0.5 * W_FVG;
    const expectedWeight = W_BOS + W_FVG;
    expect(b.rawScore).toBeCloseTo(expectedRaw, 6);
    expect(b.totalWeight).toBeCloseTo(expectedWeight, 6);
    expect(b.score).toBeCloseTo((100 * expectedRaw) / expectedWeight, 3);
  });

  it('score is always within 0..100 because strength is normalized', () => {
    const events = [
      ev({ detector: 'BOS', dedupeKey: 'a', strength: 1 }),
      ev({ detector: 'ORDER_BLOCK', dedupeKey: 'b', strength: 1 }),
      ev({ detector: 'FVG', dedupeKey: 'c', strength: 1 }),
    ];
    const b = scoreDirection(events, 'LONG', s);
    expect(b.score).toBeCloseTo(100, 6);

    const zero = scoreDirection(
      [ev({ detector: 'BOS', dedupeKey: 'a', strength: 0 })],
      'LONG',
      s,
    );
    expect(zero.score).toBe(0);
  });

  it('empty input scores 0 without dividing by zero', () => {
    const b = scoreDirection([], 'LONG', s);
    expect(b.score).toBe(0);
    expect(b.rawScore).toBe(0);
    expect(b.totalWeight).toBe(0);
  });

  it('only counts events of the requested direction', () => {
    const events = [
      ev({ detector: 'BOS', dedupeKey: 'a', strength: 1, direction: 'LONG' }),
      ev({ detector: 'ORDER_BLOCK', dedupeKey: 'b', strength: 1, direction: 'SHORT' }),
    ];
    const long = scoreDirection(events, 'LONG', s);
    expect(long.components).toHaveLength(1);
    expect(long.totalWeight).toBe(25);
  });
});

describe('anti-double-counting', () => {
  const s = Settings.fromDefaults();

  it('collapses identical dedupeKeys and keeps the strongest', () => {
    const events = [
      ev({ detector: 'BOS', dedupeKey: 'same', strength: 0.4 }),
      ev({ detector: 'BOS', dedupeKey: 'same', strength: 0.9 }),
      ev({ detector: 'BOS', dedupeKey: 'same', strength: 0.6 }),
    ];
    const b = scoreDirection(events, 'LONG', s);
    const counted = b.components.filter((c) => c.counted);
    expect(counted).toHaveLength(1);
    expect(counted[0]!.strength).toBe(0.9);
    expect(b.duplicatesRemoved).toBe(2);
    // weight counted exactly once
    expect(b.totalWeight).toBe(25);
    expect(b.rawScore).toBeCloseTo(0.9 * 25, 10);
  });

  it('a single detector cannot stack its weight multiple times', () => {
    const events = [
      ev({ detector: 'FVG', dedupeKey: 'f1', strength: 0.7 }),
      ev({ detector: 'FVG', dedupeKey: 'f2', strength: 0.6 }),
      ev({ detector: 'FVG', dedupeKey: 'f3', strength: 0.5 }),
      ev({ detector: 'FVG', dedupeKey: 'f4', strength: 0.4 }),
    ];
    const b = scoreDirection(events, 'LONG', s);
    expect(b.totalWeight).toBe(W_FVG); // FVG weight, ONCE
    expect(b.rawScore).toBeCloseTo(0.7 * W_FVG, 10);
    expect(countedDetectors(b)).toBe(1);
    expect(b.duplicatesRemoved).toBe(3);
  });

  it('reports skipped components transparently instead of hiding them', () => {
    const events = [
      ev({ detector: 'FVG', dedupeKey: 'f1', strength: 0.7 }),
      ev({ detector: 'FVG', dedupeKey: 'f2', strength: 0.6 }),
    ];
    const b = scoreDirection(events, 'LONG', s);
    expect(b.components).toHaveLength(2);
    const skipped = b.components.find((c) => !c.counted)!;
    expect(skipped.skippedReason).toBeTruthy();
    expect(skipped.contribution).toBe(0);
  });

  it('zero-weight detectors are excluded from both numerator and denominator', () => {
    const custom = Settings.fromEntries([['detectors.FVG.weight', 0]]);
    const events = [
      ev({ detector: 'BOS', dedupeKey: 'a', strength: 0.5 }),
      ev({ detector: 'FVG', dedupeKey: 'b', strength: 1 }),
    ];
    const b = scoreDirection(events, 'LONG', custom);
    expect(b.totalWeight).toBe(25);
    expect(b.rawScore).toBeCloseTo(0.5 * 25, 10);
    expect(b.score).toBeCloseTo(50, 6);
  });

  it('dedupe is deterministic regardless of input ordering', () => {
    const a = [
      ev({ detector: 'BOS', dedupeKey: 'x', strength: 0.3 }),
      ev({ detector: 'BOS', dedupeKey: 'x', strength: 0.9 }),
    ];
    const b = [...a].reverse();
    expect(scoreDirection(a, 'LONG', s).score).toBe(scoreDirection(b, 'LONG', s).score);
  });

  it('explain() renders a human-readable breakdown', () => {
    const b = scoreDirection([ev({ detector: 'BOS', dedupeKey: 'a', strength: 0.8 })], 'LONG', s);
    const lines = explain(b);
    expect(lines[0]).toContain('LONG');
    expect(lines.join('\n')).toContain('BOS');
  });
});

describe('weights are DB-driven (settings -> engine)', () => {
  it('changing a weight changes the score', () => {
    const base = Settings.fromDefaults();
    const tweaked = Settings.fromEntries([['detectors.BOS.weight', 50]]);
    const events = [
      ev({ detector: 'BOS', dedupeKey: 'a', strength: 1 }),
      ev({ detector: 'FVG', dedupeKey: 'b', strength: 0 }),
    ];
    const b1 = scoreDirection(events, 'LONG', base);
    const b2 = scoreDirection(events, 'LONG', tweaked);
    expect(b1.totalWeight).toBe(25 + W_FVG);
    expect(b2.totalWeight).toBe(50 + W_FVG);
    expect(b2.rawScore).toBeGreaterThan(b1.rawScore);
  });
});

/**
 * Chart presentation contract (requirement 7). These are cheap regression pins:
 * the numbers below are the ones the spec asks for, so a future edit that
 * quietly changes the look has to change this file too.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSignalLevels, detectorColor, detectorShortLabel } from '../src/web/overlays';
import { FACTOR_IDS } from '../src/core/types';

const chartSrc = readFileSync(
  join(process.cwd(), 'app/components/CandleChart.tsx'),
  'utf8',
);

function num(re: RegExp): number {
  const m = chartSrc.match(re);
  expect(m, `pattern not found: ${re}`).toBeTruthy();
  return Number(m![1]);
}

describe('A/C — default viewport and right-hand whitespace', () => {
  it('keeps 10-15% of the width empty to the right of the latest candle', () => {
    const ws = num(/RIGHT_WHITESPACE\s*=\s*([\d.]+)/);
    expect(ws).toBeGreaterThanOrEqual(0.1);
    expect(ws).toBeLessThanOrEqual(0.15);
  });

  it('shows 100-150 candles by default on desktop', () => {
    const v = num(/DESKTOP_VISIBLE\s*=\s*(\d+)/);
    expect(v).toBeGreaterThanOrEqual(100);
    expect(v).toBeLessThanOrEqual(150);
  });

  it('shows fewer, narrower candles on mobile', () => {
    expect(num(/MOBILE_VISIBLE\s*=\s*(\d+)/))
      .toBeLessThan(num(/DESKTOP_VISIBLE\s*=\s*(\d+)/));
  });

  it('derives barSpacing from the container width, not a fixed zoom', () => {
    expect(chartSrc).toMatch(/barSpacing\s*=\s*Math\.max\([^)]*usable\s*\/\s*targetVisible/);
  });

  it('re-applies the fit on symbol/timeframe change via fitKey', () => {
    expect(chartSrc).toMatch(/fitKey\s*!==\s*lastFitKeyRef\.current/);
  });

  it('does not fight manual scroll/zoom', () => {
    // The refit is guarded by a user-interaction flag.
    expect(chartSrc).toMatch(/shouldFit\s*\|\|\s*!userInteractedRef\.current/);
    expect(chartSrc).toMatch(/handleScroll:\s*true/);
    expect(chartSrc).toMatch(/handleScale:\s*true/);
  });
});

describe('B — price scale margins', () => {
  it('top margin is 0.08-0.12 and bottom 0.15-0.20', () => {
    const m = chartSrc.match(/scaleMargins:\s*\{\s*top:\s*([\d.]+),\s*bottom:\s*([\d.]+)\s*\}/);
    expect(m).toBeTruthy();
    const [top, bottom] = [Number(m![1]), Number(m![2])];
    expect(top).toBeGreaterThanOrEqual(0.08);
    expect(top).toBeLessThanOrEqual(0.12);
    expect(bottom).toBeGreaterThanOrEqual(0.15);
    expect(bottom).toBeLessThanOrEqual(0.2);
  });
});

describe('D — exactly one current-price line', () => {
  it('the candle series owns the price line and nothing else duplicates it', () => {
    expect(chartSrc).toMatch(/priceLineVisible:\s*true/);
    // Every other series must explicitly switch it off.
    const on = chartSrc.match(/priceLineVisible:\s*true/g) ?? [];
    expect(on).toHaveLength(1);
    expect((chartSrc.match(/priceLineVisible:\s*false/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });
});

describe('H — responsive, no horizontal overflow', () => {
  it('resizes through a ResizeObserver on the container', () => {
    expect(chartSrc).toMatch(/new ResizeObserver/);
  });

  it('the container cannot overflow the page horizontally', () => {
    expect(chartSrc).toMatch(/maxWidth:\s*'100%'/);
    expect(chartSrc).toMatch(/overflow:\s*'hidden'/);
    expect(chartSrc).toMatch(/width:\s*'100%'/);
  });
});

describe('F — legend colours', () => {
  it('every active factor has a distinct colour', () => {
    const colors = FACTOR_IDS.map((f) => detectorColor(f));
    expect(new Set(colors).size).toBe(FACTOR_IDS.length);
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('short labels are compact enough not to smother the candles', () => {
    for (const f of FACTOR_IDS) {
      const l = detectorShortLabel(f);
      expect(l.length).toBeGreaterThan(0);
      expect(l.length).toBeLessThanOrEqual(8);
    }
  });
});

describe('G — signal levels are only drawn from real data', () => {
  it('renders ENTRY, SL, TP1, TP2, TP3 when the signal is filled', () => {
    const levels = buildSignalLevels({
      entry_price: 100, stop_loss: 98, take_profits: [102, 104, 106],
    });
    expect(levels.map((l) => l.kind)).toEqual(['ENTRY', 'SL', 'TP1', 'TP2', 'TP3']);
    expect(levels.find((l) => l.kind === 'ENTRY')!.price).toBe(100);
  });

  it('NEVER fabricates an entry for a WAITING_ENTRY signal', () => {
    const levels = buildSignalLevels({
      entry_price: null, stop_loss: null, take_profits: [],
    });
    expect(levels).toEqual([]);
    expect(levels.some((l) => l.kind === 'ENTRY')).toBe(false);
  });

  it('ignores non-finite prices instead of drawing garbage lines', () => {
    const levels = buildSignalLevels({
      entry_price: Number.NaN, stop_loss: 98, take_profits: [102, Number.NaN, 106],
    });
    expect(levels.map((l) => l.kind)).toEqual(['SL', 'TP1', 'TP3']);
  });

  it('caps take-profits at three levels', () => {
    const levels = buildSignalLevels({
      entry_price: 100, stop_loss: 98, take_profits: [1, 2, 3, 4, 5],
    });
    expect(levels.filter((l) => l.kind.startsWith('TP'))).toHaveLength(3);
  });

  it('tolerates a malformed take_profits payload', () => {
    expect(() =>
      buildSignalLevels({ entry_price: 100, stop_loss: 98, take_profits: 'oops' }),
    ).not.toThrow();
  });
});

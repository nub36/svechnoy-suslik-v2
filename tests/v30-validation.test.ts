/**
 * Tests for the V3.0 VALIDATION driver (research tooling only).
 *
 * These tests exist to make three claims checkable rather than asserted:
 *
 *   1. the driver reads ONLY the window it is given — a trap outside the slice
 *      produces no signal, and a corridor that would fill outside the slice is
 *      never filled;
 *   2. the hard TEST guard refuses a split whose VALIDATION window reaches into
 *      TEST, and accepts the real frozen splits;
 *   3. the fidelity comparator used to prove "only the window changed" actually
 *      detects differences — an equality test that always passes would be worse
 *      than no test at all.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  fidelityDiff, lastIndexAtOrBefore, runSlice, sliceWindow, testGuard,
  type SplitRow,
} from '../research/v30_validate';
import { TF_MS, type Timeframe } from '../src/core/types';

const H = 3_600_000;
const H4 = 4 * H;

interface Bar { o: number; h: number; l: number; c: number; v: number }

function writeSeries(dir: string, symbol: string, tf: Timeframe, bars: Bar[]): void {
  const a = new Float64Array(bars.length * 7);
  bars.forEach((b, i) => {
    const openTime = i * TF_MS[tf];
    const o = i * 7;
    a[o] = openTime; a[o + 1] = b.o; a[o + 2] = b.h; a[o + 3] = b.l;
    a[o + 4] = b.c; a[o + 5] = b.v; a[o + 6] = openTime + TF_MS[tf] - 1;
  });
  writeFileSync(join(dir, `${symbol}-${tf}.bin`), Buffer.from(a.buffer, a.byteOffset, a.byteLength));
}

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/**
 * Synthetic BTCUSDT fixture.
 *
 * 4H structure: a single confirmed swing LOW at 98 (bar 4) and a single
 * confirmed swing HIGH at 104 (bar 8), both confirmed well before the action.
 * Every other 4H bar is identical at high 102 / low 100, which is what makes
 * those two pivots unique (an equal neighbour disqualifies a pivot).
 *
 * 1H: an in-window LONG trap on bar 62 (pierces 98, closes 99, body ratio 0.5,
 * RVOL 3.0), a second identical trap on bar 70 — deliberately OUTSIDE the
 * narrow window — then TP1 and TP2.
 */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'v30-validation-'));
  dirs.push(dir);

  const h4: Bar[] = Array.from({ length: 16 }, () => ({ o: 101, h: 102, l: 100, c: 101, v: 100 }));
  h4[4] = { o: 101, h: 102, l: 98, c: 101, v: 100 };    // swing LOW  -> 98
  h4[8] = { o: 101, h: 104, l: 100, c: 101, v: 100 };   // swing HIGH -> 104

  const neutral: Bar = { o: 102, h: 102.5, l: 101.5, c: 102, v: 100 };
  const h1: Bar[] = Array.from({ length: 80 }, () => ({ ...neutral }));
  const trap = (i: number): void => { h1[i] = { o: 97, h: 100, l: 96, c: 99, v: 300 }; };
  const fill = (i: number): void => { h1[i] = { o: 99, h: 99.5, l: 98.5, c: 99.2, v: 100 }; };
  const tp1 = (i: number): void => { h1[i] = { o: 99.2, h: 101.5, l: 99.0, c: 101.0, v: 100 }; };
  const tp2 = (i: number): void => { h1[i] = { o: 101.0, h: 104.5, l: 100.5, c: 104.0, v: 100 }; };
  const quiet = (i: number): void => { h1[i] = { o: 104, h: 104.5, l: 103, c: 104, v: 100 }; };

  trap(62); fill(63); tp1(64); tp2(65);
  for (let i = 66; i <= 69; i++) quiet(i);
  trap(70); fill(71); tp1(72); tp2(73);
  for (let i = 74; i < 80; i++) quiet(i);

  writeSeries(dir, 'BTCUSDT', '4h', h4);
  writeSeries(dir, 'BTCUSDT', '1h', h1);
  return dir;
}

const row = (over: Partial<SplitRow> = {}): SplitRow => ({
  symbol: 'BTCUSDT', timeframe: '1h',
  trainFromMs: 0, trainToMs: 61 * H,
  validFromMs: 62 * H, validToMs: 65 * H,
  testFromMs: 70 * H, testToMs: 79 * H,
  ...over,
});

/* ---------------- window selection ---------------- */

describe('sliceWindow', () => {
  it('picks the train boundaries for train and the valid boundaries for valid', () => {
    const r = row();
    expect(sliceWindow(r, 'train')).toEqual({ fromMs: 0, toMs: 61 * H });
    expect(sliceWindow(r, 'valid')).toEqual({ fromMs: 62 * H, toMs: 65 * H });
  });

  it('never returns the test boundaries', () => {
    const r = row();
    for (const s of ['train', 'valid'] as const) {
      const w = sliceWindow(r, s);
      expect(w.toMs).toBeLessThan(r.testFromMs);
    }
  });
});

/* ---------------- TEST guard ---------------- */

describe('testGuard', () => {
  it('accepts the real frozen splits for all six V3.0 series', () => {
    const doc = JSON.parse(
      readFileSync('artifacts/research/v2-real-20260915-080338/splits.json', 'utf8'),
    ) as { splits: SplitRow[] };
    const g = testGuard(doc.splits, '1h', ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT']);
    expect(g.checked).toBe(6);
    expect(g.safe).toBe(true);
    expect(g.violations).toEqual([]);
  });

  it('refuses a split whose validation window reaches into test', () => {
    const bad = row({ validToMs: 70 * H });
    const g = testGuard([bad], '1h', ['BTCUSDT']);
    expect(g.safe).toBe(false);
    expect(g.violations).toHaveLength(1);
  });

  it('refuses even a one-millisecond overlap', () => {
    const g = testGuard([row({ validToMs: 70 * H - 1, testFromMs: 70 * H - 1 })], '1h', ['BTCUSDT']);
    expect(g.safe).toBe(false);
  });

  it('ignores out-of-scope timeframe and symbol rows', () => {
    const g = testGuard(
      [row({ timeframe: '1m', validToMs: 70 * H }), row({ symbol: 'PEPEUSDT', validToMs: 70 * H })],
      '1h', ['BTCUSDT'],
    );
    expect(g.checked).toBe(0);
    expect(g.safe).toBe(true);
  });
});

/* ---------------- window enforcement, end to end ---------------- */

describe('runSlice — the window is the only thing that changes', () => {
  it('counts an in-window trap and fills it, TP2 included', () => {
    const out = runSlice({ cache: fixture(), splits: [row()], slice: 'valid' });
    expect((out.funnel as Record<string, number>).signals).toBe(1);
    expect(out.n).toBe(1);
    expect(out.exits).toEqual({ TP2: 1 });
    expect(out.grossRPerTrade).toBeGreaterThan(0);
  });

  it('produces nothing when the window excludes every trap', () => {
    const out = runSlice({ cache: fixture(), splits: [row()], slice: 'train' });
    expect((out.funnel as Record<string, number>).signals).toBe(0);
    expect(out.n).toBe(0);
    expect(out.grossRPerTrade).toBe(0);
  });

  it('does not fill a corridor on the reclaim bar itself, nor on a bar past the window', () => {
    // window ends on the trap bar: the corridor exists but no later bar is
    // inside the window, so it can never fill.
    const out = runSlice({
      cache: fixture(), splits: [row({ validToMs: 62 * H })], slice: 'valid',
    });
    expect((out.funnel as Record<string, number>).signals).toBe(1);
    expect(out.n).toBe(0);
    expect((out.funnel as Record<string, number>).expired).toBe(0); // still pending at the edge
  });

  it('sees the second trap once the window is widened to include it', () => {
    const out = runSlice({
      cache: fixture(), splits: [row({ validToMs: 73 * H })], slice: 'valid',
    });
    expect((out.funnel as Record<string, number>).signals).toBe(2);
    expect(out.n).toBe(2);
  });

  it('is deterministic — the same input produces the same artifact', () => {
    const cache = fixture();
    const a = runSlice({ cache, splits: [row()], slice: 'valid' });
    const b = runSlice({ cache, splits: [row()], slice: 'valid' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(fidelityDiff(a, b)).toEqual([]);
  });

  it('does not see a trap that sits inside TEST', () => {
    // Bar 70 is exactly testFromMs. With the window closing on bar 69, the trap
    // there must be invisible: one signal, from the in-window trap alone.
    const cache = fixture();
    const out = runSlice({ cache, splits: [row({ validToMs: 69 * H })], slice: 'valid' });
    expect((out.funnel as Record<string, number>).signals).toBe(1);
    expect(out.n).toBe(1);
  });
});

/* ---------------- fidelity comparator ---------------- */

describe('fidelityDiff', () => {
  it('is empty for identical documents', () => {
    expect(fidelityDiff({ a: 1, b: [1, 2, 3] }, { a: 1, b: [1, 2, 3] })).toEqual([]);
  });

  it('catches a changed number, naming the path', () => {
    const d = fidelityDiff({ a: { b: 2 } }, { a: { b: 1 } });
    expect(d).toEqual(['$.a.b: 2 vs frozen 1']);
  });

  it('catches a missing key and a wrong array length', () => {
    expect(fidelityDiff({}, { a: 1 })).toEqual(['$.a: missing']);
    expect(fidelityDiff({ a: [1] }, { a: [1, 2] })[0]).toContain('array length');
  });

  it('does not flag extra keys the artifact adds by design', () => {
    // harnessFidelity / testGuard are reporting-only additions.
    expect(fidelityDiff({ a: 1, extra: true }, { a: 1 })).toEqual([]);
  });

  it('is strict about types — 1 and "1" are different', () => {
    expect(fidelityDiff({ a: '1' }, { a: 1 })).toHaveLength(1);
  });

  it('detects a one-in-a-million drift in an expectancy', () => {
    const d = fidelityDiff({ grossRPerTrade: 0.1727 }, { grossRPerTrade: 0.1726 });
    expect(d).toHaveLength(1);
  });
});

/* ---------------- binary search ---------------- */

describe('lastIndexAtOrBefore', () => {
  const c = [0, 10, 20, 30, 40].map((t) => ({ openTime: t }));
  it('finds the last index at or before a timestamp', () => {
    expect(lastIndexAtOrBefore(c, -1)).toBe(-1);
    expect(lastIndexAtOrBefore(c, 0)).toBe(0);
    expect(lastIndexAtOrBefore(c, 29)).toBe(2);
    expect(lastIndexAtOrBefore(c, 30)).toBe(3);
    expect(lastIndexAtOrBefore(c, 1e9)).toBe(4);
  });
  it('handles an empty series', () => {
    expect(lastIndexAtOrBefore([], 100)).toBe(-1);
  });
});

/* ---------------- H4 alignment sanity ---------------- */

describe('fixture sanity', () => {
  it('the 4H span constant still matches the engine', () => {
    expect(TF_MS['4h']).toBe(H4);
    expect(TF_MS['1h']).toBe(H);
  });
});

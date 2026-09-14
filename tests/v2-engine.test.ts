/**
 * SMC V2 — engine-level regression suite (spec §32).
 *
 * The headline requirements under test:
 *   - reaching a range HIGH does NOT imply SHORT, and a LOW does NOT imply LONG
 *   - WAIT is a real, reasoned outcome
 *   - no look-ahead: evaluating at bar N is byte-identical whether or not
 *     later candles exist in the array
 *   - stops are structural, targets are structural and ordered
 */

import { describe, expect, it } from 'vitest';
import type { Candle, Timeframe } from '../src/core/types';
import { Settings } from '../src/core/settings';
import { evaluateV2, paramsFromSettings, aggregateEvidence } from '../src/strategy/v2/engine';
import { evaluateV2IfEnabled, v2Enabled } from '../src/strategy/v2';
import { emptyProfile, COMPONENT_KEYS } from '../src/strategy/v2/types';
import { loadFixtureCandles } from '../scripts/strategy-lab';

const H = 3_600_000;
const T0 = 1_700_000_000_000;

function c(
  i: number, o: number, h: number, l: number, cl: number, v = 100, closed = true,
): Candle {
  return {
    openTime: T0 + i * H,
    open: o, high: h, low: l, close: cl, volume: v,
    closeTime: T0 + i * H + H - 1,
    quoteVolume: v * cl, trades: 10, isClosed: closed,
  };
}

const settings = (over: Array<readonly [string, unknown]> = []): Settings =>
  Settings.fromEntries(over);

/**
 * A clean oscillating range between ~90 and ~110, long enough for every
 * indicator to warm up. The final bar is supplied by the caller.
 */
function rangeMarket(decision?: Candle, cycles = 12): Candle[] {
  const bars: Candle[] = [];
  const path = [100, 104, 110, 104, 100, 96, 90, 96];
  let i = 0;
  for (let k = 0; k < cycles; k++) {
    for (const v of path) {
      const jitter = ((i * 37) % 7) / 10 - 0.3;
      bars.push(c(i, v, v + 1.2 + jitter, v - 1.2 - jitter, v + jitter * 0.4, 100 + (i % 5) * 4));
      i++;
    }
  }
  if (decision) {
    bars.push({ ...decision, openTime: T0 + i * H, closeTime: T0 + i * H + H - 1 });
  }
  return bars;
}

describe('V2 engine — HIGH is a place to look, not a signal', () => {
  it('does NOT short merely because price reached the range high', () => {
    // Price pushes into the top of the range with an ordinary bar: no sweep,
    // no reclaim, no breakout. The only honest answer is WAIT.
    const bars = rangeMarket(c(0, 108, 110.2, 107.5, 109.5));
    const r = evaluateV2({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: bars, settings: settings(),
    })!;
    expect(r).not.toBeNull();
    expect(r.location).toBe('HIGH');
    expect(r.direction).toBe('WAIT');
    expect(r.waitReasons.length).toBeGreaterThan(0);
  });

  it('does NOT long merely because price reached the range low', () => {
    const bars = rangeMarket(c(0, 92, 92.5, 89.9, 90.4));
    const r = evaluateV2({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: bars, settings: settings(),
    })!;
    expect(r.location).toBe('LOW');
    expect(r.direction).toBe('WAIT');
  });

  it('always explains a WAIT in words', () => {
    const bars = rangeMarket(c(0, 100, 100.8, 99.2, 100.1));
    const r = evaluateV2({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: bars, settings: settings(),
    })!;
    expect(r.direction).toBe('WAIT');
    expect(r.waitReasons.join(' ')).toMatch(/\S{10,}/);
  });

  it('WAIT is reachable at every range location, not only mid-range', () => {
    const seen = new Set<string>();
    for (const d of [
      c(0, 108, 110.2, 107.5, 109.5),
      c(0, 92, 92.5, 89.9, 90.4),
      c(0, 100, 100.8, 99.2, 100.1),
    ]) {
      const r = evaluateV2({
        symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: rangeMarket(d), settings: settings(),
      })!;
      if (r.direction === 'WAIT') seen.add(r.location);
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });
});

describe('V2 engine — anti-look-ahead', () => {
  const full = rangeMarket(undefined, 14);

  it('evaluating bar N ignores every candle after N', () => {
    const n = full.length - 12;
    const truncated = full.slice(0, n + 1);
    const a = evaluateV2({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: full, atIndex: n, settings: settings(),
    });
    const b = evaluateV2({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: truncated, atIndex: n, settings: settings(),
    });
    expect(a).not.toBeNull();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('holds for a whole sweep of evaluation points', () => {
    for (let n = full.length - 30; n < full.length; n += 7) {
      const a = evaluateV2({
        symbol: 'ETHUSDT', timeframe: '1h' as Timeframe, candles: full, atIndex: n, settings: settings(),
      });
      const b = evaluateV2({
        symbol: 'ETHUSDT', timeframe: '1h' as Timeframe, candles: full.slice(0, n + 1), atIndex: n, settings: settings(),
      });
      expect(JSON.stringify(a), `mismatch at index ${n}`).toBe(JSON.stringify(b));
    }
  });

  it('never evaluates a candle that has not closed', () => {
    const bars = [...rangeMarket()];
    const lastClosed = bars[bars.length - 1]!;
    // A genuinely NEW, still-forming bar one interval later.
    const forming: Candle = {
      ...lastClosed,
      openTime: lastClosed.openTime + H,
      closeTime: lastClosed.closeTime + H,
      isClosed: false,
    };
    bars.push(forming);
    const r = evaluateV2({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: bars, settings: settings(),
    })!;
    // The forming bar is dropped, so the evaluated bar is the last CLOSED one.
    expect(r.time).toBe(lastClosed.openTime);
    expect(r.time).toBeLessThan(forming.openTime);
  });

  it('is deterministic — identical inputs give identical output', () => {
    const a = evaluateV2({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: full, settings: settings(),
    });
    const b = evaluateV2({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: full, settings: settings(),
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('V2 engine — structural risk', () => {
  /** Force a setup by relaxing the evidence gate, then inspect its geometry. */
  function anySetup(): ReturnType<typeof evaluateV2> {
    const relaxed = settings([
      ['v2.min_evidence', 0.05],
      ['v2.min_net_evidence', 0],
      ['v2.min_room_r', 0.1],
      ['v2.sweep_min_penetration_atr', 0.02],
      ['v2.sweep_min_wick_ratio', 0.05],
    ]);
    const candidates: Candle[] = [
      c(0, 108, 122, 107, 109, 400),   // upside sweep -> SHORT reversal
      c(0, 92, 93, 78, 91, 400),       // downside sweep -> LONG reversal
      c(0, 108, 128, 107.5, 127, 500), // breakout -> LONG continuation
    ];
    for (const d of candidates) {
      const r = evaluateV2({
        symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: rangeMarket(d), settings: relaxed,
      });
      if (r && r.direction !== 'WAIT') return r;
    }
    return null;
  }

  it('produces a directional setup when the evidence gate is relaxed', () => {
    const r = anySetup();
    expect(r, 'no directional setup could be produced at all').not.toBeNull();
    expect(['LONG', 'SHORT']).toContain(r!.direction);
  });

  it('places the stop on the losing side of entry and records WHY', () => {
    const r = anySetup()!;
    expect(r.stop).not.toBeNull();
    if (r.direction === 'LONG') expect(r.stop!.price).toBeLessThan(r.entry!);
    else expect(r.stop!.price).toBeGreaterThan(r.entry!);
    expect(r.stop!.reason.length).toBeGreaterThan(10);
    expect(['SWEEP_EXTREME', 'SWING', 'RANGE_EDGE', 'BREAKOUT_LEVEL']).toContain(r.stop!.anchor);
  });

  it('orders targets monotonically away from entry, each with a basis', () => {
    const r = anySetup()!;
    expect(r.targets.length).toBeGreaterThan(0);
    for (let i = 1; i < r.targets.length; i++) {
      expect(r.targets[i]!.r).toBeGreaterThan(r.targets[i - 1]!.r);
    }
    for (const t of r.targets) {
      expect(t.r).toBeGreaterThan(0);
      expect(t.reason.length).toBeGreaterThan(5);
      if (r.direction === 'LONG') expect(t.price).toBeGreaterThan(r.entry!);
      else expect(t.price).toBeLessThan(r.entry!);
    }
  });

  it('rejects a setup when there is not enough room to the final target', () => {
    // An impossible room requirement must force WAIT, never a squeezed trade.
    const strict = settings([
      ['v2.min_evidence', 0.05],
      ['v2.min_net_evidence', 0],
      ['v2.min_room_r', 999],
    ]);
    const r = evaluateV2({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe,
      candles: rangeMarket(c(0, 108, 122, 107, 109, 400)), settings: strict,
    })!;
    expect(r.direction).toBe('WAIT');
    expect(r.waitReasons.join(' ')).toMatch(/R|цел/i);
  });
});

describe('V2 engine — component profile and conflict', () => {
  it('reports both sides separately plus their conflict', () => {
    const r = evaluateV2({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe,
      candles: rangeMarket(c(0, 108, 118, 107, 109, 300)), settings: settings(),
    })!;
    expect(r.longEvidence).toBeGreaterThanOrEqual(0);
    expect(r.shortEvidence).toBeGreaterThanOrEqual(0);
    expect(r.conflict).toBeCloseTo(Math.min(r.longEvidence, r.shortEvidence), 10);
    expect(r.netEvidence).toBeCloseTo(Math.abs(r.longEvidence - r.shortEvidence), 10);
  });

  it('keeps every component within 0..1 on both sides', () => {
    const r = evaluateV2({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe,
      candles: rangeMarket(c(0, 92, 82, 81, 91, 300)), settings: settings(),
    })!;
    for (const k of COMPONENT_KEYS) {
      for (const p of [r.longProfile, r.shortProfile]) {
        expect(p[k], `${k} out of range`).toBeGreaterThanOrEqual(0);
        expect(p[k], `${k} out of range`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('evidence is a bounded 0..1 aggregate, never a percentage probability', () => {
    const zero = emptyProfile();
    expect(aggregateEvidence(zero)).toBe(0);
    const full = { ...zero };
    for (const k of COMPONENT_KEYS) full[k] = 1;
    expect(aggregateEvidence(full)).toBeCloseTo(1, 10);
  });

  it('a single maxed component cannot produce full evidence', () => {
    // This is the V1 defect the spec calls out: 25/25 = "100".
    const p = emptyProfile();
    p.structure = 1;
    expect(aggregateEvidence(p)).toBeLessThan(0.25);
  });
});

describe('V2 engine — settings are the single source of truth', () => {
  it('reads every V2 parameter from the registry', () => {
    const p = paramsFromSettings(settings());
    expect(p.rangeEdgePct).toBe(0.25);
    expect(p.minEvidence).toBe(0.45);
    expect(p.rsiPeriod).toBe(14);
    expect(p.adxPeriod).toBe(14);
  });

  it('changing a setting changes engine behaviour', () => {
    const bars = rangeMarket(c(0, 105, 106, 104, 105.5));
    const wide = evaluateV2({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: bars,
      settings: settings([['v2.range_edge_pct', 0.45]]),
    })!;
    const narrow = evaluateV2({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: bars,
      settings: settings([['v2.range_edge_pct', 0.05]]),
    })!;
    expect(wide.location).not.toBe(narrow.location);
  });

  it('V2 is DISABLED by default and the guarded entry point returns null', () => {
    const s = settings();
    expect(v2Enabled(s)).toBe(false);
    expect(evaluateV2IfEnabled({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: rangeMarket(), settings: s,
    })).toBeNull();
  });

  it('the guarded entry point works once explicitly enabled', () => {
    const s = settings([['v2.enabled', true]]);
    expect(v2Enabled(s)).toBe(true);
    expect(evaluateV2IfEnabled({
      symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles: rangeMarket(), settings: s,
    })).not.toBeNull();
  });
});

describe('V2 engine — behaviour over the fixture corpus', () => {
  const candles = loadFixtureCandles('fixtures', 'BTCUSDT', '1h' as Timeframe);

  it('runs across real candle series without throwing', () => {
    let evaluated = 0;
    for (let i = 120; i < Math.min(candles.length, 400); i += 20) {
      const r = evaluateV2({
        symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles, atIndex: i, settings: settings(),
      });
      if (r) evaluated++;
    }
    expect(evaluated).toBeGreaterThan(5);
  });

  it('issues WAIT far more often than a direction — selectivity, not noise', () => {
    let wait = 0;
    let directional = 0;
    for (let i = 120; i < Math.min(candles.length, 500); i++) {
      const r = evaluateV2({
        symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles, atIndex: i, settings: settings(),
      });
      if (!r) continue;
      if (r.direction === 'WAIT') wait++;
      else directional++;
    }
    expect(wait + directional).toBeGreaterThan(50);
    expect(wait).toBeGreaterThan(directional);
  });

  it('every directional setup carries a stop, targets and a room assessment', () => {
    for (let i = 120; i < Math.min(candles.length, 500); i++) {
      const r = evaluateV2({
        symbol: 'BTCUSDT', timeframe: '1h' as Timeframe, candles, atIndex: i, settings: settings(),
      });
      if (!r || r.direction === 'WAIT') continue;
      expect(r.stop, `no stop at ${i}`).not.toBeNull();
      expect(r.targets.length, `no targets at ${i}`).toBeGreaterThan(0);
      expect(r.room, `no room assessment at ${i}`).not.toBeNull();
      expect(r.room!.adequate).toBe(true);
      expect(r.kind === 'REVERSAL' || r.kind === 'CONTINUATION').toBe(true);
    }
  });
});

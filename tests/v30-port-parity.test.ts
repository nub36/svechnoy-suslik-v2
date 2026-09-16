/**
 * V3.0 PORT PARITY — the production module must reproduce the frozen research
 * module EXACTLY.
 *
 * Three layers:
 *  1. UNIT PARITY on synthetic bars: every decision function in
 *     `src/strategy/v30` is compared against its counterpart in
 *     `research/v30_htf_trap.ts` (which is never modified — its hash is pinned
 *     by tests/v30-validation.test.ts).
 *  2. RANDOMISED PARITY: hundreds of seeded random candles through both
 *     `manageTrade` implementations. This is the layer that caught the missing
 *     TP2-after-TP1 branch, which would have recorded every multi-bar TP2 win as
 *     a timeout or a scratch.
 *  3. REAL-DATA PARITY EVIDENCE: the committed artifact
 *     `artifacts/research/v30/v30-port-parity.json` (produced by
 *     scripts/real-data/v30-parity.ts over the TRAIN window, 6 symbols) must say
 *     PASS and its aggregate figures must equal the committed TRAIN artifact.
 *
 * If layer 3 is regenerated, it must be regenerated on TRAIN data only. The
 * VALIDATION window is spent and the TEST window has never been read.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Candle } from '../src/core/types';
import { Settings, SETTINGS_BY_KEY } from '../src/core/settings';
import {
  MIN_BODY_RATIO,
  MIN_RVOL,
  CORRIDOR_ATR_FRAC,
  CORRIDOR_EXPIRY_BARS,
  STOP_BUFFER_ATR,
  TIMEOUT_BARS,
  MAKER_BPS,
  TAKER_BPS,
  bodyRatio as rBodyRatio,
  detectTrap as rDetectTrap,
  legFeeR as rLegFeeR,
  manageTrade as rManageTrade,
  type Direction,
} from '../research/v30_htf_trap';
import {
  V30_FROZEN,
  v30Params,
  buildPlan,
  bodyRatio,
  corridorStep,
  detectTrap,
  legFeeR,
  manageTrade,
  readPlan,
  planPayload,
  activeRange,
  confirmedLevels,
} from '../src/strategy/v30';
import {
  buildChartPayload,
  buildSignalLevels,
  readV30Overlay,
  signalLabel,
} from '../src/web/overlays';
import { closedHtfCandles } from '../src/strategy/v2/htf';

const H = 3_600_000;
const settings = Settings.fromDefaults();
const p = v30Params(settings);

const bar = (
  i: number,
  o: number,
  h: number,
  l: number,
  c: number,
  volume = 100,
): Candle =>
  ({
    openTime: i * H,
    closeTime: i * H + H - 1,
    open: o,
    high: h,
    low: l,
    close: c,
    volume,
    quoteVolume: 0,
    trades: 0,
    isClosed: true,
  }) as Candle;

/* ------------------------------------------------------------------ registry */

describe('frozen configuration', () => {
  it('the settings registry defaults ARE the frozen values', () => {
    const expectDefault = (key: string, value: unknown): void => {
      const def = SETTINGS_BY_KEY.get(key);
      expect(def, `${key} missing from the registry`).toBeDefined();
      expect(def!.default).toEqual(value);
    };
    expectDefault('v30.bodyRatioMin', V30_FROZEN.bodyRatioMin);
    expectDefault('v30.rvolMin', V30_FROZEN.rvolMin);
    expectDefault('v30.corridorATR', V30_FROZEN.corridorAtr);
    expectDefault('v30.slBufferATR', V30_FROZEN.slBufferAtr);
    expectDefault('v30.tp1Equilibrium', V30_FROZEN.tp1Equilibrium);
    expectDefault('v30.breakevenTrigger', V30_FROZEN.breakevenTrigger);
    expectDefault('v30.timeoutBars', V30_FROZEN.timeoutBars);
    expectDefault('v30.positionSplitTP1', V30_FROZEN.positionSplitTp1);
    expectDefault('v30.htfTimeframe', V30_FROZEN.htfTimeframe);
    expectDefault('v30.ltfTimeframe', V30_FROZEN.ltfTimeframe);
    expectDefault('v30.symbols', [...V30_FROZEN.symbols]);
    expectDefault('v30.makerBps', V30_FROZEN.makerBps);
    expectDefault('v30.takerBps', V30_FROZEN.takerBps);
    expectDefault('strategy.active', 'V3_0');
  });

  it('the frozen constants match the pre-registered research values', () => {
    expect(V30_FROZEN.bodyRatioMin).toBe(MIN_BODY_RATIO);
    expect(V30_FROZEN.rvolMin).toBe(MIN_RVOL);
    expect(V30_FROZEN.corridorAtr).toBe(CORRIDOR_ATR_FRAC);
    expect(V30_FROZEN.corridorExpiryBars).toBe(CORRIDOR_EXPIRY_BARS);
    expect(V30_FROZEN.slBufferAtr).toBe(STOP_BUFFER_ATR);
    expect(V30_FROZEN.timeoutBars).toBe(TIMEOUT_BARS);
    expect(V30_FROZEN.makerBps).toBe(MAKER_BPS);
    expect(V30_FROZEN.takerBps).toBe(TAKER_BPS);
  });

  it('resolves the frozen parameters out of the live settings', () => {
    expect(v30Params(settings)).toEqual(V30_FROZEN);
  });

  it('a changed value reaches the strategy (no decorative settings)', () => {
    const changed = v30Params(
      Settings.fromEntries([
        ['v30.corridorATR', 0.2],
        ['v30.rvolMin', 1.5],
        ['v30.symbols', ['BTCUSDT']],
      ]),
    );
    expect(changed.corridorAtr).toBe(0.2);
    expect(changed.rvolMin).toBe(1.5);
    expect(changed.symbols).toEqual(['BTCUSDT']);
  });
});

/* -------------------------------------------------------------- pure parity */

describe('unit parity with research/v30_htf_trap.ts', () => {
  const candles = [
    bar(1, 100, 110, 90, 105),
    bar(2, 112, 115, 103, 104),
    bar(3, 88, 97, 85, 96),
    bar(4, 100, 100, 100, 100),
  ];

  it('bodyRatio', () => {
    for (const c of candles) expect(bodyRatio(c)).toBe(rBodyRatio(c));
  });

  it('detectTrap (same signal, same reason, both directions)', () => {
    const levels = { swingHigh: 110, swingLow: 90 };
    for (const c of candles) {
      const a = rDetectTrap(c, levels, 2.0);
      const b = detectTrap(c, levels, 2.0, p);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
  });

  it('detectTrap resolves a bar that sweeps both edges to SHORT', () => {
    // high > 110 AND low < 90, closing back inside: the frozen order picks SHORT.
    const c = bar(9, 96, 115, 85, 107);
    const levels = { swingHigh: 110, swingLow: 90 };
    const r = rDetectTrap(c, levels, 2.0);
    expect(r?.direction).toBe('SHORT');
    expect(detectTrap(c, levels, 2.0, p)?.direction).toBe('SHORT');
  });

  it('legFeeR', () => {
    for (const [price, weight, bps, risk] of [
      [100, 1, 2, 5],
      [104.8, 0.5, 5, 5.95],
      [0, 1, 5, 5],
    ] as const) {
      expect(legFeeR(price, weight, bps, risk)).toBe(rLegFeeR(price, weight, bps, risk));
    }
  });

  it('manageTrade: scripted scenarios agree exactly', () => {
    const scenarios: { name: string; dir: Direction; bars: Candle[] }[] = [
      {
        name: 'stop on the entry bar',
        dir: 'LONG',
        bars: [bar(0, 100, 101, 94, 95)],
      },
      {
        name: 'TP2 on the entry bar (TP1 books first, R2)',
        dir: 'LONG',
        bars: [bar(0, 100, 130, 99, 125)],
      },
      {
        name: 'TP1 then breakeven stop on a later bar (R3)',
        dir: 'LONG',
        bars: [bar(0, 100, 115, 99, 114), bar(1, 114, 116, 99.5, 100)],
      },
      {
        name: 'TP1 then TP2 TWO bars later (the branch that was missing)',
        dir: 'LONG',
        bars: [bar(0, 100, 115, 99, 112), bar(1, 112, 114, 111, 113), bar(2, 113, 131, 112, 130)],
      },
      {
        name: 'TP1 then timeout',
        dir: 'LONG',
        bars: Array.from({ length: 60 }, (_, i) =>
          i === 0 ? bar(0, 100, 115, 99, 114) : bar(i, 114, 114.5, 113.5, 114),
        ),
      },
      {
        name: 'timeout without TP1',
        dir: 'SHORT',
        bars: Array.from({ length: 60 }, (_, i) => bar(i, 100, 101, 99, 100)),
      },
      {
        name: 'SHORT: stop is checked before the target (R1)',
        dir: 'SHORT',
        bars: [bar(0, 100, 106, 94, 105)],
      },
    ];

    for (const s of scenarios) {
      const r = rManageTrade(s.dir, 100, 105, 115, 130, s.bars);
      const b = manageTrade(s.dir, 100, 105, 115, 130, s.bars, p);
      expect(b, s.name).not.toBeNull();
      expect(r, s.name).not.toBeNull();
      expect(
        {
          exit: b!.exit,
          grossR: b!.grossR,
          barsHeld: b!.barsHeld,
          hitTp1: b!.hitTp1,
          hitTp2: b!.hitTp2,
          fee25: b!.feeR(MAKER_BPS, TAKER_BPS),
        },
        s.name,
      ).toEqual({
        exit: r!.exit,
        grossR: r!.grossR,
        barsHeld: r!.barsHeld,
        hitTp1: r!.hitTp1,
        hitTp2: r!.hitTp2,
        fee25: r!.feeR(MAKER_BPS, TAKER_BPS),
      });
    }
  });

  it('manageTrade: 400 seeded random walks agree exactly (and resolve)', () => {
    let seed = 0x5eed;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    let compared = 0;

    for (let t = 0; t < 400; t++) {
      const dir: Direction = rnd() < 0.5 ? 'LONG' : 'SHORT';
      const entry = 100;
      const stop = dir === 'LONG' ? 96 : 104;
      const tp1 = dir === 'LONG' ? 108 : 92;
      const tp2 = dir === 'LONG' ? 116 : 84;
      const bars: Candle[] = [];
      let price = entry;
      for (let i = 0; i < 55; i++) {
        const o = price;
        price = o + (rnd() - 0.5) * 4.5;
        const high = Math.max(o, price) + rnd() * 0.6;
        const low = Math.min(o, price) - rnd() * 0.6;
        bars.push(bar(i, o, high, low, price));
      }

      const r = rManageTrade(dir, entry, stop, tp1, tp2, bars);
      const b = manageTrade(dir, entry, stop, tp1, tp2, bars, p);
      if (r === null || b === null) {
        expect(b === null, `random #${t}: one side unresolved`).toBe(r === null);
        continue;
      }
      compared++;
      // The ported trade exposes its fee legs; research keeps them internal, so
      // the comparison is on the decision + the money, not the bookkeeping.
      // legs = maker entry + exit leg, plus the TP1 leg when TP1 was banked.
      expect(b.legs.length, `random #${t}: leg count`).toBe(b.hitTp1 ? 3 : 2);
      expect(
        {
          exit: b.exit,
          grossR: b.grossR,
          barsHeld: b.barsHeld,
          hitTp1: b.hitTp1,
          hitTp2: b.hitTp2,
          fee25: b.feeR(MAKER_BPS, TAKER_BPS),
        },
        `random #${t}`,
      ).toEqual({
        exit: r.exit,
        grossR: r.grossR,
        barsHeld: r.barsHeld,
        hitTp1: r.hitTp1,
        hitTp2: r.hitTp2,
        fee25: r.feeR(MAKER_BPS, TAKER_BPS),
      });
    }
    expect(compared).toBeGreaterThan(300);
  });

  it('corridorStep matches the frozen corridor rules', () => {
    const plan = { direction: 'LONG' as const, zoneLow: 99, zoneHigh: 101, stop: 96 };

    // N+1 touches the zone: fill at the WORSE edge (min(open, zoneHigh)).
    expect(corridorStep(plan, bar(0, 103, 104, 100, 102), 1, p)).toEqual({
      kind: 'FILL',
      fillPrice: 101,
    });
    // Gap down through the zone: fill at the open, never at the zone edge.
    expect(corridorStep(plan, bar(0, 97, 98, 96.5, 97), 1, p)).toEqual({
      kind: 'FILL',
      fillPrice: 97,
    });
    // Bar touches the zone AND breaches the stop -> ambiguity resolves against us.
    expect(corridorStep(plan, bar(0, 100, 101.5, 95, 96), 1, p)).toEqual({
      kind: 'CANCEL',
      reason: 'AMBIGUOUS_BAR',
    });
    // A bar that breaches the stop WITHOUT touching the zone. With coherent
    // geometry (stop below the zone for a LONG) that is impossible — a stop
    // breach always reaches into the zone and is therefore AMBIGUOUS. It is
    // reachable for a plan whose geometry was already broken, which is why the
    // branch exists.
    expect(
      corridorStep({ direction: 'LONG', zoneLow: 99, zoneHigh: 101, stop: 102 }, bar(0, 103, 104, 101.5, 103.5), 1, p),
    ).toEqual({ kind: 'CANCEL', reason: 'STOP_BEFORE_FILL' });
    // Untouched on the expiry bar -> expired.
    expect(corridorStep(plan, bar(0, 105, 106, 102, 105), CORRIDOR_EXPIRY_BARS, p)).toEqual({
      kind: 'EXPIRE',
    });
    // Untouched before the expiry bar -> still resting.
    expect(corridorStep(plan, bar(0, 105, 106, 102, 105), CORRIDOR_EXPIRY_BARS - 1, p)).toEqual({
      kind: 'WAIT',
    });
    // A SHORT corridor is symmetric.
    expect(
      corridorStep({ direction: 'SHORT', zoneLow: 99, zoneHigh: 101, stop: 104 }, bar(0, 98, 99, 97, 97.5), 1, p),
    ).toEqual({ kind: 'FILL', fillPrice: 99 });
  });

  it('buildPlan reproduces the frozen plan arithmetic', () => {
    const levels = { swingHigh: 130, swingLow: 100 };
    const signal = {
      direction: 'LONG' as const,
      level: 100,
      sweepExtreme: 98,
      bodyRatio: 0.6,
      rvol: 2,
    };
    const plan = buildPlan(signal, levels, 2, 105, p);
    expect(plan).not.toBeNull();
    expect(plan!.zoneLow).toBeCloseTo(105 - CORRIDOR_ATR_FRAC * 2, 10);
    expect(plan!.zoneHigh).toBeCloseTo(105 + CORRIDOR_ATR_FRAC * 2, 10);
    expect(plan!.stop).toBeCloseTo(98 - STOP_BUFFER_ATR * 2, 10);
    expect(plan!.tp1).toBeCloseTo((130 + 100) / 2, 10); // 4H equilibrium
    expect(plan!.tp2).toBeCloseTo(130, 10); // opposing swing
    expect(activeRange(levels)).toEqual({ low: 100, high: 130 });

    // A one-sided range cannot be traded at all.
    expect(buildPlan(signal, { swingHigh: null, swingLow: 100 }, 2, 105, p)).toBeNull();
  });

  it('confirmedLevels requires the HIGH-TF bar to have closed (no look-ahead)', () => {
    // A single V trough at index 10 (low 100) and a single ^ peak at index 20
    // (high 130): each is a strict extremum over +/-3 bars, so findSwingsV2
    // has exactly one of each.
    const h4 = Array.from({ length: 40 }, (_, i) => {
      const high = 140 - Math.abs(i - 20);
      const low = 100 + Math.abs(i - 10) * 0.5;
      const close = (high + low) / 2;
      return bar(i * 4, close, high, low, close);
    });
    const asOf = h4[39]!.openTime + 4 * H - 1;
    const levels = confirmedLevels(h4, asOf, 3, '4h');
    expect(levels.swingHigh).toBe(140 - 0); // index 20
    expect(levels.swingLow).toBe(100); // index 10

    // At the moment bar 21 has NOT closed yet, the peak at index 20 is visible
    // but its right-bars are not: confirmedIndex is 23, so it must be ignored.
    const beforeConfirm = h4[21]!.openTime;
    expect(confirmedLevels(h4, beforeConfirm, 3, '4h').swingHigh).toBeNull();
    // ...while the trough, confirmed at index 13, is already usable.
    expect(confirmedLevels(h4, beforeConfirm, 3, '4h').swingLow).toBe(100);

    // The visibility boundary is `openTime + span <= asOfCloseTime`, i.e. a
    // 4H bar is only visible once it has fully closed by that instant. Passing
    // the last bar's own open, or its close time minus 1 ms, must not expose it.
    expect(closedHtfCandles(h4, '4h', h4[39]!.openTime).length).toBe(39);
    expect(closedHtfCandles(h4, '4h', h4[39]!.openTime + 4 * H - 1).length).toBe(39);
    expect(closedHtfCandles(h4, '4h', h4[39]!.openTime + 4 * H).length).toBe(40);
  });
});

/* -------------------------------------------------------------- payload I/O */

describe('signal payload round trip', () => {
  const levels = { swingHigh: 130, swingLow: 100 };
  const signal = {
    direction: 'LONG' as const,
    level: 100,
    sweepExtreme: 98,
    bodyRatio: 0.6,
    rvol: 2,
  };
  const plan = buildPlan(signal, levels, 2, 105, p)!;
  const payload = planPayload(plan, p);
  const breakdown = JSON.stringify({ v30: payload });

  it('readPlan returns the persisted plan', () => {
    const back = readPlan(breakdown);
    expect(back).not.toBeNull();
    expect(back!.plan.zoneLow).toBe(plan.zoneLow);
    expect(back!.plan.tp2).toBe(plan.tp2);
    expect(back!.params.timeoutBars).toBe(TIMEOUT_BARS);
  });

  it('readPlan ignores foreign or corrupt payloads', () => {
    expect(readPlan(null)).toBeNull();
    expect(readPlan('not json')).toBeNull();
    expect(readPlan(JSON.stringify({ v1: {} }))).toBeNull();
    expect(readPlan(JSON.stringify({ v30: { strategy: 'V2.8' } }))).toBeNull();
  });

  it('the chart overlay reads the same payload without inventing anything', () => {
    const overlay = readV30Overlay(breakdown);
    expect(overlay).not.toBeNull();
    expect(overlay!.zoneLow).toBe(plan.zoneLow);
    expect(overlay!.zoneHigh).toBe(plan.zoneHigh);
    expect(overlay!.tp1).toBe(plan.tp1);
    expect(overlay!.tp2).toBe(plan.tp2);
    expect(overlay!.level).toBe(plan.level);
    expect(overlay!.corridorExpiryBars).toBe(CORRIDOR_EXPIRY_BARS);
    expect(overlay!.exit).toBeUndefined();
    // No outcome recorded yet: nothing may claim TP1/TP2 was reached.
    expect(overlay!.hitTp1).toBe(false);
    expect(overlay!.hitTp2).toBe(false);

    // V1 payloads must never render as V3.0.
    expect(readV30Overlay(JSON.stringify({ events: [] }))).toBeNull();
  });

  it('builds the chart geometry for a resting corridor', () => {
    const signal = {
      id: 7,
      direction: 'LONG' as const,
      state: 'WAITING_ENTRY',
      score: 0,
      setupCandleTime: 1000,
      entryCandleTime: null,
      entryPrice: null,
      levels: [] as ReturnType<typeof buildSignalLevels>,
      waitingForEntry: true,
      label: 'V3.0 LONG',
      v30: readV30Overlay(breakdown)!,
    };
    const payload = buildChartPayload(
      'BTCUSDT',
      '1h',
      Array.from({ length: 3 }, (_, i) => bar(i, 100, 101, 99, 100)),
      settings,
      signal,
      null,
    );

    // The corridor is a REAL resting order, so it is drawn as a zone...
    const zone = payload.overlays.boxes.find((b) => b.id === `v30-zone-${signal.id}`);
    expect(zone, 'corridor zone missing').toBeDefined();
    expect(zone!.priceLow).toBe(plan.zoneLow);
    expect(zone!.priceHigh).toBe(plan.zoneHigh);
    expect(zone!.from).toBe(signal.setupCandleTime);
    // ...the swept 4H level as a line, and the trap as a marker.
    const level = payload.overlays.lines.find((l) => l.id === `v30-level-${signal.id}`);
    expect(level!.price).toBe(plan.level);
    expect(payload.overlays.markers.some((m) => m.text === 'TRAP')).toBe(true);
    // Nothing is filled while the order rests, so there is no FILL marker and
    // no fabricated outcome.
    expect(payload.overlays.markers.some((m) => m.text === 'FILL')).toBe(false);
    expect(payload.overlays.markers.some((m) => m.text.includes('net'))).toBe(false);
  });

  it('labels a V3.0 signal without a fabricated score', () => {
    expect(signalLabel({ direction: 'SHORT', score: 0, breakdown })).toBe('V3.0 SHORT');
    expect(signalLabel({ direction: 'LONG', score: 62 })).toBe('LONG 62');
  });

  it('buildSignalLevels attaches the V3.0 meaning to TP1/TP2', () => {
    const levelsOut = buildSignalLevels({
      entry_price: 105,
      stop_loss: plan.stop,
      take_profits: [plan.tp1, plan.tp2],
      breakdown,
    });
    expect(levelsOut.map((l) => l.kind)).toEqual(['ENTRY', 'SL', 'TP1', 'TP2']);
    expect(levelsOut.find((l) => l.kind === 'TP1')!.note).toContain('equilibrium');
    expect(levelsOut.find((l) => l.kind === 'TP2')!.note).toContain('opposing');

    // V1 rows keep their plain levels (no notes).
    const v1 = buildSignalLevels({ entry_price: 105, stop_loss: 96, take_profits: [110, 120] });
    expect(v1.find((l) => l.kind === 'TP1')!.note).toBeUndefined();
  });
});

/* ------------------------------------------------------- real-data evidence */

describe('real-data parity artifact', () => {
  const artifactPath = join(
    process.cwd(),
    'artifacts/research/v30/v30-port-parity.json',
  );

  it('the committed TRAIN parity run passed for all six symbols', () => {
    if (!existsSync(artifactPath)) {
      throw new Error(
        `missing ${artifactPath} — regenerate with scripts/real-data/v30-parity.ts on TRAIN data`,
      );
    }
    const a = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
      parity: string;
      window: string;
      totals: {
        research: { filled: number; signals: number };
        port: { filled: number; signals: number };
      };
      aggregates: {
        port: { n: number; grossRPerTrade: number; feeRPerTrade: number; netRPerTrade: number };
      };
      artifactCrossCheck: { problems: string[] };
      globalProblems: string[];
      perSymbol: { symbol: string; tradesMatch: boolean }[];
    };
    expect(a.parity).toBe('PASS');
    expect(a.globalProblems).toEqual([]);
    expect(a.artifactCrossCheck.problems).toEqual([]);
    expect(a.perSymbol.map((s) => s.symbol)).toEqual([
      'BTCUSDT',
      'ETHUSDT',
      'BNBUSDT',
      'SOLUSDT',
      'XRPUSDT',
      'DOGEUSDT',
    ]);
    expect(a.perSymbol.every((s) => s.tradesMatch)).toBe(true);
    // Same trades on both sides...
    expect(a.totals.port.filled).toBe(a.totals.research.filled);
    expect(a.totals.port.signals).toBe(a.totals.research.signals);
    // ...and the TRAIN headline numbers of the VALIDATION record.
    expect(a.aggregates.port.n).toBe(1585);
    expect(a.aggregates.port.grossRPerTrade).toBeCloseTo(0.1726, 4);
    expect(a.aggregates.port.feeRPerTrade).toBeCloseTo(0.0732, 4);
    expect(a.aggregates.port.netRPerTrade).toBeCloseTo(0.0994, 4);
  });

  it('the artifact pins TRAIN only — no VALIDATION or TEST window', () => {
    if (!existsSync(artifactPath)) return;
    const a = JSON.parse(readFileSync(artifactPath, 'utf8')) as { window: string };
    expect(a.window).toContain('TRAIN');
    expect(a.window).not.toContain('VALIDATION');
    expect(a.window).not.toContain('TEST');
  });
});

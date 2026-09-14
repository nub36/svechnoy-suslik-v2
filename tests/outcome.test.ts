import { describe, expect, it } from 'vitest';
import { trackOutcome, aggregate } from '../src/outcome/tracker';
import { buildRiskPlan, rMultiple, pnlPct } from '../src/strategy/risk';
import { Settings } from '../src/core/settings';
import { candle } from './helpers';

const H = 3_600_000;
const T0 = 1_700_000_000_000;
// fee 0 keeps the arithmetic assertions exact
const s = Settings.fromEntries([
  ['outcome.fee_pct', 0],
  ['outcome.timeout_bars', 10],
]);

describe('outcome tracking', () => {
  it('detects a take-profit hit', () => {
    const out = trackOutcome({
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [105, 110],
      entryCandleTime: T0,
      candles: [
        candle(T0, 100, 102, 99, 101),
        candle(T0 + H, 101, 106, 100, 105.5), // hits TP1 at 105
      ],
      settings: s,
    });
    expect(out).not.toBeNull();
    expect(out!.result).toBe('TP');
    expect(out!.exitPrice).toBe(105);
    expect(out!.barsHeld).toBe(2);
    expect(out!.rMultiple).toBeCloseTo(1, 6); // 5 gain / 5 risk
  });

  it('detects a stop-loss hit', () => {
    const out = trackOutcome({
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [110],
      entryCandleTime: T0,
      candles: [candle(T0, 100, 101, 99, 100), candle(T0 + H, 100, 100.5, 94, 96)],
      settings: s,
    });
    expect(out!.result).toBe('SL');
    expect(out!.exitPrice).toBe(95);
    expect(out!.rMultiple).toBeCloseTo(-1, 6);
  });

  it('SHORT direction is handled correctly', () => {
    const out = trackOutcome({
      direction: 'SHORT',
      entryPrice: 100,
      stopLoss: 105,
      takeProfits: [95],
      entryCandleTime: T0,
      candles: [candle(T0, 100, 101, 99, 100), candle(T0 + H, 100, 100.5, 94, 94.5)],
      settings: s,
    });
    expect(out!.result).toBe('TP');
    expect(out!.exitPrice).toBe(95);
    expect(out!.rMultiple).toBeCloseTo(1, 6);
    expect(out!.pnlPct).toBeCloseTo(5, 6);
  });

  it('an ambiguous bar (both SL and TP touched) resolves to SL by default', () => {
    const out = trackOutcome({
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [105],
      entryCandleTime: T0,
      candles: [candle(T0, 100, 106, 94, 100)], // touches both
      settings: s,
    });
    expect(out!.result).toBe('SL');
    expect(out!.rMultiple).toBeCloseTo(-1, 6);
  });

  it('ambiguous-bar policy is configurable from settings', () => {
    const optimistic = Settings.fromEntries([
      ['outcome.fee_pct', 0],
      ['outcome.sl_priority_on_ambiguous_bar', false],
    ]);
    const out = trackOutcome({
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [105],
      entryCandleTime: T0,
      candles: [candle(T0, 100, 106, 94, 100)],
      settings: optimistic,
    });
    expect(out!.result).toBe('TP');
  });

  it('closes as TIMEOUT at the close of the last allowed bar', () => {
    const cs = Array.from({ length: 12 }, (_, i) =>
      candle(T0 + i * H, 100, 101, 99, 100 + i * 0.01),
    );
    const out = trackOutcome({
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 90,
      takeProfits: [120],
      entryCandleTime: T0,
      candles: cs,
      settings: s, // timeout_bars = 10
    });
    expect(out!.result).toBe('TIMEOUT');
    expect(out!.barsHeld).toBe(10);
    expect(out!.exitPrice).toBe(cs[9]!.close);
  });

  it('returns null while the trade is still open', () => {
    const out = trackOutcome({
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 90,
      takeProfits: [120],
      entryCandleTime: T0,
      candles: [candle(T0, 100, 101, 99, 100), candle(T0 + H, 100, 102, 98, 101)],
      settings: s,
    });
    expect(out).toBeNull();
  });

  it('ignores candles before the entry candle', () => {
    const out = trackOutcome({
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [105],
      entryCandleTime: T0 + 2 * H,
      candles: [
        candle(T0, 100, 200, 50, 100), // pre-entry monster bar -> must be ignored
        candle(T0 + H, 100, 200, 50, 100),
        candle(T0 + 2 * H, 100, 101, 99, 100),
      ],
      settings: s,
    });
    expect(out).toBeNull(); // nothing hit after entry
  });

  it('never resolves an outcome on a non-closed candle', () => {
    const out = trackOutcome({
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [105],
      entryCandleTime: T0,
      candles: [candle(T0, 100, 106, 94, 105, 1000, false)], // forming
      settings: s,
    });
    expect(out).toBeNull();
  });

  it('picks the nearest TP when several are on the same bar', () => {
    const out = trackOutcome({
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [105, 110, 115],
      entryCandleTime: T0,
      candles: [candle(T0, 100, 112, 99, 111)],
      settings: s,
    });
    // 115 not reached; furthest reached is 110 (index 1 after distance sort)
    expect(out!.result).toBe('TP');
    expect(out!.exitPrice).toBe(110);
    expect(out!.tpHitIndex).toBe(1);
  });

  it('tracks max favorable and adverse excursion', () => {
    const out = trackOutcome({
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 90,
      takeProfits: [130],
      entryCandleTime: T0,
      candles: [
        candle(T0, 100, 108, 96, 104),
        candle(T0 + H, 104, 112, 91, 92),
        ...Array.from({ length: 9 }, (_, i) => candle(T0 + (i + 2) * H, 92, 93, 91, 92)),
      ],
      settings: s,
    });
    expect(out!.result).toBe('TIMEOUT');
    expect(out!.maxFavorablePct).toBeCloseTo(12, 6); // high 112
    expect(out!.maxAdversePct).toBeCloseTo(-9, 6); // low 91
  });

  it('applies the configured fee to pnl and R', () => {
    const withFee = Settings.fromEntries([
      ['outcome.fee_pct', 0.2],
      ['outcome.timeout_bars', 10],
    ]);
    const out = trackOutcome({
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 95,
      takeProfits: [105],
      entryCandleTime: T0,
      candles: [candle(T0, 100, 106, 99.5, 105.5)],
      settings: withFee,
    });
    expect(out!.pnlPct).toBeCloseTo(5 - 0.2, 6);
    // fee in R = (0.2/100 * 100) / 5 = 0.04
    expect(out!.rMultiple).toBeCloseTo(1 - 0.04, 6);
  });
});

describe('risk plan', () => {
  const rs = Settings.fromEntries([
    ['risk.sl_atr_mult', 1.5],
    ['risk.tp1_r', 1],
    ['risk.tp2_r', 2],
    ['risk.tp3_r', 3],
    ['risk.account_quote', 10000],
    ['risk.risk_pct', 1],
  ]);

  it('builds a LONG plan with SL below and TPs above entry', () => {
    const p = buildRiskPlan({ direction: 'LONG', entry: 100, atr: 2, settings: rs })!;
    expect(p.stopLoss).toBeCloseTo(97, 9); // 100 - 2*1.5
    expect(p.riskPerUnit).toBeCloseTo(3, 9);
    expect(p.takeProfits).toEqual([103, 106, 109]);
    expect(p.rrTp1).toBeCloseTo(1, 9);
    // risk 1% of 10000 = 100 quote; qty = 100/3
    expect(p.qty).toBeCloseTo(100 / 3, 9);
    expect(p.positionSizeQuote).toBeCloseTo((100 / 3) * 100, 6);
  });

  it('builds a SHORT plan mirrored correctly', () => {
    const p = buildRiskPlan({ direction: 'SHORT', entry: 100, atr: 2, settings: rs })!;
    expect(p.stopLoss).toBeCloseTo(103, 9);
    expect(p.takeProfits).toEqual([97, 94, 91]);
  });

  it('honours a wider structural stop but never a tighter one', () => {
    const wider = buildRiskPlan({
      direction: 'LONG', entry: 100, atr: 2, settings: rs, structuralStop: 95,
    })!;
    expect(wider.stopLoss).toBe(95);

    const tighter = buildRiskPlan({
      direction: 'LONG', entry: 100, atr: 2, settings: rs, structuralStop: 99,
    })!;
    expect(tighter.stopLoss).toBeCloseTo(97, 9); // ATR stop kept
  });

  it('rejects invalid inputs', () => {
    expect(buildRiskPlan({ direction: 'LONG', entry: 0, atr: 2, settings: rs })).toBeNull();
    expect(buildRiskPlan({ direction: 'LONG', entry: 100, atr: 0, settings: rs })).toBeNull();
    expect(buildRiskPlan({ direction: 'LONG', entry: 100, atr: Number.NaN, settings: rs })).toBeNull();
  });

  it('R multiple and pnl helpers are direction aware', () => {
    expect(rMultiple('LONG', 100, 110, 5)).toBeCloseTo(2, 9);
    expect(rMultiple('SHORT', 100, 90, 5)).toBeCloseTo(2, 9);
    expect(pnlPct('LONG', 100, 110)).toBeCloseTo(10, 9);
    expect(pnlPct('SHORT', 100, 90)).toBeCloseTo(10, 9);
  });
});

describe('aggregate stats', () => {
  it('computes win rate, R and profit factor', () => {
    const st = aggregate([
      { result: 'TP', r_multiple: 2 },
      { result: 'TP', r_multiple: 1 },
      { result: 'SL', r_multiple: -1 },
      { result: 'TIMEOUT', r_multiple: -0.5 },
    ]);
    expect(st.total).toBe(4);
    expect(st.wins).toBe(2);
    expect(st.losses).toBe(1);
    expect(st.timeouts).toBe(1);
    expect(st.winRate).toBeCloseTo(50, 6);
    expect(st.totalR).toBeCloseTo(1.5, 6);
    expect(st.avgR).toBeCloseTo(0.375, 6);
    expect(st.profitFactor).toBeCloseTo(3 / 1.5, 6);
  });

  it('handles an empty set without NaN', () => {
    const st = aggregate([]);
    expect(st.total).toBe(0);
    expect(st.winRate).toBe(0);
    expect(st.avgR).toBe(0);
    expect(st.profitFactor).toBe(0);
  });

  it('computes max drawdown on the R equity curve', () => {
    const st = aggregate([
      { result: 'TP', r_multiple: 2 },
      { result: 'SL', r_multiple: -1 },
      { result: 'SL', r_multiple: -1 },
      { result: 'TP', r_multiple: 1 },
    ]);
    expect(st.maxDrawdownR).toBeCloseTo(-2, 6);
  });
});

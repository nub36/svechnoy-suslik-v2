/**
 * H1 EXIT-MODEL RESEARCH ACCOUNTING.
 *
 * Re-accounts ALREADY-RECORDED V2 trades under four exit models. It does NOT
 * change the strategy: no signal is regenerated, no entry re-chosen, no stop or
 * target recomputed. Every trade's entry, stop and target ladder are read from
 * the saved artifacts; only what happens to the position AFTER entry is
 * re-simulated, from the candle cache.
 *
 * Models, intrabar rules (R1-R7) and the leg-based fee model are specified in
 * docs/V2_1_H1_PREREGISTRATION.md, committed BEFORE any comparative result.
 *
 * Model A is validated against the stored `rMultiple` before B/C/D are trusted.
 */

import type { Candle, Timeframe } from '../../src/core/types';

export type ModelId = 'A' | 'B' | 'C' | 'D';

export interface TradeSpec {
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;
  takeProfits: readonly number[]; // engine order; we re-sort by distance
  timeoutBars: number;
}

export interface LegFill {
  /** fraction of the original position closed at this leg */
  weight: number;
  price: number;
}

export interface ModelOutcome {
  /** gross R, fees excluded, weighted across legs */
  grossR: number;
  /** 'TP' | 'SL' | 'TIMEOUT' | 'TP1' | 'PARTIAL_SL' | 'PARTIAL_TIMEOUT' | 'BE' */
  result: string;
  barsHeld: number;
  reachedTp1: boolean;
  tp1Bar: number | null;
  /** exit legs, for the leg-based fee model (entry leg added separately) */
  legs: LegFill[];
}

const EPS = 0;

/** Signed favourable move in R. */
const rOf = (t: TradeSpec, price: number, risk: number): number =>
  (t.direction === 'LONG' ? price - t.entryPrice : t.entryPrice - price) / risk;

/**
 * Simulate one trade under one model.
 *
 * `bars` must start at the entry candle (openTime >= entryCandleTime), in
 * chronological order. Intrabar ordering follows R1-R7 of the pre-registration.
 */
export function simulate(
  t: TradeSpec, bars: readonly Candle[], model: ModelId,
): ModelOutcome | null {
  const risk = Math.abs(t.entryPrice - t.stopLoss);
  if (!(risk > 0) || bars.length === 0) return null;

  const long = t.direction === 'LONG';
  // TP1 = NEAREST rung, final = FURTHEST. trackOutcome sorts the same way.
  const tps = [...t.takeProfits]
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => Math.abs(a - t.entryPrice) - Math.abs(b - t.entryPrice));
  if (tps.length === 0) return null;
  const t1 = tps[0]!;
  const finalTp = tps[tps.length - 1]!;
  const singleRung = tps.length === 1;

  const hitSl = (c: Candle, stop: number): boolean =>
    long ? c.low <= stop + EPS : c.high >= stop - EPS;
  const hitUp = (c: Candle, p: number): boolean =>
    long ? c.high >= p - EPS : c.low <= p + EPS;

  let reachedTp1 = false;
  let tp1Bar: number | null = null;
  let partialBooked = false; // C/D: the 50% at TP1
  const legs: LegFill[] = [];

  const fin = (
    result: string, idx: number,
  ): ModelOutcome => ({
    grossR: legs.reduce((s, l) => s + l.weight * rOf(t, l.price, risk), 0),
    result, barsHeld: idx + 1, reachedTp1, tp1Bar, legs,
  });

  for (let i = 0; i < bars.length; i++) {
    const c = bars[i]!;
    const beArmed = (model === 'D') && partialBooked
      && tp1Bar !== null && i > tp1Bar; // R5: strictly after the TP1 bar

    const slLevel = beArmed ? t.entryPrice : t.stopLoss;
    const slNow = hitSl(c, slLevel);
    const tp1Now = !reachedTp1 && hitUp(c, t1);
    const finalNow = hitUp(c, finalTp);

    /* ---------- pre-TP1 phase ---------- */
    if (!reachedTp1) {
      // R1: SL wins against TP1 on the same bar (frozen conservative policy).
      if (slNow) { legs.push({ weight: 1, price: t.stopLoss }); return fin('SL', i); }

      if (tp1Now) {
        reachedTp1 = true; tp1Bar = i;

        if (singleRung) {
          // TP1 IS the final rung: every model behaves like A.
          legs.push({ weight: 1, price: t1 });
          return fin('TP', i);
        }
        if (model === 'B') {
          legs.push({ weight: 1, price: t1 });
          return fin('TP1', i);
        }
        if (model === 'C' || model === 'D') {
          legs.push({ weight: 0.5, price: t1 });
          partialBooked = true;
          // R3: TP1 booked first, then the final rung may close the rest
          // on this same bar.
          if (finalNow) { legs.push({ weight: 0.5, price: finalTp }); return fin('TP', i); }
          // IMPORTANT: do NOT `continue` here. The frozen tracker treats a TP1
          // touch as a non-event and still evaluates TIMEOUT on the same bar.
          // Skipping that check shifted TIMEOUT one bar late and broke the
          // Model A fidelity test.
          if (i + 1 >= t.timeoutBars) {
            legs.push({ weight: 0.5, price: c.close });
            return fin('PARTIAL_TIMEOUT', i);
          }
          continue;
        }
        // Model A: TP1 is only a milestone, keep running.
        if (finalNow) { legs.push({ weight: 1, price: finalTp }); return fin('TP', i); }
        if (i + 1 >= t.timeoutBars) {
          legs.push({ weight: 1, price: c.close }); return fin('TIMEOUT', i);
        }
        continue;
      }

      // R2: SL vs final rung already handled above (SL wins).
      if (finalNow) {
        // Reached the final rung without TP1 registering first: possible only
        // when one bar spans both, and R3 says the nearer rung is traversed
        // first, so mark TP1 as reached on this bar too.
        reachedTp1 = true; tp1Bar = i;
        if (model === 'B') { legs.push({ weight: 1, price: t1 }); return fin('TP1', i); }
        if (model === 'C' || model === 'D') {
          legs.push({ weight: 0.5, price: t1 });
          legs.push({ weight: 0.5, price: finalTp });
          return fin('TP', i);
        }
        legs.push({ weight: 1, price: finalTp });
        return fin('TP', i);
      }

      if (i + 1 >= t.timeoutBars) {
        legs.push({ weight: 1, price: c.close }); return fin('TIMEOUT', i);
      }
      continue;
    }

    /* ---------- post-TP1 phase (C and D only; A handled above) ---------- */
    // Model A after TP1 behaves identically to before: only final/SL/TIMEOUT.
    if (model === 'A') {
      if (slNow) { legs.push({ weight: 1, price: t.stopLoss }); return fin('SL', i); }
      if (finalNow) { legs.push({ weight: 1, price: finalTp }); return fin('TP', i); }
      if (i + 1 >= t.timeoutBars) {
        legs.push({ weight: 1, price: c.close }); return fin('TIMEOUT', i);
      }
      continue;
    }

    // C: original stop retained on the remainder.
    // D: breakeven stop, armed only from the bar after TP1 (R5).
    if (slNow) {
      // R4: in D, breakeven wins against the final rung on the same bar.
      legs.push({ weight: 0.5, price: slLevel });
      return fin(beArmed ? 'BE' : 'PARTIAL_SL', i);
    }
    if (finalNow) { legs.push({ weight: 0.5, price: finalTp }); return fin('TP', i); }
    if (i + 1 >= t.timeoutBars) {
      legs.push({ weight: 0.5, price: c.close }); return fin('PARTIAL_TIMEOUT', i);
    }
  }

  return null; // unresolved at dataset boundary (R7)
}

/**
 * Leg-based transaction cost in R.
 *
 * `bps` is the ROUND-TRIP-EQUIVALENT; per side c = bps/2, charged on each leg's
 * own notional and divided by the R unit. The entry leg is always weight 1.
 */
export function feeRFor(
  t: TradeSpec, o: ModelOutcome, bps: number,
): number {
  const risk = Math.abs(t.entryPrice - t.stopLoss);
  if (!(risk > 0)) return 0;
  const perSide = bps / 2 / 10000;
  let notional = t.entryPrice * 1; // entry leg
  for (const l of o.legs) notional += l.price * l.weight;
  return (perSide * notional) / risk;
}

export interface SeriesKey { symbol: string; timeframe: Timeframe }

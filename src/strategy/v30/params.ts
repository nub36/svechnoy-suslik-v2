/**
 * V3.0 HTF LIQUIDATION TRAP — parameters.
 *
 * The strategy that PASSED the pre-registered VALIDATION run
 * (docs/V3_0_VALIDATION_RESULTS.md, artifact `v30-validation-metrics.json`)
 * is the one implemented here. Its constants were frozen before that run and
 * are reproduced as the DEFAULTS below, so a fresh install trades exactly the
 * validated configuration.
 *
 * ⚠️ THE FREEZE EXISTS FOR A REASON. Both the TRAIN and the VALIDATION window
 * have been spent on this exact parameter set. Any change here — or in the
 * admin panel — produces a strategy that has never been tested, and the
 * documented results no longer apply to it. `src/strategy/v30` is a faithful
 * port of `research/v30_htf_trap.ts`; `tests/v30-port-parity.test.ts` and the
 * real-data parity harness enforce that the two agree.
 *
 * SCOPE OF THE PORT: research/v30_htf_trap.ts is NOT modified. The validated
 * artifact stays attached to that file's hash.
 */

import type { Settings } from '../../core/settings';
import type { Timeframe } from '../../core/types';

/** Timeframes the frozen candidate can be configured with. */
export const V30_LTF_OPTIONS: readonly Timeframe[] = ['15m', '30m', '1h'];
export const V30_HTF_OPTIONS: readonly Timeframe[] = ['1h', '4h', '1d'];

/**
 * Breakeven trigger values. Only `tp1` is validated: the frozen candidate moves
 * the stop on the remaining half to the entry price on bars STRICTLY AFTER the
 * TP1 bar (intrabar rule R3). `never` disables it and is an untested variant.
 */
export const V30_BREAKEVEN_OPTIONS = ['tp1', 'never'] as const;
export type V30BreakevenTrigger = (typeof V30_BREAKEVEN_OPTIONS)[number];

/**
 * Ids of the strategies the site can actually RUN. V1_SMC is the original
 * Smart Money engine; V3_0 is this strategy.
 *
 * The V2.x research candidates are deliberately absent: the validated results
 * in docs/strategies/* were produced by standalone harnesses
 * (scripts/real-data/, research/) that were never ported into the production
 * pipeline. Offering them in the selector would let an operator pick a strategy
 * that emits nothing, so they are documented as research-only instead.
 */
export const ACTIVE_STRATEGIES = ['V3_0', 'V1_SMC'] as const;
export type ActiveStrategy = (typeof ACTIVE_STRATEGIES)[number];

/** Frozen config of the validated candidate. */
export interface V30Params {
  // ---- entry ----
  bodyRatioMin: number;
  rvolMin: number;
  corridorAtr: number;
  corridorExpiryBars: number;
  // ---- exit ----
  slBufferAtr: number;
  tp1Equilibrium: number;
  breakevenTrigger: V30BreakevenTrigger;
  timeoutBars: number;
  positionSplitTp1: number;
  // ---- fees (charged per leg, on that leg's own notional) ----
  makerBps: number;
  takerBps: number;
  // ---- scope ----
  htfTimeframe: Timeframe;
  ltfTimeframe: Timeframe;
  symbols: readonly string[];
}

/**
 * The validated values. Kept as a literal so the parity test can assert that
 * the settings registry defaults and the frozen research constants agree.
 */
export const V30_FROZEN: V30Params = {
  bodyRatioMin: 0.35,
  rvolMin: 1.25,
  corridorAtr: 0.1,
  corridorExpiryBars: 3,
  slBufferAtr: 0.15,
  tp1Equilibrium: 0.5,
  breakevenTrigger: 'tp1',
  timeoutBars: 50,
  positionSplitTp1: 0.5,
  makerBps: 2,
  takerBps: 5,
  htfTimeframe: '4h',
  ltfTimeframe: '1h',
  symbols: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'],
};

/**
 * Read the live configuration. Every value comes from the settings registry, so
 * the admin panel is the single source of truth; anything absent or unusable
 * falls back to the frozen default rather than to zero.
 */
export function v30Params(settings: Settings): V30Params {
  const num = (key: string, fallback: number): number => {
    const v = settings.num(key);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const tf = (key: string, allowed: readonly Timeframe[], fallback: Timeframe): Timeframe => {
    const v = settings.str(key) as Timeframe;
    return allowed.includes(v) ? v : fallback;
  };
  const breakeven = settings.str('v30.breakevenTrigger');
  const symbols = settings
    .arr<string>('v30.symbols')
    .map((s) => String(s).toUpperCase())
    .filter((s) => /^[A-Z0-9]{2,20}USDT$/.test(s));

  return {
    bodyRatioMin: num('v30.bodyRatioMin', V30_FROZEN.bodyRatioMin),
    rvolMin: num('v30.rvolMin', V30_FROZEN.rvolMin),
    corridorAtr: num('v30.corridorATR', V30_FROZEN.corridorAtr),
    // Not exposed in the admin panel: part of the frozen tested configuration.
    corridorExpiryBars: V30_FROZEN.corridorExpiryBars,
    slBufferAtr: num('v30.slBufferATR', V30_FROZEN.slBufferAtr),
    tp1Equilibrium: num('v30.tp1Equilibrium', V30_FROZEN.tp1Equilibrium),
    breakevenTrigger: (V30_BREAKEVEN_OPTIONS as readonly string[]).includes(breakeven)
      ? (breakeven as V30BreakevenTrigger)
      : V30_FROZEN.breakevenTrigger,
    timeoutBars: Math.floor(num('v30.timeoutBars', V30_FROZEN.timeoutBars)),
    positionSplitTp1: num('v30.positionSplitTP1', V30_FROZEN.positionSplitTp1),
    makerBps: settings.num('v30.makerBps'),
    takerBps: settings.num('v30.takerBps'),
    htfTimeframe: tf('v30.htfTimeframe', V30_HTF_OPTIONS, V30_FROZEN.htfTimeframe),
    ltfTimeframe: tf('v30.ltfTimeframe', V30_LTF_OPTIONS, V30_FROZEN.ltfTimeframe),
    symbols: symbols.length > 0 ? symbols : V30_FROZEN.symbols,
  };
}

/** True when the frozen configuration is in force (used by the admin banner). */
export function isFrozenConfiguration(p: V30Params): boolean {
  return (
    p.bodyRatioMin === V30_FROZEN.bodyRatioMin &&
    p.rvolMin === V30_FROZEN.rvolMin &&
    p.corridorAtr === V30_FROZEN.corridorAtr &&
    p.slBufferAtr === V30_FROZEN.slBufferAtr &&
    p.tp1Equilibrium === V30_FROZEN.tp1Equilibrium &&
    p.breakevenTrigger === V30_FROZEN.breakevenTrigger &&
    p.timeoutBars === V30_FROZEN.timeoutBars &&
    p.positionSplitTp1 === V30_FROZEN.positionSplitTp1 &&
    p.htfTimeframe === V30_FROZEN.htfTimeframe &&
    p.ltfTimeframe === V30_FROZEN.ltfTimeframe
  );
}

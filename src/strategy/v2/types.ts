/**
 * SMC V2 — type vocabulary.
 *
 * Design rule that governs this whole module: every value carries the index at
 * which it became KNOWN, never merely the index where it happened. A pivot that
 * occurred at bar 40 but needs 3 confirming bars is not usable until bar 43.
 * Anything that ignores this distinction is look-ahead bias.
 */

import type { Candle, Direction, Timeframe } from '../../core/types';

/* ------------------------------------------------------------------ */
/* Structure                                                           */
/* ------------------------------------------------------------------ */

export type SwingKind = 'HIGH' | 'LOW';

export interface V2Swing {
  kind: SwingKind;
  /** Index of the pivot bar itself. */
  index: number;
  /** Index at which the pivot became confirmed = index + strength. */
  confirmedIndex: number;
  time: number;
  price: number;
  /** Structural label relative to the previous same-kind swing. */
  label: 'HH' | 'LH' | 'HL' | 'LL' | 'FIRST';
}

export type StructureBias = 'BULLISH' | 'BEARISH' | 'RANGE';

/** A break of an existing structural level. */
export interface StructureBreak {
  type: 'BOS' | 'CHOCH';
  direction: Direction;
  /** Index of the bar whose CLOSE broke the level. */
  index: number;
  time: number;
  /** The swing price that was broken. */
  level: number;
  /** Index of the swing that was broken. */
  levelIndex: number;
  /** Close beyond the level, in ATR units. Always > 0 for a valid break. */
  penetrationAtr: number;
  /** Wick-only excursion beyond the level, in ATR units. */
  wickPenetrationAtr: number;
  /** True when only the wick crossed — NOT a valid break. */
  wickOnly: boolean;
  reason: string;
}

/* ------------------------------------------------------------------ */
/* Range                                                               */
/* ------------------------------------------------------------------ */

export interface V2Range {
  high: number;
  low: number;
  mid: number;
  size: number;
  /** Bars since the range was established. */
  age: number;
  /** Index at which this range became known. */
  knownAtIndex: number;
  highIndex: number;
  lowIndex: number;
  /** Times price interacted with the boundaries. */
  touchCountHigh: number;
  touchCountLow: number;
  /** 0 = at low, 1 = at high. */
  position: number;
  /** 0..1 — how well-formed the range is. */
  confidence: number;
  sourceTimeframe: Timeframe;
  /**
   * Has price ACCEPTED (closed decisively) beyond one of the boundaries? A
   * range whose edge has been broken is stale on that side: the broken edge is
   * no longer resistance/support and the OPPOSITE edge is no longer a valid
   * structural target for a continuation trade.
   *
   *   null   - range intact, both edges usable
   *   'HIGH' - accepted above the high; the LOW is a stale target
   *   'LOW'  - accepted below the low;  the HIGH is a stale target
   */
  brokenSide: 'HIGH' | 'LOW' | null;
  /** Index of the bar whose close broke the range, when `brokenSide` is set. */
  brokenAtIndex: number | null;
}

export type RangeLocation = 'HIGH' | 'LOW' | 'MID';

/** Fibonacci map of the active range. */
export interface FibMap {
  /** Anchors. `low` = 0%, `high` = 100% for a bullish leg. */
  level0: number;
  level236: number;
  level382: number;
  level500: number;
  level618: number;
  level786: number;
  level1000: number;
  /** Where the current close sits, as a fraction of the range. */
  pricePosition: number;
  zone: 'DISCOUNT' | 'EQUILIBRIUM' | 'PREMIUM';
}

/* ------------------------------------------------------------------ */
/* Liquidity                                                           */
/* ------------------------------------------------------------------ */

export type LiquiditySide = 'BUY_SIDE' | 'SELL_SIDE';

/**
 * LIQUIDITY LIFECYCLE.
 *
 * A pool is resting orders sitting at a level. Once price has actually reached
 * that level the orders are gone, so the pool must stop being offered as a
 * FUTURE destination. The four states are ordered by severity and are computed
 * strictly from bars at or before the evaluation index:
 *
 *   FRESH     price has never traded to the level since the pool was confirmed.
 *             Untouched resting liquidity — a valid future target.
 *
 *   TOUCHED   price reached the level but only grazed it: penetration stayed
 *             below the sweep threshold and no bar closed beyond it. A touch
 *             alone does NOT destroy a level; it stays a valid target.
 *
 *   SWEPT     price pierced the level by at least the sweep penetration
 *             threshold WITHOUT accepting beyond it (a wick raid, typically
 *             reclaimed). The resting orders were taken. It is no longer
 *             untouched resting liquidity and must not be a future target.
 *
 *   CONSUMED  price CLOSED beyond the level by at least the acceptance
 *             threshold — full acceptance through the level. The pool is gone
 *             and must not be a future target.
 *
 * SWEPT and CONSUMED are both terminal for targeting purposes; they are kept
 * distinct because a sweep (rejection) and an acceptance (continuation) mean
 * opposite things structurally.
 */
export type LiquidityState = 'FRESH' | 'TOUCHED' | 'SWEPT' | 'CONSUMED';

export interface LiquidityPool {
  side: LiquiditySide;
  price: number;
  /** Index at which the pool became known. */
  knownAtIndex: number;
  /** Bars that make up the pool (equal highs/lows cluster). */
  memberIndexes: number[];
  /** How many touches formed it — more touches = more resting orders. */
  touches: number;
  /** 0..1 strength: touches, tightness and age. */
  strength: number;
  kind: 'SWING' | 'EQUAL' | 'CLUSTER';
  /**
   * Stable identity of the structural AREA this pool occupies. Every swing
   * clustered into this pool shares it. Two targets carrying the same
   * `clusterId` are the same area and must never occupy two TP slots.
   */
  clusterId: string;
  /** Lifecycle state as known at the evaluation index — never later. */
  state: LiquidityState;
  /**
   * Index of the bar that moved the pool into its current state, or null while
   * it is still FRESH. Always <= the evaluation index.
   */
  stateAtIndex: number | null;
  /**
   * True while the pool is still untaken resting liquidity (FRESH or TOUCHED)
   * and may therefore be used as a future target. False once SWEPT/CONSUMED.
   */
  resting: boolean;
  /** Human-readable explanation of the lifecycle verdict. */
  stateReason: string;
}

export interface SweepEvent {
  side: LiquiditySide;
  /** Reversal direction implied by the sweep. */
  direction: Direction;
  index: number;
  time: number;
  /** The pool level that was taken. */
  level: number;
  /** Max excursion beyond the level, in ATR units. */
  penetrationAtr: number;
  /** Rejection wick beyond the level / full candle range, 0..1. */
  wickRatio: number;
  /** Body size / full range of the sweeping candle, 0..1. */
  bodyRatio: number;
  /** Did the candle close back on the correct side of the level? */
  reclaimed: boolean;
  /** Bars taken to reclaim (0 = same candle). null = not reclaimed. */
  reclaimBars: number | null;
  /** Relative volume of the sweep candle. */
  rvol: number;
  /** Bars between pool creation and the sweep. */
  ageBars: number;
  /** Strength of the level that was swept, 0..1. */
  levelStrength: number;
  /** Composite 0..1. */
  quality: number;
  reason: string;
}

export interface BreakoutEvent {
  direction: Direction;
  index: number;
  time: number;
  level: number;
  /** Close beyond the level in ATR units. */
  closeBeyondAtr: number;
  /** Body / ATR of the breaking candle. */
  displacementAtr: number;
  bodyRatio: number;
  rvol: number;
  /** Did price hold beyond the level on subsequent KNOWN bars? */
  held: boolean;
  holdBars: number;
  /** Was there an immediate strong reclaim back inside? */
  immediateReclaim: boolean;
  /** Composite 0..1. */
  quality: number;
  reason: string;
}

/* ------------------------------------------------------------------ */
/* Displacement, OB, FVG                                               */
/* ------------------------------------------------------------------ */

export interface Displacement {
  direction: Direction;
  index: number;
  time: number;
  /** Candle body in ATR units. */
  bodyAtr: number;
  /** Body / full range, 0..1. */
  bodyRatio: number;
  /** Close position within the bar range, 0..1 (1 = closed at the high). */
  closeLocation: number;
  /** Consecutive same-direction bars ending here. */
  consecutive: number;
  rvol: number;
  /** Composite 0..1. */
  strength: number;
}

export type ObState = 'FRESH' | 'TOUCHED' | 'MITIGATED' | 'INVALIDATED';

export interface OrderBlock {
  direction: Direction;
  high: number;
  low: number;
  /** Index of the origin candle (the one before the displacement). */
  index: number;
  time: number;
  /** Index at which the OB became known (the displacement bar). */
  knownAtIndex: number;
  state: ObState;
  /** Index where the state last changed. */
  stateIndex: number;
  /** Strength of the displacement that created it. */
  displacementStrength: number;
  /** The structural event that justifies this OB. */
  origin: 'BOS' | 'CHOCH' | 'SWEEP_REACTION';
  timeframe: Timeframe;
}

export type FvgState = 'FRESH' | 'PARTIAL' | 'FILLED';

export interface FairValueGap {
  direction: Direction;
  /** Gap boundaries. */
  top: number;
  bottom: number;
  size: number;
  sizeAtr: number;
  /** Index of the middle candle of the 3-bar pattern. */
  index: number;
  time: number;
  knownAtIndex: number;
  state: FvgState;
  /** Fraction of the gap that has been filled, 0..1. */
  filledFraction: number;
  timeframe: Timeframe;
}

/* ------------------------------------------------------------------ */
/* Indicators                                                          */
/* ------------------------------------------------------------------ */

export interface EmaContext {
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  priceAbove20: boolean;
  priceAbove50: boolean;
  priceAbove200: boolean;
  /** ema20 > ema50 */
  fastAboveSlow: boolean;
  /** ema50 > ema200 */
  slowAboveAnchor: boolean;
  /** Per-bar slope of EMA20, normalised by ATR. */
  slope20Atr: number | null;
  /** |ema20 - ema50| / ATR — expansion vs compression. */
  spreadAtr: number | null;
  alignment: StructureBias;
}

export interface MacdContext {
  macd: number | null;
  signal: number | null;
  histogram: number | null;
  /** histogram[i] - histogram[i-1] */
  histogramSlope: number | null;
  crossUp: boolean;
  crossDown: boolean;
  aboveZero: boolean;
  /** Histogram magnitude growing = acceleration. */
  accelerating: boolean;
}

export interface RsiContext {
  rsi: number | null;
  slope: number | null;
  overbought: boolean;
  oversold: boolean;
  above50: boolean;
  crossedUp50: boolean;
  crossedDown50: boolean;
  bullishDivergence: boolean;
  bearishDivergence: boolean;
}

export type VolatilityRegime = 'LOW' | 'NORMAL' | 'HIGH';

export interface AtrContext {
  atr: number | null;
  /** ATR / close, as a percentage. */
  atrPct: number | null;
  /** Current ATR / median ATR over the window. */
  atrRatio: number | null;
  regime: VolatilityRegime;
}

export type AdxRegime = 'RANGE' | 'DEVELOPING' | 'STRONG';

export interface AdxContext {
  adx: number | null;
  plusDi: number | null;
  minusDi: number | null;
  regime: AdxRegime;
  /** +DI > -DI */
  bullishPressure: boolean;
}

export interface VolumeContext {
  volume: number;
  avgVolume: number | null;
  medianVolume: number | null;
  /** volume / avgVolume */
  rvol: number | null;
  spike: boolean;
}

/* ------------------------------------------------------------------ */
/* HTF context                                                         */
/* ------------------------------------------------------------------ */

export interface HtfContext {
  timeframe: Timeframe;
  bias: StructureBias;
  /** Close time of the last HTF candle that had actually CLOSED. */
  asOfTime: number;
  /** Number of closed HTF candles used. */
  bars: number;
  available: boolean;
}

export type HtfAlignment = 'ALIGNED' | 'COUNTER_TREND' | 'NEUTRAL' | 'UNKNOWN';

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

export type SetupKind = 'REVERSAL' | 'CONTINUATION';

export type SetupPhase =
  | 'SCANNING'
  | 'APPROACHING_LEVEL'
  | 'AT_LIQUIDITY'
  | 'SWEEP_DETECTED'
  | 'BREAKOUT_DETECTED'
  | 'STRUCTURE_CONFIRMATION'
  | 'READY'
  | 'INVALIDATED';

export type V2Direction = Direction | 'WAIT';

/** The component profile. Each is evidence in [0,1], per side. */
export interface ComponentProfile {
  structure: number;
  liquidity: number;
  displacement: number;
  obFvg: number;
  volume: number;
  htf: number;
  trend: number;
  momentum: number;
  volatility: number;
  roomToTarget: number;
}

export const COMPONENT_KEYS: readonly (keyof ComponentProfile)[] = [
  'structure', 'liquidity', 'displacement', 'obFvg', 'volume',
  'htf', 'trend', 'momentum', 'volatility', 'roomToTarget',
];

export function emptyProfile(): ComponentProfile {
  return {
    structure: 0, liquidity: 0, displacement: 0, obFvg: 0, volume: 0,
    htf: 0, trend: 0, momentum: 0, volatility: 0, roomToTarget: 0,
  };
}

/** Structural stop with a recorded justification. */
export interface StructuralStop {
  price: number;
  /** Why this level: what invalidates the idea. */
  reason: string;
  /** Buffer applied, in ATR units. */
  bufferAtr: number;
  anchor: 'SWEEP_EXTREME' | 'SWING' | 'RANGE_EDGE' | 'BREAKOUT_LEVEL';
}

export interface TargetPlan {
  price: number;
  /**
   * What market feature this target corresponds to.
   *
   * NOTE: there is deliberately no `EXTERNAL_LIQUIDITY` member. It existed in
   * this union but was never emitted anywhere in `src/`, and a dead variant
   * invites callers to switch on a case that cannot occur. External liquidity
   * (the far side of the range) is already expressed as `RANGE_EDGE`. If a
   * genuinely separate external-liquidity source is ever introduced, add the
   * member together with the code that emits it — not before.
   */
  basis: 'INTERNAL_LIQUIDITY' | 'EQUILIBRIUM' | 'RANGE_EDGE' | 'R_MULTIPLE';
  reason: string;
  /**
   * Structural AREA identity, used for target de-duplication. Liquidity-derived
   * targets inherit the `clusterId` of the pool they came from, so two rungs
   * from one liquidity cluster are recognised as one area regardless of their
   * exact prices. Non-liquidity rungs get a synthetic id.
   */
  clusterId: string;
  /** R multiple this target represents, given entry and stop. */
  r: number;
  /**
   * Directional distance from entry to this target, in ATR units. Always
   * measured along the trade direction, never as an absolute price.
   */
  atrDistance: number;
}

export interface RoomToTarget {
  /** Distance from entry to the final target, in R. */
  finalR: number;
  /** Distance to the nearest (first) target, in R. */
  firstR: number;
  /**
   * Distance to the NEXT structural target after TP1, in R. Equals `finalR`
   * when the ladder only has two rungs, and `firstR` when it has one.
   */
  nextStructuralR: number;
  /**
   * Directional distance from entry to the FINAL target in ATR units:
   *   LONG  (targetPrice - entryPrice) / ATR
   *   SHORT (entryPrice - targetPrice) / ATR
   * This is a real distance — never `abs(price) / ATR`.
   */
  atrDistance: number;
  /** Directional distance from entry to the FIRST target, in ATR units. */
  firstAtrDistance: number;
  /** Is there enough room for the trade to be worth taking? */
  adequate: boolean;
  reason: string;
}

/** A fully-described V2 evaluation at one closed bar. */
export interface V2Setup {
  symbol: string;
  timeframe: Timeframe;
  index: number;
  time: number;
  close: number;

  direction: V2Direction;
  kind: SetupKind | null;
  phase: SetupPhase;
  location: RangeLocation;

  range: V2Range | null;
  fib: FibMap | null;
  bias: StructureBias;

  sweep: SweepEvent | null;
  breakout: BreakoutEvent | null;
  structureBreak: StructureBreak | null;
  displacement: Displacement | null;
  orderBlock: OrderBlock | null;
  fvg: FairValueGap | null;

  ema: EmaContext;
  macd: MacdContext;
  rsi: RsiContext;
  atr: AtrContext;
  adx: AdxContext;
  vol: VolumeContext;

  htf: HtfContext[];
  htfAlignment: HtfAlignment;

  /** Evidence per side, and the conflict between them. */
  longProfile: ComponentProfile;
  shortProfile: ComponentProfile;
  longEvidence: number;
  shortEvidence: number;
  conflict: number;
  netEvidence: number;

  entry: number | null;
  stop: StructuralStop | null;
  targets: TargetPlan[];
  room: RoomToTarget | null;

  /** Plain-language reasons, always populated — especially for WAIT. */
  reasons: string[];
  waitReasons: string[];
}

export interface V2EvaluateArgs {
  symbol: string;
  timeframe: Timeframe;
  candles: readonly Candle[];
  atIndex?: number;
  settings: import('../../core/settings').Settings;
  /**
   * Higher timeframe candle series, keyed by timeframe. Only bars that had
   * CLOSED at or before the evaluated bar's close time are consulted.
   */
  htfCandles?: Partial<Record<Timeframe, readonly Candle[]>>;
}

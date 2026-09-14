/**
 * Core domain types.
 *
 * Architecture constraints enforced here:
 *  - Binance Spot USDT only (no multi-exchange, no quorum, no voting, no minExchanges)
 *  - Single Smart Money engine (no V1/V2)
 *  - Signals are produced from CLOSED candles only
 *  - Entry = OPEN of candle N+1
 */

export const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export function isTimeframe(v: string): v is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(v);
}

/** Timeframe duration in milliseconds. Used for closed-candle math and N+1 entry timing. */
export const TF_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

export function tfMs(tf: Timeframe): number {
  return TF_MS[tf];
}

/**
 * A candle. `openTime` is the inclusive start, `closeTime` the exclusive-ish end
 * as reported by Binance (openTime + tfMs - 1).
 *
 * `isClosed` is authoritative: the engine must never evaluate a candle with
 * isClosed === false.
 */
export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
  isClosed: boolean;
}

export type Direction = 'LONG' | 'SHORT';

/**
 * SIGNAL lifecycle — the life of ONE trade record, persisted in `signals.state`.
 *
 * WAITING_ENTRY -> OPEN -> TP1_HIT -> TP2_HIT -> TP3_HIT
 *                    \        \         \
 *                     +--------+---------+--> STOPPED
 *                     +-------------------------> EXPIRED
 *
 * TP milestones are PROGRESSIVE, not terminal: a trade that reaches TP1 and is
 * later stopped ends in STOPPED while `tp1_hit_at` stays populated forever.
 * Only TP3_HIT, STOPPED and EXPIRED are terminal.
 *
 * This is deliberately SEPARATE from StrategyState (below). A signal is a
 * trade; a strategy state is the per-slot detector memory. Conflating the two
 * is what previously allowed a bootstrap observation to emit a signal.
 */
export type SignalState =
  | 'WAITING_ENTRY'
  | 'OPEN'
  | 'TP1_HIT'
  | 'TP2_HIT'
  | 'TP3_HIT'
  | 'STOPPED'
  | 'EXPIRED';

export const SIGNAL_STATES: readonly SignalState[] = [
  'WAITING_ENTRY',
  'OPEN',
  'TP1_HIT',
  'TP2_HIT',
  'TP3_HIT',
  'STOPPED',
  'EXPIRED',
];

/** Terminal signal states — no further milestone may be recorded. */
export const TERMINAL_STATES: readonly SignalState[] = ['TP3_HIT', 'STOPPED', 'EXPIRED'];

export function isTerminal(s: SignalState): boolean {
  return TERMINAL_STATES.includes(s);
}

/** States in which a signal still occupies a concurrency slot. */
export const LIVE_SIGNAL_STATES: readonly SignalState[] = [
  'WAITING_ENTRY',
  'OPEN',
  'TP1_HIT',
  'TP2_HIT',
];

/** Signal states in which the position is actually filled and running. */
export const IN_POSITION_STATES: readonly SignalState[] = [
  'OPEN',
  'TP1_HIT',
  'TP2_HIT',
];

/** How far the trade progressed through its take-profit ladder. 0 = none. */
export function tpMilestoneLevel(s: SignalState): 0 | 1 | 2 | 3 {
  if (s === 'TP1_HIT') return 1;
  if (s === 'TP2_HIT') return 2;
  if (s === 'TP3_HIT') return 3;
  return 0;
}

/**
 * STRATEGY state — persistent per (strategy, symbol, timeframe) detector memory.
 *
 * NEUTRAL     — baseline: the condition is NOT currently satisfied.
 * EDGE_LONG   — the transition NEUTRAL/REARM -> long condition just fired.
 * EDGE_SHORT  — same for the short side.
 * HOLD_LONG   — the long condition persists; must NOT emit again.
 * HOLD_SHORT  — same for the short side.
 * REARM       — the condition dropped away and the slot is waiting to return
 *               to NEUTRAL; guarantees a passing condition must first FALL
 *               before it can produce another edge.
 *
 * UNINITIALISED is NOT a stored state: absence of a row means "never seen".
 * The first observation of an unseen slot only establishes the baseline.
 */
export type StrategyState =
  | 'NEUTRAL'
  | 'EDGE_LONG'
  | 'EDGE_SHORT'
  | 'HOLD_LONG'
  | 'HOLD_SHORT'
  | 'REARM';

export const STRATEGY_STATES: readonly StrategyState[] = [
  'NEUTRAL',
  'EDGE_LONG',
  'EDGE_SHORT',
  'HOLD_LONG',
  'HOLD_SHORT',
  'REARM',
];

export function isEdgeState(s: StrategyState): boolean {
  return s === 'EDGE_LONG' || s === 'EDGE_SHORT';
}

export function holdFor(d: Direction): StrategyState {
  return d === 'LONG' ? 'HOLD_LONG' : 'HOLD_SHORT';
}

export function edgeFor(d: Direction): StrategyState {
  return d === 'LONG' ? 'EDGE_LONG' : 'EDGE_SHORT';
}

export function directionOfStrategyState(s: StrategyState): Direction | null {
  if (s === 'EDGE_LONG' || s === 'HOLD_LONG') return 'LONG';
  if (s === 'EDGE_SHORT' || s === 'HOLD_SHORT') return 'SHORT';
  return null;
}

/** Trading mode. LIVE is intentionally NOT part of the union — it is locked. */
export type TradingMode = 'DRY_RUN' | 'FORWARD_TEST';
export const TRADING_MODES: readonly TradingMode[] = ['DRY_RUN', 'FORWARD_TEST'];

/**
 * LIVE is deliberately represented separately and is always rejected.
 * See src/core/mode.ts
 */
export const LOCKED_MODE = 'LIVE' as const;

/**
 * Smart Money FACTOR identifiers — the single engine's factor set.
 *
 * The model has three kinds of factor:
 *
 *  INDEPENDENT — stand-alone evidence, each contributes its own weight:
 *      BOS, ORDER_BLOCK, FVG, LIQUIDITY_SWEEP, RANGE_POSITION
 *  CONTEXT     — describes the prevailing internal structure and only
 *      participates through its configured context weight:
 *      INTERNAL_STRUCTURE
 *  DERIVED     — computed FROM other factors; carries only its own small
 *      bonus weight and never re-adds its parents' weight:
 *      OB_FVG_CONFLUENCE
 *
 * Factors deliberately NOT in this model (removed by specification):
 * change-of-character, equal-highs/lows, volume-imbalance, and
 * premium/discount as a factor name. The dealing-range logic that used to be
 * called premium/discount now lives in RANGE_POSITION.
 */
export type FactorId =
  | 'BOS'
  | 'ORDER_BLOCK'
  | 'FVG'
  | 'LIQUIDITY_SWEEP'
  | 'RANGE_POSITION'
  | 'INTERNAL_STRUCTURE'
  | 'OB_FVG_CONFLUENCE';

export type FactorKind = 'INDEPENDENT' | 'CONTEXT' | 'DERIVED';

/** Independent factors: stand-alone evidence. */
export const INDEPENDENT_FACTORS = [
  'BOS',
  'ORDER_BLOCK',
  'FVG',
  'LIQUIDITY_SWEEP',
  'RANGE_POSITION',
] as const satisfies readonly FactorId[];

/** Context factors: internal structure bias. */
export const CONTEXT_FACTORS = ['INTERNAL_STRUCTURE'] as const satisfies readonly FactorId[];

/** Derived factors: computed from other factors, bonus weight only. */
export const DERIVED_FACTORS = ['OB_FVG_CONFLUENCE'] as const satisfies readonly FactorId[];

/** Every factor, in canonical display order. */
export const FACTOR_IDS: readonly FactorId[] = [
  ...INDEPENDENT_FACTORS,
  ...CONTEXT_FACTORS,
  ...DERIVED_FACTORS,
];

export const FACTOR_KIND: Readonly<Record<FactorId, FactorKind>> = {
  BOS: 'INDEPENDENT',
  ORDER_BLOCK: 'INDEPENDENT',
  FVG: 'INDEPENDENT',
  LIQUIDITY_SWEEP: 'INDEPENDENT',
  RANGE_POSITION: 'INDEPENDENT',
  INTERNAL_STRUCTURE: 'CONTEXT',
  OB_FVG_CONFLUENCE: 'DERIVED',
};

/** Human-readable factor names for UI legends and breakdowns. */
export const FACTOR_LABEL: Readonly<Record<FactorId, string>> = {
  BOS: 'BOS',
  ORDER_BLOCK: 'ORDER BLOCK',
  FVG: 'FVG',
  LIQUIDITY_SWEEP: 'LIQUIDITY SWEEP',
  RANGE_POSITION: 'RANGE POSITION',
  INTERNAL_STRUCTURE: 'INTERNAL STRUCTURE',
  OB_FVG_CONFLUENCE: 'OB + FVG CONFLUENCE',
};

/**
 * Factor names that were removed from the model. Used by the architecture
 * guard test to prove they never return to strategy/settings/UI code.
 */
export const FORBIDDEN_FACTOR_NAMES: readonly string[] = [
  'CHOCH',
  'EQUAL_LEVELS',
  'VOLUME_IMBALANCE',
  'PREMIUM_DISCOUNT',
];

export function isFactorId(v: unknown): v is FactorId {
  return typeof v === 'string' && (FACTOR_IDS as readonly string[]).includes(v);
}

/**
 * @deprecated Legacy alias kept so older imports keep compiling.
 * Prefer `FactorId`.
 */
export type DetectorId = FactorId;
/** @deprecated Prefer `FACTOR_IDS`. */
export const DETECTOR_IDS: readonly FactorId[] = FACTOR_IDS;

/**
 * A single detector finding on a closed candle series.
 * `index` refers to the index within the evaluated closed-candle array.
 */
export interface DetectorEvent {
  detector: FactorId;
  /** INDEPENDENT | CONTEXT | DERIVED — drives how scoring treats the event. */
  kind: FactorKind;
  direction: Direction;
  /** index of the candle that CONFIRMED the event (closed) */
  index: number;
  /** openTime of the confirming candle */
  time: number;
  /** Raw detector strength 0..1 before weighting */
  strength: number;
  /** Human readable reason */
  reason: string;
  /** Geometry for chart overlays (drawn by frontend, computed by backend ONLY) */
  zone?: { from: number; to: number; priceLow: number; priceHigh: number };
  line?: { from: number; to: number; price: number };
  /**
   * Anti-double-counting key. Two events sharing a dedupeKey are the same
   * underlying market fact and MUST contribute to the score at most once.
   */
  dedupeKey: string;
  /**
   * For DERIVED factors: the dedupeKeys of the parent events it was computed
   * from. Present so the breakdown can prove the parents were counted once
   * each and the derived factor only added its own bonus weight.
   */
  derivedFrom?: string[];
}

/** One line of the transparent score breakdown. */
export interface ScoreComponent {
  detector: FactorId;
  kind: FactorKind;
  direction: Direction;
  /** raw detector strength 0..1 */
  strength: number;
  /** configured weight from DB settings */
  weight: number;
  /** strength * weight, the actual contribution */
  contribution: number;
  counted: boolean;
  /** if !counted, why */
  skippedReason?: string;
  dedupeKey: string;
  time: number;
  reason: string;
  derivedFrom?: string[];
}

export interface ScoreBreakdown {
  direction: Direction;
  /** sum of counted contributions */
  rawScore: number;
  /** sum of weights of counted components */
  totalWeight: number;
  /** normalized 0..100 */
  score: number;
  components: ScoreComponent[];
  /** components excluded by dedupe */
  duplicatesRemoved: number;
  /** distinct factors that actually contributed weight */
  confirmations: number;
}

/** Result of evaluating one symbol+timeframe at one closed candle. */
export interface Evaluation {
  symbol: string;
  timeframe: Timeframe;
  /** openTime of the last CLOSED candle evaluated (candle N) */
  candleTime: number;
  /** close price of candle N */
  closePrice: number;
  /** ATR value (risk only, never confirmation) */
  atr: number | null;
  events: DetectorEvent[];
  long: ScoreBreakdown;
  short: ScoreBreakdown;
  /** convenience mirrors of long.score / short.score (persisted on signals) */
  longScore: number;
  shortScore: number;
  /** distinct factors that contributed to the winning side */
  confirmations: number;
  /** chosen direction if a signal threshold was met */
  decision: {
    direction: Direction;
    score: number;
    threshold: number;
    passed: boolean;
    confirmations: number;
    minConfirmations: number;
  } | null;
}

export interface RiskPlan {
  direction: Direction;
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  riskPerUnit: number;
  rrTp1: number;
  atr: number;
  positionSizeQuote: number;
  qty: number;
}

export interface OhlcvRow extends Candle {
  symbol: string;
  timeframe: Timeframe;
}

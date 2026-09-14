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

/** Signal lifecycle states, persisted in DB. */
export type SignalState =
  | 'IDLE'
  | 'SETUP'
  | 'WAITING_ENTRY'
  | 'ACTIVE'
  | 'CLOSED_TP'
  | 'CLOSED_SL'
  | 'CLOSED_TIMEOUT'
  | 'CANCELLED';

export const TERMINAL_STATES: readonly SignalState[] = [
  'CLOSED_TP',
  'CLOSED_SL',
  'CLOSED_TIMEOUT',
  'CANCELLED',
];

export function isTerminal(s: SignalState): boolean {
  return TERMINAL_STATES.includes(s);
}

/** Trading mode. LIVE is intentionally NOT part of the union — it is locked. */
export type TradingMode = 'DRY_RUN' | 'FORWARD_TEST';
export const TRADING_MODES: readonly TradingMode[] = ['DRY_RUN', 'FORWARD_TEST'];

/**
 * LIVE is deliberately represented separately and is always rejected.
 * See src/core/mode.ts
 */
export const LOCKED_MODE = 'LIVE' as const;

/** Detector identifiers — the single Smart Money engine's component set. */
export type DetectorId =
  | 'BOS'
  | 'CHOCH'
  | 'ORDER_BLOCK'
  | 'FVG'
  | 'LIQUIDITY_SWEEP'
  | 'EQUAL_LEVELS'
  | 'PREMIUM_DISCOUNT'
  | 'VOLUME_IMBALANCE';

export const DETECTOR_IDS: readonly DetectorId[] = [
  'BOS',
  'CHOCH',
  'ORDER_BLOCK',
  'FVG',
  'LIQUIDITY_SWEEP',
  'EQUAL_LEVELS',
  'PREMIUM_DISCOUNT',
  'VOLUME_IMBALANCE',
];

/**
 * A single detector finding on a closed candle series.
 * `index` refers to the index within the evaluated closed-candle array.
 */
export interface DetectorEvent {
  detector: DetectorId;
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
}

/** One line of the transparent score breakdown. */
export interface ScoreComponent {
  detector: DetectorId;
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
  /** chosen direction if a signal threshold was met */
  decision: {
    direction: Direction;
    score: number;
    threshold: number;
    passed: boolean;
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

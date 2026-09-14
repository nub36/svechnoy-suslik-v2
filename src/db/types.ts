import type { ColumnType, Generated, JSONColumnType } from 'kysely';

type Ts = ColumnType<Date, Date | string | undefined, Date | string>;

export interface SymbolsTable {
  symbol: string;
  base_asset: string;
  quote_asset: string;
  enabled: boolean;
  rank: number;
  quote_volume_24h: number;
  last_price: number;
  price_change_pct: number;
  tick_size: number;
  step_size: number;
  min_notional: number;
  updated_at: Ts;
}

export interface CandlesTable {
  symbol: string;
  timeframe: string;
  open_time: ColumnType<number, number, number>;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  close_time: ColumnType<number, number, number>;
  quote_volume: number;
  trades: number;
  is_closed: boolean;
}

export interface StrategyStateTable {
  symbol: string;
  timeframe: string;
  state: string;
  direction: string | null;
  last_candle_time: ColumnType<number, number | undefined, number>;
  setup_candle_time: ColumnType<number | null, number | null | undefined, number | null>;
  setup_score: number | null;
  active_signal_id: ColumnType<number | null, number | null | undefined, number | null>;
  /** FALSE only for rows written before an observation; absence of a row means
   *  "never seen" and is what blocks bootstrap signals. */
  initialised: ColumnType<boolean, boolean | undefined, boolean>;
  payload: JSONColumnType<Record<string, unknown>, string | undefined, string>;
  updated_at: Ts;
}

export interface SignalsTable {
  id: Generated<number>;
  symbol: string;
  timeframe: string;
  direction: string;
  state: string;
  mode: string;
  source: string;
  replay_run_id: ColumnType<number | null, number | null | undefined, number | null>;
  score: number;
  threshold: number;
  long_score: ColumnType<number, number | undefined, number>;
  short_score: ColumnType<number, number | undefined, number>;
  confirmations: ColumnType<number, number | undefined, number>;
  breakdown: JSONColumnType<Record<string, unknown>, string | undefined, string>;
  events: JSONColumnType<unknown[], string | undefined, string>;
  setup_candle_time: ColumnType<number, number, number>;
  setup_close: number;
  entry_candle_time: ColumnType<number | null, number | null | undefined, number | null>;
  entry_price: number | null;
  entry_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  stop_loss: number | null;
  take_profits: JSONColumnType<number[], string | undefined, string>;
  atr: number | null;
  rr_tp1: number | null;
  qty: number | null;
  position_quote: number | null;
  /** Persistent milestone timestamps — never cleared once set. */
  opened_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  tp1_hit_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  tp2_hit_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  tp3_hit_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  stopped_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  expired_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** Highest TP index reached so far (0..3). */
  tp_level: ColumnType<number, number | undefined, number>;
  created_at: Ts;
  updated_at: Ts;
}

export interface OutcomesTable {
  id: Generated<number>;
  signal_id: number;
  result: string;
  exit_price: number;
  exit_candle_time: ColumnType<number, number, number>;
  bars_held: number;
  pnl_pct: number;
  pnl_quote: number;
  r_multiple: number;
  max_favorable_pct: number;
  max_adverse_pct: number;
  tp_hit_index: number | null;
  created_at: Ts;
}

export interface SettingsTable {
  key: string;
  // Settings values are arbitrary JSON (number|bool|string|array), so we model
  // the column directly rather than via JSONColumnType (which requires object).
  value: ColumnType<unknown, string, string>;
  type: string;
  category: string;
  label: string;
  description: string;
  min_value: number | null;
  max_value: number | null;
  editable: boolean;
  updated_at: Ts;
}

export interface AdminUsersTable {
  id: Generated<number>;
  username: string;
  password_hash: string;
  created_at: Ts;
}

export interface AdminSessionsTable {
  token: string;
  user_id: number;
  expires_at: Ts;
  created_at: Ts;
}

export interface WorkerHeartbeatsTable {
  worker: string;
  status: string;
  detail: string;
  loops: ColumnType<number, number | undefined, number>;
  errors: ColumnType<number, number | undefined, number>;
  last_beat: Ts;
  started_at: Ts;
}

export interface EngineLogTable {
  id: Generated<number>;
  level: string;
  worker: string;
  message: string;
  meta: JSONColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: Ts;
}

export interface ReplayRunsTable {
  id: Generated<number>;
  label: string;
  symbols: JSONColumnType<string[], string | undefined, string>;
  timeframes: JSONColumnType<string[], string | undefined, string>;
  from_time: ColumnType<number, number, number>;
  to_time: ColumnType<number, number, number>;
  settings_used: JSONColumnType<Record<string, unknown>, string | undefined, string>;
  status: string;
  candles_seen: number;
  signals_count: number;
  wins: number;
  losses: number;
  timeouts: number;
  win_rate: number;
  avg_r: number;
  total_r: number;
  profit_factor: number;
  max_drawdown_r: number;
  metrics: JSONColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: Ts;
  finished_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface Database {
  symbols: SymbolsTable;
  candles: CandlesTable;
  strategy_state: StrategyStateTable;
  signals: SignalsTable;
  outcomes: OutcomesTable;
  settings: SettingsTable;
  admin_users: AdminUsersTable;
  admin_sessions: AdminSessionsTable;
  worker_heartbeats: WorkerHeartbeatsTable;
  engine_log: EngineLogTable;
  replay_runs: ReplayRunsTable;
}

-- svechnoy-suslik-v2 PostgreSQL schema
-- Binance Spot USDT only. Single writer per table-domain (market/strategy/outcome workers).

CREATE TABLE IF NOT EXISTS symbols (
  symbol            TEXT PRIMARY KEY,
  base_asset        TEXT NOT NULL,
  quote_asset       TEXT NOT NULL DEFAULT 'USDT',
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  rank              INTEGER NOT NULL DEFAULT 0,
  quote_volume_24h  DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_price        DOUBLE PRECISION NOT NULL DEFAULT 0,
  price_change_pct  DOUBLE PRECISION NOT NULL DEFAULT 0,
  tick_size         DOUBLE PRECISION NOT NULL DEFAULT 0.00000001,
  step_size         DOUBLE PRECISION NOT NULL DEFAULT 0.00000001,
  min_notional      DOUBLE PRECISION NOT NULL DEFAULT 5,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS symbols_rank_idx ON symbols (rank);
CREATE INDEX IF NOT EXISTS symbols_enabled_idx ON symbols (enabled);

-- Closed candles only are ever *evaluated*; the in-progress candle may be
-- stored with is_closed = FALSE for charting, and is filtered out by the engine.
CREATE TABLE IF NOT EXISTS candles (
  symbol        TEXT NOT NULL,
  timeframe     TEXT NOT NULL,
  open_time     BIGINT NOT NULL,
  open          DOUBLE PRECISION NOT NULL,
  high          DOUBLE PRECISION NOT NULL,
  low           DOUBLE PRECISION NOT NULL,
  close         DOUBLE PRECISION NOT NULL,
  volume        DOUBLE PRECISION NOT NULL,
  close_time    BIGINT NOT NULL,
  quote_volume  DOUBLE PRECISION NOT NULL DEFAULT 0,
  trades        INTEGER NOT NULL DEFAULT 0,
  is_closed     BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (symbol, timeframe, open_time)
);
CREATE INDEX IF NOT EXISTS candles_lookup_idx ON candles (symbol, timeframe, open_time DESC);
CREATE INDEX IF NOT EXISTS candles_closed_idx ON candles (symbol, timeframe, is_closed, open_time DESC);

-- Persistent per (symbol,timeframe) state machine. EDGE-only signal emission:
-- a signal is created only when the machine TRANSITIONS, never while it merely
-- remains in a state.
CREATE TABLE IF NOT EXISTS strategy_state (
  symbol              TEXT NOT NULL,
  timeframe           TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'IDLE',
  direction           TEXT,
  -- open_time of the last CLOSED candle already processed (idempotency guard)
  last_candle_time    BIGINT NOT NULL DEFAULT 0,
  -- candle N that produced the setup; entry must be the OPEN of N+1
  setup_candle_time   BIGINT,
  setup_score         DOUBLE PRECISION,
  -- signal currently owned by this state machine slot
  active_signal_id    BIGINT,
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (symbol, timeframe)
);

CREATE TABLE IF NOT EXISTS signals (
  id                BIGSERIAL PRIMARY KEY,
  symbol            TEXT NOT NULL,
  timeframe         TEXT NOT NULL,
  direction         TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'WAITING_ENTRY',
  mode              TEXT NOT NULL DEFAULT 'DRY_RUN',
  source            TEXT NOT NULL DEFAULT 'LIVE_ENGINE', -- LIVE_ENGINE | REPLAY
  replay_run_id     BIGINT,

  score             DOUBLE PRECISION NOT NULL,
  threshold         DOUBLE PRECISION NOT NULL,
  breakdown         JSONB NOT NULL DEFAULT '{}'::jsonb,
  events            JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- candle N (the CLOSED candle that produced the setup)
  setup_candle_time BIGINT NOT NULL,
  setup_close       DOUBLE PRECISION NOT NULL,
  -- candle N+1 (entry candle). NULL until N+1 actually exists.
  entry_candle_time BIGINT,
  entry_price       DOUBLE PRECISION,
  entry_at          TIMESTAMPTZ,

  stop_loss         DOUBLE PRECISION,
  take_profits      JSONB NOT NULL DEFAULT '[]'::jsonb,
  atr               DOUBLE PRECISION,
  rr_tp1            DOUBLE PRECISION,
  qty               DOUBLE PRECISION,
  position_quote    DOUBLE PRECISION,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- EDGE-only guarantee: at most one signal per (symbol,timeframe,setup candle,
-- source, run). NOTE: a plain UNIQUE constraint would NOT work here, because
-- replay_run_id is NULL for live signals and in SQL NULL <> NULL, so duplicate
-- live rows would slip through. COALESCE makes the key total.
CREATE UNIQUE INDEX IF NOT EXISTS signals_edge_unique
  ON signals (symbol, timeframe, setup_candle_time, source, COALESCE(replay_run_id, -1));
CREATE INDEX IF NOT EXISTS signals_state_idx ON signals (state);
CREATE INDEX IF NOT EXISTS signals_symbol_tf_idx ON signals (symbol, timeframe, setup_candle_time DESC);
CREATE INDEX IF NOT EXISTS signals_created_idx ON signals (created_at DESC);
CREATE INDEX IF NOT EXISTS signals_source_idx ON signals (source, replay_run_id);

CREATE TABLE IF NOT EXISTS outcomes (
  id                BIGSERIAL PRIMARY KEY,
  signal_id         BIGINT NOT NULL UNIQUE REFERENCES signals(id) ON DELETE CASCADE,
  result            TEXT NOT NULL,           -- TP | SL | TIMEOUT
  exit_price        DOUBLE PRECISION NOT NULL,
  exit_candle_time  BIGINT NOT NULL,
  bars_held         INTEGER NOT NULL DEFAULT 0,
  pnl_pct           DOUBLE PRECISION NOT NULL DEFAULT 0,
  pnl_quote         DOUBLE PRECISION NOT NULL DEFAULT 0,
  r_multiple        DOUBLE PRECISION NOT NULL DEFAULT 0,
  max_favorable_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
  max_adverse_pct   DOUBLE PRECISION NOT NULL DEFAULT 0,
  tp_hit_index      INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS outcomes_result_idx ON outcomes (result);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  type        TEXT NOT NULL DEFAULT 'string',
  category    TEXT NOT NULL DEFAULT 'general',
  label       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  min_value   DOUBLE PRECISION,
  max_value   DOUBLE PRECISION,
  editable    BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token      TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker      TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'OK',
  detail      TEXT NOT NULL DEFAULT '',
  loops       BIGINT NOT NULL DEFAULT 0,
  errors      BIGINT NOT NULL DEFAULT 0,
  last_beat   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS engine_log (
  id         BIGSERIAL PRIMARY KEY,
  level      TEXT NOT NULL DEFAULT 'info',
  worker     TEXT NOT NULL DEFAULT '',
  message    TEXT NOT NULL,
  meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS engine_log_created_idx ON engine_log (created_at DESC);

CREATE TABLE IF NOT EXISTS replay_runs (
  id             BIGSERIAL PRIMARY KEY,
  label          TEXT NOT NULL DEFAULT '',
  symbols        JSONB NOT NULL DEFAULT '[]'::jsonb,
  timeframes     JSONB NOT NULL DEFAULT '[]'::jsonb,
  from_time      BIGINT NOT NULL,
  to_time        BIGINT NOT NULL,
  settings_used  JSONB NOT NULL DEFAULT '{}'::jsonb,
  status         TEXT NOT NULL DEFAULT 'RUNNING',
  candles_seen   INTEGER NOT NULL DEFAULT 0,
  signals_count  INTEGER NOT NULL DEFAULT 0,
  wins           INTEGER NOT NULL DEFAULT 0,
  losses         INTEGER NOT NULL DEFAULT 0,
  timeouts       INTEGER NOT NULL DEFAULT 0,
  win_rate       DOUBLE PRECISION NOT NULL DEFAULT 0,
  avg_r          DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_r        DOUBLE PRECISION NOT NULL DEFAULT 0,
  profit_factor  DOUBLE PRECISION NOT NULL DEFAULT 0,
  max_drawdown_r DOUBLE PRECISION NOT NULL DEFAULT 0,
  metrics        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ
);

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
  -- Both directional scores are kept so the decision is auditable, not just
  -- the winning side. 0..100 each.
  long_score        DOUBLE PRECISION NOT NULL DEFAULT 0,
  short_score       DOUBLE PRECISION NOT NULL DEFAULT 0,
  confirmations     INTEGER NOT NULL DEFAULT 0,
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

-- Additive, idempotent migration for databases created before the factor-model
-- correction. Existing production rows keep their data; the new columns are
-- backfilled from the winning score so historical rows stay readable.
ALTER TABLE signals ADD COLUMN IF NOT EXISTS long_score    DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS short_score   DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS confirmations INTEGER NOT NULL DEFAULT 0;

UPDATE signals SET long_score = score
  WHERE direction = 'LONG'  AND long_score  = 0 AND score > 0;
UPDATE signals SET short_score = score
  WHERE direction = 'SHORT' AND short_score = 0 AND score > 0;

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

-- ===================================================================
-- Signal lifecycle v2 + strategy-state semantics v2.
-- Additive and idempotent: safe to re-run on a populated production DB.
-- ===================================================================

-- Persistent milestone timestamps. A trade that reaches TP1 and is later
-- stopped keeps tp1_hit_at forever; the milestones are an audit trail, not a
-- mutable "current state" mirror.
ALTER TABLE signals ADD COLUMN IF NOT EXISTS opened_at  TIMESTAMPTZ;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS tp1_hit_at TIMESTAMPTZ;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS tp2_hit_at TIMESTAMPTZ;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS tp3_hit_at TIMESTAMPTZ;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS stopped_at TIMESTAMPTZ;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;
-- Highest take-profit index reached so far (0 = none). Lets the outcome worker
-- resume progressively without re-deriving history.
ALTER TABLE signals ADD COLUMN IF NOT EXISTS tp_level INTEGER NOT NULL DEFAULT 0;

-- --- signal state migration ----------------------------------------
-- Old lifecycle -> new lifecycle. Data is PRESERVED: score, breakdown, events,
-- entry, SL/TP and timestamps are untouched; only `state` is renamed and the
-- corresponding milestone timestamp is backfilled from existing columns.
UPDATE signals SET state = 'OPEN'    WHERE state = 'ACTIVE';
UPDATE signals SET state = 'STOPPED' WHERE state = 'CLOSED_SL';
UPDATE signals SET state = 'EXPIRED' WHERE state IN ('CLOSED_TIMEOUT', 'CANCELLED');
-- A legacy CLOSED_TP closed the whole trade at the FIRST take-profit, so it maps
-- to TP1_HIT unless the recorded outcome says a further TP was reached.
UPDATE signals s SET state = 'TP1_HIT' WHERE s.state = 'CLOSED_TP';
UPDATE signals s SET state = 'TP2_HIT'
  FROM outcomes o WHERE o.signal_id = s.id AND s.state = 'TP1_HIT' AND o.tp_hit_index = 1;
UPDATE signals s SET state = 'TP3_HIT'
  FROM outcomes o WHERE o.signal_id = s.id AND s.state = 'TP1_HIT' AND o.tp_hit_index >= 2;
-- Any unknown legacy value must not silently survive as an invalid state.
UPDATE signals SET state = 'EXPIRED'
  WHERE state NOT IN ('WAITING_ENTRY','OPEN','TP1_HIT','TP2_HIT','TP3_HIT','STOPPED','EXPIRED');

-- Backfill milestones from data that already exists.
UPDATE signals SET opened_at = COALESCE(entry_at, updated_at)
  WHERE opened_at IS NULL AND entry_price IS NOT NULL;
UPDATE signals SET tp1_hit_at = updated_at
  WHERE tp1_hit_at IS NULL AND state IN ('TP1_HIT','TP2_HIT','TP3_HIT');
UPDATE signals SET tp2_hit_at = updated_at
  WHERE tp2_hit_at IS NULL AND state IN ('TP2_HIT','TP3_HIT');
UPDATE signals SET tp3_hit_at = updated_at
  WHERE tp3_hit_at IS NULL AND state = 'TP3_HIT';
UPDATE signals SET stopped_at = updated_at WHERE stopped_at IS NULL AND state = 'STOPPED';
UPDATE signals SET expired_at = updated_at WHERE expired_at IS NULL AND state = 'EXPIRED';
UPDATE signals SET tp_level = 1 WHERE tp_level = 0 AND state = 'TP1_HIT';
UPDATE signals SET tp_level = 2 WHERE tp_level < 2 AND state = 'TP2_HIT';
UPDATE signals SET tp_level = 3 WHERE tp_level < 3 AND state = 'TP3_HIT';

-- --- strategy_state migration ---------------------------------------
-- `initialised` distinguishes "never observed" from "observed, currently
-- NEUTRAL". Every pre-existing row HAS been observed, so it defaults to TRUE
-- and cannot bootstrap a fake signal after deployment.
ALTER TABLE strategy_state ADD COLUMN IF NOT EXISTS initialised BOOLEAN NOT NULL DEFAULT TRUE;

-- Slots that were mid-trade migrate to the matching HOLD so the persisting
-- condition cannot be re-read as a fresh rising edge after deploy.
UPDATE strategy_state SET state = 'HOLD_LONG'
  WHERE state IN ('ACTIVE','WAITING_ENTRY','SETUP') AND direction = 'LONG';
UPDATE strategy_state SET state = 'HOLD_SHORT'
  WHERE state IN ('ACTIVE','WAITING_ENTRY','SETUP') AND direction = 'SHORT';
-- Mid-trade but no recorded direction: REARM is the safe landing — it requires
-- the condition to be observed absent before anything can fire.
UPDATE strategy_state SET state = 'REARM'
  WHERE state IN ('ACTIVE','WAITING_ENTRY','SETUP');
-- Idle/terminal legacy slots become an observed NEUTRAL baseline.
UPDATE strategy_state SET state = 'NEUTRAL'
  WHERE state IN ('IDLE','CLOSED_TP','CLOSED_SL','CLOSED_TIMEOUT','CANCELLED');
UPDATE strategy_state SET state = 'NEUTRAL'
  WHERE state NOT IN ('NEUTRAL','EDGE_LONG','EDGE_SHORT','HOLD_LONG','HOLD_SHORT','REARM');
-- An EDGE is a momentary transition and must never be left persisted.
UPDATE strategy_state SET state = 'HOLD_LONG'  WHERE state = 'EDGE_LONG';
UPDATE strategy_state SET state = 'HOLD_SHORT' WHERE state = 'EDGE_SHORT';

# svechnoy-suslik-v2

Smart Money signal engine on **Binance Spot USDT only**.

It ranks the TOP-10 USDT pairs by 24h quote volume, evaluates eight Smart Money
detectors on **closed candles only**, emits a signal on the rising edge of the
state machine, enters at the **open of candle N+1**, and tracks every trade to
TP / SL / TIMEOUT. Nothing is ever sent to an exchange: **LIVE trading is
locked at the source level**.

---

## Architecture

```
Binance Spot (REST)
        |
   market worker ........ TOP-10 by quote volume + candles for every timeframe
        |
      Postgres  <-- single source of truth (settings, candles, signals, outcomes)
        |
  strategy worker ....... Smart Money engine -> state machine -> signals
        |
  outcome  worker ....... TP / SL / TIMEOUT, R multiple, MFE / MAE
        |
       web (Next.js) .... Markets + chart, Signals, Monitoring, Replay, Admin
```

One process per role, **exactly one writer per table**:

| table | sole writer |
|---|---|
| `symbols`, `candles` | market worker |
| `signals`, `strategy_state` | strategy worker |
| `outcomes`, terminal signal states | outcome worker |
| `settings` | admin UI |

Deliberately **not** in this system: multi-exchange aggregation, quorum or
voting between venues, a `minExchanges` threshold, a V1/V2 engine split, legacy
signal workers, and the TradingView embed widget. Charts use the
**TradingView Lightweight Charts** library, rendering data the backend computed.

### The eight detectors

| detector | default weight |
|---|---|
| `BOS` (break of structure) | 25 |
| `CHOCH` (change of character) | 20 |
| `ORDER_BLOCK` | 18 |
| `LIQUIDITY_SWEEP` | 15 |
| `FVG` (fair value gap) | 12 |
| `EQUAL_LEVELS` | 8 |
| `PREMIUM_DISCOUNT` | 7 |
| `MITIGATION` | 6 |

Score: `contribution = strength x weight`, then
`score = 100 * Σcontribution / Σweight` over **counted** components only, so the
result is always in `[0, 100]` and weights can be retuned without rescaling.

ATR is used for **risk sizing only** — never as a confirmation component.

---

## Correctness guarantees (all covered by tests)

* **No future leakage.** A swing pivot at index `p` is only usable from
  `p + strength` onward; detectors read `candles[0..evalIndex]`; `evaluate()`
  throws `FutureLeakageError` if any event references a later index or if the
  evaluation candle is not closed.
* **Closed candles only.** Forming candles are never evaluated.
* **Entry at N+1.** A signal is created in `WAITING_ENTRY` with a `NULL` entry
  price. The entry is the **open of `setupCandleTime + tfMs`** and is written
  only once that candle exists. An entry is never invented ahead of time.
* **Edge-only signals.** One signal per `IDLE -> WAITING_ENTRY` transition,
  enforced in the database by
  `UNIQUE (symbol, timeframe, setup_candle_time, source, COALESCE(replay_run_id, -1))`.
  The `COALESCE` matters: a plain `UNIQUE` over the nullable `replay_run_id`
  would not constrain live rows at all, because `NULL <> NULL`.
* **No double counting.** Each detector contributes at most once per
  evaluation (strongest instance kept); duplicate market facts are removed by
  `dedupeKey`. Skipped components stay visible in the breakdown with a reason.
* **Replay == live.** `/replay` and the CLI call the *same* `evaluate()`; a test
  asserts replay reproduces live direction and score to 6 decimal places.
* **LIVE is locked.** `LIVE_TRADING_ENABLED = false` is a source constant,
  `TradingMode` has no `LIVE` member, `assertNoRealExecution()` always throws,
  and the admin API rejects `LIVE` with HTTP 400.

---

## Setup

```bash
npm ci --legacy-peer-deps
cp .env.example .env          # then edit DATABASE_URL and ADMIN_PASSWORD
npm run db:migrate
npm run db:seed
npm run bootstrap             # TOP-10 + candles for all 8 timeframes
```

### Scripts

| command | what it does |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run build` | `build:backend` (tsc -> `dist/`) + `next build` |
| `npm start` | production web server |
| `npm run worker:market` / `:strategy` / `:outcome` | run one worker in the foreground |
| `npm run db:migrate` / `db:seed` | schema + default settings and admin user |
| `npm run bootstrap` | seed TOP-10 and backfill candles |
| `npm run seed:history` | walk stored candles bar-by-bar to build a signal history |
| `npm run replay` | historical replay on the CLI |
| `npm run smoke` | end-to-end time-stepped simulation with assertions |
| `npm test` | full Vitest suite |
| `npm run fixtures` | regenerate offline fixtures |

### Timeframes

`1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`, `1w` — all eight are supported
everywhere (chart, engine, replay). Which ones the engine trades is the
`engine.timeframes` setting.

---

## Admin

`/admin`, protected by a bcrypt password and an HTTP-only session cookie.

Every key in `SETTINGS_REGISTRY` is editable there and **actually reaches the
engine** — nothing is decorative. Each setting declares `consumedBy` (the files
that read it), and `tests/settings-wiring.test.ts` proves for every single key
both that the declared consumer really reads it *and* that changing it changes
engine behaviour. Two keys are deliberately locked: `market.quote_asset`
(USDT) and any attempt to set `engine.trading_mode` to `LIVE`.

---

## Deployment (VPS, PM2)

Target `/root/svechnoy-suslik-v2`, web on port 3000.

```bash
cd /root/svechnoy-suslik-v2
git pull
npm ci --legacy-peer-deps
npm run build
npm run db:migrate && npm run db:seed
pm2 start ecosystem.config.js
pm2 save
pm2 status
```

PM2 apps: `svechnoy-suslik-v2-web`, `-market`, `-strategy`, `-outcome`.
Each runs `instances: 1` in fork mode — **do not scale a worker above one
instance**, it would break the single-writer guarantee.

Switching DRY_RUN -> FORWARD_TEST: set `engine.trading_mode` in `/admin` (it
takes effect on the workers' next loop, no restart needed), or set
`TRADING_MODE=FORWARD_TEST` in the environment for the value used at boot.
Neither mode places orders; FORWARD_TEST means outcomes are tracked as a paper
record.

---

## Testing

```bash
npm test                                                   # 248 tests
SMOKE_BASE_URL=http://127.0.0.1:3000 npx vitest run        # + live HTTP tests
```

Tests run against a **real PostgreSQL** (embedded binaries, temp datadir,
random port) rather than an in-memory fake — that is how the nullable-`UNIQUE`
bug above was caught. Set `TEST_DATABASE_URL` to point at your own instance.
`tests/api.test.ts` is skipped unless `SMOKE_BASE_URL` is set.

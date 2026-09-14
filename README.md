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
   market worker ........ TOP-10 by quote volume + candles for ALL 8 timeframes
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

### The seven Smart Money factors

| factor | kind | default weight |
|---|---|---|
| `BOS` (break of structure) | INDEPENDENT | 25 |
| `ORDER_BLOCK` | INDEPENDENT | 20 |
| `FVG` (fair value gap) | INDEPENDENT | 15 |
| `LIQUIDITY_SWEEP` | INDEPENDENT | 15 |
| `RANGE_POSITION` | INDEPENDENT | 10 |
| `INTERNAL_STRUCTURE` | CONTEXT | 8 |
| `OB_FVG_CONFLUENCE` | DERIVED | 7 |

`CHOCH`, `EQUAL_LEVELS`, `VOLUME_IMBALANCE` and `PREMIUM_DISCOUNT` (as a factor
name) were removed deliberately. `tests/factor-model.test.ts` contains an
architecture guard that fails the build if any of them reappears in the
strategy, the settings registry or the UI.

`OB_FVG_CONFLUENCE` is DERIVED: it adds only its own small bonus and never
re-adds the weight of its OB/FVG parents. One factor contributes at most once
per direction per evaluation (strongest kept).

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
* **Real-time display is isolated from the engine.** The chart subscribes to
  the Binance kline WebSocket and animates the forming candle with
  `series.update()`, but `src/web/binance-stream.ts` has no database and no
  engine import at all, so a tick is structurally incapable of producing a
  signal. `tests/realtime-safety.test.ts` also proves it behaviourally: 20
  ticks that double the forming bar's price change no score and create no
  signal row.
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
npm run db:seed               # creates the admin ONLY if it does not exist yet
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
| `npm run admin:reset-password` | **change the admin password** (see below) |
| `npm run bootstrap` | seed TOP-10 and backfill candles |
| `npm run seed:history` | walk stored candles bar-by-bar to build a signal history |
| `npm run replay` | historical replay on the CLI |
| `npm run smoke` | end-to-end time-stepped simulation with assertions |
| `npm test` | full Vitest suite |
| `npm run fixtures` | regenerate offline fixtures |

### Real-time prices

The selected symbol/timeframe subscribes to `<symbol>@kline_<tf>` and the
TOP-10 table to a combined `@miniTicker` stream. Typical visual latency is well
under a second. The client reconnects with exponential backoff (0.5s -> 30s),
reports `Онлайн / Подключение / Нет данных / Оффлайн`, and tears the previous
socket down before opening the next one, so switching symbol or timeframe can
never leave a duplicate subscription behind. REST (`/api/chart`, every 30s)
remains the authoritative source and the fallback when the socket is down.

### Timeframes

`1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`, `1w` — all eight are supported
everywhere (chart, engine, replay). Which ones the engine trades is the
`engine.timeframes` setting.

---

## Strategy state machine and signal lifecycle

Two SEPARATE state machines. Conflating them is what once allowed a cold start
to emit a batch of signals.

### Strategy state — per (symbol, timeframe) detector memory

```
NEUTRAL --pass--> EDGE_LONG/EDGE_SHORT --(settle)--> HOLD_LONG/HOLD_SHORT
   ^                                                        |
   |                                                     fail|
   +---------------- fail ------------------ REARM <---------+
```

A signal is emitted **only on a genuine rising edge** — an evaluation that
passes immediately after an observed evaluation that did not.

* **Bootstrap rule.** A slot with no persisted row has never been observed, so
  its first evaluation only records a baseline; if the condition already passes
  it parks in `HOLD_*`, never `EDGE_*`. Without this, starting the worker made
  every currently-true condition look like a transition.
* **No re-emission.** While the condition persists the slot stays in `HOLD_*`.
* **REARM.** After the condition drops, the slot must be observed absent before
  it can fire again — so a flickering condition cannot spam signals.
* **Suppression is not a deferral.** When an edge is suppressed (capacity,
  missing ATR, R:R below `risk.min_rr`) it is settled into `HOLD_*`, not back
  to `NEUTRAL`. Returning to NEUTRAL would let the same persisting condition
  read as a fresh edge on the next loop — a delayed fake edge.
* A direction flip out of a hold IS a genuine new edge.

### Signal lifecycle — the life of one trade

```
WAITING_ENTRY -> OPEN -> TP1_HIT -> TP2_HIT -> TP3_HIT
                   \        \          \
                    +--------+----------+--> STOPPED
                    +------------------------> EXPIRED
```

Take-profits are **progressive milestones, not terminal states**. Each writes
its own timestamp exactly once (`tp1_hit_at`, `tp2_hit_at`, `tp3_hit_at`,
`stopped_at`, `expired_at`, `opened_at`) and those timestamps are **never
cleared**. A trade that reaches TP1 and is later stopped ends in `STOPPED`
while `tp1_hit_at` remains — so "won then gave it back" stays distinguishable
from "lost immediately". Only `TP3_HIT`, `STOPPED` and `EXPIRED` are terminal,
and only then is the `outcomes` row written and the slot released.

Outcome processing reads **closed candles only**; the entry is always the OPEN
of candle N+1 and is never fabricated.

---

## Outcome accounting (R and P&L)

A trade's economics are computed once, in `src/outcome/tracker.ts`, and reused
by the outcome worker, `/signals`, `/monitoring` and replay so the four can
never drift apart.

**A take-profit closes the trade only on the FINAL rung of the ladder.**
Touching TP1 or TP2 records a milestone and nothing else: this build has no
partial-exit accounting, so no profit is realised there and the position keeps
running with the same stop. If price later reaches the stop, the trade is a
loss and reports a negative R.

This was previously wrong. The outcome walk exited at whichever TP a bar
touched, so a trade that tagged TP1 and was then stopped out was recorded as a
TP exit — producing the production defect where signal #9 (BTCUSDT 1m SHORT,
entry 78590.70, SL 78692.77) displayed **state «Стоп» alongside R = +0.23**.

Invariants, each pinned by a test:

| Case | Result |
| --- | --- |
| LONG entry 100 / SL 95 / exit 95 | negative R |
| SHORT entry 100 / SL 105 / exit 105 | negative R |
| LONG entry 100 / TP 105 | positive R |
| SHORT entry 100 / TP 95 | positive R |
| TP1 touched, then stopped | **negative** R, TP1 milestone retained |

`trackMilestones()` (lifecycle state) and `trackOutcome()` (P&L) walk the same
bars under the same rules. The outcome worker asserts they agree before writing
— `TP3_HIT→TP`, `STOPPED→SL`, `EXPIRED→TIMEOUT` — and refuses to persist a
contradictory row or a stop-out carrying a positive R.

### Legacy rows

Historical production data written by the old logic can still contain
contradictions (the known case is `state=EXPIRED` with `outcome.result=TP`).
Such rows are **not rewritten** — history is preserved — they are flagged
`legacyInconsistent` by `/api/signals` and labelled «устаревшие данные» in the
UI. New writes cannot create them.

### Milestones are history, not profit

`/signals` separates two things that the old summary conflated:

- **Текущее состояние** — mutually exclusive, one row counted exactly once:
  `Всего = Ожидание входа + Открыт + TP1 + TP2 + TP3 + Стоп + Истёк`.
- **Достигнутые цели** — deliberately overlapping "ever reached TP1/TP2/TP3",
  including trades later stopped out. These are historical facts and are never
  added to the state totals.

---

## Timeframe scanning control

`engine.timeframes` is the **single source of truth** for which timeframes the
strategy scans. There is deliberately no `strategy.timeframes`,
`scan.timeframes` or `market.strategy_timeframes` — one setting, one behaviour.

Supported values: `1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w`.

### Admin UI

Admin → «Таймфреймы стратегии» renders a checkbox per timeframe
(1м/5м/15м/30м/1ч/4ч/1д/1н) plus «Выбрать все» / «Сбросить». Any combination is
valid — one, several, or all eight. Nothing is forced.

At least one timeframe must remain selected. The last checked box is disabled in
the UI, and the API independently rejects an empty array with
`engine.timeframes: выберите хотя бы один таймфрейм для стратегии`. Duplicates
are collapsed and the list is stored in canonical chronological order, so
`["1h","15m","1h"]` persists as `["15m","1h"]` and can never double-scan a slot.

### Scan slots

The selected set is applied to the **dynamic** Binance Spot USDT TOP-10; symbols
are never hard-coded. Scan slots = TOP-10 x selected timeframes:

| Selection | Slots |
| --- | --- |
| `["15m"]` | 10 x 1 = 10 |
| `["15m","1h"]` | 10 x 2 = 20 |
| `["5m","15m","1h"]` | 10 x 3 = 30 |
| all 8 | 10 x 8 = 80 |

Changes take effect on the **next worker loop** — no code change, no restart,
because settings are reloaded every iteration.

### Chart display vs strategy scanning

**Ingestion and scanning are deliberately decoupled.** `engine.timeframes` is a
*scan* filter only; it is not a data-collection switch.

| Worker | Timeframes | Source |
| --- | --- | --- |
| market (ingestion) | **always all 8 supported** | `TIMEFRAMES` constant |
| strategy (scanning) | the selected subset | `engine.timeframes` |

- Unchecking a timeframe stops the strategy from **looking for new signals**
  there. The market worker **keeps fetching its candles**, so the chart for that
  timeframe stays live and never goes stale.
- Already-stored history is **never deleted**, and missing candles are **never
  fabricated**.
- `strategy_state` rows and historical signals for disabled timeframes are
  **retained**. A retained row is not a currently-scanned combination.

Earlier builds had the market worker read `engine.timeframes` too, which meant
disabling a timeframe for scanning also starved its chart. That coupling is
gone; `engine.timeframes` remains the single source of truth for scanning.

### Re-enabling a timeframe (and worker downtime)

Re-enabling a timeframe after hours or days is treated exactly like worker
downtime. The engine must never jump to the newest candle and read a
long-standing condition as a fresh rising edge. Instead it walks every missed
**CLOSED** candle in order through the state machine, so an edge is only emitted
where a real transition actually occurred.

`engine.max_catchup_candles` (default 500) bounds that walk. If the gap is
larger, the slot is silently **re-baselined** to `REARM` at the newest closed
candle — cold-start semantics, structurally incapable of emitting. A slot that
has never been observed likewise takes its baseline from the newest candle only
and stays silent on its first run.

### One active signal per symbol

A symbol may hold only **one** non-terminal signal at a time, across all
selected timeframes. If BTCUSDT fires on 15m, a BTCUSDT 1h edge is suppressed
while that signal is `WAITING_ENTRY` / `OPEN` / `TP1_HIT` / `TP2_HIT`. ETHUSDT is
unaffected. Once the BTCUSDT signal reaches `TP3_HIT` / `STOPPED` / `EXPIRED`,
BTCUSDT is eligible again — but only on a fresh genuine edge.

A suppressed edge is settled into the corresponding `HOLD_*` state, never back
to `NEUTRAL`. Returning to `NEUTRAL` would let the same still-passing condition
re-read as a brand new edge on the following candle (a delayed fake edge).

## Admin

`/admin`, protected by a bcrypt password and an HTTP-only session cookie.
The UI is in Russian; internal identifiers (`BTCUSDT`, `WAITING_ENTRY`,
`FORWARD_TEST`, factor names) stay in their canonical form everywhere.

### Changing the admin password

### Session cookie: `COOKIE_SECURE`

The `Secure` cookie attribute describes the **transport the app is actually
reached over**, not the build type. Deriving it from `NODE_ENV` alone breaks a
production deployment served over plain HTTP.

That was a real production failure: the VPS ran `NODE_ENV=production` but was
reached at `http://89.125.24.50:3000`, so the browser received a `Secure`
session cookie over HTTP and refused to send it back. Credentials, session
creation and Postgres storage were all working — `admin_sessions` held 7 valid
rows — but `GET /api/admin/session` never saw the cookie, so the Admin UI
rendered for about a second and then bounced back to the login form.

| Value | When to use |
| --- | --- |
| `COOKIE_SECURE=false` | **Only** for a direct HTTP deployment (`http://<ip>:3000`, no TLS). Required there, or admin login cannot persist. |
| `COOKIE_SECURE=true` | Whenever the app is served over HTTPS, directly or behind a TLS-terminating proxy. |
| unset | Falls back to `NODE_ENV === 'production'` — the security-conscious default. |

An unrecognised value (e.g. `COOKIE_SECURE=yes`) is ignored and the safe
default applies, so a typo can never silently disable the flag.

The current VPS needs `COOKIE_SECURE=false`. **Switch it to `true` as soon as
TLS is put in front of the app** — a non-Secure cookie may be transmitted in
cleartext, so this setting is a stopgap for an HTTP deployment, not a
recommended end state.

Only `Secure` is configurable. `httpOnly: true`, `sameSite: 'lax'` and
`path: '/'` are constants in `src/web/cookie-policy.ts` and are never relaxed;
the token is never exposed to JavaScript, `localStorage`, `sessionStorage` or
query parameters. `X-Forwarded-Proto` is deliberately **not** trusted: the
header is attacker-controlled without a trusted-proxy model, and honouring it
would let a client dictate its own cookie security.

---

**Editing `ADMIN_PASSWORD` in `.env` does NOT change an existing password.**
PostgreSQL (`admin_users`) is the source of truth, and `db:seed` creates the
account only when it is absent — otherwise every deploy would silently reset a
rotated credential. This is why a changed `.env` still produced
"Invalid credentials" in production.

There are two ways to change it.

**1. From the UI (normal case).** Sign in and use the **Безопасность** section
at the bottom of `/admin`: current password, new password, confirmation. It
requires a valid session, verifies the current password, enforces the same
policy as the CLI, and revokes every OTHER session while keeping you signed in.
Repeated wrong attempts are rate-limited.

**2. From the CLI (recovery, when nobody can sign in):**

```bash
cd /root/svechnoy-suslik-v2
ADMIN_USER=admin ADMIN_PASSWORD='<new-strong-password>' npm run admin:reset-password
```

The command validates the password (minimum 12 characters, known defaults
rejected), writes the new bcrypt hash **and all existing sessions for that user
are revoked**, so everyone must sign in again. It never prints the password,
the hash or any session token. It is intentionally explicit — no web restart
ever rewrites credentials.

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
# db:migrate is additive and idempotent. It also performs the lifecycle
# migration (ACTIVE -> OPEN, CLOSED_* -> STOPPED/EXPIRED, legacy strategy
# states -> HOLD_*/NEUTRAL) while preserving every existing row.
# TAKE A DATABASE BACKUP FIRST:
#   pg_dump -Fc "$DATABASE_URL" > backup-$(date +%F-%H%M).dump
npm run db:migrate && npm run db:seed
# Only when the admin password must change (does not happen automatically).
# Normally use Admin -> Безопасность instead; this is the recovery path.
# ADMIN_USER=admin ADMIN_PASSWORD='<new-strong-password>' npm run admin:reset-password
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
npm test                                                   # 615 tests
SMOKE_BASE_URL=http://127.0.0.1:3000 npx vitest run        # + live HTTP tests
```

Tests run against a **real PostgreSQL** (embedded binaries, temp datadir,
random port) rather than an in-memory fake — that is how the nullable-`UNIQUE`
bug above was caught. Set `TEST_DATABASE_URL` to point at your own instance.
`tests/api.test.ts` is skipped unless `SMOKE_BASE_URL` is set.

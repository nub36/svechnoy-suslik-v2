# V3.0 — PRODUCTION PORT (FORWARD TEST)
# V3.0 — ПЕРЕНОС В РАБОЧУЮ СРЕДУ САЙТА (ФОРВАРД-ТЕСТ)

**Status / Статус: `V3_0_IN_FORWARD_TEST`** — the validated candidate is now the
default strategy of the site's engine and is ready for **paper forward testing on
live data** (`FORWARD_TEST` / `DRY_RUN`). `LIVE` remains locked.
**`PRODUCTION_READY` is FORBIDDEN** — this is not a claim of deployability, and no
capital should be risked on it.

**Статус: `V3_0_IN_FORWARD_TEST`** — валидированный кандидат стал стратегией по
умолчанию и готов к **бумажному форвард-тесту на живых данных** (`FORWARD_TEST` /
`DRY_RUN`). Режим `LIVE` по-прежнему заблокирован. **`PRODUCTION_READY`
ЗАПРЕЩЕНО** — это не заявление о готовности к реальной торговле, и рисковать
капиталом на этой стратегии нельзя.

| pinned / зафиксировано | value / значение |
|---|---|
| research module (frozen) / исследовательский модуль | `research/v30_htf_trap.ts` — sha256 `a821757ff0319a100a8a9087da1bdd137abb1df0785493d644ad4d87f05dc4cd` (unmodified / не изменялся) |
| production module / прод-модуль | `src/strategy/v30/` (`params · levels · trap · execution · outcome · runner · validated · index`) |
| parity evidence / доказательство паритета | `artifacts/research/v30/v30-port-parity.json` — **PASS**, 1,585 / 1,585 trades identical |
| parity harness / прогон паритета | `scripts/real-data/v30-parity.ts` (+ `v30-parity-ingest.ts`) |
| data used / данные | dataset `c3c1dce`, **TRAIN only** (`2022-01-01 … 2024-05-26`) |
| tests / тесты | `tests/v30-port-parity.test.ts`, `tests/v30-integration.test.ts`, `tests/v30-admin.test.ts` |
| validated record / запись валидации | [V3_0_VALIDATION_RESULTS.md](V3_0_VALIDATION_RESULTS.md) — net **+0.0600 R/trade** @2/5 bps, n = 536 |

---

## 1. What "port" means here / Что значит «перенос»

The research implementation is a **script**: constants at the top, a `main()` that
reads binary series from a cache, and a trade loop. The site's engine is a set of
**workers** that read candles from PostgreSQL, write `signals` rows and resolve
them later through an `outcomes` row.

The port therefore keeps the *logic* and replaces the *plumbing*:

| research / исследование | production / прод |
|---|---|
| compile-time constants | `v30.*` settings (defaults = the frozen values) |
| `main()` loop over a cached series | `runV30Once(db, settings, log)` per symbol, triggered by the strategy worker |
| in-memory pending corridor | persisted `signals` row in `WAITING_ENTRY`, plan stored in `breakdown.v30` |
| trade result object | `outcomes` row written by the outcome worker (`r_multiple` = **net** R) |
| `ExitReason` string | same `ExitReason` string, plus the site's `signal.state` |

**The strategy logic itself is unchanged.** `tests/v30-port-parity.test.ts`
compares the two implementations function by function — including 400 seeded
random walks through the trade manager — and
`scripts/real-data/v30-parity.ts` replayed the whole TRAIN window with both
implementations, symbol by symbol:

```
BTCUSDT: research fills 259  port fills 259  -> MATCH
ETHUSDT: research fills 268  port fills 268  -> MATCH
BNBUSDT: research fills 295  port fills 295  -> MATCH
SOLUSDT: research fills 259  port fills 259  -> MATCH
XRPUSDT: research fills 238  port fills 238  -> MATCH
DOGEUSDT: research fills 266  port fills 266 -> MATCH

PARITY: PASS
  port: gross/trade 0.1726 · fee/trade 0.0732 · net/trade 0.0994
  (artifact: 0.1726 / 0.0732 / 0.0994)
```

Every trade — direction, entry price, stop, TP1, TP2, exit reason, bars held,
gross R, fee R, net R — is identical, and the aggregate reproduces the committed
TRAIN artifact exactly. That harness caught two real defects during the port (a
missing "TP2 on a bar after TP1" branch, which would have turned every multi-bar
TP2 win into a timeout or a scratch, and a plan-time geometry gate the research
implementation does not have).

**The research file was not modified**; its hash is pinned by
`tests/v30-validation.test.ts`, so the validated artifact stays attached to the
exact code that produced it.

---

## 2. What runs in the site / Что именно работает в сайте

Per symbol in `v30.symbols`, on every strategy-worker tick:

1. **Corridor first.** A resting `WAITING_ENTRY` signal is advanced over the
   closed bars that followed the setup bar: fill / cancel / expire, in order,
   deterministically. A worker restart cannot change the outcome.
2. **Then detection.** Only the NEWEST closed execution bar is evaluated — never
   a back-fill of missed bars, which would produce signals with a stale entry.
3. **Then the outcome.** The outcome worker walks filled positions bar by bar
   with the same `manageTrade` the research harness uses, writes the milestone
   (`tp1_hit_at`) and finally the `outcomes` row.

Decision rules (frozen, non-configurable — relaxing any of them inflates a
backtest without changing live results):

| rule | content |
|---|---|
| entry | the corridor fills from bar **N+1**, at the **worse** edge (`min(open, zoneHigh)` long, `max(open, zoneLow)` short) |
| expiry | the corridor lives **3 bars** |
| ambiguity | a bar that both touches the corridor and breaches the stop is **cancelled**, never filled |
| R1 | the stop is checked **before** the targets on every bar |
| R2 | if TP1 and TP2 land on one bar, TP1 books first, then TP2 |
| R3 | breakeven arms only on bars **strictly after** the TP1 bar |
| R4 | the stop never moves backwards |
| R5 | the timeout counts the entry bar as bar 1 |

Fees are charged **per leg on that leg's own notional**: maker on the entry,
taker on every exit, and the partial exit means **three legs** (entry + TP1 half +
final half). The `r_multiple` written to the database is **net** of those fees,
because that is the figure the validation headline used; the gross figure, the
fee and the leg count are kept alongside it in `signals.breakdown.v30.lastOutcome`
so the difference is never hidden.

---

## 3. Known divergences from the validated simulator / Известные расхождения

These are stated rather than hidden. Both are consequences of the site being a
live engine rather than a batch replay.

1. **One position per symbol.** A symbol with a live signal is skipped until that
   trade closes. The validated harness resolved a trade by walking the bars ahead
   of the fill and then continued its scan from the fill bar, so it could open a
   new setup while an earlier simulated trade was still in flight. Per-trade
   expectancy is unaffected in expectation (each trade is normalised to its own
   R), but the forward-test **trade rate will be at or below** the validated
   54.7 trades/month. Do not compare raw trade counts.
2. **The strategy selector lists only implemented strategies.** The admin
   specification's dropdown also lists the V2.x candidates. Those exist in this
   repository only as research harnesses (`scripts/real-data/`, `research/`) that
   were never ported into the pipeline; offering them in the site would let an
   operator select a strategy that emits nothing. They are therefore shown as
   **research-only** instead of selectable. See
   [ADMIN_PANEL_SPEC.md](ADMIN_PANEL_SPEC.md) §1.

Additional differences that are *not* divergences but are worth knowing:

- The validated windows are **spent**. Forward testing is the only remaining
  honest source of evidence; it cannot be back-filled with old data.
- The production port is a re-implementation, not the research file. The parity
  harness is what makes that statement checkable; it must be re-run (TRAIN only)
  after any change to `src/strategy/v30/`.

---

## 4. Operating the forward test / Как вести форвард-тест

1. **Mode.** `engine.trading_mode` accepts `DRY_RUN` and `FORWARD_TEST` only;
   `LIVE` is rejected at the API, the settings layer and the engine
   (`assertAllowedMode`). `LIVE_TRADING_ENABLED` is `false` and there is no code
   path in this repository that places an order.
2. **Strategy.** `strategy.active = V3_0` (default). Switching to `V1_SMC` stops
   new V3.0 signals but still manages and closes any position already open —
   an open trade is never abandoned by a setting change.
3. **Configuration.** The admin panel shows a freeze banner. If any `v30.*`
   parameter differs from the validated value, the banner turns red and names the
   keys: the TRAIN/VALIDATION numbers no longer describe what the engine is
   doing, and such a run must not be presented as validated.
4. **What to watch.** Trade count, TP1/TP2 hit rates, realised net R per trade,
   and the fee drag actually paid. The validated expectation is
   ~55 trades/month across six symbols, net **+0.0600 R/trade** — with the
   caveats below.
5. **What must NOT happen.** Running any research slice again (`--slice=validation`
   is spent; the 2026 TEST window has never been read and must stay that way),
   changing a parameter after seeing forward results and calling the result
   validated, or enabling `LIVE`.

---

## 5. Caveats carried into the forward test / Оговорки, перенесённые в форвард

- **Aggregate pass only:** on VALIDATION 3 of 6 symbols were negative
  (BTC −0.0129, SOL −0.0685, XRP −0.0966) and only two symbol cells cleared
  n ≥ 100 — and they disagree in sign.
- **Outlier fragility:** removing the best 5 of 536 trades turns the net negative
  (ex-top-1 % gross +0.0384 is **below** the 0.0673 R fee drag).
- **The pre-registered mechanism was falsified:** the 4H stop did not widen
  (1.28 % vs V2.8's ~1.30 %) and fee drag grew because the partial exit pays three
  legs. The edge's true driver is still unmodelled, so decay should be expected.
- **Decay is real:** gross fell 26 % and net 40 % from TRAIN to VALIDATION. A
  forward-test sample of a few hundred trades is what a later decision would need.
- **Both research windows are spent.** Any parameter change after this point
  produces an untested strategy and cannot be re-validated on the old data.

---

## 6. How to verify / Как это проверить

```bash
npm run typecheck && npm run fixtures && npm test && npm run build

# TRAIN-only parity of the port against the research module (~60 s, needs the
# dataset checkout at ~/.cache/binance-data and a 1h/4h subset cache):
npx tsx scripts/real-data/v30-parity-ingest.ts \
  --dataset=~/.cache/binance-data --cache=~/.cache/v30parity
npx tsx scripts/real-data/v30-parity.ts \
  --cache=~/.cache/v30parity --dataset=~/.cache/binance-data \
  --splits=artifacts/research/v2-real-20260915-080338/splits.json \
  --out=artifacts/research/v30/v30-port-parity.json
```

`tests/v30-port-parity.test.ts` re-checks the committed artifact, so a
regenerated PASS/FAIL cannot be left stale in the repository.

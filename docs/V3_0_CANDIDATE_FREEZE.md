# V3.0 CANDIDATE FREEZE — HTF LIQUIDATION TRAP

**Status: FROZEN CANDIDATE — VALIDATION COMPLETE, `V3_0_VALIDATED_FOR_RESEARCH`.**
The freeze held: the candidate ran exactly as specified, one run, no parameter
changed. Result: [V3_0_VALIDATION_RESULTS.md](V3_0_VALIDATION_RESULTS.md).

**Статус: замороженный кандидат — VALIDATION завершён, `V3_0_VALIDATED_FOR_RESEARCH`.**
Заморозка выдержана: кандидат прогнан ровно как зафиксирован, один прогон, ни один
параметр не изменён.

**Committed BEFORE the VALIDATION replay is run.** No VALIDATION number exists at
the time of this commit. Nothing in this document, and no parameter of the
candidate, may change afterwards.

**Зафиксировано ДО запуска VALIDATION.** На момент этого коммита числа
VALIDATION не существует. Ничто в этом документе и ни один параметр кандидата
не подлежат изменению после этого.

| pinned / зафиксировано | value / значение |
|---|---|
| frozen engine / замороженный движок | `4839074` (`48390748ff1ed1f08b104206c3430142059d7430`) — `src/` byte-identical |
| pre-registration / предрегистрация | `6c2bf9e` |
| TRAIN result / результат TRAIN | `5674e65` — n = 1,585, net +0.0994 @2/5 bps |
| dataset / датасет | `c3c1dce` — Binance Spot klines, 2022-01 … 2025-12 |
| candidate / кандидат | **V3.0 HTF Liquidation Trap** |
| implementation / реализация | `research/v30_htf_trap.ts` — sha256 `a821757ff0319a100a8a9087da1bdd137abb1df0785493d644ad4d87f05dc4cd` |
| metrics artifact / артефакт TRAIN | `artifacts/research/v30/v30-train-metrics.json` — sha256 `bc18ad9612b987678a40551be9ecfb064db5c15a72ebf3ff3d6e7357fca33fec` |
| TRAIN window / окно TRAIN | 2022-01-01T00:00Z … 2024-05-26T13:00Z (1H, per series) |
| **VALIDATION window / окно VALIDATION** | **2024-05-26T14:00Z … 2025-03-14T18:00Z (1H, per series)** — read **once**, 2026-09-16 |
| VALIDATION result / результат | **PASS** — n = 536 · gross +0.1274 · net +0.0600 @2/5 bps · PF 1.2484 |
| TEST (2022–25) | **spent / израсходован — must not be run or inspected** |
| TEST (2026-H1) | **unspent / не тронут, data unavailable** |
| VALIDATION runs allowed / число прогонов VALIDATION | **exactly one / ровно один** — used / израсходован |

---

## 1. The frozen candidate (a)

**V3.0 HTF Liquidation Trap** = confirmed 4H swing sweep + same-candle 1H reclaim +
body/RVOL filters + limit corridor entry + 4H-equilibrium partial exit with
breakeven and timeout. Full rules: [strategies/V3_0_HTF_LIQUIDATION_TRAP.md](strategies/V3_0_HTF_LIQUIDATION_TRAP.md).

### b) Frozen parameters — exact values, no post-hoc adjustment

**Условия и параметры заморожены и не подлежат изменению до завершения
VALIDATION.** All parameters are frozen and may not be changed until VALIDATION
has completed and its result is published.

| Parameter | Value | Source |
|---|---|---|
| `bodyRatioMin` (`MIN_BODY_RATIO`) | **0.35** | `research/v30_htf_trap.ts` |
| `rvolMin` (`MIN_RVOL`, strict `>`) | **1.25** | `research/v30_htf_trap.ts` |
| `corridorATR` (`CORRIDOR_ATR_FRAC`) | **0.10** | `research/v30_htf_trap.ts` |
| `CORRIDOR_EXPIRY_BARS` | **3** | `research/v30_htf_trap.ts` |
| `slBufferATR` (`STOP_BUFFER_ATR`) | **0.15** | `research/v30_htf_trap.ts` |
| `tp1Equilibrium` | **0.50** (range midpoint) | `(swingHigh + swingLow) / 2` |
| `breakevenTrigger` | **`"tp1"`** | stop → entry after TP1 |
| `positionSplitTP1` | **0.50** | hard-coded leg weight |
| `timeoutBars` (`TIMEOUT_BARS`) | **50** | `research/v30_htf_trap.ts` |
| `htfTimeframe` (`STRUCT_TF`) | **`"4h"`** | `research/v30_htf_trap.ts` |
| `ltfTimeframe` (`EXEC_TF`) | **`"1h"`** | `research/v30_htf_trap.ts` |
| `MAKER_BPS` / `TAKER_BPS` | **2 / 5** | fee model, per leg |
| `engine.swing_lookback` | **3** | frozen registry |
| `risk.atr_period` | **14** | frozen registry |
| `v2.volume_period` | **20** | frozen registry |
| intrabar rules R1–R5 | **as registered** | not configurable |
| symbols | **BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT, DOGEUSDT** | all six |

**Frozen in place / что запрещено менять:**

- The values above, and every constant in `research/v30_htf_trap.ts`.
- The 4H pivot causality rule (`confirmedIndex = i + 3`, `closedHtfCandles`).
- The corridor fill semantics (from N+1, worse edge, 3-bar expiry, ambiguity against the trade).
- The exit structure (50 % at 4H equilibrium, stop → breakeven after TP1, remainder at the opposing 4H swing, 50-bar timeout).
- The intrabar rules R1–R5.
- The fee model and the split boundaries.

**The only thing a VALIDATION driver may change is the WINDOW it reads.** A new
runner (e.g. `research/v30_validate.ts`) must **import** the frozen module
unchanged and read `validFromMs` / `validToMs` instead of `trainFromMs` /
`trainToMs`. Before and after the run, `research/v30_htf_trap.ts` must hash to
`a821757f…`, and `git diff 4839074 -- src/` must be empty. Any diff to the
candidate logic invalidates the freeze and the run.

## 2. Pre-registered VALIDATION success criteria (d)

**PASS requires BOTH, under the headline Futures model (2 bps maker entry / 5 bps
taker exit):**

| # | Criterion | Threshold |
|---|---|---|
| **a** | **Net R/trade** at Futures 2/5 bps | **> 0** |
| **b** | **Gross R/trade** | **> 0** |

**Оба критерия обязательны:** (a) Net R/сделку > 0 при комиссиях Futures
2/5 bps; (b) Gross R/сделку > 0.

Reported alongside, as **diagnostics only** (not part of pass/fail): net under the
5/5 bps stress, edge retention after removing the top 1 % (`ex-top-1 %`), TP1/TP2
hit rates, median stop, profit factor, max drawdown, and the direction/symbol
breakdowns with `n` on every row.

**Anything else is FAIL.** No criterion may be relaxed, re-weighted, substituted
or re-interpreted after the numbers are seen. There is exactly **one** VALIDATION
run: no re-runs, no variants, no parameter changes, no "one more look".

Outcome mapping:

- both (a) and (b) met → **`V3_0_VALIDATED_FOR_RESEARCH`**
- otherwise → **`V3_0_NOT_VALIDATED`**

`PRODUCTION_READY` remains **forbidden** either way. Passing VALIDATION would mean
only that the design survived one unseen split — **not** that it is deployable.

## 3. Risks, recorded in advance (c)

1. **The programme's base rate is poor.** Three of the four prior TRAIN-derived
   candidates failed to reproduce out of sample — V2.4 passed TRAIN at +0.2023
   gross and then *inverted* to **−0.1098** on validation. Even V2.8, the one
   candidate that passed, saw gross fall from +0.1462 (TRAIN) to **+0.0488**
   (VALIDATION) — a 67 % decay. **Expect the same decay here.** 3 из 4 предыдущих
   стратегий (выведенных из TRAIN) провалили валидацию; затухание преимущества
   вне выборки — норма, а не исключение.
2. **The sample may be thin.** TRAIN produced 1,585 trades over ~29 months
   (~54/month). VALIDATION covers ~9.6 months, so expect roughly **n ≈ 450–550** —
   about one third of TRAIN. At that size the top-1 % trim removes ~5 trades, and
   several symbol/direction cells will drop below the `n < 100` rule; no such cell
   may decide the verdict. **Выборка может оказаться тонкой.**
3. **The mechanism was falsified even though the result was favourable.** The
   pre-registered reason for the edge (wider 4H stop → smaller fee-in-R) did not
   occur: median stop 1.2520 % vs V2.8's ~1.30 %, and fee drag *worse* at
   0.0732 R vs ~0.0538 R. The observed edge therefore rests on an unexplained
   driver, which makes it more likely to be regime-specific.
4. **Failure to clear the real fee line.** Fee drag at 2/5 bps is 0.0732 R against
   a TRAIN gross of 0.1726 R — a margin of only 0.0994 R. Under 5/5 bps the whole
   margin is 0.0680 R. A modest adverse shift in gross or in stop distance erases
   it. Prior candidates died exactly here.
5. **Post-only fill optimism.** A real post-only order is rejected when it would
   cross; OHLC cannot detect that, so every touch of the corridor is booked as a
   fill. The bias is optimistic, and the TRAIN fill rate of 78.7 % is a large part
   of why TRAIN looks good. The same bias applies to VALIDATION.
6. **Spread and slippage are not modelled** beyond the stated fee schedule.
7. **XRP and DOGE were marginal on TRAIN** (+0.0386, +0.0648). If either turns
   negative it does not by itself fail the run (all six symbols are in scope), but
   it would further erode the margin.
8. **Regime risk.** TRAIN spans 2022-01 … 2024-05; VALIDATION spans
   2024-05 … 2025-03. Different volatility and participation regime.

**The honest prior: a genuine coin-flip, not a formality.** TREAT THIS AS SUCH.

## 4. Protocol constraints for the run

- VALIDATION window only, per-series boundaries from the frozen `splits.json`
  (`validFromMs` … `validToMs`), all 6 symbols, 1H execution with 4H structure.
- **TEST must not be read.** The driver must assert `validToMs < testFromMs`
  before loading a single candle.
- The 2026-H1 window stays unspent and is not downloaded.
- `v2.enabled = false`, `LIVE_TRADING_ENABLED = false`, `src/` untouched
  (`git diff 4839074 -- src/` empty).
- Publish the run artifact under `artifacts/research/v30/` and record the result
  in a new `docs/V3_0_VALIDATION_RESULTS.md`, including the verdict string and the
  full diagnostics above.

## 5. Status

# FREEZE DISCHARGED — `V3_0_VALIDATED_FOR_RESEARCH`

The single authorised run happened on 2026-09-16 and **both criteria passed**
(net +0.0600 @2/5 bps, gross +0.1274, n = 536). Every parameter above is still
frozen **as tested**: the values that produced the PASS are the values recorded
here, and they may not be retro-fitted to either window. The validation budget is
spent — re-reading this window after any change would be fitting and is
forbidden. `PRODUCTION_READY` remains forbidden.

Единственный разрешённый прогон состоялся 2026-09-16, и **оба критерия
выполнены**. Все параметры выше остаются замороженными **ровно как
протестированы**: менять их по итогам любого из окон запрещено. Бюджет
VALIDATION израсходован.

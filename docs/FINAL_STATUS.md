# FINAL STATUS — SMC V2 / V3 RESEARCH PROGRAMME

> **CURRENT PORTFOLIO ARCHITECTURE (2026-09-16).** The programme now has **two
> leaders**, and they are **not** equally evidenced — the distinction is the whole
> point of this section:
>
> | role | strategy | status | engine |
> |---|---|---|---|
> | **Reversal sniper** — fade a swept 4H level | **V3.0 HTF Liquidation Trap** ⭐ | **`V3_0_VALIDATED_FOR_RESEARCH`**: TRAIN +0.0994 (n=1,585) **and** pre-registered VALIDATION **+0.0600** @2/5 bps (n=536) | **running** — default strategy, paper forward test (`FORWARD_TEST`; `LIVE` locked, `PRODUCTION_READY` forbidden) |
> | **High-frequency mitigation** — fade into a fresh displacement-created 4H zone on a 1H exhaustion bar | **V3.3 HTF Zone Mitigation & LTF Squeeze** ⚠️ | **`V3_3_TRAIN_ONLY`**: TRAIN **+0.0267** @2/5 bps (n=6,957), TP1 65.24 %, fee drag 0.0511 R, PF 1.2341 — **never validated** | **not ported** — research harness only; `v33.*` is a proposal in the admin spec, not settings |
>
> **Only V3.0 has passed out-of-sample validation.** V3.3 is the first hypothesis
> since V3.0 to pass its pre-registered **TRAIN** criteria, and it is documented
> and frozen — but TRAIN is burned data (V3.0, V3.1, V3.2 all used it), its edge
> lives in the top 1 % of trades (ex-top-1 % gross **+0.0264** vs a **0.0511 R**
> fee, i.e. net-negative without the tail), the strictest reading of the same
> entry rule (`window=first`) fails the primary criterion (−0.0253), and **no
> unspent validation window remains** — VALIDATION was read once on 2026-09-16 and
> the 2026-H1 TEST window must stay unread. V3.3 is therefore a **queue item for an
> operator decision**, not a second verified winner.
>
> Specs: [strategies/V3_0_HTF_LIQUIDATION_TRAP.md](strategies/V3_0_HTF_LIQUIDATION_TRAP.md) ·
> [strategies/V3_3_HTF_ZONE_MITIGATION.md](strategies/V3_3_HTF_ZONE_MITIGATION.md) ·
> [V3_0_PRODUCTION_PORT.md](V3_0_PRODUCTION_PORT.md) ·
> [V3_3_HTF_ZONE_MITIGATION_TRAIN_RESULTS.md](V3_3_HTF_ZONE_MITIGATION_TRAIN_RESULTS.md) ·
> [STRATEGY_ARCHIVE.md](STRATEGY_ARCHIVE.md) ·
> [ADMIN_PANEL_SPEC.md](ADMIN_PANEL_SPEC.md).
>
> **`PRODUCTION_READY` is forbidden for every strategy in this repository,
> V3.0 and V3.3 included. Neither is approved for live capital.**

> **Historical document — the V2 research phase as it closed.** The programme was
> subsequently reopened: **V3.0 HTF Liquidation Trap** is the current lead
> candidate and is now **`V3_0_VALIDATED_FOR_RESEARCH`** (TRAIN net +0.0994,
> VALIDATION net +0.0600 R/trade @2/5 bps, n = 536); everything below is
> superseded as a recommendation. See
> [strategies/V3_0_HTF_LIQUIDATION_TRAP.md](strategies/V3_0_HTF_LIQUIDATION_TRAP.md),
> [V3_0_CANDIDATE_FREEZE.md](V3_0_CANDIDATE_FREEZE.md),
> [V3_0_VALIDATION_RESULTS.md](V3_0_VALIDATION_RESULTS.md) and
> [V3_0_PRODUCTION_PORT.md](V3_0_PRODUCTION_PORT.md) — V3.0 is now the site's
> default strategy in **paper forward test** (`FORWARD_TEST`; `LIVE` locked,
> `PRODUCTION_READY` forbidden), with the port's equivalence to the research
> module proven trade by trade on TRAIN data.
> [STRATEGY_ARCHIVE.md](STRATEGY_ARCHIVE.md). V2.8 remains the only V2 strategy
> that passed a pre-registered validation — at **zero fees only**.

**Research phase closed.** Final strategy: **V2.8 Zero-Fee Sniper + Trailing**.

| pinned | value |
|---|---|
| frozen engine | `4839074` — `src/` byte-identical throughout |
| final candidate freeze | `852167c` |
| validation result | `1d4d575` — `V2_8_VALIDATED_FOR_RESEARCH` |
| dataset | `c3c1dce` — Binance Spot klines 2022-01 … 2025-12 |
| tests | 1,090 passing |

---

## 1. What was built

A research programme testing whether an SMC (Smart Money Concepts) strategy can
produce a tradeable edge on Binance, evaluated on **16,681,073 real klines**
across 6 symbols × 7 timeframes × 48 months.

**Method, applied to every stage without exception:**

- Chronological TRAIN (60 %) / VALIDATION (20 %) / TEST (20 %) split, frozen
  before the first comparison.
- Every hypothesis **pre-registered and committed before the run** — parameters,
  success criteria and anti-bias checks fixed in advance.
- The trading engine (`src/`) frozen at `4839074` and **never modified**; all
  research lives in `scripts/real-data/` and `research/`.
- Mandatory anti-bias checks each stage: same-entry invariants, outlier
  sensitivity, selection-bias decomposition, and an `n < 100` rule barring thin
  subgroups from supporting conclusions.

## 2. What was tested

Eight strategy generations. Seven rejected, one validated.

| Strategy | Hypothesis | Outcome |
|---|---|---|
| V2.1 | Limit/corridor entry beats market entry | ❌ Fill rate 24 %, tighter stops inflated fee-in-R |
| V2.2 | Fix funnel losses (rr1 rejection, dead reversals) | ❌ Both "fixes" backfired |
| V2.3 | Pure reversal sniper with R-multiple targets | ❌ 77 % of edge in 1 % of trades |
| V2.4 | Asymmetric LONG filter | ❌ Passed TRAIN, **inverted** on validation |
| V2.5 | Trailing exit beats fixed targets | ⚠️ Beat baseline, still net-negative |
| V2.6 | Best entry + best exit | ❌ −0.0092 R/trade after fees |
| V2.7 | Bigger targets dilute commission | ❌ **Arithmetically disproven** |
| **V2.8** | Best entry + best exit at **zero fees** | ✅ **VALIDATED** |

## 3. What was proven

### 3.1 Commission is set by stop distance, not target distance

```
feeR = fee% × price / stopDistance
```

V2.7 measured fee drag at **0.1555 R across all five target levels — spread
0.0000**. The take-profit does not appear in the formula. This invalidates the
common intuition that larger targets dilute commission when expectancy is
measured in R.

### 3.2 The sniper entry filter is the one component with real value

Sweep + body reclaim (`bodyRatio ≥ 0.35`) + volume surge (`rvol > 1.2`) selects
setups with baseline gross **+0.2663** versus **−0.0036** for those it declines,
and cuts max drawdown from **−505.8 R to −32.7 R**.

### 3.3 Entry filtering and exit management do not compose

Trailing alone: **+0.0472**. Trailing on top of the sniper filter: **−0.0028**.
Both harvest the same favourable excursion.

### 3.4 Commission, not signal quality, is the binding constraint

Best gross edge ever measured: **~0.15 R/trade**. Fee drag at Binance futures
rates on the same population: **~0.1555 R/trade**.

### 3.5 TRAIN-derived hypotheses usually fail

Three of four failed to reproduce. V2.4 is the clearest case: it passed every
TRAIN criterion, then inverted out of sample — including its selection filter
becoming *anti*-selective (rejecting the best trades).

## 4. Final recommendation

**V2.8 for zero-fee or full-rebate venues only.**

| Metric | TRAIN | VALIDATION |
|---|---|---|
| n | 317 | 98 |
| Gross R/trade | +0.1462 | **+0.0488** |
| Profit factor | 1.3508 | **1.1087** |
| Win rate | 50.79 % | 44.90 % |
| Max drawdown | −16.16 R | −8.11 R |

Both pre-registered criteria (gross > 0, PF > 1.0) were met on unseen data.

## 5. Known limitations — read before porting

1. **Not profitable at real fees.** Validation gross +0.0488 R against ~0.1555 R
   of drag at 2/5 bps: a deficit of ~0.107 R/trade.
2. **One trade from zero.** At n=98, removing the single best trade flips
   validation gross to **−0.0143**.
3. **Negative median trade** on validation (−0.1270). The average is carried by
   the upper tail.
4. **The SHORT leg inverted.** Stronger in every earlier study; **−0.1525** on
   validation while LONG carried the result.
5. **No subgroup is decisive** — every validation cell has n < 100.
6. **Small absolute sample.** 317 TRAIN / 98 validation trades.
7. **Post-only fills modelled optimistically.** OHLC cannot detect a crossing
   rejection, so fills are assumed whenever price enters the zone.

## 6. Untouched test window — 2026-H1

**Status: UNSPENT.** The final test was pre-registered
(`V2_8_FINAL_UNTOUCHED_TEST_2026_PREREGISTRATION.md`) but **could not run**:

- The frozen dataset ends **2025-12**; no 2026 file exists locally or upstream.
- `data.binance.vision`, `api.binance.com`, `fapi`, Bybit and Kraken all return
  **HTTP 000** (DNS resolves, TCP connects, session filtered) while `github.com`
  returns 200 — a **sandbox egress allowlist**.

Running on an empty window would have produced a meaningless `n = 0` result, and
synthesising data would have burned a single-use window on fabricated input. The
window remains available for exactly one future test.

**To unblock:** allowlist `data.binance.vision`, or update the dataset repo with
2026-01…06 and pin a new commit, or upload the monthly ZIPs manually.

## 7. Instructions for the porting agent

### Port this

| Component | Source | Notes |
|---|---|---|
| Sniper entry filter | `scripts/real-data/v24-engine.ts` → `baseSniper()` | 8 conditions, all required |
| Trailing exit | `scripts/real-data/v25-trailing.ts` → `simulateTrailing()` | Includes intrabar rules R1–R5 |
| Pool-kind recovery | `scripts/real-data/corridor-entry.ts` → `extremePoolKind()` | Reproduces the engine's exact window |
| Fee model | `research/v27_rr_test.ts` → `feeR()` | Per-leg, no rebate |
| Reference runner | `research/v28_gross_only.ts` | Wires it together |

### Do not port

- V2.4's LONG asymmetry (failed validation — known overfit).
- V2.7's RR-target search (arithmetically disproven).
- The Fee Drag Guard as an active gate (removes edge with cost; measured inert).
- The confluence filter (removes ~95 % of setups; duplicates the RVOL gate).

### Preserve these invariants

1. **Never modify the frozen engine.** Verify with `git diff 4839074 -- src/`.
2. **Keep intrabar rules R1–R5 exactly.** Relaxing them inflates backtests
   without changing live results.
3. **Entry is the OPEN of bar N+1**, never the close of bar N — that would be
   look-ahead.
4. **Same-bar SL+TP resolves to SL.**
5. **HTF context must use only closed HTF bars** with
   `closeTime ≤ evaluated bar's closeTime`.
6. **Report `ex-top-1 %` beside every gross figure.** Several strategies looked
   profitable until trimmed.
7. **Never fabricate market data.** Report the blocker instead.

### Recommended first step

Reproduce the V2.8 validation result (n = 98, gross +0.0488, PF 1.1087) in the
new repository before changing anything. If the port cannot reproduce it, the
port is wrong — not the strategy.

## 8. Honest closing assessment

This programme found a **small, fragile, fee-sensitive edge**. V2.8 is the only
strategy that survived out-of-sample testing, and it does so only under a
zero-fee assumption, on 98 trades, with a result that a single trade can erase.

That is a genuine result worth preserving — and it is **not** a deployable
trading system. `PRODUCTION_READY` was forbidden throughout and remains so. The
responsible next step is more data (the untouched 2026-H1 window, once
reachable), not live capital.

---

## PORTFOLIO ARCHITECTURE (added 2026-09-16) / АРХИТЕКТУРА ПОРТФЕЛЯ

**EN.** The programme's outcome is a **two-candidate portfolio with one validated
member**, and this section is the canonical statement of it.

| | **V3.0 — Reversal Sniper** ⭐ | **V3.3 — High-Frequency Mitigation** ⚠️ |
|---|---|---|
| Signal | a confirmed 4H swing is **swept** and the 1H candle closes back behind it (liquidation trap) | price **mitigates a fresh 4H zone** (order block or imbalance, both displacement-created) and the 1H bar prints an exhaustion signature |
| Entry | maker corridor `close ± 0.10 ATR`, fill from N+1 at the worse edge | same corridor mechanics |
| Risk | stop behind the sweep wick + 0.15 ATR | stop behind the **further** of the exhaustion wick and the zone's invalidation edge + 0.15 ATR |
| Targets | TP1 = 4H equilibrium → BE → TP2 = opposing 4H swing | TP1 = equilibrium of the leg that **created** the zone → BE → TP2 = opposing confirmed 4H swing |
| Trade rate | 1,585 over TRAIN (~5.4/month per symbol-scale) | 6,957 over TRAIN (~4.4× more) |
| Status | `V3_0_VALIDATED_FOR_RESEARCH` | `V3_3_TRAIN_ONLY` |
| Engine | **ported, default, paper forward test** | **not ported** |
| Blocker to promotion | none for forward testing; validation windows spent | tail dependence, `first` window fails F1, no validation window, no `v33.*` settings/wiring |
| Next action | keep the forward test running; monitor drift and the caveats below | operator decision; if a forward test is wanted it needs its own pre-registration (primary reading `while` + `protective` + `displacement`, drift monitoring, stopping rule) |

**Why they are complements, not substitutes.** V3.0 fades a **level** and trades
rarely with a large per-trade edge (+0.1726 gross). V3.3 fades a **zone** and
trades often with a small per-trade edge (+0.0778 gross, +0.0267 net). They fire
on different market structures, so the two curves are not the same bet — but
neither is a live recommendation, and V3.3's small net edge sits inside its own
fee drag once the tail is removed.

**What must not happen next.** Do not re-read the VALIDATION window. Do not read
the 2026-H1 TEST window (no data, and it is the last unspent slice). Do not port
V3.3 on the strength of a TRAIN pass. Do not label anything `PRODUCTION_READY`.
Do not present V3.3 as validated, verified or live — the correct phrasing is
*"TRAIN pass, not validated, not implemented in the engine"*.

**RU.** Итог программы — **портфель из двух кандидатов, из которых валидирован
один**, и этот раздел является его канонической формулировкой.

| | **V3.0 — Разворотный снайпер** ⭐ | **V3.3 — Высокочастотная митигация** ⚠️ |
|---|---|---|
| Сигнал | подтверждённый 4H-свинг **снят**, и 1H-свеча закрывается обратно за уровнем (ловушка ликвидности) | цена **митигирует свежую 4H-зону** (ордер-блок или имбаланс, созданные смещением), и 1H-бар печатает сигнатуру истощения |
| Вход | мейкер-коридор `close ± 0.10 ATR`, исполнение с N+1 по худшему краю | та же механика коридора |
| Риск | стоп за тенью выноса + 0.15 ATR | стоп за **дальней** из {тень истощения, край инвалидации зоны} + 0.15 ATR |
| Цели | TP1 = равновесие 4H → безубыток → TP2 = противоположный 4H-свинг | TP1 = равновесие ноги, **создавшей** зону → безубыток → TP2 = противоположный подтверждённый 4H-свинг |
| Частота | 1 585 сделок на TRAIN | 6 957 на TRAIN (в 4.4 раза больше) |
| Статус | `V3_0_VALIDATED_FOR_RESEARCH` | `V3_3_TRAIN_ONLY` |
| Движок | **перенесён, по умолчанию, бумажный форвард-тест** | **не перенесён** |
| Что мешает повышению | для форварда — ничего; окна валидации израсходованы | зависимость от хвоста, `first` проваливает F1, нет окна валидации, нет настроек и проводки `v33.*` |
| Следующее действие | продолжать форвард-тест, следить за дрейфом и оговорками ниже | решение оператора; для форварда нужна своя предрегистрация (основное чтение `while` + `protective` + `displacement`, контроль дрейфа, правило остановки) |

**Почему они дополняют, а не заменяют друг друга.** V3.0 торгует против
**уровня** — редко и с большим преимуществом на сделку (+0.1726 валового). V3.3
торгует против **зоны** — часто и с малым преимуществом (+0.0778 валового,
+0.0267 чистого). Они срабатывают на разных структурах рынка, поэтому их кривые
— не одна и та же ставка; но ни одна из них не является живой рекомендацией, а
малое чистое преимущество V3.3 при удалении хвоста оказывается внутри его же
комиссии.

**Чего нельзя делать дальше.** Не перечитывать окно VALIDATION. Не читать окно
TEST-2026 (данных нет, и это последний неизрасходованный срез). Не переносить
V3.3 в движок на основании прохождения TRAIN. Не помечать ничего как
`PRODUCTION_READY`. Не представлять V3.3 как валидированный, проверенный или
живой — правильная формулировка: «пройден TRAIN, не валидирован, в движке не
реализован».

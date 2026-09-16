# V3.0 HTF LIQUIDATION TRAP — VALIDATION RESULTS

## Verdict: `V3_0_VALIDATED_FOR_RESEARCH` — **PASS**

**Both pre-registered criteria met, on a single run, with the candidate frozen as
tested.** TEST untouched.

| | |
|---|---|
| date | 2026-09-16 |
| slice | **VALIDATION only** (`validFromMs` … `validToMs`, per series) |
| window | **2024-05-26T14:00Z … 2025-03-14T18:00Z** (1H, per series) |
| symbols | BTCUSDT · ETHUSDT · BNBUSDT · SOLUSDT · XRPUSDT · DOGEUSDT |
| execution / structure | 1H execution · 4H structure |
| candidate | frozen in [V3_0_CANDIDATE_FREEZE.md](V3_0_CANDIDATE_FREEZE.md) — **no parameter changed** |
| frozen module | `research/v30_htf_trap.ts` — sha256 `a821757ff0319a100a8a9087da1bdd137abb1df0785493d644ad4d87f05dc4cd` (verified before and after the run) |
| driver | `research/v30_validate.ts` — window selection only; no strategy code |
| artifact | `artifacts/research/v30/v30-validation-metrics.json` |
| runs performed | **exactly one** |

---

## 1. Headline — VALIDATION

| Metric | Value |
|---|---|
| **Trades (n)** | **536** |
| TP1 hit rate | 47.39 % |
| Full TP2 hit rate | 14.18 % |
| Positive-R rate | 48.69 % |
| Median stop distance | 1.2799 % of price (p25 0.8330 % · p75 1.9565 %) |
| **Gross R/trade** | **+0.1274** |
| Fee drag @2/5 bps | 0.0673 R |
| **Net R/trade @2/5 bps** | **+0.0600** ✅ |
| Fee drag @5/5 bps | 0.0962 R |
| **Net R/trade @5/5 bps (stress)** | **+0.0312** ✅ |
| **Profit factor** | **1.2484** |
| **Max drawdown** | **−25.94 R** |
| Median R | −1.0000 |
| Avg win / avg loss | +1.3146 R / −0.9994 R |
| Median bars held | 7 |

### Criteria (fixed in [V3_0_CANDIDATE_FREEZE.md](V3_0_CANDIDATE_FREEZE.md) before the run)

| # | Criterion | Threshold | Result | |
|---|---|---|---|---|
| **a** | Net R/trade @ Futures 2/5 bps | > 0 | **+0.0600** | ✅ **PASS** |
| **b** | Gross R/trade | > 0 | **+0.1274** | ✅ **PASS** |

**Verdict: PASS → `V3_0_VALIDATED_FOR_RESEARCH`.**
`PRODUCTION_READY` remains forbidden: this means the design survived one unseen
split, not that it is deployable.

### Exits

| Reason | Count |
|---|---|
| `SL` | 274 |
| `TP1_THEN_BE` | 157 |
| `TP2` | 76 |
| `TP1_THEN_TIMEOUT` | 21 |
| `TIMEOUT` | 8 |

### Funnel

| Stage | Count |
|---|---|
| Trap signals detected | 691 |
| Corridors published | 691 |
| **Filled** | **536 (77.6 %)** |
| Cancelled (stop before fill / ambiguous bar) | 130 |
| Rejected on geometry | 24 |
| Expired unfilled | 0 |
| Unresolved at the TEST boundary | 1 |

Signal frequency is stable across the two windows: **54.7 trades/month on TRAIN
vs 55.8/month on VALIDATION** — the flow did not thin out.

## 2. TRAIN vs VALIDATION — side by side

| Metric | TRAIN | VALIDATION | Δ |
|---|---|---|---|
| **n** | 1,585 | **536** | −66 % |
| TP1 hit rate | 48.26 % | 47.39 % | −0.87 pp |
| TP2 hit rate | 17.35 % | 14.18 % | −3.17 pp |
| Positive-R rate | 50.73 % | 48.69 % | −2.04 pp |
| Median stop (% of price) | 1.2520 | 1.2799 | +0.03 pp |
| Fee drag @2/5 (R) | 0.0732 | 0.0673 | **−0.0059** |
| **Gross R/trade** | **+0.1726** | **+0.1274** | **−26.2 %** |
| **Net R/trade @2/5** | **+0.0994** | **+0.0600** | **−39.6 %** |
| Net R/trade @5/5 | +0.0680 | +0.0312 | −54.1 % |
| Profit factor | 1.3538 | 1.2484 | −0.105 |
| Max drawdown | −37.18 R | −25.94 R | better |
| Median R | +0.0179 | **−1.0000** | flips |
| Median bars held | 7 | 7 | — |
| Fill rate | 78.7 % | 77.6 % | −1.1 pp |
| **ex-top-1 % gross** | **+0.0983** | **+0.0384** | −61 % |
| **Edge retained after top-1 % trim** | **57.0 %** | **30.1 %** | −26.9 pp |

**Decay is real but survivable.** Gross fell 26 %, net fell 40 % — squarely inside
the range the freeze predicted (V2.8 gross decayed 67 % from TRAIN to VALIDATION).
Fee drag *improved* slightly on validation (0.0673 vs 0.0732 R) because the median
stop was marginally wider.

### Direction

| Direction | TRAIN n · gross | VALIDATION n · gross |
|---|---|---|
| LONG | 796 · +0.1736 | 230 · **+0.0837** |
| SHORT | 789 · +0.1717 | 306 · **+0.1602** |

The TRAIN symmetry did **not** repeat: on VALIDATION the SHORT side carried the
result (+0.1602) at roughly twice the LONG edge (+0.0837). Both remain positive,
so the 4H-trap asymmetry of V2.4 is absent — but the balance has shifted.

### Symbol

| Symbol | TRAIN n · gross | VALIDATION n · gross | |
|---|---|---|---|
| ETHUSDT | 268 · +0.2520 | 101 · **+0.4684** | ✅ n ≥ 100 |
| BNBUSDT | 295 · +0.1387 | 77 · +0.4272 | ⚠️ n < 100 |
| DOGEUSDT | 266 · +0.0648 | 74 · +0.0542 | ⚠️ n < 100 |
| BTCUSDT | 259 · +0.2517 | 107 · **−0.0129** | ❌ n ≥ 100 |
| SOLUSDT | 259 · +0.2841 | 90 · −0.0685 | ⚠️ n < 100 |
| XRPUSDT | 238 · +0.0386 | 87 · −0.0966 | ⚠️ n < 100 |

**This is the weakest part of the result and must not be glossed over:**

- **3 of 6 symbols are negative on validation** (BTC, SOL, XRP), against 0 of 6 on TRAIN.
- **Only two cells clear the `n < 100` rule** — ETHUSDT (+0.4684, n = 101) and BTCUSDT (−0.0129, n = 107). One is strongly positive, the other slightly negative; **the two usable cells disagree in sign.**
- The four remaining symbols (74–90 trades each) are below the rule the pre-registration set, so **none of them may support a conclusion** — neither the three negatives nor BNB's +0.4272.
- The overall PASS therefore rests on ETHUSDT plus sub-100 cells. The pre-registered criteria are aggregate and were met as written; they do not license a per-symbol claim.

## 3. Outlier check

| Measure | TRAIN | VALIDATION |
|---|---|---|
| Gross | +0.1726 | +0.1274 |
| ex-top-1 | +0.1665 | +0.0995 |
| ex-top-5 | +0.1451 | +0.0482 |
| **ex-top-1 % (6 trades)** | **+0.0983** | **+0.0384** |
| **Edge retained** | **57.0 %** | **30.1 %** |

⚠️ **The fragility flag is up.** After removing the best 6 of 536 trades
(1 %), gross falls to **+0.0384** — which is **below** the 0.0673 R fee drag, so
the *trimmed* net is **−0.0289 R**. Against the fee line:

| Sample | Gross | Fee drag @2/5 | Net |
|---|---|---|---|
| All 536 trades | +0.1274 | 0.0673 | **+0.0600** ✅ |
| ex-top-1 (535) | +0.0995 | 0.0673 | +0.0322 ✅ |
| ex-top-5 (531) | +0.0482 | 0.0673 | **−0.0191** ❌ |
| ex-top-1 % (530) | +0.0384 | 0.0673 | **−0.0289** ❌ |

The pre-registered primary criterion refers to the **full** sample, and it passes.
But **five trades out of 536 separate a profitable validation from an unprofitable
one** — the margin over fees is thinner on validation (0.0600) than on TRAIN
(0.0994) and it is not outlier-independent. This is a qualitative regression from
TRAIN, where the same trim left the net positive.

## 4. Protocol compliance and the TEST guard

| Check | Result |
|---|---|
| Parameters changed after seeing TRAIN results | **none** |
| Parameters changed after seeing VALIDATION results | **none** |
| Frozen module sha256 before / after the run | `a821757f…` / `a821757f…` — unchanged |
| `git diff 4839074 -- src/` | **empty** (`src/` tree `8ca9a8c77ecd7aa002080fb05852dc2f1443debd` on both sides) |
| Runs performed | **exactly one** — no re-runs, no variants |
| Candles read with `openTime ≥ testFromMs` | **0** |
| Candles read with `openTime ≥ 2026-01-01` | **0** |
| Maximum candle open time actually read | **2025-03-14T18:00:00Z** = `validToMs` exactly |
| Outcome bars withheld from resolution at the TEST boundary | 42,078 (the TEST segment of each series) |
| TEST (2022–25) | **not read** — clip enforced at `testFromMs` |
| TEST (2026-H1) | **unspent** — not read, not downloaded |
| `v2.enabled` / `LIVE_TRADING_ENABLED` | `false` / `false` |

The guard is enforced by construction (a `while` loop finds the first index at or
beyond `testFromMs` and slices there), asserted per symbol in the artifact, and
throws if a single TEST candle is ever touched.

### Pre-run self-check (parity)

Before the VALIDATION run, the driver was run once on the **TRAIN** slice and its
output compared field-by-field against the frozen
`artifacts/research/v30/v30-train-metrics.json`. **Every shared metric is
identical** — n = 1,585 · TP1 48.26 % · TP2 17.35 % · median stop 1.2520 % · fee
0.0732 R · gross +0.1726 · net +0.0994 · net 5/5 +0.0680 · PF 1.3538 · MaxDD
−37.18 R · all direction and symbol cells. The only differences are two additive
fields (`edgeRetainedPct`, and the `criteria` block that replaces `criterion`).
This proves the driver reproduces the frozen simulator exactly, so the VALIDATION
numbers are comparable to TRAIN by construction.

The dataset was also rebuilt from scratch for this run
(`nub36/svechnoy-suslik-binance-data` @ `c3c1dcecfe2784a147f591f2b5b4526cbf99df9f`,
2016 ZIPs, 16,681,073 candles) and its manifest matches the frozen one **column
for column, zero mismatches**.

### The single unresolved trade

One setup filled near the end of the window (its entry bar is inside VALIDATION)
could not resolve inside the clipped bars, because resolution would have required
TEST candles. It is excluded from all metrics (`unresolved` = 1, exactly as the
frozen runner excludes dataset-boundary trades). Excluding it is the conservative
reading; it is 1 trade of 537 filled, and its direction is unknown by design.

## 5. What this does and does not establish

**Establishes:**
1. The frozen V3.0 rule set produced **positive gross and positive net at realistic
   futures fees on data it had never seen** — the first candidate in this programme
   to do so. Both criteria fixed in advance were met.
2. The edge did not evaporate at the 5/5 bps stress (+0.0312).
3. Signal frequency, fill rate and median stop distance all reproduced closely, so
   the *pipeline* generalised, not just the numbers.

**Does not establish:**
1. **Per-symbol reliability.** 3 of 6 symbols are negative and only two cells clear
   `n < 100`; those two disagree in sign.
2. **Outlier independence.** Removing the best 5 trades flips the net negative
   (§3). TRAIN was far more robust on the same test.
3. **That the mechanism is understood.** The pre-registered thesis (wider 4H stop →
   lower fee-in-R) was falsified on TRAIN and remains falsified: the median stop is
   1.2799 % (not materially wider than V2.8's ~1.30 %) and fee drag is 0.0673 R
   (worse than V2.8's ~0.0538 R, because the partial exit pays three legs). The
   strategy works for a reason that is still not modelled.
4. **Deployability.** No live execution path exists; `PRODUCTION_READY` is
   forbidden; the 2026-H1 window has never been examined.
5. **Statistical strength of a 536-trade, 9.6-month result** on 6 correlated crypto
   pairs in a single regime.

## 6. Next step (not authorised by this document)

The VALIDATION budget is spent. Any further work is a **new** pre-registration,
not a re-run of this one — e.g. a per-symbol or per-direction hypothesis tested on
a freshly frozen design, with its own window discipline. Re-reading this window
after changing anything would be fitting, and is forbidden.

---

# РЕЗЮМЕ — РУССКИЙ

## Вердикт: `V3_0_VALIDATED_FOR_RESEARCH` — **PASS**

**Оба предрегистрированных критерия выполнены на одном прогоне**, кандидат
заморожен ровно как был протестирован, TEST не тронут.

| Метрика | Значение |
|---|---|
| **Сделок (n)** | **536** |
| Винрейт TP1 | 47.39 % |
| Винрейт TP2 | 14.18 % |
| **Gross R/сделку** | **+0.1274** |
| **Net R/сделку @2/5 bps** | **+0.0600** ✅ |
| **Net R/сделку @5/5 bps (стресс)** | **+0.0312** ✅ |
| **Profit Factor** | **1.2484** |
| **Макс. просадка** | **−25.94 R** |
| Медианный стоп | 1.2799 % от цены |
| Плата комиссий @2/5 | 0.0673 R |

| Критерий | Порог | Результат | |
|---|---|---|---|
| (a) Net R/сделку @2/5 bps | > 0 | **+0.0600** | ✅ |
| (b) Gross R/сделку | > 0 | **+0.1274** | ✅ |

**Затухание против TRAIN** предсказуемо и в пределах ожиданий: gross 0.1726 →
0.1274 (−26 %), net 0.0994 → 0.0600 (−40 %). Для сравнения, у V2.8 gross упал на
67 %. Частота сигналов сохранилась (54.7 сделок/мес на TRAIN против 55.8 на
VALIDATION), медианный стоп и fill rate почти совпали — значит генерализуется
сам конвейер, а не только цифры.

**Честные оговорки, без которых этот PASS читать нельзя:**

1. **3 из 6 монет в минусе** (BTC −0.0129, SOL −0.0685, XRP −0.0966), тогда как
   на TRAIN в минусе не было ни одной. Правило «клетка с n < 100 не решает»
   оставляет пригодными всего две: ETHUSDT (+0.4684, n = 101) и BTCUSDT
   (−0.0129, n = 107) — и **они расходятся по знаку**.
2. **Устойчивость к выбросам хуже.** После удаления лучших 6 сделок (1 %)
   gross падает до +0.0384, что **ниже** платы 0.0673 R → нетто становится
   **−0.0289 R**. После удаления лучших 5 сделок нетто уже **−0.0191 R**. Пять
   сделок из 536 отделяют прибыльную валидацию от убыточной. На TRAIN тот же
   тест оставлял нетто положительным.
3. **Механизм по-прежнему опровергнут.** Стоп не расширился (1.2799 % против
   ~1.30 % у V2.8), плата выросла (0.0673 R против ~0.0538 R) — преимущество
   держится на причине, которая пока не смоделирована.
4. **Не для продакшена.** `PRODUCTION_READY` запрещён; окно 2026-H1 не
   просматривалось; повторный прогон этого окна запрещён — бюджет VALIDATION
   израсходован.

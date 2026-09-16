# V3.0 — HTF LIQUIDATION TRAP
# V3.0 — ЛОВУШКА ЛИКВИДНОСТИ НА СТАРШЕМ ТАЙМФРЕЙМЕ

**Status / Статус: `V3_0_PROMISING_PENDING_VALIDATION`** — lead candidate of the
programme. TRAIN passed; VALIDATION not yet run.

**Статус: `V3_0_PROMISING_PENDING_VALIDATION`** — главный кандидат программы.
TRAIN пройден; VALIDATION ещё не запускался.

| pinned / зафиксировано | value / значение |
|---|---|
| frozen engine / замороженный движок | `4839074` (`48390748ff1ed1f08b104206c3430142059d7430`) — `src/` byte-identical |
| pre-registration / предрегистрация | `6c2bf9e` (`6c2bf9e3302dff59eb226285f3fa7f419b5c1f64`) |
| TRAIN results commit / коммит результатов TRAIN | `5674e65` |
| dataset / датасет | `c3c1dce` (`c3c1dcecfe2784a147f591f2b5b4526cbf99df9f`) — Binance Spot klines, 2022-01 … 2025-12 |
| implementation / реализация | `research/v30_htf_trap.ts` (sha256 `a821757ff0319a100a8a9087da1bdd137abb1df0785493d644ad4d87f05dc4cd`) |
| tests / тесты | `tests/v30-htf-trap.test.ts` |
| metrics artifact / артефакт метрик | `artifacts/research/v30/v30-train-metrics.json` (sha256 `bc18ad9612b987678a40551be9ecfb064db5c15a72ebf3ff3d6e7357fca33fec`) |
| TRAIN window / окно TRAIN | per series 1H: `2022-01-01T00:00:00Z` … `2024-05-26T13:00:00Z` (21,037 candles/symbol) |
| VALIDATION window / окно VALIDATION | per series 1H: `2024-05-26T14:00:00Z` … `2025-03-14T18:00:00Z` — **UNTOUCHED / НЕ ТРОГАЛИ** |
| TEST (2022–25) | **spent / израсходован** |
| TEST (2026-H1) | **unspent, no data / не тронут, данных нет** |

**The first strategy in this programme to be net-positive at realistic Binance
futures fees.** TRAIN only. Frozen parameter set — see
[V3_0_CANDIDATE_FREEZE.md](../V3_0_CANDIDATE_FREEZE.md).
**Ни один параметр ниже не изменялся после получения результатов.**

---

# PART A — ENGLISH

## A1. The idea

Price **pierces a significant 4-hour high or low** (a confirmed 4H Swing
High/Low), **sweeping the crowd's stops**. On the 1-hour chart the same candle
then **closes back behind that level** — a failed breakout, a liquidation trap.
We take the trade **in the direction of the reclaim**, and target the movement
back to the **opposite boundary of the 4H range**.

```
4H  ── swing high ────────────────┐  stops rest just above
                                  │
1H                    ▲ wick pierces the level      ← liquidity taken
                      │ body closes back below      ← Reclaim (same bar)
                      ▼
      entry corridor = close(N) ± 0.10 × ATR(1H,14)   → SHORT
      stop  = sweep high + 0.15 × ATR
      TP1   = 50 % of the active 4H range (Equilibrium) → close 50 %, stop → BE
      TP2   = opposing 4H swing level (the swing low)   → close the remainder
      timeout = 50 × 1H bars
```

This is a **mean-reversion trap**, not a breakout. Sweeping a 4H **high** and
reclaiming → **SHORT**. Sweeping a 4H **low** and reclaiming → **LONG**.

**Registered thesis (and how it turned out):** the pre-registration argued V3.0
would beat fees by *widening the stop* (`feeR = fee% × price / stopDistance`).
That mechanism was **falsified** — the median stop came in at 1.2520 % versus
V2.8's ~1.30 %, and fee drag got *worse* (0.0732 R vs ~0.0538 R) because the
partial exit charges three legs. The edge actually came from a higher gross
(+0.1726 vs +0.1462) and a **5× larger sample** (1,585 vs 317 trades). See §A8.

## A2. Entry rules — EN

| # | Condition | Exact implementation |
|---|---|---|
| 1 | **A confirmed 4H swing exists** | frozen `findSwingsV2(candles4h, strength = engine.swing_lookback = 3)`. A pivot at bar `i` is usable only from `confirmedIndex = i + 3` (3 right-bars printed), and only from 4H bars that had already closed by the 1H bar's close time (`closedHtfCandles`). Using an unconfirmed pivot is look-ahead and is forbidden. |
| 2 | **Sweep (pierce)** | SHORT setup: 1H `high > 4H swing high`. LONG setup: 1H `low < 4H swing low`. |
| 3 | **Reclaim (same candle)** | SHORT: the same 1H candle `close < 4H swing high`. LONG: the same 1H candle `close > 4H swing low`. V3.0 requires pierce **and** reclaim on **one** candle — there is no multi-bar reclaim window (V2.x allowed 3 bars). |
| 4 | **Body of the reclaim candle** | `bodyRatio = |close − open| / (high − low) ≥ 0.35` (a decisive reclaim, not a wick). |
| 5 | **Volume of the reclaim candle** | `RVOL > 1.25` (strict `>`), `RVOL = volume / SMA(volume, 20)`. Note 1.25 here, deliberately different from V2.x's 1.2. |
| 6 | **Entry order** | **Limit corridor** centred on the reclaim candle: `centre = close(N)`, `halfWidth = 0.10 × ATR(1H, 14)` at bar N, `zone = [centre − halfWidth, centre + halfWidth]`. |

**Corridor fill semantics (frozen, conservative):**

- Fills only from bar **N+1** onward — never on the reclaim bar itself.
- Fill at the **worse edge**: LONG at `min(open, zoneHigh)`, SHORT at `max(open, zoneLow)`. Never the midpoint.
- Zone unfilled after **3 bars** → `EXPIRED`.
- Stop breached before a fill → `CANCELLED`.
- A single bar that both fills and breaches the stop → `CANCELLED` (unfavourable reading).
- If after the fill the geometry does not hold (stop on the wrong side, or TP1 not strictly between fill and TP2 on the profit side) → `REJECTED_GEOMETRY`.

## A3. Exit rules — EN

Let `E` = fill price, `S` = stop, `R = |E − S|`.

| Element | Rule |
|---|---|
| **Stop-loss** | Behind the sweep wick **+ 0.15 × ATR(1H, 14)**. LONG: `sweepLow − 0.15·ATR`; SHORT: `sweepHigh + 0.15·ATR`. |
| **TP1** | **50 % of the active 4H range = Equilibrium** = `(4H swingHigh + 4H swingLow) / 2`. Close **50 %** of the position. |
| **Breakeven** | Arming trigger = **TP1** (`breakevenTrigger = "tp1"`). Once TP1 fills, the stop on the remaining 50 % moves to **`E`** (entry price). |
| **TP2** | The **opposing 4H swing level** (LONG: the 4H swing high; SHORT: the 4H swing low). Close the remaining 50 %. |
| **Timeout** | If neither TP nor SL has resolved within **50 × 1H bars**, close the remainder at that bar's CLOSE. Rule **R5**: the entry bar counts as bar 1. |

**Position accounting:** realised R = `0.5 × R(TP1 leg) + 0.5 × R(final leg)`.
Fees are charged **per leg on that leg's own notional** — maker entry (2 bps),
taker exit on each closing leg (5 bps). A partial exit therefore pays **three**
legs (entry, TP1 exit, final exit), not two.

Recorded exit reasons (`ExitReason`): `SL` · `TP1_THEN_BE` · `TP1_THEN_SL` ·
`TP2` · `TP1_THEN_TIMEOUT` · `TIMEOUT`.

## A4. Intrabar rules — fixed in advance, all conservative

- **R1** — the stop is checked **before** the targets on every bar. A bar that touches both books the **stop**.
- **R2** — if TP1 and TP2 fall on the same bar, TP1 books first, then TP2.
- **R3** — breakeven arms only on bars **strictly after** the TP1 bar.
- **R4** — the stop never moves backwards.
- **R5** — the timeout counts the entry bar as bar 1.

Relaxing any of R1–R5 would inflate the backtest without changing live results.
They are **not** configurable and must not be exposed in the admin panel.

## A5. Parameters — admin panel surface — EN

These are the frozen values. In the research implementation they are
compile-time constants in `research/v30_htf_trap.ts`; exposing them as UI
settings requires wiring and is **forbidden until VALIDATION completes**.

| Parameter | Type | Default | Min | Max | Description |
|---|---|---|---|---|---|
| `bodyRatioMin` | number | **0.35** | 0.10 | 0.80 | Minimum body/range of the reclaim candle. |
| `rvolMin` | number | **1.25** | 1.00 | 3.00 | Minimum volume surge (strict `>`). |
| `corridorATR` | number | **0.10** | 0.02 | 0.30 | Entry corridor half-width, in ATR. |
| `slBufferATR` | number | **0.15** | 0.05 | 0.50 | Stop buffer beyond the sweep wick, in ATR. |
| `tp1Equilibrium` | number | **0.50** | 0.25 | 0.75 | Share of the 4H range used for TP1 (0.50 = midpoint/equilibrium). |
| `breakevenTrigger` | string | **"tp1"** | — | — | When to move the stop to breakeven. |
| `timeoutBars` | number | **50** | 10 | 100 | Timeout in 1H bars. |
| `positionSplitTP1` | number | **0.50** | 0.25 | 0.75 | Fraction of the position closed at TP1. |
| `htfTimeframe` | enum | **"4h"** | `"1h"`, `"4h"`, `"1d"` | — | Higher timeframe supplying the levels. |
| `ltfTimeframe` | enum | **"1h"** | `"15m"`, `"30m"`, `"1h"` | — | Working timeframe for the entry. |

### Mapping to code, and the rest of the frozen constant set

| Admin parameter | Code constant / expression |
|---|---|
| `bodyRatioMin` | `MIN_BODY_RATIO = 0.35` |
| `rvolMin` | `MIN_RVOL = 1.25` |
| `corridorATR` | `CORRIDOR_ATR_FRAC = 0.10` |
| `slBufferATR` | `STOP_BUFFER_ATR = 0.15` |
| `tp1Equilibrium` | `(levels.swingHigh + levels.swingLow) / 2` (midpoint = 0.50 of the range) |
| `breakevenTrigger` | hard-coded: stop → `entry` after TP1 |
| `timeoutBars` | `TIMEOUT_BARS = 50` |
| `positionSplitTP1` | hard-coded leg weight `0.5` |
| `htfTimeframe` | `STRUCT_TF = '4h'` |
| `ltfTimeframe` | `EXEC_TF = '1h'` |

Also part of the frozen candidate (not swept, must not change):

| Constant | Value | Role |
|---|---|---|
| `CORRIDOR_EXPIRY_BARS` | **3** | Corridor lifetime before `EXPIRED`. |
| `MAKER_BPS` / `TAKER_BPS` | **2 / 5** | Per-leg fee model (maker entry, taker exit). |
| `engine.swing_lookback` | **3** | Pivot strength on 4H (`confirmedIndex = i + 3`). |
| `risk.atr_period` | **14** | ATR period (corridor, stop buffer). |
| `v2.volume_period` | **20** | RVOL averaging window. |
| one position at a time | — | Per series; no overlapping trades. |

## A6. TRAIN results — EN (verbatim from `artifacts/research/v30/v30-train-metrics.json`)

| Metric | Value |
|---|---|
| **Trades (n)** | **1,585** |
| TP1 hit rate | 48.26 % |
| TP2 hit rate | 17.35 % |
| Positive-R rate | 50.73 % |
| **Median stop distance** | **1.2520 % of price** (p25 0.7848 %, p75 1.9874 %) |
| **Gross R/trade** | **+0.1726** |
| Fee drag @2/5 bps | 0.0732 R |
| **Net R/trade @2/5 bps (headline)** | **+0.0994** ✅ |
| Fee drag @5/5 bps (stress) | 0.1046 R |
| Net R/trade @5/5 bps (stress) | +0.0680 |
| **Profit factor** | **1.3538** |
| Max drawdown | **−37.18 R** |
| Median R | +0.0179 |
| Average win / loss | +1.3022 R / −0.9901 R |
| Median bars held | 7 |

**All six symbols positive, longs ≈ shorts:**

| Direction | n | Gross R/trade |
|---|---|---|
| LONG | 796 | +0.1736 |
| SHORT | 789 | +0.1717 |

| Symbol | n | Gross R/trade |
|---|---|---|
| SOLUSDT | 259 | +0.2841 |
| ETHUSDT | 268 | +0.2520 |
| BTCUSDT | 259 | +0.2517 |
| BNBUSDT | 295 | +0.1387 |
| DOGEUSDT | 266 | +0.0648 |
| XRPUSDT | 238 | +0.0386 |

**Funnel**

| Stage | Count |
|---|---|
| Trap signals detected | 2,015 |
| Corridors published | 2,015 |
| **Filled** | **1,585 (78.7 %)** |
| Cancelled (stop before fill / ambiguous bar) | 330 |
| Rejected on geometry | 100 |
| Expired unfilled | 0 |

**Exits:** `SL` 772 · `TP1_THEN_BE` 410 · `TP2` 275 · `TP1_THEN_TIMEOUT` 80 · `TIMEOUT` 48.

**Robustness**

| Measure | Value |
|---|---|
| Gross | +0.1726 |
| ex-top-1 | +0.1665 |
| ex-top-5 | +0.1451 |
| **ex-top-1 % (16 trades removed)** | **+0.0983** |
| **Edge retained** | **57.0 %** |

**Pre-registered criteria — all three met:**

| Requirement | Result |
|---|---|
| Primary: net > 0 @2/5 bps | **+0.0994** ✅ |
| Robustness 1: gross > 0 after trimming the top 1 % | **+0.0983** ✅ |
| Robustness 2: net > 0 under the 5/5 stress | **+0.0680** ✅ |

## A7. How to reproduce the TRAIN run — EN

```bash
npx tsx research/v30_htf_trap.ts \
  --cache=<binary candle cache dir> \
  --splits=artifacts/research/v2-real-20260915-080338/splits.json \
  --out=artifacts/research/v30/v30-train-metrics.json
```

The runner reads the **TRAIN** boundaries (`trainFromMs` / `trainToMs`) only.
The candle cache is rebuilt from the dataset repo
(`nub36/svechnoy-suslik-binance-data` @ `c3c1dce`) and lives outside the project
tree. `tests/v30-htf-trap.test.ts` pins the constants, the causality of the 4H
pivot (`confirmedIndex`) and the R1–R5 intrabar rules.

## A8. Honest caveats — EN

1. **TRAIN only.** V2.4 passed TRAIN with +0.2023 gross and *inverted* to −0.1098 out of sample. Nothing here is proven until VALIDATION passes.
2. **The registered mechanism was falsified.** The strategy won, but not for the reason pre-registered (stop width / fee-in-R). The stop did not widen (1.2520 % vs V2.8's ~1.30 %) and fee drag worsened (0.0732 R vs ~0.0538 R). An unexpected win is weaker evidence than a predicted one, because the model of *why* it works is not yet correct.
3. **Margin over fees is real but not large** — 0.1726 gross against 0.0732 drag. Under 5/5 bps stress it narrows to +0.0680.
4. **Post-only fill optimism.** A real post-only order can be rejected when it would cross; OHLC cannot detect that, so a fill is assumed whenever price enters the corridor. The bias is optimistic.
5. **Spread and slippage are not modelled** beyond the stated fee schedule.
6. **XRP and DOGE are marginal** (+0.0386, +0.0648) — barely above the fee line.
7. Not production-ready. `PRODUCTION_READY` is forbidden; `v2.enabled = false`, `LIVE_TRADING_ENABLED = false`.

---

# PART B — РУССКИЙ

## B1. Идея стратегии

Цена **пробивает значимый 4-часовой максимум или минимум** (подтверждённый 4H
Swing High/Low), **выбивая стопы толпы**. Затем на 1-часовом графике та же
свеча **закрывается обратно за этим уровнем** — ложный пробой, ловушка
ликвидности. Мы входим **в сторону возврата** и забираем движение к
**противоположной границе диапазона**.

```
4H  ── swing high ────────────────┐  стопы стоят чуть выше
                                  │
1H                    ▲ тень пробивает уровень      ← снятие ликвидности
                      │ тело закрывается обратно    ← Reclaim (та же свеча)
                      ▼
      коридор входа = close(N) ± 0.10 × ATR(1H,14)   → SHORT
      стоп = максимум выноса + 0.15 × ATR
      TP1  = 50 % активного 4H ренджа (Equilibrium) → закрыть 50 %, стоп → BE
      TP2  = противоположный 4H Swing уровень       → закрыть остаток
      таймаут = 50 свечей 1H
```

Это **контртрендовая ловушка**, а не пробой. Вынос 4H **максимума** с возвратом
→ **SHORT**. Вынос 4H **минимума** с возвратом → **LONG**.

**Зарегистрированная гипотеза (и что вышло):** предрегистрация утверждала, что
V3.0 победит комиссии за счёт *расширения стопа* (`feeR = fee% × price /
stopDistance`). Этот механизм **опровергнут**: медианный стоп составил 1.2520 %
против ~1.30 % у V2.8, а плата за комиссии стала *хуже* (0.0732 R против
~0.0538 R), потому что частичный выход оплачивает три плеча. Реальный источник
преимущества — более высокий gross (+0.1726 против +0.1462) и **выборка в 5 раз
больше** (1 585 против 317 сделок). См. §B8.

## B2. Правила входа — RU

| # | Условие | Точная реализация |
|---|---|---|
| 1 | **Есть подтверждённый 4H Swing** | замороженный `findSwingsV2(candles4h, strength = engine.swing_lookback = 3)`. Пивот на свече `i` доступен только начиная с `confirmedIndex = i + 3` (напечатаны 3 правые свечи) и только по 4H свечам, которые успели закрыться к моменту закрытия 1H свечи (`closedHtfCandles`). Использовать неподтверждённый пивот — это заглядывание в будущее, оно запрещено. |
| 2 | **Sweep (пробой)** | SHORT: `high` 1H свечи > 4H swing high. LONG: `low` 1H свечи < 4H swing low. |
| 3 | **Reclaim (возврат за уровень)** | SHORT: та же 1H свеча закрывается `close < 4H swing high`. LONG: та же 1H свеча закрывается `close > 4H swing low`. В V3.0 пробой и возврат обязаны произойти на **одной** свече — окна на несколько свечей нет (в V2.x допускалось 3 свечи). |
| 4 | **Тело свечи возврата** | `bodyRatio = |close − open| / (high − low) ≥ 0.35` — решительный возврат, а не просто тень. |
| 5 | **Объём свечи возврата** | `RVOL > 1.25` (строго `>`), где `RVOL = volume / SMA(volume, 20)`. Здесь именно 1.25, что намеренно отличается от 1.2 в V2.x. |
| 6 | **Ордер на вход** | **Лимитный коридор** вокруг свечи возврата: `центр = close(N)`, `полуширина = 0.10 × ATR(1H, 14)` на свече N, `зона = [центр − полуширина, центр + полуширина]`. |

**Семантика исполнения коридора (заморожена, консервативна):**

- Исполнение только с свечи **N+1** и позже — никогда на самой свече возврата.
- Цена исполнения — **худшая граница**: LONG по `min(open, zoneHigh)`, SHORT по `max(open, zoneLow)`. Никогда по середине.
- Зона не исполнена за **3 свечи** → `EXPIRED`.
- Стоп пробит до исполнения → `CANCELLED`.
- Одна свеча, которая и исполнила ордер, и пробила стоп → `CANCELLED` (неблагоприятное чтение).
- Если после исполнения геометрия не выполняется (стоп с неверной стороны, либо TP1 не лежит строго между ценой входа и TP2 со стороны прибыли) → `REJECTED_GEOMETRY`.

## B3. Правила выхода — RU

Пусть `E` = цена входа, `S` = стоп, `R = |E − S|`.

| Элемент | Правило |
|---|---|
| **Стоп-лосс** | За тенью выноса **+ 0.15 × ATR(1H, 14)**. LONG: `sweepLow − 0.15·ATR`; SHORT: `sweepHigh + 0.15·ATR`. |
| **TP1** | **50 % диапазона активного 4H ренджа = Equilibrium** = `(4H swingHigh + 4H swingLow) / 2`. Закрываем **50 %** позиции. |
| **Безубыток** | Триггер = **TP1** (`breakevenTrigger = "tp1"`). После исполнения TP1 стоп по оставшимся 50 % переносится на **`E`** (цену входа). |
| **TP2** | **Противоположный 4H Swing уровень** (для LONG — 4H swing high, для SHORT — 4H swing low). Закрываем остаток 50 %. |
| **Таймаут** | Если за **50 свечей 1H** ни TP, ни SL не сработали — закрываем остаток по CLOSE этой свечи. Правило **R5**: свеча входа считается свечой 1. |

**Учёт позиции:** реализованный R = `0.5 × R(плечо TP1) + 0.5 × R(финальное
плечо)`. Комиссии берутся **за каждое плечо с его собственного нотионала**:
вход мейкером (2 bps), выход тейкером на каждом закрывающем плече (5 bps).
Частичный выход поэтому оплачивает **три** плеча (вход, выход по TP1, финальный
выход), а не два.

Записанные причины выхода (`ExitReason`): `SL` · `TP1_THEN_BE` · `TP1_THEN_SL` ·
`TP2` · `TP1_THEN_TIMEOUT` · `TIMEOUT`.

## B4. Внутрисвечные правила — зафиксированы заранее, все консервативны

- **R1** — стоп проверяется **раньше** целей на каждой свече. Свеча, коснувшаяся и стопа и цели, закрывается **по стопу**.
- **R2** — если TP1 и TP2 попадают на одну свечу, сначала фиксируется TP1, затем TP2.
- **R3** — безубыток включается только на свечах **строго после** свечи TP1.
- **R4** — стоп никогда не двигается назад.
- **R5** — таймаут считает свечу входа свечой 1.

Ослабление любого из R1–R5 раздувает бэктест, не меняя реальных результатов.
Эти правила **не** настраиваются и не должны выноситься в админ-панель.

## B5. Параметры — поверхность админ-панели — RU

Это замороженные значения. В исследовательской реализации это compile-time
константы в `research/v30_htf_trap.ts`; их вынос в настройки интерфейса требует
доработки и **запрещён до завершения VALIDATION**.

| Параметр | Тип | Дефолт | Мин | Макс | Описание |
|----------|-----|--------|-----|------|----------|
| `bodyRatioMin` | number | 0.35 | 0.10 | 0.80 | Мин. размер тела свечи возврата |
| `rvolMin` | number | 1.25 | 1.00 | 3.00 | Мин. всплеск объёма |
| `corridorATR` | number | 0.10 | 0.02 | 0.30 | Ширина коридора входа в ATR |
| `slBufferATR` | number | 0.15 | 0.05 | 0.50 | Буфер стоп-лосса за тенью |
| `tp1Equilibrium` | number | 0.50 | 0.25 | 0.75 | Доля ренджа для TP1 |
| `breakevenTrigger` | string | "tp1" | - | - | Когда переносить стоп в безубыток |
| `timeoutBars` | number | 50 | 10 | 100 | Таймаут в свечах |
| `positionSplitTP1` | number | 0.50 | 0.25 | 0.75 | Доля позиции для закрытия на TP1 |
| `htfTimeframe` | enum | "4h" | "1h","4h","1d" | - | Старший ТФ для уровней |
| `ltfTimeframe` | enum | "1h" | "15m","30m","1h" | - | Рабочий ТФ для входа |

### Соответствие параметров коду и остальные замороженные константы

| Параметр админки | Константа / выражение в коде |
|---|---|
| `bodyRatioMin` | `MIN_BODY_RATIO = 0.35` |
| `rvolMin` | `MIN_RVOL = 1.25` |
| `corridorATR` | `CORRIDOR_ATR_FRAC = 0.10` |
| `slBufferATR` | `STOP_BUFFER_ATR = 0.15` |
| `tp1Equilibrium` | `(levels.swingHigh + levels.swingLow) / 2` (середина = 0.50 ренджа) |
| `breakevenTrigger` | зашито: стоп → `entry` после TP1 |
| `timeoutBars` | `TIMEOUT_BARS = 50` |
| `positionSplitTP1` | зашитый вес плеча `0.5` |
| `htfTimeframe` | `STRUCT_TF = '4h'` |
| `ltfTimeframe` | `EXEC_TF = '1h'` |

Также входит в замороженный кандидат (не перебиралось, менять нельзя):

| Константа | Значение | Роль |
|---|---|---|
| `CORRIDOR_EXPIRY_BARS` | **3** | Срок жизни коридора до `EXPIRED`. |
| `MAKER_BPS` / `TAKER_BPS` | **2 / 5** | Модель комиссии по плечам (вход мейкер, выход тейкер). |
| `engine.swing_lookback` | **3** | Сила пивота на 4H (`confirmedIndex = i + 3`). |
| `risk.atr_period` | **14** | Период ATR (коридор, буфер стопа). |
| `v2.volume_period` | **20** | Окно усреднения объёма для RVOL. |
| одна позиция за раз | — | На серию; пересекающихся сделок нет. |

## B6. Результаты TRAIN — RU (дословно из `artifacts/research/v30/v30-train-metrics.json`)

| Метрика | Значение |
|---|---|
| **Сделок (n)** | **1 585** |
| Винрейт TP1 | 48.26 % |
| Винрейт TP2 | 17.35 % |
| Доля сделок с положительным R | 50.73 % |
| **Медианный стоп** | **1.2520 % от цены** (p25 0.7848 %, p75 1.9874 %) |
| **Gross R/сделку** | **+0.1726** |
| Плата комиссий @2/5 bps | 0.0732 R |
| **Net R/сделку @2/5 bps (основная метрика)** | **+0.0994** ✅ |
| Плата комиссий @5/5 bps (стресс) | 0.1046 R |
| Net R/сделку @5/5 bps (стресс) | +0.0680 |
| **Profit Factor** | **1.3538** |
| Максимальная просадка | **−37.18 R** |
| Медианный R | +0.0179 |
| Средний выигрыш / проигрыш | +1.3022 R / −0.9901 R |
| Медианное удержание | 7 свечей |

**Все шесть монет в плюсе, лонги ≈ шорты:**

| Направление | n | Gross R/сделку |
|---|---|---|
| LONG | 796 | +0.1736 |
| SHORT | 789 | +0.1717 |

| Монета | n | Gross R/сделку |
|---|---|---|
| SOLUSDT | 259 | +0.2841 |
| ETHUSDT | 268 | +0.2520 |
| BTCUSDT | 259 | +0.2517 |
| BNBUSDT | 295 | +0.1387 |
| DOGEUSDT | 266 | +0.0648 |
| XRPUSDT | 238 | +0.0386 |

**Воронка**

| Этап | Количество |
|---|---|
| Обнаружено сигналов-ловушек | 2 015 |
| Опубликовано коридоров | 2 015 |
| **Исполнено** | **1 585 (78.7 %)** |
| Отменено (стоп до входа / неоднозначная свеча) | 330 |
| Отклонено по геометрии | 100 |
| Истёк срок без входа | 0 |

**Выходы:** `SL` 772 · `TP1_THEN_BE` 410 · `TP2` 275 · `TP1_THEN_TIMEOUT` 80 · `TIMEOUT` 48.

**Устойчивость**

| Мера | Значение |
|---|---|
| Gross | +0.1726 |
| Без топ-1 сделки | +0.1665 |
| Без топ-5 сделок | +0.1451 |
| **Без топ-1 % (убрано 16 сделок)** | **+0.0983** |
| **Сохранённое преимущество** | **57.0 %** |

**Предрегистрированные критерии — выполнены все три:**

| Требование | Результат |
|---|---|
| Основной: net > 0 @2/5 bps | **+0.0994** ✅ |
| Устойчивость 1: gross > 0 после отсечения топ-1 % | **+0.0983** ✅ |
| Устойчивость 2: net > 0 в стрессе 5/5 | **+0.0680** ✅ |

## B7. Как воспроизвести TRAIN — RU

```bash
npx tsx research/v30_htf_trap.ts \
  --cache=<каталог бинарного кэша свечей> \
  --splits=artifacts/research/v2-real-20260915-080338/splits.json \
  --out=artifacts/research/v30/v30-train-metrics.json
```

Раннер читает только границы **TRAIN** (`trainFromMs` / `trainToMs`). Кэш свечей
пересобирается из репозитория данных
(`nub36/svechnoy-suslik-binance-data` @ `c3c1dce`) и лежит вне дерева проекта.
Файл `tests/v30-htf-trap.test.ts` фиксирует константы, причинность 4H пивота
(`confirmedIndex`) и внутрисвечные правила R1–R5.

## B8. Честные оговорки — RU

1. **Только TRAIN.** Стратегия V2.4 прошла TRAIN с gross +0.2023, а вне выборки *инвертировалась* в −0.1098. Пока VALIDATION не пройден, ничего не доказано.
2. **Зарегистрированный механизм опровергнут.** Стратегия выиграла, но не по той причине, что была зарегистрирована (ширина стопа / fee-in-R). Стоп не расширился (1.2520 % против ~1.30 % у V2.8), а плата за комиссии даже выросла (0.0732 R против ~0.0538 R). Неожиданный выигрыш — более слабое доказательство, чем предсказанный: модель того, *почему* это работает, пока неверна.
3. **Запас над комиссиями реальный, но небольшой** — 0.1726 gross против 0.0732 платы. В стрессе 5/5 он сжимается до +0.0680.
4. **Оптимизм post-only исполнения.** Реальный post-only ордер может быть отклонён, если он пересёк бы рынок; по OHLC это не определить, поэтому исполнение предполагается всегда, когда цена вошла в коридор. Смещение — в оптимистичную сторону.
5. **Спред и проскальзывание не моделируются** сверх указанной сетки комиссий.
6. **XRP и DOGE — маргинальны** (+0.0386, +0.0648) — едва выше линии комиссий.
7. Не для продакшена. `PRODUCTION_READY` запрещён; `v2.enabled = false`, `LIVE_TRADING_ENABLED = false`.

---

## Next step / Следующий шаг

One VALIDATION run over the untouched window `2024-05-26T14:00Z … 2025-03-14T18:00Z`,
with the candidate frozen exactly as tested. Success criteria and risks:
[V3_0_CANDIDATE_FREEZE.md](../V3_0_CANDIDATE_FREEZE.md).
Один прогон VALIDATION на нетронутом окне, с кандидатом, замороженным ровно
таким, каким он был протестирован. Критерии успеха и риски — там же.

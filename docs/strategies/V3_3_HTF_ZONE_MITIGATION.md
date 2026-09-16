# V3.3 — HTF ZONE MITIGATION & LTF SQUEEZE
# V3.3 — МИТИГАЦИЯ ЗОНЫ НА СТАРШЕМ ТАЙМФРЕЙМЕ И СЖАТИЕ НА МЛАДШЕМ

**Status / Статус: `V3_3_TRAIN_ONLY`** — the pre-registered primary variant
**passed all three registered criteria on TRAIN** (net **+0.0267 R/trade**
@2/5 bps, n = 6,957, TP1 hit 65.24 %, fee drag 0.0511 R). It is **NOT validated**
and **NOT ported into the engine**. TRAIN is burned data (V3.0, V3.1 and V3.2 all
used it), the single VALIDATION window was spent on 2026-09-16 and may never be
re-read, and the 2026-H1 TEST window must stay unread — so **no validation on
existing data is possible**.

**Статус: `V3_3_TRAIN_ONLY`** — предрегистрированный основной вариант **прошёл
все три зарегистрированных критерия на TRAIN** (net **+0.0267 R/сделку** @2/5 bps,
n = 6 957, TP1 65.24 %, комиссия 0.0511 R). Он **НЕ валидирован** и **НЕ перенесён
в движок**. TRAIN — израсходованные данные (их использовали V3.0, V3.1 и V3.2),
единственное окно VALIDATION потрачено 16.09.2026 и не может быть прочитано
повторно, а окно TEST-2026 должно остаться непрочитанным — поэтому **валидация на
существующих данных невозможна**.

| pinned / зафиксировано | value / значение |
|---|---|
| pre-registration / предрегистрация | `16728ef` — [V3_3_HTF_ZONE_MITIGATION_PREREGISTRATION.md](../V3_3_HTF_ZONE_MITIGATION_PREREGISTRATION.md) |
| amendment 1 / поправка 1 | `01cbc28` — [amendment](../V3_3_HTF_ZONE_MITIGATION_PREREGISTRATION_AMENDMENT_1.md) |
| implementation / реализация | `research/v33_zone_mitigation.ts` (sha256 `3f5b1478a1b0c240a85b28a0280d61761246091ca0ed122fab2e03113fe2b1c6`) |
| artifacts / артефакты | `artifacts/research/v33/v33-train-metrics-<window>-<stop>-<leg>.json` (8 runs) |
| results report / отчёт | [V3_3_HTF_ZONE_MITIGATION_TRAIN_RESULTS.md](../V3_3_HTF_ZONE_MITIGATION_TRAIN_RESULTS.md) |
| tests / тесты | `tests/v33-zone-mitigation.test.ts` (35 tests) |
| engine surface / поверхность движка | unchanged / не изменялась (`srcModified: false`) |

---

# PART A — ENGLISH

## A1. The idea

Institutions leave footprints. Two of them matter here:

1. **An order block (OB)** — the last candle *against* a violent move. Price ran
   away from that candle so fast that resting orders were never filled; the
   candle's range is where unfilled interest still sits.
2. **A fair-value gap (FVG)** — a three-candle imbalance: the first and third
   candle do not overlap at all, because the middle candle moved so hard it left a
   hole. Markets tend to come back and trade inside the hole.

V3.3 only accepts zones that were **created by a displacement** — a 4H candle whose
body is at least 0.6 × ATR(4H). A zone is **fresh/unmitigated** until price returns
to it. When the 1H chart finally trades into that zone, and the candle doing so
prints an **exhaustion signature** — a volume surge with a long rejection wick, or
a strong body reclaim that closes back in the direction of the original move — the
hypothesis is that the retracement is being **absorbed** and the original direction
resumes.

```text
4H   ── displacement ──────►         (created a zone: last opposite candle's range)
        ░░░ zone ░░░                  ← unfilled orders / imbalance
                              ▼
1H                price trades INTO the zone       ← mitigation
                       │  rejection wick ≥ 35 %  or  body reclaim ≥ 0.40
                       │  and RVOL ≥ 1.25          ← absorption (the squeeze)
                       ▼
      entry corridor = close(N) ± 0.10 × ATR(1H,14)
      stop  = behind the further of { exhaustion wick, zone invalidation edge } + 0.15 ATR
      TP1   = 50 % equilibrium of the leg that created the zone → close 50 %, stop → BE
      TP2   = opposing confirmed 4H swing                    → close the remainder
      timeout = 48 × 1H bars
```

**Where the names come from.** "Zone mitigation" is the return of price to the
zone; "LTF squeeze" is the 1H bar where the seller/buyer is squeezed out against
the zone. **This is a reversal trade, not a continuation trade**: the entry is
taken against the move that is entering the zone and in the direction the zone
was created by. A bullish zone (built by an up-displacement) invites a **LONG**;
a bearish zone invites a **SHORT**. (A summary calling V3.3 a "zone continuation"
strategy would be wrong and is corrected here.)

## A2. Entry rules — EN

| # | Condition | Exact implementation |
|---|---|---|
| 1 | **Fresh 4H zone exists** | Frozen `detectDisplacement(h4, i, atr4, rvol4, v2.displacement_min_body_atr = 0.6)`; the OB is `buildOrderBlock(...)` = the **full range of the last opposite candle within 5 bars**, the FVG is `findFvg(...)` ≥ `v2.fvg_min_size_atr = 0.15 × ATR(4H)` whose **middle bar is itself a displacement**. A zone is usable only after the 4H bar that reveals it has CLOSED (`openTime + 4h ≤ 1H closeTime`). |
| 2 | **Price enters the zone on 1H** | OB: the 1H bar's range intersects `[zoneLow, zoneHigh]` (inclusive). FVG: the 1H **fill fraction** reaches **≥ 50 %**, using the frozen `findFvg` definition of fill (largest single-bar overlap / gap size, full fill = 1). |
| 3 | **Zone is still alive** | OB dies on the first 1H **close** beyond its far edge (`close < zoneLow` for a bullish zone). FVG dies when the fill reaches 1. A bar that both mitigates and invalidates kills the zone — ambiguity never favours the trade. |
| 4 | **Trigger window** | **PRIMARY (`window = while`)**: any 1H bar **at or after** the mitigation bar, while the zone is alive, whose range intersects the zone. `window = first` (the mitigating bar itself) is a registered sensitivity and **fails F1** — see §A8. |
| 5 | **Volume** | `RVOL ≥ 1.25` on the 1H bar, `RVOL = volume / mean(volume, 20)` (inclusive, unlike V3.0/V3.1's strict `>`). |
| 6 | **Absorption rejection** | Either branch, on the same 1H bar: **wick** — lower wick ≥ 35 % of the range for a LONG, upper wick ≥ 35 % for a SHORT; or **reclaim** — `bodyRatio ≥ 0.40` **and** the close in the outer 30 % of the range (≥ 0.70 for a LONG, ≤ 0.30 for a SHORT). No engulfing requirement. |
| 7 | **Tie-break** | If several live zones qualify on one bar, the **most recently created** wins; an OB precedes the FVG from the same displacement. More than one zone qualified on 8,756 of 15,957 trigger bars, so this rule matters. |
| 8 | **Entry order** | **Limit corridor** centred on the trigger bar: `centre = close(N)`, `halfWidth = 0.10 × ATR(1H,14)` at bar N. |

**Corridor fill semantics (frozen, conservative):**

- Fills only from bar **N+1** onward — never on the trigger bar.
- Fill at the **worse edge**: LONG at `min(open, zoneHigh)`, SHORT at `max(open, zoneLow)`.
- Unfilled after **3 bars** → `EXPIRED`.
- Stop breached before a fill → `CANCELLED`.
- One bar that both fills and breaches the stop → `CANCELLED`.
- Geometry gate: the fill must satisfy `stop < fill < TP1 < TP2` (LONG, mirrored SHORT), otherwise `REJECTED_GEOMETRY`.

## A3. Exit rules — EN

Let `E` = fill price, `S` = stop, `R = |E − S|`.

| Element | Rule |
|---|---|
| **Stop-loss** | Behind the **further** of the two structures the specification names: LONG `min(exhaustionLow, zoneLow) − 0.15 × ATR`; SHORT `max(exhaustionHigh, zoneHigh) + 0.15 × ATR`. The `climax` variant (wick only) is a registered sensitivity. |
| **TP1** | **50 % equilibrium of the leg that created the zone** = `(legLow + legHigh) / 2`, where the leg is the 4H window `[originIndex, displacementIndex]` for an OB and `[i−1, i+1]` for an FVG. Close **50 %** of the position. |
| **Breakeven** | Once TP1 fills, the stop on the remaining 50 % moves to `E`. Arms only on bars **strictly after** the TP1 bar. |
| **TP2** | The **opposing confirmed 4H swing**: the last 4H swing HIGH (LONG) / LOW (SHORT) confirmed by the trigger bar's close time. Close the remaining 50 %. |
| **Timeout** | **48 × 1H bars**, the entry bar counting as bar 1; close the remainder at that bar's CLOSE. |

**Position accounting:** realised R = `0.5 × R(TP1 leg) + 0.5 × R(final leg)`. Fees
are charged **per leg on that leg's own notional** — maker entry (2 bps), taker
exit on each closing leg (5 bps) — so a partial exit pays **three** legs.

Recorded exit reasons: `SL` · `TP1_THEN_BE` · `TP1_THEN_SL` · `TP2` ·
`TP1_THEN_TIMEOUT` · `TIMEOUT`.

## A4. Intrabar rules — fixed in advance, all conservative

- **R1** — the stop is checked **before** the targets on every bar.
- **R2** — if TP1 and TP2 fall on the same bar, TP1 books first, then TP2.
- **R3** — breakeven arms only on bars **strictly after** the TP1 bar.
- **R4** — the stop never moves backwards.
- **R5** — the timeout counts the entry bar as bar 1.

These are **not** configurable and must not be exposed as inputs.

## A5. Parameters — admin panel surface — EN

> ⚠️ **NOT IMPLEMENTED AS SETTINGS YET.** V3.3 exists only as a research harness
> (`research/v33_zone_mitigation.ts`, compile-time constants). There is **no
> `v33.*` category in `src/core/settings.ts`**, no admin route and no engine
> wiring; the strategy selector must therefore show V3.3 as **research-only**
> until a port is authorised (see [ADMIN_PANEL_SPEC.md](../ADMIN_PANEL_SPEC.md) §1
> and §2b). The table below is the surface a port would have to expose, with the
> **values that produced the TRAIN artifact** as defaults.

> ⚠️ **NOTHING HERE WAS SWEPT.** Every value is the pre-registered constant. The
> min/max columns are **guard rails for a future UI**, not a tested range: any
> value other than the default produces a strategy that has never been measured,
> and the TRAIN figures below would no longer describe it.

| Parameter | Type | Default | Min | Max | Description |
|---|---|---|---|---|---|
| `v33.bodyRatioMin` | number | **0.40** | 0.10 | 0.80 | Мин. тело свечи-возврата / Min. body/range of the reclaim branch |
| `v33.wickRatioMin` | number | **0.35** | 0.10 | 0.80 | Мин. доля тени-отказа / Min. rejection wick as a share of range |
| `v33.rvolMin` | number | **1.25** | 1.00 | 3.00 | Мин. всплеск объёма, включительно / Min. volume surge (inclusive `>=`) |
| `v33.closeTopFrac` | number | **0.70** | 0.55 | 0.95 | Закрытие в крайних 30 % диапазона / Close in the outer 30 % (mirror 0.30) |
| `v33.fvgFillMin` | number | **0.50** | 0.25 | 1.00 | Доля заполнения 4H FVG для митигации / FVG fill share required to mitigate |
| `v33.zoneType` | enum | **`"both"`** | `"both"` · `"ob"` · `"fvg"` | — | Какие 4H-зоны принимать / Which 4H zones are eligible |
| `v33.triggerWindow` | enum | **`"while"`** | `"while"` · `"first"` | — | Окно триггера / Trigger window (`while` = any bar in the live zone) |
| `v33.stopAnchor` | enum | **`"zoneEdge"`** | `"zoneEdge"` · `"climax"` | — | Стоп за дальней структурой или только за тенью / Stop behind the further structure, or the wick only |
| `v33.tp1Leg` | enum | **`"displacement"`** | `"displacement"` · `"swing"` | — | Как измеряется нога для TP1 / Which leg defines TP1 |
| `v33.corridorATR` | number | **0.10** | 0.02 | 0.30 | Ширина коридора входа в ATR / Entry corridor half-width, in ATR |
| `v33.slBufferATR` | number | **0.15** | 0.05 | 0.50 | Буфер стопа за структурой / Stop buffer beyond the structure, in ATR |
| `v33.tp1Equilibrium` | number | **0.50** | 0.25 | 0.75 | Доля ноги для TP1 (0.50 = равновесие) / Share of the leg used for TP1 |
| `v33.timeoutBars` | number | **48** | 10 | 100 | Таймаут в свечах 1H / Timeout in 1H bars |
| `v33.positionSplitTP1` | number | **0.50** | 0.25 | 0.75 | Доля позиции, закрываемая на TP1 / Fraction closed at TP1 |
| `v33.htfTimeframe` | enum | **`"4h"`** | `"4h"` · `"1d"` | — | Старший ТФ для зон / Zone timeframe (1D was never read — see §A8) |
| `v33.ltfTimeframe` | enum | **`"1h"`** | `"15m"` · `"30m"` · `"1h"` | — | Рабочий ТФ входа / Working timeframe for entry |

### Mapping to code, and the rest of the frozen constant set

| Admin parameter | Code constant / expression |
|---|---|
| `bodyRatioMin` | `RECLAIM_BODY_MIN = 0.40` |
| `wickRatioMin` | `WICK_FRAC_MIN = 0.35` |
| `rvolMin` | `MIN_RVOL = 1.25` |
| `closeTopFrac` | `CLOSE_TOP_FRAC = 0.70` / `CLOSE_BOTTOM_FRAC = 0.30` |
| `fvgFillMin` | `FVG_FILL_MIN = 0.50` |
| `zoneType` | `buildZones()` — OB via `buildOrderBlock`, FVG via `findFvg` |
| `triggerWindow` | `--window=while\|first` |
| `stopAnchor` | `--stop=protective\|climax` |
| `tp1Leg` | `--leg=displacement\|swing` |
| `corridorATR` | `CORRIDOR_ATR_FRAC = 0.10` |
| `slBufferATR` | `STOP_BUFFER_ATR = 0.15` |
| `tp1Equilibrium` | `(legLow + legHigh) / 2` (midpoint = 0.50) |
| `timeoutBars` | `TIMEOUT_BARS = 48` |
| `positionSplitTP1` | hard-coded leg weight `0.5` |
| `htfTimeframe` | `STRUCT_TF = '4h'` |
| `ltfTimeframe` | `EXEC_TF = '1h'` |

Also part of the tested configuration (not swept, must not change):

| Constant | Value | Role |
|---|---|---|
| `CORRIDOR_EXPIRY_BARS` | **3** | Corridor lifetime (inherited from V3.0; the request was silent). |
| `MAKER_BPS` / `TAKER_BPS` | **2 / 5** | Per-leg fee model. |
| `v2.displacement_min_body_atr` | **0.6** | What counts as displacement on 4H. |
| `v2.fvg_min_size_atr` | **0.15** | Minimum FVG size on 4H. |
| `engine.swing_lookback` | **3** | Pivot strength (4H swings for TP2, and the incremental levels). |
| `risk.atr_period` | **14** | ATR period (corridor, stop buffer). |
| `v2.volume_period` | **20** | RVOL averaging window. |
| `WARMUP_BARS` | **60** | Bars skipped at the start of each series, inside TRAIN. |

## A6. TRAIN results — EN (verbatim from `artifacts/research/v33/v33-train-metrics-while-protective-displacement.json`)

| Metric | Value |
|---|---|
| Trades (n) | **6,957** |
| TP1 hit | **65.24 %** |
| TP2 hit | **12.43 %** |
| Positive-R trades | 66.16 % |
| Natural stop distance (p25 / median / p75) | 1.0914 % / **1.6953 %** / 2.6374 % |
| Fee drag @2/5 bps | **0.0511 R** |
| Fee drag @5/5 bps | 0.0731 R |
| Median TP1 / TP2 distance | 0.5824 R / 2.9164 R |
| **Gross R/trade** | **+0.0778** |
| **Net R/trade @2/5 bps** | **+0.0267** |
| Net R/trade @5/5 bps | +0.0047 |
| Profit factor | **1.2341** |
| Max drawdown | **−43.67 R** |
| Average win / average loss | +0.6200 R / −0.9823 R |
| Median bars held | 6 |
| Exit mix | TP1_THEN_BE 3,295 · SL 2,298 · TP2 865 · TP1_THEN_TIMEOUT 379 · TIMEOUT 120 |
| Funnel | 10,665 zones → 8,627 mitigated → 15,957 triggers → **6,957 filled** · 8,140 rejected (geometry) · 849 cancelled · 9 unresolved |
| Zone types | 7,425 OB / 3,240 FVG created · 14,512 OB / 1,445 FVG triggers taken |
| Absorbance branches | WICK 10,670 · RECLAIM 4,537 · both 750 (trigger-bar evaluations) |
| Direction | LONG n = 3,537 (+0.0382) · SHORT n = 3,420 (+0.1188) |
| Symbols (gross) | BTC +0.1074 (1,135) · ETH +0.1003 (1,149) · BNB +0.0944 (1,092) · XRP +0.0893 (1,213) · SOL +0.0407 (1,154) · DOGE +0.0378 (1,214) |
| Outlier dependence | gross +0.0778 · ex-top-1 +0.0758 · ex-top-5 +0.0710 · **ex-top-1 % +0.0264 (below the 0.0511 R fee)** |
| F1 net > 0 @2/5 | **PASS** |
| F2 fee drag < 0.10 R | **HOLDS** (0.0511) |
| F3 TP1 hit ≥ 50 % | **HOLDS** (65.24 %) |

### Comparison with the rest of the portfolio (TRAIN)

| | n | TP1 % | stop % (med) | fee R | gross R | net R @2/5 | PF | MaxDD |
|---|---|---|---|---|---|---|---|---|
| **V3.3** | **6,957** | 65.24 | 1.695 | 0.0511 | **+0.0778** | **+0.0267** | 1.2341 | −43.67 |
| V3.0 | 1,585 | 48.26 | 1.252 | 0.0732 | +0.1726 | **+0.0994** | 1.3538 | −37.18 |
| V3.2 | 307 | 60.59 | 1.585 | 0.0538 | −0.0082 | −0.0620 | 0.9791 | −19.97 |
| V3.1 | 158 | 48.10 | 3.456 | 0.0258 | −0.0838 | −0.1097 | 0.7873 | −20.42 |

## A7. How to reproduce the TRAIN run — EN

```bash
npx tsx research/v33_zone_mitigation.ts \
  --cache=~/.cache/v30parity \
  --splits=artifacts/research/v2-real-20260915-080338/splits.json \
  --window=while --stop=protective --leg=displacement \
  --out=artifacts/research/v33/v33-train-metrics-while-protective-displacement.json

npx vitest run tests/v33-zone-mitigation.test.ts   # 35 tests
```

## A8. Honest caveats — EN

1. **The edge lives in the tail.** Removing the best 1 % of trades (70 of 6,957)
   leaves a gross of **+0.0264 R**, *below* the 0.0511 R fee — so **without its
   tail the strategy is net-negative**. This is the single most important
   caveat and it is pinned by a test.
2. **The window rule is load-bearing.** The strictest reading of the same entry
   rule — triggering on the mitigating bar itself (`window = first`) — gives
   n = 600 and **net −0.0253 (F1 FAIL)**. The state reading (`while`) is the one
   that works.
3. **Half the triggers never trade.** 8,140 of 15,957 triggers are rejected by
   the geometry gate because the corridor `close ± 0.10 ATR` sits at or beyond
   TP1, or the fill is already behind the protective stop.
4. **Only 6 of the 8 pre-registered cells pass F1** (the two `first` +
   `protective` cells fail), and the two "best" cells (`climax` stop) have fee
   drag 0.0816–0.0834 R — near the 0.10 R falsification line. Choosing a cell
   after seeing all of them is not evidence; only the pre-registered primary's
   verdict counts.
5. **Not validated, and cannot be.** TRAIN is burned (V3.0/V3.1/V3.2 used it), the
   VALIDATION window is spent, TEST-2026 must stay unread. A TRAIN pass earns
   `V3_3_TRAIN_ONLY` and nothing more.
6. **The 1D series was never read.** The request named "4H/1D context"; no rule
   references 1D, so loading it would have been purposeless data access. The
   artifact records exactly the six 4H series that were used.
7. **Research runner convention:** a new setup may be taken while an earlier
   filled trade is still open (same as V3.0/V3.1/V3.2, for comparability). A
   production port would enforce one position per symbol and therefore trade
   **less** often — so a forward test's trade rate will be lower than 6,957 over
   29 months.
8. **Never port V3.3 to LIVE on the strength of these numbers.** Live is locked
   (`LIVE_TRADING_ENABLED = false`, `assertAllowedMode` rejects `LIVE`), and
   `PRODUCTION_READY` is forbidden for every strategy in this repository.

---

# PART B — РУССКИЙ

## B1. Идея стратегии

Институциональный поток оставляет следы. Здесь важны два:

1. **Ордер-блок (OB)** — последняя свеча *против* резкого движения. Цена ушла от
   неё так быстро, что выставленные заявки не исполнились; диапазон этой свечи —
   там, где всё ещё стоит нереализованный интерес.
2. **Имбаланс (FVG)** — дисбаланс из трёх свечей: первая и третья не
   пересекаются, потому что средняя прошла слишком сильно и оставила «дыру».
   Рынок склонен вернуться и поторговать внутри неё.

V3.3 принимает только зоны, созданные **смещением** — 4H-свечой, тело которой не
меньше 0.6 × ATR(4H). Зона считается **свежей/немитигированной**, пока цена в неё
не вернулась. Когда 1H-график входит в зону и свеча входа печатает **сигнатуру
истощения** — всплеск объёма с длинной тенью-отказом либо сильный возврат телом,
закрывающийся обратно в направлении исходного движения, — гипотеза состоит в том,
что откат **абсорбируется** и исходное направление возобновляется.

**Откуда названия.** «Митигация зоны» — возврат цены в зону; «сжатие на LTF» —
1H-свеча, на которой продавец/покупатель выжимается против зоны. **Это сделка
разворота, а не продолжения**: вход совершается против движения, входящего в
зону, и в направлении, которым зона была создана. Бычья зона (созданная
движением вверх) приглашает **LONG**, медвежья — **SHORT**. (Обозначать V3.3 как
стратегию «продолжения зоны» было бы неверно, и здесь это исправлено.)

## B2. Правила входа — RU

| # | Условие | Точная реализация |
|---|---|---|
| 1 | **Есть свежая 4H-зона** | Замороженный `detectDisplacement(h4, i, atr4, rvol4, v2.displacement_min_body_atr = 0.6)`; OB — `buildOrderBlock(...)` = **полный диапазон последней противоположной свечи в пределах 5 баров**, FVG — `findFvg(...)` ≥ `v2.fvg_min_size_atr = 0.15 × ATR(4H)`, у которого **средняя свеча сама является смещением**. Зона доступна только после ЗАКРЫТИЯ 4H-свечи, её раскрывшей (`openTime + 4h ≤ closeTime` 1H-бара). |
| 2 | **Цена входит в зону на 1H** | OB: диапазон 1H-свечи пересекается с `[zoneLow, zoneHigh]` (включительно). FVG: **доля заполнения** достигает **≥ 50 %** по замороженному определению `findFvg` (максимальное пересечение одной свечи / размер гэпа, полное заполнение = 1). |
| 3 | **Зона ещё жива** | OB умирает на первом 1H-закрытии за дальним краем (`close < zoneLow` для бычьей зоны). FVG умирает при заполнении на 1. Свеча, которая одновременно митигирует и инвалидирует, убивает зону — неоднозначность никогда не в пользу сделки. |
| 4 | **Окно триггера** | **ОСНОВНОЕ (`window = while`)**: любой 1H-бар **на митигирующем или позже**, пока зона жива, диапазон которого пересекается с зоной. `window = first` (сам митигирующий бар) — зарегистрированная чувствительность, **проваливающая F1** (§B8). |
| 5 | **Объём** | `RVOL ≥ 1.25` на 1H-баре (включительно, в отличие от строгого `>` у V3.0/V3.1). |
| 6 | **Абсорбция** | Любая из ветвей на том же баре: **тень** — нижняя тень ≥ 35 % диапазона для LONG, верхняя ≥ 35 % для SHORT; либо **возврат телом** — `bodyRatio ≥ 0.40` **и** закрытие в крайних 30 % диапазона (≥ 0.70 для LONG, ≤ 0.30 для SHORT). Требования поглощения нет. |
| 7 | **Разрешение равенства** | Если на одном баре подходят несколько живых зон, побеждает **самая свежая**; OB имеет приоритет над FVG того же смещения. Более одной зоны подходило на 8 756 из 15 957 триггерных баров — правило существенно. |
| 8 | **Заявка на вход** | **Лимитный коридор** вокруг триггерной свечи: `центр = close(N)`, `полуширина = 0.10 × ATR(1H,14)` на баре N. |

**Семантика исполнения коридора (заморожена, консервативна):**

- Исполнение только с бара **N+1** — никогда на триггерном баре.
- По **худшему краю**: LONG по `min(open, zoneHigh)`, SHORT по `max(open, zoneLow)`.
- Не исполнен через **3 бара** → `EXPIRED`.
- Стоп пробит до исполнения → `CANCELLED`.
- Один бар, который и исполняет, и пробивает стоп → `CANCELLED`.
- Геометрический фильтр: `stop < fill < TP1 < TP2` (LONG, зеркально SHORT), иначе `REJECTED_GEOMETRY`.

## B3. Правила выхода — RU

Пусть `E` — цена исполнения, `S` — стоп, `R = |E − S|`.

| Элемент | Правило |
|---|---|
| **Стоп-лосс** | За **дальней** из двух названных структур: LONG `min(climaxLow, zoneLow) − 0.15 × ATR`; SHORT `max(climaxHigh, zoneHigh) + 0.15 × ATR`. Вариант `climax` (только тень) — зарегистрированная чувствительность. |
| **TP1** | **50 % равновесие ноги, создавшей зону** = `(legLow + legHigh) / 2`, где нога — окно 4H `[originIndex, displacementIndex]` для OB и `[i−1, i+1]` для FVG. Закрывается **50 %** позиции. |
| **Безубыток** | После TP1 стоп по оставшимся 50 % переносится в `E`. Взводится только на барах **строго после** бара TP1. |
| **TP2** | **Противоположный подтверждённый 4H-свинг**: последний подтверждённый свинг-хай (LONG) / свинг-лоу (SHORT) на момент закрытия триггерного бара. Закрывается остаток 50 %. |
| **Таймаут** | **48 × 1H баров**, бар входа считается первым; остаток закрывается по CLOSE этого бара. |

**Учёт позиции:** реализованный R = `0.5 × R(TP1) + 0.5 × R(финал)`. Комиссии
берутся **за каждую ногу с её собственного нотионала** — мейкер на входе (2 bps),
тейкер на каждом закрывающем выходе (5 bps), поэтому частичный выход платит
**три** ноги.

Записанные причины выхода: `SL` · `TP1_THEN_BE` · `TP1_THEN_SL` · `TP2` ·
`TP1_THEN_TIMEOUT` · `TIMEOUT`.

## B4. Внутрисвечные правила — зафиксированы заранее, все консервативны

- **R1** — стоп проверяется **раньше** целей на каждом баре.
- **R2** — если TP1 и TP2 попадают на один бар, сначала учитывается TP1.
- **R3** — безубыток взводится только на барах **строго после** бара TP1.
- **R4** — стоп никогда не двигается назад.
- **R5** — таймаут считает бар входа первым.

Правила **не** конфигурируемы и не должны выноситься в интерфейс.

## B5. Параметры — поверхность админ-панели — RU

> ⚠️ **КАК НАСТРОЙКИ ЕЩЁ НЕ РЕАЛИЗОВАНЫ.** V3.3 существует только как
> исследовательский стенд (`research/v33_zone_mitigation.ts`, константы времени
> компиляции). В `src/core/settings.ts` **нет категории `v33.*`**, нет ни
> админ-маршрута, ни подключения к движку; поэтому селектор стратегий обязан
> показывать V3.3 как **research-only** до санкционированного переноса
> ([ADMIN_PANEL_SPEC.md](../ADMIN_PANEL_SPEC.md) §1 и §2b). Таблица ниже — та
> поверхность, которую перенос должен будет открыть, со **значениями,
> породившими артефакт TRAIN**, в качестве значений по умолчанию.

> ⚠️ **ЗДЕСЬ НИЧЕГО НЕ ПОДБИРАЛОСЬ.** Каждое значение — предрегистрированная
> константа. Столбцы min/max — **ограничители для будущего интерфейса**, а не
> проверенный диапазон: любое значение, кроме значения по умолчанию, даёт
> стратегию, которая никогда не измерялась, и приведённые ниже цифры TRAIN к ней
> уже не относятся.

См. таблицу параметров в §A5 (двуязычные описания уже приведены в столбце
Description). Соответствие коду и остальной набор замороженных констант — там же.

## B6. Результаты TRAIN — RU (дословно из артефакта)

Полная таблица — §A6. Ключевые числа: **n = 6 957**, TP1 **65.24 %**,
TP2 12.43 %, медиана стопа **1.6953 %** цены, комиссия **0.0511 R** @2/5 bps,
валовый **+0.0778 R**, **net +0.0267 R/сделку** @2/5 bps, PF **1.2341**,
макс. просадка **−43.67 R**, средний выигрыш +0.6200 R против среднего проигрыша
−0.9823 R, медиана удержания 6 баров. F1 **PASS**, F2 **HOLDS**, F3 **HOLDS**.
Все шесть символов положительны по валовому, оба направления тоже.

## B7. Как воспроизвести TRAIN — RU

Команды — в §A7. Артефакты всех восьми предрегистрированных прогонов лежат в
`artifacts/research/v33/`; тесты `tests/v33-zone-mitigation.test.ts` (35) пинят
константы, эквивалентность замороженным примитивам `src/`, правила R1–R5, сумму
комиссионных ног, sha256 модуля, все восемь артефактов и хвостовую хрупкость.

## B8. Честные оговорки — RU

1. **Преимущество живёт в хвосте.** Удаление лучшего 1 % сделок (70 из 6 957)
   оставляет валовый результат **+0.0264 R** — *меньше* комиссии 0.0511 R, то
   есть **без хвоста стратегия убыточна**. Это самая важная оговорка, и она
   закреплена тестом.
2. **Правило окна — несущее.** Самое строгое прочтение того же правила входа —
   триггер на самом митигирующем баре (`window = first`) — даёт n = 600 и
   **net −0.0253 (F1 FAIL)**. Работает чтение состояния (`while`).
3. **Половина триггеров не торгуется.** 8 140 из 15 957 триггеров отклонены
   геометрией: коридор `close ± 0.10 ATR` стоит на TP1 или за ним, либо цена
   исполнения уже за защитным стопом.
4. **Только 6 из 8 предрегистрированных ячеек проходят F1** (проваливаются две
   ячейки `first` + `protective`), а у двух «лучших» ячеек (стоп `climax`)
   комиссия 0.0816–0.0834 R — вблизи порога фальсификации 0.10 R. Выбор ячейки
   после просмотра всех не является доказательством; засчитывается только вердикт
   предрегистрированного основного варианта.
5. **Не валидирована и не может быть.** TRAIN израсходован (его использовали
   V3.0/V3.1/V3.2), окно VALIDATION потрачено, TEST-2026 должен остаться
   непрочитанным. Успех на TRAIN даёт `V3_3_TRAIN_ONLY` и ничего больше.
6. **Ряд 1D не читался.** В задании упоминался «4H/1D context»; ни одно правило
   на 1D не ссылается, поэтому загрузка была бы бесцельным доступом к данным.
   Артефакт фиксирует ровно шесть использованных 4H-рядов.
7. **Конвенция исследовательского стенда:** новый сетап берётся, пока открыта
   ранее исполненная сделка (как у V3.0/V3.1/V3.2, для сопоставимости).
   Продакшн-версия ограничила бы одну позицию на символ и потому торговала бы
   **реже** — форвардный тест даст меньше сделок, чем 6 957 за 29 месяцев.
8. **Никогда не переносить V3.3 в LIVE на основании этих цифр.** LIVE
   заблокирован (`LIVE_TRADING_ENABLED = false`, `assertAllowedMode` отклоняет
   `LIVE`), и `PRODUCTION_READY` запрещён для любой стратегии репозитория.

---

## Portfolio position / Место в портфеле

| | V3.0 HTF Liquidation Trap | V3.3 HTF Zone Mitigation & LTF Squeeze |
|---|---|---|
| Role / роль | reversal sniper — fade a swept 4H level | high-frequency mitigation — fade into a fresh 4H zone with an LTF exhaustion trigger |
| Evidence / доказательства | TRAIN **+0.0994** (n = 1,585) **and** VALIDATION **+0.0600** (n = 536) — `V3_0_VALIDATED_FOR_RESEARCH` | TRAIN **+0.0267** (n = 6,957) only — `V3_3_TRAIN_ONLY` |
| In the engine / в движке | **yes** — default strategy, paper forward test ([V3_0_PRODUCTION_PORT.md](../V3_0_PRODUCTION_PORT.md)) | **no** — research harness only |
| Next step / следующий шаг | forward test continues; both research windows spent | operator decision; a forward test would need its own pre-registration, and no validation window remains |

`PRODUCTION_READY` is forbidden for both.

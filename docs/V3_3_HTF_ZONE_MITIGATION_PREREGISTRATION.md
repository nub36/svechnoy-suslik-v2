# V3.3 — HTF ZONE MITIGATION & LTF SQUEEZE
# V3.3 — МИТИГАЦИЯ ЗОНЫ НА СТАРШЕМ ТАЙМФРЕЙМЕ И СЖАТИЕ НА МЛАДШЕМ

**Status / Статус: `V3_3_PRE_REGISTERED`** — written and committed **before** the
simulator exists and before any TRAIN candle is read. Every rule, constant,
ambiguity resolution and falsification criterion below is frozen at this moment.

**Статус: `V3_3_PRE_REGISTERED`** — документ написан и закоммичен **до** появления
симулятора и до чтения первой свечи TRAIN. Все правила, константы, разрешения
неоднозначностей и критерии фальсификации ниже заморожены в этот момент.

| pinned / зафиксировано | value / значение |
|---|---|
| engine surface / поверхность движка | `4839074` — nothing under `src/` is modified / `src/` не изменяется |
| dataset / датасет | `c3c1dce` — Binance Spot klines, 2022-01 … 2025-12 |
| slice / срез | **TRAIN only** — 1H per symbol `2022-01-01T00:00:00Z` … `2024-05-26T13:00:00Z` (21,037 candles), 4H series truncated at the same instant |
| symbols / символы | BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT, DOGEUSDT |
| timeframes / таймфреймы | 1H execution + 4H structural context (no 1D — see §1.4) |
| implementation / реализация | `research/v33_zone_mitigation.ts` (written after this file) |
| artifacts / артефакты | `artifacts/research/v33/v33-train-metrics.json` (primary) + 3 variants |
| tests / тесты | `tests/v33-zone-mitigation.test.ts` |
| baselines / базы сравнения | V3.0 TRAIN net **+0.0994** (n = 1,585) · V3.2 TRAIN net **−0.0620** (n = 307, F1 falsified) |

> ⚠️ **Exploratory by construction.** TRAIN has already been used by V3.0, V3.1 and
> V3.2, so a TRAIN pass is not a validation. The single pre-registered VALIDATION
> window was spent on 2026-09-16 and may never be re-read; the 2026-H1 TEST window
> has never been read and must stay that way. **Nothing in this programme can be
> validated on existing data any more.** `PRODUCTION_READY` is forbidden for every
> strategy here.

---

## 0. Hypothesis / Гипотеза

**EN.** V3.0 faded a swept *level*; V3.1 joined a *trend*; V3.2 faded a flow
*event* on one timeframe and found a zero pre-cost edge. V3.3 tests whether the
missing ingredient is **confluence across timeframes**: an HTF zone that
institutional flow left behind (a fresh 4H order block or a 4H imbalance, both
created by a **displacement** move), mitigated by price on the 1H timeframe, and
then a 1H **exhaustion signature** at that zone (volume ≥ 1.25× and a rejection
wick ≥ 35 % of range, or a body reclaim closing in the outer 30 %). Entry is a
maker corridor at the trigger close; the first target is the 50 % equilibrium of
the leg that *created* the zone, the second the opposing confirmed 4H swing.

The mechanism claim, stated so it can be falsified: *a zone that was created by
displacement and is being mitigated for the first time is where the reversal has
its fuel*, so the trigger should fire often enough to be measured (F3 checks that
the equilibrium is actually reached), and the stop — placed behind the 1H exhaustion
wick **and** the zone's invalidation level, not just the wick — should be wide
enough that fees stay near V3.0's level (F2). Unlike V3.1, the target geometry here
is not a midpoint tucked behind a strong trigger candle: the stop is deliberately
placed at the *further* of two structures, which is the single most likely way this
variant loses its edge to a wide stop and a small TP1 — registered in advance.

**RU.** V3.0 торговал против снятого *уровня*; V3.1 присоединялся к *тренду*;
V3.2 торговал против потокового *события* на одном таймфрейме и получил нулевое
преимущество до издержек. V3.3 проверяет, не является ли недостающим
ингредиентом **совпадение по таймфреймам**: зона, оставленная институциональным
потоком на старшем таймфрейме (свежий 4H ордер-блок или 4H имбаланс, созданные
**смещением**), митигируется ценой на 1H, и на этой зоне возникает 1H
**сигнатура истощения** (объём ≥ 1.25× и свеча-отказ с тенью ≥ 35 % диапазона
либо возврат телом, закрывающийся в крайних 30 %). Вход — лимитный коридор на
закрытии триггера; первая цель — 50 % равновесие ноги, *создавшей* зону, вторая —
противоположный подтверждённый 4H-свинг.

Механизм сформулирован так, чтобы его можно было опровергнуть: *зона, созданная
смещением и митигируемая впервые, — это место, где у разворота есть топливо*,
поэтому триггер должен срабатывать достаточно часто, чтобы его можно было
измерить (F3 проверяет, что равновесие действительно достигается), а стоп —
поставленный за тенью истощения на 1H **и** за уровнем инвалидации зоны, а не
только за тенью, — должен быть достаточно широким, чтобы комиссия осталась на
уровне V3.0 (F2). В отличие от V3.1, геометрия целей здесь — не середина,
спрятанная за сильной свечой триггера: стоп осознанно ставится за *дальнюю* из
двух структур, и это самый вероятный способ потерять преимущество из-за
широкого стопа и маленького TP1 — регистрируется заранее.

---

## 1. Data scope and hard guards / Данные и жёсткие ограничения

1. **TRAIN only.** Both the 1H and the 4H series are truncated in memory at
   `trainToMs` immediately after loading, before any computation. No candle with
   `openTime > trainToMs` is read, therefore no VALIDATION candle (from
   `validFromMs` = 2024-05-26T14:00Z) and no 2026 candle can be read.
2. **Outcome resolution is clipped too**: bars are those with
   `openTime <= trainToMs`. A trade that cannot resolve inside the clip is
   `unresolved` and excluded from every metric.
3. **Guards are recorded in the artifact**: `trainFromUtc`, `trainToUtc`,
   `candlesIgnoredBeyondTrain`, `candlesBeyondTrainRead` (must be 0),
   `candles2026Read` (must be 0), `warmupBarsSkipped`.
4. **Deviation, disclosed: no 1D series is loaded.** The request names "4H/1D
   structural context", but no rule below references 1D. Reading it would be data
   access with no purpose, so 4H is the only higher timeframe materialised;
   `htfSeriesLoaded` in the artifact records exactly which series were read.
5. **Windows come from the repository artifact**, not from memory:
   `artifacts/research/v2-real-20260915-080338/splits.json`. The run refuses to
   start if `trainFromMs >= trainToMs` or `trainToMs >= validFromMs`.

---

## 2. Frozen rules / Замороженные правила

Frozen primitives are reused **unchanged** from `src/`:
`detectDisplacement`, `buildOrderBlock`, `findFvg`, `findSwingsV2`,
`detectStructureBreak`, `atrSeriesV2`, `buildVolumeContext`, `closedHtfCandles`.
Settings defaults used (not re-tuned): `engine.swing_lookback = 3`,
`risk.atr_period = 14`, `v2.volume_period = 20`,
`v2.displacement_min_body_atr = 0.6`, `v2.fvg_min_size_atr = 0.15`.

### 2.1 Zone identification (4H) / Идентификация зоны

Evaluated on the 4H series only, with `ATR(14)` and `RVOL(20)` computed on 4H.

- **Displacement:** the frozen `detectDisplacement(h4, i, atr4h[i], rvol4h[i],
  displacementMinBodyAtr)` — a bar whose **body ≥ 0.6 × ATR(4H)**, with its
  direction taken from the candle.
- **Order block (OB):** the frozen `buildOrderBlock(h4, displacement, origin,
  evalIndex, '4h')` — the last opposite-direction candle within 5 bars before the
  displacement. **Zone = the origin candle's full range `[low, high]`.** Known
  from the close of the displacement bar. The `origin` label is metadata only
  (taken from `detectStructureBreak` at the displacement bar when that break
  agrees with the displacement direction, otherwise `SWEEP_REACTION`); it never
  affects the zone's geometry, entry or exit.
- **Fair-value gap (FVG):** the frozen 3-bar imbalance — `low[i+1] > high[i−1]`
  (bullish, gap `[high[i−1], low[i+1]]`) or `high[i+1] < low[i−1]` (bearish) —
  with `size >= 0.15 × ATR(4H)`, **and** the middle bar `i` is itself a
  displacement (body ≥ 0.6 ATR), which is the "created by displacement moves"
  requirement. Known from the close of bar `i+1`.
- **Direction convention:** a bullish zone (created by an up displacement)
  invites a **LONG** fade; a bearish zone invites a SHORT.

### 2.2 Zone mitigation (1H) / Митигация зоны

Both zone types are tracked on the **1H** series, which is what the request's
"Price on the 1H timeframe enters…" specifies.

- **OB mitigation:** the first 1H bar whose range intersects the zone
  (`low <= zoneHigh && high >= zoneLow`).
- **FVG mitigation:** the 1H **fill fraction** of the gap reaches **≥ 50 %**. The
  fill fraction follows the frozen `findFvg` definition exactly — the largest
  single-bar overlap fraction seen so far,
  `fillFrac(N) = max over bars b in (known 1H index, N] of overlap(b, gap) / gapSize`.
  A test pins that this incremental tracker reproduces the frozen `findFvg`
  `filledFraction` when it is fed 4H bars.
- **Invalidation (1H resolution), registered because the request does not define
  it:** an OB dies on the first 1H **close** beyond its far edge (bullish:
  `close < zoneLow`; bearish: `close > zoneHigh`); an FVG dies when `fillFrac`
  reaches 1. If a bar both mitigates and invalidates, the zone is **dead** and no
  trigger is possible — the same "ambiguity resolves against the trade" rule the
  programme uses everywhere else.
- **Zones are never aged out.** A fresh zone stays a candidate until it is
  mitigated-then-invalidated or filled; no time limit is invented here.

### 2.3 LTF exhaustion trigger (1H bar N) / Триггер истощения

All of the following hold on the closed bar N:

1. **Inside the zone:** bar N's range intersects the zone. This is the
   request's "1H candle N, inside the 4H zone" and is checked on bar N itself,
   independently of the mitigation bar.
2. **Extreme volume:** `RVOL(20) >= 1.25` on the 1H series (inclusive, as
   written).
3. **Absorption rejection** — either branch, both measured on bar N:
   - **WICK:** for a LONG, `(min(open, close) − low) / (high − low) >= 0.35`; for
     a SHORT, `(high − max(open, close)) / (high − low) >= 0.35`. A degenerate
     range (`high == low`) fails. **No close-direction requirement is imposed
     here** — the request states none for this branch, and the direction mix of
     triggers that take it is reported as a split rather than filtered.
   - **RECLAIM:** `bodyRatio = |close − open| / (high − low) >= 0.40` **and** the
     close in the outer 30 % of the range (`(close − low)/(high − low) >= 0.70`
     for a LONG, `<= 0.30` for a SHORT). These two conditions jointly imply the
     candle closes in the fade direction: for a LONG, a down-candle with
     `position >= 0.70` and `bodyRatio >= 0.40` would need `open > high`.
     No engulfing requirement is imposed — unlike V3.2, this request does not ask
     for one.
4. **Window:** primary `while` — `N ∈ [mitigationIndex, deathIndex − 1]`, i.e. any
   bar after the level is mitigated while the zone is still alive and bar N is
   inside it. Secondary `first` — `N = mitigationIndex` exactly. See §3.

### 2.4 Execution / Исполнение

- **Corridor:** `close(N) ± 0.10 × ATR(1H, 14)`; fill from bar **N+1**, never on
  N; fill at the **worse** edge (`LONG min(open, zoneHigh)`,
  `SHORT max(open, zoneLow)`).
- **Corridor expiry:** 3 bars. The request is silent; V3.0's frozen value is
  inherited deliberately and frozen here.
- **Ambiguity:** a bar that touches the corridor *and* breaches the stop is
  cancelled, never filled (inherited).
- **Geometry gate:** `risk > 0` and, for LONG, `stop < fill < tp1 < tp2`
  (mirrored SHORT); otherwise the setup is `rejected` and counted in the funnel.
- **Fees:** maker 2 bps on entry, taker 5 bps on every exit, **per leg on that
  leg's own notional** (three legs for a TP1+TP2 trade). No rebate.
- **Overlap:** as in the V3.0/V3.1/V3.2 research runners, a new setup may be taken
  while a previously filled trade is still open; the production engine would trade
  **less**. Disclosed, not corrected.

### 2.5 Exit and risk management / Выход и риск

| item | rule |
|---|---|
| SL, primary (`protective`) | behind the **further** of the two structures the request names: for a LONG `min(climaxLow, zoneFarEdge) − 0.15 × ATR(1H)`; for a SHORT `max(climaxHigh, zoneFarEdge) + 0.15 × ATR`. `climaxLow/High` is bar N's wick extreme; `zoneFarEdge` is the zone's far boundary (`zoneLow` bullish / `zoneHigh` bearish). |
| SL, secondary (`climax`) | behind the 1H exhaustion wick only: `climaxLow − 0.15 ATR` (LONG) / `climaxHigh + 0.15 ATR` (SHORT). |
| TP1 | **50 % equilibrium of the 4H leg that created the zone**: `(legLow + legHigh) / 2`. The leg is measured on 4H from the zone's origin to the end of the displacement — `[originIndex, displacementIndex]` for an OB, `[i−1, i+1]` for an FVG: `legLow = min(low)`, `legHigh = max(high)` over that window. 50 % of the position closes here. |
| Breakeven | after TP1 the stop moves to the entry price, armed only on bars **strictly after** the TP1 bar. |
| TP2 | **the opposing confirmed 4H swing**: the most recent 4H swing HIGH (LONG) / LOW (SHORT) whose pivot was confirmed by the trigger bar's close time — the same object V3.0's `confirmedLevels` returns, pinned equal by a test. The remaining 50 % closes here. |
| Timeout | 48 bars (1H), the entry bar counting as bar 1. |

### 2.6 Inherited intrabar rules / Унаследованные внутрибарные правила

**R1** stop before targets on every bar; **R2** TP1 books before TP2 when both
land on one bar; **R3** breakeven arms only on bars strictly after the TP1 bar;
**R4** the stop never moves backwards; **R5** the timeout counts the entry bar as
bar 1.

---

## 3. Variants and reporting / Варианты и отчёт

Two orthogonal ambiguities are resolved by shipping **all four combinations**,
with the primary named **before** the run:

| run | trigger window | SL | status |
|---|---|---|---|
| A | `while` (mitigated, still alive, bar inside) | `protective` (further of wick / zone edge) | **PRIMARY** |
| B | `while` | `climax` (wick only) | sensitivity |
| C | `first` (the mitigating bar itself) | `protective` | sensitivity |
| D | `first` | `climax` | sensitivity |

Reported for every run: n; TP1 hit %; TP2 hit %; positive-R %; natural stop
distance % (p25/median/p75); fee drag in R @2/5 bps (and 5/5 spot for reference);
gross R/trade; net R/trade @2/5; profit factor; max drawdown in R; median bars
held; exit mix; the full funnel (zones → mitigations → triggers → signals →
filled / expired / cancelled / rejected / unresolved); zone-source split
(OB vs FVG); absorption-branch split (WICK / RECLAIM / both) **and the close-
direction mix of WICK triggers**; TP1/TP2 distance in R; per-direction and
per-symbol expectancy; outlier dependence (ex-top-1, ex-top-5, ex-top-1 %); and a
side-by-side table against V3.0 and V3.2 TRAIN.

## 4. Falsification criteria / Критерии фальсификации

Registered now, evaluated once, no adjustment afterwards:

- **F1 (primary).** `net R/trade @2/5 bps <= 0` on TRAIN ⇒ *"an unmitigated 4H zone
  plus a 1H exhaustion signature is a profitable reversal entry at Binance futures
  fees"* is **falsified**.
- **F2 (cost).** fee drag `>= 0.10 R` at 2/5 bps ⇒ the claim that a stop behind
  both structures is survivable is **falsified**.
- **F3 (premise).** TP1 hit rate `< 50 %` ⇒ the premise that mitigation triggers a
  move back to the creating leg's equilibrium is **falsified**.

Sample-size honesty: if `n < 100` the result is reported as **underpowered** and no
conclusion may be drawn from it.

## 5. What a PASS would and would not mean / Что означает PASS и что не означает

**Would mean:** a fourth hypothesis cleared a fee-inclusive TRAIN run at the
pre-registered criterion, with the cost and premise claims checked against F2/F3.

**Would not mean:** validation, deployability, or survival. TRAIN is burned for
this programme; the VALIDATION window is spent and may never be re-read; the
2026-H1 window must stay unread. A passing V3.3 earns `V3_3_TRAIN_ONLY` and
nothing else; any forward use is a separate operator decision, and a new
pre-registration would be required for any variant promoted after seeing results.

## 6. Reproduce / Воспроизведение

```bash
for w in while first; do for s in protective climax; do
  npx tsx research/v33_zone_mitigation.ts \
    --cache=/home/user/.cache/v30parity \
    --splits=artifacts/research/v2-real-20260915-080338/splits.json \
    --window=$w --stop=$s \
    --out=artifacts/research/v33/v33-train-metrics-$w-$s.json
done; done
```

The cache holds 1H and 4H binary series for the six symbols covering 2022-01-01 …
2025-12-31; the simulator truncates both at `trainToMs` on load, so no candle
outside TRAIN is ever materialised. (The primary artifact is the `while` +
`protective` run.)

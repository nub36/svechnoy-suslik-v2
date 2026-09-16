# V3.2 — HTF VOLUME CLIMAX & ABSORPTION
# V3.2 — ОБЪЁМНЫЙ КЛИМАКС И АБСОРБЦИЯ

**Status / Статус: `V3_2_PRE_REGISTERED`** — written and committed **before** the
simulator exists and before any TRAIN candle is read. Every rule, constant,
ambiguity resolution and falsification criterion below is frozen at this moment.

**Статус: `V3_2_PRE_REGISTERED`** — документ написан и закоммичен **до** появления
симулятора и до чтения первой свечи TRAIN. Все правила, константы, разрешения
неоднозначностей и критерии фальсификации ниже заморожены в этот момент.

| pinned / зафиксировано | value / значение |
|---|---|
| engine surface / поверхность движка | `4839074` — nothing under `src/` is modified / `src/` не изменяется |
| dataset / датасет | `c3c1dce` — Binance Spot klines, 2022-01 … 2025-12 |
| slice / срез | **TRAIN only** — 1H per symbol `2022-01-01T00:00:00Z` … `2024-05-26T13:00:00Z` (21,037 candles) |
| symbols / символы | BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT, DOGEUSDT |
| timeframe / таймфрейм | 1H execution (no HTF series is loaded / HTF-ряды не загружаются) |
| implementation / реализация | `research/v32_volume_climax.ts` (written after this file) |
| artifacts / артефакты | `artifacts/research/v32/v32-train-metrics.json` (primary) + 3 sensitivity artifacts |
| tests / тесты | `tests/v32-volume-climax.test.ts` |
| baselines / базы сравнения | V3.0 TRAIN **+0.0994 R/trade** (n = 1,585); V3.1 TRAIN **−0.1097** (n = 158, falsified) |

> ⚠️ **Exploratory by construction.** TRAIN has already been used by V3.0 (and
> V3.1), so a TRAIN pass is not a validation. The single pre-registered
> VALIDATION window was spent on 2026-09-16 and may never be re-read; the 2026-H1
> TEST window has never been read and must stay that way. **Nothing in this
> programme can be validated on existing data any more.**`PRODUCTION_READY` is
> forbidden for every strategy here.

---

## 0. Hypothesis / Гипотеза

**EN.** V3.0 fades a *level* (a swept 4H swing). V3.1 joined a *trend*. V3.2 fades a
*flow event*: a fast directional expansion (≥ 2 × ATR over 3–6 bars) that prints a
**volume climax** (RVOL ≥ 2.2) and an **absorption signature** — a long rejection
wick or a strong engulfing reversal at the extreme. The claim is that such a bar is
a forced-liquidation cascade that a market maker has sized into, so the next move is
a mean reversion back into the cascade's own range, not a continuation. Targets are
deliberately structural rather than ambitious: half the cascade, then its origin.

The mechanism claim, stated so it can be falsified: *fading a cascade has wide
stops too* — the stop sits behind the climax wick, which in a cascade is far from
the entry's own ATR — so fee drag should stay low (F2), and the mean-reversion
premise should show up as a **high TP1 hit rate** (F3), because half of a 2-ATR
expansion is a modest distance. If instead the climax bar is just the beginning of
a larger move, TP1 will not be reached and the strategy will look like every other
fade in this programme: a losing short-volatility bet.

**RU.** V3.0 торгует против *уровня* (снятый 4H-свинг). V3.1 присоединялся к
*тренду*. V3.2 торгует против *потока*: быстрое направленное расширение
(≥ 2 × ATR за 3–6 баров), которое печатает **объёмный климакс** (RVOL ≥ 2.2) и
**сигнатуру абсорбции** — длинную свечу-отказ или сильное поглощение на
экстремуме. Утверждение: такая свеча — это каскад вынужденных ликвидаций, в
который встал маркетмейкер, поэтому следующее движение — возврат в диапазон
каскада, а не продолжение. Цели намеренно структурные, а не амбициозные:
половина каскада, затем его начало.

Механизм сформулирован так, чтобы его можно было опровергнуть: *у торговли
против каскада тоже широкий стоп* — стоп стоит за свечой-климаксом, которая при
каскаде далека от входа по ATR — поэтому комиссия в R должна остаться низкой
(F2), а посылка возврата должна проявиться **высокой долей попаданий в TP1**
(F3), ведь половина расширения на 2 ATR — небольшое расстояние. Если же свеча
климакса оказывается лишь началом большего движения, TP1 не будет достигаться, и
стратегия станет очередной проигрышной ставкой против волатильности, как и все
предыдущие фейды в этой программе.

---

## 1. Data scope and hard guards / Данные и жёсткие ограничения

1. **TRAIN only.** The 1H series is truncated in memory at `trainToMs` immediately
   after loading, before any computation. No candle with `openTime > trainToMs` is
   read, therefore no VALIDATION candle (from `validFromMs` = 2024-05-26T14:00Z)
   and no 2026 candle can be read.
2. **Outcome resolution is clipped too**: bars are those with
   `openTime <= trainToMs`. A trade that cannot resolve inside the clip is
   `unresolved` and excluded from every metric.
3. **Guards are recorded in the artifact**: `trainFromUtc`, `trainToUtc`,
   `candlesIgnoredBeyondTrain`, `candlesBeyondTrainRead` (must be 0),
   `candles2026Read` (must be 0), `warmupBarsSkipped`.
4. **Only the 1H series is loaded.** V3.2 references no higher timeframe, so none
   is read — the cascade window, RVOL, ATR and EMA50 are all 1H quantities.
5. **Windows come from the repository artifact**, not from memory:
   `artifacts/research/v2-real-20260915-080338/splits.json`. The run refuses to
   start if `trainFromMs >= trainToMs` or `trainToMs >= validFromMs`.

---

## 2. Frozen rules / Замороженные правила

Frozen primitives reused unchanged from `src/`: `buildAtrContext` (Wilder ATR),
`buildVolumeContext` (RVOL = volume / mean of the previous `v2.volume_period` = 20
bars), `emaSeries`. Settings defaults: `risk.atr_period = 14`.

### 2.1 Cascade detection (1H) / Детекция каскада

The cascade window `[N−k, N]` is evaluated **including** the climax bar N.

- **Directional expansion:** `|close(N) − close(N−k)| >= 2.0 × ATR(14)@N`, signed —
  a **downward** cascade is required for a bullish reversal and an **upward** one
  for a bearish reversal.
- **k, primary (`--cascade=union`):** the *largest* `k ∈ {3,4,5,6}` that satisfies
  the inequality; the union reading of "over the last 3–6 bars". The origin of the
  move is then the earliest one the specification allows.
- **k, secondary (`--cascade=fast3`):** `k = 3` only — the fastest window the
  specification names. Reported side by side, never selected after the fact.
- **Cascade extremes** (used for TP1/TP2/stop disclosure), for a downward cascade:
  `origin = max(high)` and `terminal = min(low)` over `[N−k, N]`; mirrored upward.
- ATR is taken at bar **N** (the literal reading). Because the climax bar inflates
  ATR, the artifact also records `atrAtWindowStart` so the self-inflation is
  visible rather than hidden.

### 2.2 Volume climax and absorption (1H candle N) / Климакс и абсорбция

All four conditions are evaluated on the closed bar N:

1. **Cascade** (§2.1) present, and the cascade direction is opposite to the
   intended reversal direction.
2. **Extreme volume:** `RVOL >= 2.2` (inclusive, as written — note this differs
   from V3.0/V3.1, which used a strict `> 1.25`).
3. **Absorption rejection** — for a **bullish** reversal (down-cascade), either:
   - **wick:** `(min(open, close) − low) / (high − low) >= 0.40`; or
   - **engulfing:** the previous candle is bearish (`prev.close < prev.open`), the
     current is bullish (`close > open`), the body engulfs the previous body
     (`open <= prev.close` **and** `close >= prev.open`), **and**
     `bodyRatio = |close − open| / (high − low) >= 0.40`, **and** the close sits
     in the upper 30 % of the range (`(close − low) / (high − low) >= 0.70`).
   - Bearish reversal mirrored (upper wick; bullish→bearish engulfing; close in the
     lower 30 %: `(close − low)/(high − low) <= 0.30`).
   - A degenerate range (`high == low`) fails both branches.
4. **Direction of the candle:** for a bullish reversal `close > open`; bearish
   mirrored. (The engulfing branch implies this; the wick branch is stated
   explicitly so a long-wicked *down* bar cannot qualify.)

### 2.3 Execution / Исполнение

- **Corridor:** `close(N) ± 0.10 × ATR(1H, 14)`; fill from bar **N+1**, never on
  N; fill at the **worse** edge (`LONG min(open, zoneHigh)`, `SHORT max(open, zoneLow)`).
- **Corridor expiry:** 3 bars. The specification is silent; V3.0's frozen value is
  inherited deliberately and frozen here.
- **Ambiguity:** a bar that touches the corridor *and* breaches the stop is
  cancelled, never filled (inherited).
- **Geometry gate:** `risk > 0` and, for LONG, `stop < fill < tp1 < tp2` (mirrored
  SHORT); otherwise the setup is `rejected` and counted in the funnel. A cascade
  whose 50 % retracement already sits at or behind the entry corridor is therefore
  not traded — this is the same "the move happened without me" gate as V3.1's.
- **Fees:** maker 2 bps on entry, taker 5 bps on every exit, **per leg on that leg's
  own notional** (three legs for a TP1+TP2 trade). No rebate.
- **Overlap:** the research runner allows a new setup while a previously filled
  trade is still open — the same convention as the V3.0 and V3.1 research runners,
  kept for comparability. The production engine enforces one position per symbol;
  any port would trade **less** often. Disclosed, not corrected here.

### 2.4 Exit and risk management / Выход и риск

| item | rule |
|---|---|
| SL | behind the **climax wick extreme** ∓ `0.15 × ATR`: `low(N) − 0.15 ATR` for a bullish reversal, `high(N) + 0.15 ATR` for a bearish one. The artifact also records the cascade *window* extreme so a reader can see when the two differ. |
| TP1 | **50 % mean reversion of the cascade move** — the midpoint `(origin + terminal) / 2` of the cascade leg. 50 % of the position closes here. |
| TP1 alternative | `--tp1=ema50`: the 1H EMA50 at bar N instead (the specification's parenthetical alternative). Reported as a sensitivity, never as the primary. |
| Breakeven | after TP1 the stop moves to entry, armed only on bars **strictly after** the TP1 bar. |
| TP2 | **the origin of the cascade move** (`origin`, i.e. the window extreme against the cascade direction); the remaining 50 % closes here. |
| Timeout | 48 bars (1H), the entry bar counting as bar 1. |

### 2.5 Inherited intrabar rules / Унаследованные внутрибарные правила

Identical to the V3.0/V3.1 conventions (generic bar-resolution rules, not tuned
parameters): **R1** stop before targets on every bar; **R2** TP1 books before TP2
when both land on one bar; **R3** breakeven arms only on bars strictly after the
TP1 bar; **R4** the stop never moves backwards; **R5** the timeout counts the entry
bar as bar 1.

---

## 3. Variants and reporting / Варианты и отчёт

Two orthogonal specification ambiguities are resolved by shipping **all four
combinations** and naming the primary **before** the run:

| run | cascade window | TP1 | status |
|---|---|---|---|
| A | `union` (`k ∈ {3..6}`, largest qualifying) | 50 % of the cascade | **PRIMARY** |
| B | `fast3` (`k = 3`) | 50 % of the cascade | sensitivity |
| C | `union` | 1H EMA50 | sensitivity |
| D | `fast3` | 1H EMA50 | sensitivity |

Reported for the primary, and for every variant: n; TP1 hit %; TP2 hit %;
positive-R %; natural stop distance % (p25/median/p75); fee drag in R @2/5 bps
(and 5/5 spot for reference); gross R/trade; net R/trade @2/5; profit factor; max
drawdown in R; median bars held; exit mix; the full funnel (signals → pending →
filled / expired / cancelled / rejected / unresolved); per-direction and per-symbol
expectancy; the cascade-window distribution (`k*`) and the RVOL distribution of
entered trades; wick-vs-engulfing split; outlier dependence (ex-top-1, ex-top-5,
ex-top-1 %); and a side-by-side table against V3.0 (and V3.1) TRAIN.

## 4. Falsification criteria / Критерии фальсификации

Registered now, evaluated once, no adjustment afterwards:

- **F1 (primary).** `net R/trade @2/5 bps <= 0` on TRAIN ⇒ *"a volume climax with
  absorption after a ≥ 2 ATR expansion can be faded profitably at Binance futures
  fees"* is **falsified**.
- **F2 (cost).** fee drag `>= 0.10 R` at 2/5 bps ⇒ the claim that the
  climax-wick stop is wide enough to survive fees is **falsified**.
- **F3 (premise).** TP1 hit rate `< 50 %` ⇒ the mean-reversion premise is
  **falsified**: a cascade does *not* retrace half of its own range often enough
  for the fade to be a majority trade.

Sample-size honesty: if `n < 100` (primary or any variant quoted) the result is
reported as **underpowered** and no conclusion may be drawn from it.

## 5. What a PASS would and would not mean / Что означает PASS и что не означает

**Would mean:** a third hypothesis cleared a fee-inclusive TRAIN run at the
pre-registered criterion, with the cost and premise claims checked against F2/F3.

**Would not mean:** validation, deployability, or survival. TRAIN is burned data
for this programme; the VALIDATION window is spent and may never be re-read; the
2026-H1 window must stay unread. A passing V3.2 earns `V3_2_TRAIN_ONLY` and
nothing else. Any forward use is a separate operator decision and is not implied
by this document.

## 6. Reproduce / Воспроизведение

```bash
for c in union fast3; do for t in cascade ema50; do
  npx tsx research/v32_volume_climax.ts \
    --cache=/home/user/.cache/v30parity \
    --splits=artifacts/research/v2-real-20260915-080338/splits.json \
    --cascade=$c --tp1=$t \
    --out=artifacts/research/v32/v32-train-metrics-$c-$t.json
done; done
```

The cache holds 1H binary series for the six symbols covering 2022-01-01 …
2025-12-31; the simulator truncates them at `trainToMs` on load, so no candle
outside TRAIN is ever materialised. (The primary artifact is the `union` +
`cascade` run.)

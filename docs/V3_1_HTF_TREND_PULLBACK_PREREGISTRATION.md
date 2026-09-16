# V3.1 — HTF TREND PULLBACK & MITIGATION
# V3.1 — ОТКАТ В ТРЕНДЕ НА СТАРШЕМ ТАЙМФРЕЙМЕ И МИТИГАЦИЯ

**Status / Статус: `V3_1_PRE_REGISTERED`** — written and committed **before** the
simulator existed and before any TRAIN candle was read. Every rule, constant and
falsification criterion below was frozen at this moment; none of it may be
changed after the first run, and any later change requires a new document.

**Статус: `V3_1_PRE_REGISTERED`** — документ написан и закоммичен **до** того,
как появился симулятор и до чтения первой свечи TRAIN. Все правила, константы и
критерии фальсификации ниже заморожены в этот момент; после первого прогона
менять их нельзя, а любое изменение требует нового документа.

| pinned / зафиксировано | value / значение |
|---|---|
| engine surface / поверхность движка | `4839074` — nothing under `src/` is modified / `src/` не изменяется |
| dataset / датасет | `c3c1dce` — Binance Spot klines, 2022-01 … 2025-12 |
| slice / срез | **TRAIN only** — 1H per symbol `2022-01-01T00:00:00Z` … `2024-05-26T13:00:00Z` (21,037 candles) |
| symbols / символы | BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT, DOGEUSDT |
| timeframes / таймфреймы | 1H execution, 4H context (no 1D — see §1.4) |
| implementation / реализация | `research/v31_trend_pullback.ts` (written after this file) |
| artifact / артефакт | `artifacts/research/v31/v31-train-metrics.json` |
| tests / тесты | `tests/v31-trend-pullback.test.ts` |
| baseline / база сравнения | V3.0 TRAIN: net **+0.0994 R/trade** @2/5 bps, n = 1,585 |

> ⚠️ This is a **new hypothesis evaluated on a partly burned TRAIN window**. V3.0
> already used TRAIN, so any V3.1 result is exploratory by construction. A TRAIN
> pass is **not** a validation, and — because the single pre-registered VALIDATION
> window was spent on 2026-09-16 and may never be re-read — **V3.1 can never be
> validated on existing data**. Its only possible forward path is paper forward
> testing, and that requires a separate decision. `PRODUCTION_READY` is forbidden.

---

## 0. Hypothesis / Гипотеза

**EN.** V3.0 trades *reversals*: it waits for a 4H level to be swept and takes the
trade back through it. V3.1 tests the opposite behaviour in the same market: when
the 4H macro trend is already established (price above a rising EMA structure with
causal HH/HL), a pullback into the 50 % equilibrium of the active 4H impulse leg —
or into a fresh 4H imbalance — followed by a **displaced 1H resumption candle**
that breaks the previous 1H swing, continues rather than reverses. Entry is a
maker corridor around that candle's close, so the entry pays 2 bps instead of
5 bps and the trade is not chasing.

The mechanism claim, stated so it can be falsified: *a continuation entry has the
leg's terminal extreme (TP1) and its 1.5 extension (TP2) ahead of it, so a
correctly identified pullback should reach further than a reversal trade does* —
**but the stop is a 1H pullback extreme + 0.15 ATR**, which is the small
denominator that gave every V2.x strategy a 0.12–0.16 R fee drag. V3.1 therefore
predicts a *higher* fee-in-R than V3.0 (0.0732 R) and can only clear fees if the
gross edge is correspondingly larger. This is the single most likely way V3.1
fails, and it is registered here in advance.

**RU.** V3.0 торгует *развороты*: ждёт снятия 4H-уровня и заходит обратно через
него. V3.1 проверяет противоположное поведение на том же рынке: когда 4H-тренд
уже установлен (цена выше структуры EMA и каузальные HH/HL), откат в 50 %
равновесия активной 4H-импульсной ноги — или в свежий 4H-имбаланс — вместе с
**свечой возобновления на 1H с сильным смещением**, закрывающейся за предыдущий
1H-свинг, продолжает движение, а не разворачивает его. Вход — лимитный коридор
вокруг закрытия этой свечи: вход платит 2 bps вместо 5 bps, и сделка не
догоняет цену.

Механизм сформулирован так, чтобы его можно было опровергнуть: *у
продолжения впереди есть терминальный экстремум ноги (TP1) и его расширение 1.5
(TP2), поэтому правильно определённый откат должен доходить дальше, чем сделка
разворота* — **но стоп стоит за экстремумом 1H-отката + 0.15 ATR**, а это тот
самый малый знаменатель, который давал всем стратегиям V2.x комиссию 0.12–0.16 R.
Таким образом V3.1 предсказывает *большую* комиссию в R, чем V3.0
(0.0732 R), и может перекрыть её только за счёт существенно большего валового
преимущества. Это и есть наиболее вероятный способ провала V3.1, и он
регистрируется здесь заранее.

---

## 1. Data scope and hard guards / Данные и жёсткие ограничения

1. **TRAIN only.** Both series (1H and 4H) are truncated in memory at
   `trainToMs` before any computation. The simulator reads **no candle** with
   `openTime > trainToMs`, therefore no VALIDATION candle (from
   `validFromMs` = 2024-05-26T14:00Z) and no 2026 candle can be read.
2. **Outcome resolution is clipped too.** Bars handed to the trade manager must
   satisfy `openTime <= trainToMs`. A trade that cannot resolve inside the clip
   is counted as `unresolved` and excluded from every metric — the same treatment
   the frozen V3.0 runner gives dataset-boundary trades. Consequence: the very
   last setups of TRAIN are under-represented; that is the honest price of never
   touching the next slice.
3. **Guards are written into the artifact** (`guards`), so the claim is
   checkable rather than asserted: `trainToMs`, `maxCandleOpenTimeRead`,
   `candlesBeyondTrainRead` (must be 0), `candles2026Read` (must be 0),
   `barsClippedAtTrainBoundary`.
4. **No 1D series is loaded.** No rule below references 1D, so reading it would
   be data access with no purpose. The "4H/1D context" of the request is
   implemented as 4H context; 1D is deliberately unused.
5. **Windows come from the repository artifact**, not from memory:
   `artifacts/research/v2-real-20260915-080338/splits.json`
   (`trainFromMs` … `trainToMs` per symbol; the run refuses to start if a split
   is missing or if `trainToMs >= validFromMs`).

---

## 2. Frozen rules / Замороженные правила

All indicator primitives are the frozen ones already in `src/` and reused
unchanged: `emaSeries`, `findSwingsV2`, `knownSwings`, `structureBias`,
`detectStructureBreak`, `buildAtrContext`, `buildVolumeContext`,
`closedHtfCandles`. Defaults from the settings registry:
swing strength `engine.swing_lookback = 3`, `risk.atr_period = 14`,
`v2.volume_period = 20`.

### 2.1 HTF trend identification (4H) / Идентификация тренда

Evaluated on the 4H candles that had closed by the evaluated 1H bar's close
(`closedHtfCandles(h4, '4h', c.closeTime)`); every swing is used only from
`confirmedIndex` onward.

- **Bullish** when all three hold:
  1. `ema50[last] > ema200[last]` and `close[last] > ema50[last]`;
  2. `structureBias(swings4h, last) === 'BULLISH'` — the last two confirmed 4H
     swings are HH and HL (the "series of causal HH/HL");
  3. the last confirmed 4H swing LOW is *before* the last confirmed 4H swing HIGH
     (the up-leg is the one currently terminated, i.e. the impulse leg is active).
- **Bearish** is the mirror: `close < ema50 < ema200`, `structureBias === 'BEARISH'`,
  last confirmed HIGH before last confirmed LOW.
- `emaSeries` is computed on the truncated 4H closes with periods 50 and 200;
  a bar whose EMA200 is still `null` (the first ~200 4H bars of 2022) can never
  produce a signal. That warm-up is inside TRAIN, so it costs no data access.

### 2.2 Pullback into value / discount (1H bar N) / Откат в зону стоимости

The **active impulse leg** is `[legLow, legHigh]` for a bull trend
(`legLow` = last confirmed 4H swing low, `legHigh` = last confirmed 4H swing high)
and `[legHigh, legLow]` mirrored for a bear trend. Two independent pullback
conditions, OR-ed; the one that fired is recorded (`pullbackSource`):

- **EQ** — the bar trades into the leg's equilibrium:
  LONG `c.low <= (legLow + legHigh)/2`, SHORT `c.high >= (legLow + legHigh)/2`.
- **FVG** — the bar trades into a **fresh** 4H fair-value gap in the trend's
  direction. Gap construction (3 consecutive closed 4H candles `a,b,c`):
  bullish gap = `[a.high, c.low]` when `c.low > a.high`; bearish gap =
  `[c.high, a.low]` when `c.high < a.low`. A gap is **fresh** while no closed 4H
  candle after `c` has intersected the zone; it is dead forever once one has.
  Touch: `c.low <= gap.top && c.high >= gap.bottom` (bullish), mirrored bearish.

The leg is only valid if the 1H bar's close has not invalidated it
(LONG `c.close > legLow`, SHORT `c.close < legHigh`); an invalidated leg means the
pullback became a reversal and no trade is taken.

### 2.3 Resumption trigger (1H bar N) / Триггер возобновления

All four conditions must hold **on the same closed bar N**:

1. **Direction:** LONG `c.close > c.open`, SHORT `c.close < c.open`.
2. **Displacement:** `bodyRatio = |close − open| / (high − low) >= 0.35` and
   `RVOL > 1.25` (strictly greater — same asymmetry as V3.0).
3. **1H structure break:** `detectStructureBreak(h1, swings1h, N, atr1h, 0)` with
   `!wickOnly` and `direction === trend`. The broken swing's index is kept: it is
   the pullback's origin. The returned `type` (BOS / CHOCH) is recorded for
   reporting; both are accepted because the specification says "CHoCH / break of
   previous 1H swing".
4. **Pullback condition (§2.2)** satisfied on the same bar N.

### 2.4 Execution / Исполнение

- **Corridor:** `close(N) ± 0.10 × ATR(1H, 14)`; fill from bar **N+1**, never on
  N; fill price is the **worse** edge (`LONG min(open, zoneHigh)`,
  `SHORT max(open, zoneLow)`).
- **Corridor expiry:** 3 bars. The specification is silent on this; the frozen
  V3.0 value `CORRIDOR_EXPIRY_BARS = 3` is inherited deliberately and frozen now,
  so it is a declared convention rather than a post-hoc choice.
- **Ambiguity:** a bar that touches the corridor *and* breaches the stop is
  cancelled (never filled) — inherited from V3.0.
- **Geometry gate:** fill must satisfy `risk > 0` and, for LONG,
  `stop < fill < tp1 < tp2` (mirrored SHORT); otherwise the setup is rejected and
  counted as `rejected`.
- **Fees:** maker 2 bps on entry, taker 5 bps on every exit, charged **per leg on
  that leg's own notional** (3 legs for a TP1+TP2 trade: entry, half, half).
  No rebate.

### 2.5 Exit and risk management / Выход и риск

| item | rule |
|---|---|
| SL | behind the 1H pullback extreme ∓ `0.15 × ATR(1H)`. Pullback extreme = min(low) over `(levelIndex, N]` for LONG (max(high) for SHORT), where `levelIndex` is the swing index returned by the structure break — i.e. the extreme of the leg that started at the broken swing. |
| TP1 | the terminal extreme of the active impulse leg: `legHigh` (LONG) / `legLow` (SHORT) — *the 4H swing at which the pullback began*. 50 % of the position closes here. |
| Breakeven | after TP1 the stop moves to the entry price, armed only on bars **strictly after** the TP1 bar. |
| TP2 | 1.5× Fibonacci extension of the impulse leg: LONG `legLow + 1.5 × (legHigh − legLow)`, SHORT `legHigh − 1.5 × (legHigh − legLow)`. The remaining 50 % closes here. |
| Timeout | 60 bars (1H), the entry bar counting as bar 1. |

**Interpretation registered in advance.** "The origin 4H Swing High (for Long)"
is read as *the swing high from which the current pullback originated*, i.e. the
terminal extreme of the active impulse leg (`legHigh`), because (a) it is the
level the continuation retests first and (b) the mirrored SHORT rule names the
swing low, which is the same object on the other side. Under the alternative
reading (the swing low that originated the up-leg) TP1 would be *below* the
entry for a long and the trade would be geometrically impossible; the gate in
§2.4 would reject 100 % of setups, which is stated here so the choice cannot be
re-litigated after seeing results.

### 2.6 Inherited intrabar rules / Унаследованные внутрибарные правила

Identical to V3.0's frozen conventions (they are generic bar-resolution rules,
not tuned parameters):

- **R1** the stop is checked before targets on every bar;
- **R2** if TP1 and TP2 land on one bar, TP1 books first, then TP2;
- **R3** breakeven arms only on bars strictly after the TP1 bar;
- **R4** the stop never moves backwards;
- **R5** the timeout counts the entry bar as bar 1.

---

## 3. Reported metrics / Отчётные метрики

Exactly what will be published, whether or not it is flattering:
n; TP1 hit %; TP2 hit %; positive-R %; natural stop distance % (p25/median/p75);
fee drag in R at 2/5 bps (and 5/5 spot for reference); gross R/trade; net R/trade
@2/5; profit factor; max drawdown in R; median bars held; exit mix; the full
funnel (signals → pending → filled / expired / cancelled / rejected / unresolved);
per-direction and per-symbol expectancy; `pullbackSource` split (EQ vs FVG);
BOS/CHOCH split; outlier dependence (ex-top-1, ex-top-5, ex-top-1 %); and a
side-by-side comparison with V3.0 TRAIN.

## 4. Falsification criteria / Критерии фальсификации

Registered now, evaluated once, no adjustment afterwards:

- **F1 (primary).** `net R/trade @2/5 bps <= 0` on TRAIN ⇒ *"a displaced pullback
  continuation in an established 4H trend pays Binance futures fees"* is
  **falsified**. Same criterion that V3.0 had to clear.
- **F2 (mechanism).** fee drag `>= 0.10 R` at 2/5 bps ⇒ the claim that the
  1H-pullback stop is wide enough to survive fees (V3.0: 0.0732 R) is
  **falsified**, and the result must be reported as "the continuation edge, if
  any, is smaller than the cost of expressing it".
- **F3 (premise).** TP1 hit rate `< 40 %` ⇒ the *continuation* premise is
  **falsified**: pullbacks into value inside a confirmed 4H trend do not resume
  often enough for the direction of the trade to be right more often than not.

Reported but **not** pass/fail: profit factor, drawdown, symbol and direction
splits, outlier dependence. Sample-size honesty: if `n < 100` the result is
reported as **underpowered** regardless of sign, and no conclusion may be drawn.

## 5. What a PASS would and would not mean / Что означает PASS и что не означает

**Would mean:** one more candidate cleared a fee-inclusive TRAIN run at the
pre-registered criterion, with the mechanism claim of §0 checked against F2/F3.

**Would not mean:** validation, deployability, or that the edge will survive.
TRAIN is partly burned (V3.0 used it); the VALIDATION window is spent and may
never be re-read; the 2026-H1 window has no data and must stay unread. A passing
V3.1 therefore earns the status `V3_1_TRAIN_ONLY` and nothing more; the only
forward evidence available is a paper forward test, which is a separate decision
by the operator and is not implied by this document.

## 6. Reproduce / Воспроизведение

```bash
npx tsx research/v31_trend_pullback.ts \
  --cache=/home/user/.cache/v30parity \
  --splits=artifacts/research/v2-real-20260915-080338/splits.json \
  --out=artifacts/research/v31/v31-train-metrics.json
```

The cache holds 1H and 4H binary series for the six symbols covering 2022-01-01 …
2025-12-31; the simulator truncates both at `trainToMs` on load, so no candle
outside TRAIN is ever materialised.

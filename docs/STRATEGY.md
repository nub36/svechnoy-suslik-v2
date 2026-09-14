# Strategy reference

This document describes **both** strategies that exist in this repository and
states plainly which one trades.

| | SMC V1 | SMC V2 |
|---|---|---|
| status | **ACTIVE** — production / FORWARD_TEST | **RESEARCH ONLY** — not wired into the signal path |
| entry point | `src/strategy/smart-money.ts` → `evaluate()` | `src/strategy/v2/engine.ts` → `evaluateV2()` |
| gate | always on | `v2.enabled`, default **false** |
| outputs | LONG / SHORT / no-signal | LONG / SHORT / **WAIT** |
| used by | strategy worker, replay, overlays | `scripts/v1-vs-v2.ts` only |

**V2 is not active.** It was built, tested and measured, and the measurement did
not justify switching. §22 explains exactly why. Activation is a separate
decision that requires real historical data.

---

## Part 0 — Why V2 exists

V1 answers "do enough Smart Money factors point the same way?" It does not model
*where* price is. The requirement that motivated V2 is different and much more
specific:

> Price has arrived at a significant range high or low. Is the market confirming
> **REVERSAL** (liquidity swept, reclaimed, structure turning) or
> **CONTINUATION** (a genuine break, accepted and held)?

### 0.1 HIGH is not SHORT, LOW is not LONG

The rule `reached HIGH → SHORT` is wrong, and dangerous in a trending market: it
shorts every new high in a bull run. A range boundary is a **place to look**,
never a signal. The same boundary can produce a short (it was swept and
rejected) or a long (it was broken and accepted). Only the market's reaction to
the level decides, and until that reaction exists the answer is **WAIT**.

### 0.2 WAIT is a first-class answer

`V2Setup.direction` is `'LONG' | 'SHORT' | 'WAIT'`. WAIT always carries
`waitReasons`, in plain Russian, e.g.:

> «Цена у верхней границы диапазона, но нет ни подтверждённого снятия
> ликвидности с возвратом, ни принятия выше уровня.»

This is deliberately more useful than a fabricated 60%-confidence LONG.

---

## Part 1 — Pipeline

```
closed candle N
   │
   ├─ indicators ......... ATR, EMA20/50/200, MACD 12/26/9, RSI14, ADX14, RVOL
   │
   ├─ swings ............. fractal pivots, confirmed at index + strength
   ├─ structure .......... HH/HL/LH/LL → bias; BOS / CHoCH by CLOSE
   ├─ range .............. rangeHigh / rangeLow / mid / confidence / touches
   ├─ fibonacci .......... 0 / 23.6 / 38.2 / 50 / 61.8 / 78.6 / 100
   ├─ liquidity .......... buy-side & sell-side pools, equal-level clustering
   │
   ├─ CLASSIFIER ......... sweep (→ REVERSAL) vs breakout (→ CONTINUATION)
   ├─ displacement ....... impulse vs noise, ATR-normalised
   ├─ OB / FVG ........... structurally justified only
   ├─ HTF context ........ only CLOSED higher-timeframe candles
   │
   ├─ component profile .. 10 components, scored per side
   ├─ conflict ........... LONG evidence vs SHORT evidence
   │
   └─ decision ........... LONG / SHORT / WAIT
         └─ entry OPEN N+1 → structural SL → structural TP1/TP2/TP3
```

Source files:

| concern | file |
|---|---|
| vocabulary / types | `src/strategy/v2/types.ts` |
| indicator maths | `src/strategy/v2/indicators.ts` |
| structure, range, liquidity, sweep/breakout, OB, FVG | `src/strategy/v2/structure.ts` |
| higher-timeframe context | `src/strategy/v2/htf.ts` |
| setup assembly and decision | `src/strategy/v2/engine.ts` |
| public surface + `v2.enabled` gate | `src/strategy/v2/index.ts` |
| walk-forward replay | `src/replay/v2-runner.ts` |

---

## Part 2 — Market structure

### 2.1 Swing detection

`findSwingsV2(candles, strength)` — a high at index `i` is a pivot when it is
the **strict** maximum of `[i-s, i+s]`; symmetrically for lows.

**Confirmation timing is the anti-look-ahead cornerstone.** A pivot at bar `i`
needs `s` bars on its right, so it becomes knowable only at `i + s`:

```ts
confirmedIndex = index + strength
```

Every consumer filters with `knownSwings(swings, atIndex)`, which keeps only
`confirmedIndex <= atIndex`. Parameter: `engine.swing_lookback` (default 3).

### 2.2 HH / HL / LH / LL

Each swing is labelled against the previous swing of the same kind:

| label | meaning |
|---|---|
| HH | higher high |
| LH | lower high |
| HL | higher low |
| LL | lower low |
| FIRST | no previous same-kind swing |

### 2.3 Bias

`structureBias()` reads the last two confirmed highs and lows:

- `HH && HL` → **BULLISH**
- `LH && LL` → **BEARISH**
- anything else → **RANGE**

### 2.4 BOS and CHoCH

`detectStructureBreak()`. A break requires the bar to **CLOSE** beyond the most
recent confirmed swing.

```
penetrationAtr     = (close - level) / ATR        [LONG; mirrored for SHORT]
wickPenetrationAtr = (high  - level) / ATR
wickOnly           = closeBeyond <= 0 && wickBeyond > 0
```

- **`wickOnly` is never a break.** A wick through a level is returned with
  `wickOnly: true` and the reason string "not a break", so callers can display
  the event without acting on it. Pinned by test *"a wick through a swing high
  is NOT a BOS"*, which fails if the rule is relaxed.
- **BOS** — break that *continues* the prevailing bias.
- **CHoCH** — break that *opposes* it, i.e. a potential regime change.
- Minimum size: `v2.structure_min_penetration_atr` (default 0.05 ATR).

---

## Part 3 — Range, Fibonacci, premium/discount

### 3.1 Range construction

`buildRange()` anchors on the **highest confirmed swing high** and **lowest
confirmed swing low** in the lookback window — explicitly *not* a raw
`max/min` of the last N candles.

Stored fields: `high`, `low`, `mid`, `size`, `age`, `knownAtIndex`,
`touchCountHigh`, `touchCountLow`, `position`, `confidence`, `sourceTimeframe`.

```
position   = (close - low) / (high - low)                     ∈ [0,1]
sizeScore  = min(1, size / (ATR * 4))
touchScore = min(1, (min(touchHigh, touchLow) + 1) / 3)
ageScore   = min(1, age / 10)
confidence = 0.5*sizeScore + 0.3*touchScore + 0.2*ageScore
```

A touch counts when a bar's extreme comes within 10% of the range size of the
boundary. Setups are rejected when `confidence < v2.min_range_confidence`.

### 3.2 Location

`rangeLocation()` with `v2.range_edge_pct` (default 0.25):

- `position >= 0.75` → **HIGH**
- `position <= 0.25` → **LOW**
- otherwise → **MID**

### 3.3 Fibonacci

Anchored low→high, so it reads identically for both directions:

```
level(f) = low + size * f     f ∈ {0, .236, .382, .5, .618, .786, 1}
```

`level500` is **equilibrium**. Zones: `> 0.55` PREMIUM, `< 0.45` DISCOUNT, else
EQUILIBRIUM. Bullish setups are preferred from discount, bearish from premium.

**Fibonacci never generates a signal.** It is confluence, a position map, and a
source of targets.

---

## Part 4 — Liquidity

### 4.1 Pools

Liquidity rests where stops are: **above highs** (buy-side) and **below lows**
(sell-side). `findLiquidityPools()` clusters confirmed swings whose prices are
within `v2.liquidity_tol_atr` ATR of each other.

```
pool price = max(cluster)  for BUY_SIDE
             min(cluster)  for SELL_SIDE
touchScore = min(1, touches / 3)
ageScore   = min(1, age / 20)
strength   = 0.6*touchScore + 0.4*ageScore
```

Kind: 1 touch `SWING`, 2 `EQUAL`, 3+ `CLUSTER`.

### 4.2 Sweep — the reversal trigger

`detectSweep()`. **All** of the following must hold:

1. the bar's extreme penetrates the pool by `>= v2.sweep_min_penetration_atr`;
2. price **reclaims** — closes back on the original side, on the sweep bar or
   within `v2.sweep_reclaim_window` bars **already known** at evaluation time;
3. a rejection wick beyond the level `>= v2.sweep_min_wick_ratio` of the bar
   range.

```
quality = 0.25*min(1, penetrationAtr)
        + 0.25*wickRatio
        + 0.25*levelStrength
        + 0.15*rvolScore
        + (reclaimBars == 0 ? 0.10 : 0.05)

rvolScore = clamp01((rvol - 0.8) / 1.2)
```

Direction: sweeping **buy-side** liquidity implies a **SHORT** reversal, and
vice versa.

Two requirements are pinned by tests that fail if relaxed:
- *"merely touching a level is NOT a sweep"*
- *"penetration WITHOUT a reclaim is not a sweep"*

### 4.3 Breakout — the continuation trigger

`detectBreakout()` requires acceptance, not just penetration:

1. the bar **CLOSES** beyond the level by `>= v2.breakout_min_close_atr`;
2. body `>= v2.breakout_min_body_atr` ATR (displacement);
3. the bar's own direction agrees with the break;
4. no immediate reclaim within `v2.breakout_hold_window` known bars.

```
quality = 0.28*min(1, closeBeyondAtr)
        + 0.28*min(1, displacementAtr/1.5)
        + 0.16*bodyRatio
        + 0.16*rvolScore
        + 0.12*holdScore
```

### 4.4 Sweep vs breakout, and invalidation

They are mutually exclusive on a bar (asserted by test). A **valid, holding
breakout takes priority** and *invalidates the opposing reversal idea* at that
level — this is what stops the system shorting every new high in an uptrend.

| at range HIGH | outcome |
|---|---|
| swept + reclaimed | REVERSAL **SHORT** |
| closed beyond + held | CONTINUATION **LONG** |
| neither | **WAIT** |

| at range LOW | outcome |
|---|---|
| swept + reclaimed | REVERSAL **LONG** |
| closed beyond + held | CONTINUATION **SHORT** (breakdown) |
| neither | **WAIT** |

---

## Part 5 — Displacement, Order Blocks, FVG

### 5.1 Displacement

```
bodyAtr       = |close - open| / ATR          must be >= v2.displacement_min_body_atr
bodyRatio     = |close - open| / (high - low)
closeLocation = (close - low) / (high - low)
locScore      = LONG ? closeLocation : 1 - closeLocation
strength      = 0.40*min(1, bodyAtr/2) + 0.25*bodyRatio + 0.20*locScore + 0.15*rvolScore
```

### 5.2 Order Blocks

An OB is the last **opposing** candle before a displacement — and only when
that displacement has a **structural cause**: `BOS`, `CHOCH`, or
`SWEEP_REACTION`. Without one, no OB is created. "Any red candle before a green
one" is explicitly not an OB.

Lifecycle (`buildOrderBlock`, walking forward only to the evaluation bar):

| state | condition |
|---|---|
| FRESH | created, untouched |
| TOUCHED | price traded into `[low, high]` |
| MITIGATED | price traded through the 50% midpoint |
| INVALIDATED | a bar **closed** fully beyond the far side |

### 5.3 Fair Value Gap

Three-bar imbalance, known only once bar `i+1` has closed:

```
bullish: low[i+1] > high[i-1]   →  gap = (high[i-1], low[i+1])
bearish: high[i+1] < low[i-1]   →  gap = (high[i+1], low[i-1])
sizeAtr = (top - bottom) / ATR  must be >= v2.fvg_min_size_atr
```

States: FRESH, PARTIAL (`filledFraction > 0.05`), FILLED (traded fully
through). OB + FVG together are confluence, but a missing FVG does **not** veto
a setup — there is no statistical evidence yet that it should.

---

## Part 6 — Indicators

All are causal: the value at bar `i` uses only bars `0..i`.

### 6.1 ATR — Wilder, `risk.atr_period` (14)

```
TR[t]   = max(high-low, |high - close[t-1]|, |low - close[t-1]|)
ATR[p-1]= mean(TR[0..p-1])
ATR[t]  = (ATR[t-1]*(p-1) + TR[t]) / p
```

ATR is the **normalisation backbone**: displacement, sweep penetration, break
size, FVG size, stop buffers and the volatility regime are all expressed in ATR,
so one threshold works for both BTCUSDT and DOGEUSDT.

```
atrPct   = ATR / close * 100
atrRatio = ATR / median(ATR series)
regime   = ratio < 0.75 → LOW;  ratio > 1.4 → HIGH;  else NORMAL
```

### 6.2 EMA 20 / 50 / 200

```
k        = 2 / (period + 1)
EMA[p-1] = SMA(close[0..p-1])
EMA[t]   = close[t]*k + EMA[t-1]*(1-k)
slope20Atr = (EMA20[t] - EMA20[t-1]) / ATR
spreadAtr  = |EMA20 - EMA50| / ATR
```

`alignment` is BULLISH when `price > EMA20 && EMA20 > EMA50 && (EMA200 absent ||
EMA50 > EMA200)`, mirrored for BEARISH, else RANGE. EMA200 requires ≥200 bars,
otherwise `null`. **`price > EMA` alone is never a signal** — EMA is context.

### 6.3 MACD 12 / 26 / 9

```
MACD      = EMA(close,12) - EMA(close,26)
signal    = EMA(MACD, 9)
histogram = MACD - signal
```

Reported: `histogramSlope` (Δhistogram), `crossUp`/`crossDown` (histogram sign
change), `aboveZero`, `accelerating` (|h| growing over three bars). Periods are
the fixed baseline and are **not optimised**. Momentum confirmation only.

### 6.4 RSI 14 — Wilder

```
avgGain[p] = mean(gains[1..p]);   then  avgGain[t] = (avgGain[t-1]*(p-1) + gain[t]) / p
RS  = avgGain / avgLoss
RSI = 100 - 100/(1 + RS)          (RSI = 100 when avgLoss == 0)
```

Divergence compares the last two local extremes: price HH with RSI LH → bearish;
price LL with RSI HL → bullish.

**RSI > 70 is not a SHORT and RSI < 30 is not a LONG.** Strong trends stay
overbought for a long time. The `RsiContext` object deliberately has **no
direction field** (asserted by test). Only divergence and the 50-line nudge the
momentum component.

### 6.5 ADX 14 — Wilder

```
+DM = (high-prevHigh) if > (prevLow-low) and > 0 else 0
-DM = (prevLow-low)   if > (high-prevHigh) and > 0 else 0
+DI = 100 * wilder(+DM) / wilder(TR)
-DI = 100 * wilder(-DM) / wilder(TR)
DX  = 100 * |+DI - -DI| / (+DI + -DI)
ADX = Wilder average of DX
```

Regime: `>= 25` STRONG, `>= 20` DEVELOPING, else RANGE. **ADX never chooses a
direction** — asserted by a test that feeds a pure downtrend and requires
STRONG strength with `bullishPressure === false`.

### 6.6 Volume / RVOL

```
RVOL = volume[t] / mean(volume[t-period .. t-1])     period = v2.volume_period (20)
spike = RVOL >= 1.8
```

The average **excludes the current bar** so a huge bar cannot dilute its own
signal. Volume is never a standalone direction.

---

## Part 7 — Multi-timeframe context

`src/strategy/v2/htf.ts`.

```
1m → 5m,15m    5m → 15m,1h    15m → 1h,4h    30m → 1h,4h
1h → 4h,1d     4h → 1d        1d → 1w        1w → (none)
```

**The rule that prevents the most common backtest fraud:** a higher-timeframe
candle with `openTime T` closes at `T + tfMs(htf)` and is usable only when that
close time is `<= the evaluated bar's closeTime`.

```ts
closedHtfCandles(candles, htf, asOfCloseTime)
  → candles.filter(c => c.isClosed && c.openTime + tfMs(htf) <= asOfCloseTime)
```

Using a forming 4h candle to justify a 15m entry is look-ahead. Pinned by test
*"an HTF candle is unusable until it has actually CLOSED"*.

Alignment is **labelled, not enforced**:

| alignment | score |
|---|---|
| ALIGNED | 1.0 |
| NEUTRAL | 0.5 |
| UNKNOWN | 0.4 |
| COUNTER_TREND | 0.15 |

A counter-trend setup is penalised but **not banned** — whether to filter it out
is a question for statistics, not for an assumption.

---

## Part 8 — Component scoring and conflict

### 8.1 The V1 defect this fixes

V1 computes `score = 100 * Σcontribution / Σweight` over **counted factors
only**. One factor firing alone gives `25/25 = 100`. Measured over the corpus,
V1 score is *inversely* related to outcome (score 100 → avgR −0.46; score 55–60
→ avgR +1.13) because `corr(score, confirmations) = −0.36`. See
`docs/strategy-evidence.md`.

### 8.2 The V2 profile

Ten components, each scored **0..1 for each side independently**:

| component | source |
|---|---|
| structure | confirmed BOS/CHoCH in this direction, else bias |
| liquidity | sweep quality (or breakout quality × 0.7) |
| displacement | displacement strength |
| obFvg | 0.6 live OB + 0.4 live FVG |
| volume | `clamp01((RVOL - 0.7) / 1.3)` |
| htf | alignment score |
| trend | EMA alignment |
| momentum | MACD agreement, acceleration, RSI divergence / 50-line |
| volatility | ATR regime (NORMAL 0.8, HIGH 0.5, LOW 0.35) |
| roomToTarget | `clamp01(finalR / (2 * v2.min_room_r))` |

```
evidence = Σ(component_i * weight_i) / Σ weight_i          ∈ [0,1]
```

Weights (`COMPONENT_WEIGHTS`): structure 1.4, liquidity 1.4, displacement 1.1,
roomToTarget 1.1, htf 1.0, obFvg 0.9, volume 0.8, trend 0.8, momentum 0.8,
volatility 0.5.

These are **deliberately flat and were not tuned**. Per the requirement, the
features were made measurable first; weighting is a job for statistics on real
data.

A single maxed component now yields evidence `< 0.25`, not 100 — asserted by
test.

### 8.3 Conflict

```
conflict     = min(longEvidence, shortEvidence)
netEvidence  = |longEvidence - shortEvidence|
```

A direction is issued only when:

```
evidence(candidate)               >= v2.min_evidence      (0.45)
evidence(candidate) - evidence(other) >= v2.min_net_evidence (0.12)
```

Otherwise → WAIT, with the conflict spelled out in `waitReasons`.

### 8.4 Evidence is not probability

`evidence` is a bounded weighted average of heuristic components. It is **not**
calibrated and must never be displayed as a `%` or called a probability. The
replay layer stores `score = round(evidence * 100)` purely for interface
compatibility with V1 tooling; it carries no probabilistic meaning.

---

## Part 9 — Entry, stop, targets

### 9.1 Entry — N+1

A setup confirmed on **closed** candle N enters at the **OPEN of N+1**, via the
shared `resolveEntry()`. Until N+1 exists there is no entry price. This is the
reproducible baseline entry.

A retracement entry (OB/FVG retest, 50% of displacement) is a *separate* model,
recorded as future work in §23 — deliberately **not** mixed into the baseline.

### 9.2 Structural stop

| setup | anchor | level |
|---|---|---|
| REVERSAL | `SWEEP_EXTREME` | beyond the sweep extreme ± `v2.stop_buffer_atr` × ATR |
| CONTINUATION | `BREAKOUT_LEVEL` | back inside the broken level ± buffer |

Every stop carries a human-readable `reason` describing what invalidates the
idea. A stop landing on the wrong side of entry forces WAIT. There is no
fixed-percentage stop.

### 9.3 Structural targets

| target | basis |
|---|---|
| TP1 | `INTERNAL_LIQUIDITY` — nearest pool ahead of price |
| TP2 | `EQUILIBRIUM` — range mid / 50% Fib |
| TP3 | `RANGE_EDGE` — opposite side of the range |
| fallback | `R_MULTIPLE` — 1R/2R/3R, only when structure supplies nothing |

So a short from the high targets: internal liquidity → 50% → range low.
Targets are de-duplicated, must have `r > 0`, and are sorted ascending by R.

### 9.4 Room to target

```
finalR   = R multiple of the furthest target
adequate = finalR >= v2.min_room_r      (1.5)
```

Inadequate room → WAIT. Note the interaction documented in §22: when the stop is
tight and the opposite range edge is far, `finalR` can reach 40R+, which makes
the final target effectively unreachable within the timeout.

---

## Part 10 — State machine

```
SCANNING
   └─ price approaches a boundary        → APPROACHING_LEVEL
        └─ price at the edge              → AT_LIQUIDITY
             ├─ sweep + reclaim           → SWEEP_DETECTED      (REVERSAL)
             └─ close beyond + hold       → BREAKOUT_DETECTED   (CONTINUATION)
                  └─ evidence + stop + room pass → READY → signal
                  └─ any gate fails              → WAIT (reasons recorded)
```

`INVALIDATED` covers a reversal idea killed by a holding breakout in the
opposite direction. Transitions are deterministic: the same candles always
produce the same phase (asserted by a determinism test).

Signal lifecycle after READY is unchanged from V1 and is owned by the shared
code: `WAITING_ENTRY` → `OPEN` → `TP1_HIT` / `TP2_HIT` → `TP3_HIT` / `STOPPED` /
`EXPIRED`. Only the **final** TP rung terminates the walk; TP1 and TP2 are
milestones and do **not** close the position.

---

## Part 11 — Anti-look-ahead guarantees

| guarantee | mechanism | test |
|---|---|---|
| only closed candles | `candles.filter(c => c.isClosed)` | "never evaluates a candle that has not closed" |
| bar N cannot see N+1 | `closed.slice(0, evalIndex + 1)` | "evaluating bar N ignores every candle after N" |
| pivots delayed | `confirmedIndex = index + strength` | "confirms a pivot only after `strength` bars" |
| HTF must be closed | `openTime + tfMs(htf) <= asOfCloseTime` | "an HTF candle is unusable until it has actually CLOSED" |
| OB/FVG lifecycle causal | forward walk bounded by `evalIndex` | OB lifecycle test |
| sweep reclaim causal | backwards scan over already-known bars | reclaim tests |
| deterministic | no clock, no randomness | "identical inputs give identical output" |

The strongest of these is the equality test: `evaluateV2` at index N over the
**full** array must be byte-identical (`JSON.stringify`) to the same call over
the array **truncated** at N. Any future leak breaks it.

### Ambiguous TP/SL candles

When one bar's range touches both a take-profit and the stop, the outcome is
decided by `outcome.sl_priority_on_ambiguous_bar`, default **true** → the
**stop** wins. The favourable outcome is never silently assumed. V2 inherits
this because it calls the same `trackOutcome()`.

---

## Part 12 — Replay and the V1/V2 comparison

`src/replay/v2-runner.ts` walks candles strictly chronologically. **Only signal
generation differs between V1 and V2.** Entry resolution (`resolveEntry`), the
TP/SL walk, the ambiguous-bar policy and R accounting (`trackOutcome`) are the
*same production functions* V1 uses. There is no second backtester, so a
difference in results is attributable to the strategy.

```bash
npx tsx scripts/v1-vs-v2.ts --tf=15m,1h,4h
```

Split: **per (symbol, timeframe) series**, 60% TRAIN / 20% VALIDATION / 20%
TEST, by time. Per-series rather than global because 600 candles spans ~11 years
on `1w` and ~10 hours on `1m`; a single global cut put nearly all intraday
trades in one slice.

---

## Part 13 — Parameters and their exact runtime source

Every V2 parameter lives in `SETTINGS_REGISTRY` (`src/core/settings.ts`) and is
read by `paramsFromSettings()` in `src/strategy/v2/engine.ts`. There are no
decorative settings — `tests/settings-wiring.test.ts` fails if a key is not
actually read by its declared consumer.

| key | default | used for |
|---|---|---|
| `v2.enabled` | `false` | master gate for the research engine |
| `v2.range_edge_pct` | 0.25 | HIGH/LOW/MID classification |
| `v2.min_range_confidence` | 0.25 | reject weak ranges |
| `v2.sweep_min_penetration_atr` | 0.1 | sweep must exceed level |
| `v2.sweep_min_wick_ratio` | 0.25 | rejection wick |
| `v2.sweep_reclaim_window` | 3 | bars allowed to reclaim |
| `v2.breakout_min_close_atr` | 0.25 | close beyond level |
| `v2.breakout_min_body_atr` | 0.5 | breakout displacement |
| `v2.breakout_hold_window` | 3 | immediate-reclaim check |
| `v2.displacement_min_body_atr` | 0.6 | impulse vs noise |
| `v2.structure_min_penetration_atr` | 0.05 | BOS/CHoCH size |
| `v2.fvg_min_size_atr` | 0.15 | ignore micro gaps |
| `v2.liquidity_tol_atr` | 0.25 | equal-level clustering |
| `v2.min_evidence` | 0.45 | direction gate |
| `v2.min_net_evidence` | 0.12 | conflict gate |
| `v2.min_room_r` | 1.5 | room-to-target floor |
| `v2.stop_buffer_atr` | 0.25 | structural stop buffer |
| `v2.rsi_period` | 14 | RSI |
| `v2.adx_period` | 14 | ADX |
| `v2.volume_period` | 20 | RVOL average |

Shared with V1: `engine.swing_lookback` (3), `engine.lookback_candles` (300),
`risk.atr_period` (14), `risk.min_rr`, `outcome.timeout_bars` (48),
`outcome.sl_priority_on_ambiguous_bar` (true).

**Registry default ≠ live value.** `loadSettings()` layers the `settings` table
over registry defaults, so the DB wins. Read the DB (or Admin) for live values.

---

## Part 14 — Worked examples

### 14.1 REVERSAL SHORT from the range high

```
range: high 110.5 (two equal highs), low 88.5, mid 99.5
bar 23:  O 100.0   H 118.0   L 99.5   C 101.0   vol 3x average
```

1. `position ≈ 0.57` before the bar; the high is the observation point.
2. Pool BUY_SIDE @ 110.5, `touches = 2` → EQUAL, strength ≈ 0.6.
3. Penetration `= 118 - 110.5 = 7.5` ≈ 1.9 ATR ≥ 0.1 ✓
4. Close 101.0 < 110.5 → **reclaimed on the same bar**, `reclaimBars = 0` ✓
5. Rejection wick `= 118 - 101 = 17` of an 18.5 range → `wickRatio ≈ 0.92` ✓
6. → `SWEEP_DETECTED`, direction **SHORT**, quality ≈ 0.8
7. Stop: above the sweep extreme 118 + 0.25 ATR.
8. Targets: internal liquidity → 99.5 equilibrium → 88.5 range low.
9. If evidence ≥ 0.45 and net ≥ 0.12 and room ≥ 1.5R → **SHORT**, entry at the
   open of bar 24.

### 14.2 CONTINUATION LONG through the same high

```
bar 23:  O 100.0   H 125.0   L 99.5   C 124.0   vol 4x average
```

Close 124 is **beyond** 110.5 by ≈3.4 ATR, body ≈3.1 ATR, bar is bullish, no
reclaim → `BREAKOUT_DETECTED`, **LONG**. The bearish reversal idea at this level
is invalidated. Same level, opposite conclusion — decided by the reaction.

### 14.3 WAIT at the same high

```
bar 23:  O 108.0   H 110.2   L 107.5   C 109.5   vol 1x average
```

No penetration beyond 110.5 → no sweep. No close beyond → no breakout.

> direction **WAIT** — «Цена у верхней границы диапазона, но нет ни
> подтверждённого снятия ликвидности с возвратом, ни принятия выше уровня.»

### 14.4 A wick that is not a BOS

```
swing high 115 confirmed;  bar 26: O 100  H 118  L 99  C 101
```

`closeBeyond = 101 - 115 < 0`, `wickBeyond = 3` → `wickOnly: true`, reason
"…but no close beyond — not a break". Structure is unchanged.

---

## Part 15 — Results

### 15.1 The limitation that governs everything

**No number below comes from real market history.** All crypto-market egress is
blocked from this environment (`api.binance.com`, `data-api.binance.vision`,
`data.binance.vision`, bybit, kraken, coingecko, coinbase, cryptocompare — all
curl code 000; npm/github/pypi return 200). `fixtures/` is **synthetic**, from a
seeded mulberry32 PRNG.

These results measure the engines **against a random generator**. They are
sufficient to prove the machinery runs, is causal and is deterministic. They are
**not** evidence of a market edge.

### 15.2 V1 vs V2, 6 symbols, 15m/1h/4h

| slice | engine | n | win | expectancy | total R | PF | maxDD |
|---|---|---|---|---|---|---|---|
| TRAIN | V1 | 382 | 23.82% | −0.0239 | −9.12 | 0.969 | −33.69 |
| TRAIN | V2 | 97 | 18.56% | +0.9910 | +96.13 | 3.153 | −10.31 |
| VALIDATION | V1 | 128 | 27.34% | +0.0737 | +9.44 | 1.098 | −31.78 |
| VALIDATION | V2 | 31 | 9.68% | +0.4643 | +14.39 | 1.874 | −7.16 |
| **TEST** | **V1** | **144** | **23.61%** | **−0.0796** | **−11.46** | **0.900** | **−24.88** |
| **TEST** | **V2** | **40** | **10.00%** | **+0.8673** | **+34.69** | **2.571** | **−5.82** |

V2 is far more selective: **53.9%** of evaluations returned WAIT.

### 15.3 Why V2 was NOT activated

The headline numbers favour V2 — and they do not survive scrutiny.

**Exit composition, TEST slice:**

| exit | n | total R | avg R |
|---|---|---|---|
| SL | 19 | −21.8 | −1.15 |
| TP | 4 | +18.7 | +4.68 |
| **TIMEOUT** | **17** | **+37.8** | **+2.22** |

**42.5% of V2's trades end in TIMEOUT, and that is where the profit is.**
Excluding timeouts:

```
V2 TEST excluding TIMEOUT:  n = 23,  expectancy = -0.1332R
```

The edge inverts. V2's apparent performance comes from being marked to market at
bar 48 while still in an open position, **not** from its targets being reached.
Combined with §9.4 — `finalR` values above 40R because the opposite range edge
is divided by a very tight sweep stop — the diagnosis is that **the target
ladder is not working**: TP3 is unreachable within the timeout, so trades drift
to the bar limit and are booked at whatever unrealised R they happen to hold.

The comparison script encodes this as an automatic integrity gate, so the
conclusion cannot be quietly lost:

> V2 beats V1 on headline metrics, BUT its positive expectancy depends on
> TIMEOUT exits — excluding them the edge is not positive. That means the
> TARGETS are not demonstrably working. NOT a basis for activation.

### 15.4 Where V2 is better / worse

Better: selectivity (WAIT is real), drawdown (−5.8R vs −24.9R on TEST),
explicit reasoning, structural rather than arbitrary stops and targets, no
score-inversion pathology.

Worse: win rate (10% vs 23.6%), sample size (40 vs 144), dependence on TIMEOUT,
and unreachable far targets.

---

## Part 16 — Current limitations

1. **No real market data.** Everything above is synthetic. The whole comparison
   must be repeated on real Binance Spot history before any activation.
2. **The V2 target ladder is not validated** — see §15.3. This is the first
   thing to fix, before any weighting work.
3. **Component weights are untuned by design** and should be fitted only on
   real data, with a held-out TEST slice.
4. **`outcome.timeout_bars = 48`** interacts badly with far structural targets;
   the timeout may be truncating winners, or the targets may be unreachable.
   Both hypotheses are open.
5. **No retracement entry model** — only the reproducible OPEN N+1 baseline.
6. **RSI divergence** uses a simple two-extreme comparison.
7. **V2 is not wired into the strategy worker**, by design.
8. **Browser verification of the UI diagnostics is not possible** in this
   sandbox (Playwright downloads blocked).

---

## Part 17 — V1 reference (the ACTIVE strategy)

Seven factors, weights from the registry, layered over by the DB:

| factor | kind | default weight |
|---|---|---|
| `BOS` | INDEPENDENT | 25 |
| `ORDER_BLOCK` | INDEPENDENT | 20 |
| `FVG` | INDEPENDENT | 15 |
| `LIQUIDITY_SWEEP` | INDEPENDENT | 15 |
| `RANGE_POSITION` | INDEPENDENT | 10 |
| `INTERNAL_STRUCTURE` | CONTEXT | 8 |
| `OB_FVG_CONFLUENCE` | DERIVED | 7 |

```
score = 100 * Σ(strength_i * weight_i) / Σ weight_i     over COUNTED factors only
```

Gates: `engine.score_threshold` (55), `engine.min_components` (2). Entry OPEN
N+1, ATR-based stop (`risk.sl_atr_mult`, `risk.sl_policy`), TP1/TP2/TP3 as R
multiples (1/2/3).

Known pathology, measured and documented in `docs/strategy-evidence.md`: score
is **inversely** related to outcome because the denominator counts only factors
that fired. `engine.min_components` — not the score threshold — is the real
evidence guard.

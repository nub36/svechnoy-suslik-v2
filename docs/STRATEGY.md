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
`touchCountHigh`, `touchCountLow`, `position`, `confidence`, `sourceTimeframe`,
`brokenSide`, `brokenAtIndex`.

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

### 3.4 Range invalidation

The boundaries come from confirmed swings, so price can trade — and **close** —
beyond them afterwards. When that happens the range is **stale on that side**
and must not keep serving as a structural target.

```
acceptTol = 0.10 * range.size
for every bar i in [establishedAt .. evalIndex]:      # causal, never future
    if close[i] > high + acceptTol:  brokenSide = 'HIGH'; brokenAtIndex = i
    if close[i] < low  - acceptTol:  brokenSide = 'LOW';  brokenAtIndex = i
```

Rules that follow from it:

* **A wick beyond the boundary never invalidates a range.** Only a CLOSE does —
  the same principle as "a wick is not a BOS" (§2.3).
* **The opposite edge of an invalidated range is not a target.** `buildTargets()`
  drops the `RANGE_EDGE` candidate whenever `brokenSide !== null`. This is the
  direct answer to "can TP3 reference a range already invalidated by the current
  breakout?" — it cannot.
* **A continuation trade does not aim back at the old opposite structure.**
  After acceptance above the high, the far side of the broken container carries
  no structural claim on price, so the ladder falls back to real liquidity ahead
  (or to `R_MULTIPLE` if there is none).
* **A new external HH/LL replaces the old boundary** on the next evaluation:
  `buildRange()` is recomputed from scratch on every bar from the currently
  confirmed swings, so once the breakout high is itself confirmed as a swing it
  becomes the new `high`. Invalidation covers the window between acceptance and
  that confirmation.

The flag is diagnostic elsewhere: it is reported on each replay trade as
`rangeBrokenSide` so real-data analysis can slice by it.

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

### 7.1 HTF in the UI diagnostic panel

The replay supplies higher-timeframe candles, so replay-time HTF context is
real. The chart payload historically did **not**, which meant the V2 diagnostic
panel could show `UNKNOWN` where the replay saw a genuine bias.

`app/api/chart/route.ts` now loads the timeframes listed in `HTF_MAP` from the
database (ingestion already covers all supported timeframes) and passes them to
`buildChartPayload()`. Constraints held:

* The load happens **only when `v2.enabled` is true**. With the default `false`
  no extra query runs and the payload is unchanged.
* Only `closedOnly: true` rows are read, and the engine's `closedHtfCandles()`
  filter still decides which of them had closed by the evaluated bar — the
  causal rule in Part 7 is unchanged, so no look-ahead is introduced.
* Missing data stays missing: the panel reports `UNKNOWN` rather than a
  fabricated bias.
* This is diagnostic only. V2 still does not influence any production signal.

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

Targets are the **next levels the move must actually travel through** — not a
fixed TP1/TP2/TP3 template, and not arbitrary R multiples.

| rung | basis | rule |
|---|---|---|
| TP1 | `INTERNAL_LIQUIDITY` | nearest resting pool ahead of entry |
| next | `EQUILIBRIUM` | range mid, **only if it is genuinely the next level ahead** |
| next | `RANGE_EDGE` | opposite edge, **only while the range is still valid on that side** |
| fallback | `R_MULTIPLE` | 1R/2R/3R, only when structure supplies nothing |

Construction, in `buildTargets()` (`src/strategy/v2/engine.ts`):

1. **Collect candidates** ahead of entry: same-side liquidity pools, the range
   mid, the opposite range edge.
2. **Side / direction filter.** A level behind entry, on the wrong side, or
   already passed is never a candidate. Equilibrium is *not* automatically TP2:
   a LONG entered above the 50% line has no equilibrium target at all.
3. **Range-invalidation filter.** If `range.brokenSide !== null`, the opposite
   edge is dropped — see §3.4. A continuation trade that just broke out does not
   aim back across the stale range.
4. **Order by distance** from entry, then keep only the **nearest three**. This
   is what prevents TP2 from skipping a dozen pools to land on equilibrium.
5. **Collapse near-duplicates** within `0.15 × ATR` (or 0.05% of price when ATR
   is unusable).
6. **Guarantee** strictly positive, strictly increasing R.

Each rung carries `price`, `basis`, `reason`, `r`, and `atrDistance` (a real
directional distance — see §9.4).

**Why this replaced the old ladder.** The audit of `b8825d1` found final targets
at 10R–45R: the opposite edge of a 300-bar envelope (median ~35 ATR wide)
divided by a ~1 ATR sweep stop. The fix is structural, not a cap: the ladder now
stops at the nearest real levels, and a stale range contributes no target at
all. On the same synthetic fixtures the TEST-slice final-R median fell from
8.40R to 3.00R and the maximum from 45.19R to 21.03R.

### 9.4 Room to target

```
firstR          = R multiple of the NEAREST target
nextStructuralR = R multiple of the second rung (falls back to the last)
finalR          = R multiple of the FURTHEST target

atrDistance      = directional distance to the final target, in ATR:
                     LONG  (target - entry) / ATR
                     SHORT (entry - target) / ATR
firstAtrDistance = the same measure for the first target

adequate = finalR >= v2.min_room_r         (1.5)
       AND firstR >= v2.min_first_target_r  (0.5)
```

Both floors matter. A trade is **not** admitted merely because a distant final
target inflates `finalR`: if the nearest structural level sits 0.2R away, the
setup is rejected with an explicit reason. Inadequate room → WAIT.

> **Fixed bug.** `atrDistance` previously computed `abs(targetPrice) / ATR` —
> an absolute price divided by ATR, which for BTC produced values in the
> thousands. It is now a genuine directional distance and is covered by tests
> with explicit numbers.

### 9.5 RR acceptance

`src/replay/v2-runner.ts` re-anchors the structural plan to the **actual** fill
(the OPEN of N+1), then calls `executableLadder()`:

```
risk    = abs(entry - structuralSL)
ladder  = take-profits strictly ahead of the fill, sorted by distance
reward1 = directionalDistance(entry, ladder[0])
rr1     = reward1 / risk
accept  = risk > 0 AND stop on the correct side AND ladder non-empty
                    AND rr1 >= risk.min_rr
```

`rr1` is measured on the **first executable target only**. A generous TP2 or TP3
can never carry a setup past `min_rr` when TP1 itself does not pay for the risk.
Targets left behind by a gap fill are dropped from the ladder before TP1 is
chosen.

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

### 12.1 Exit states — TP, SL, TIMEOUT, OPEN

Four states, and they are **not** interchangeable.

| state | meaning | exit price |
|---|---|---|
| `TP` | the **final** rung of the ladder was reached | that target's price |
| `SL` | the stop was touched | the stop price |
| `TIMEOUT` | **forced time exit** — neither terminal TP nor SL within `outcome.timeout_bars` | **close of the timeout candle** |
| `OPEN` | the replay window ended while the trade was still running | **none** (`exitPrice = null`) |

**TIMEOUT is a time exit, never a take-profit.** Mechanics, in
`src/outcome/tracker.ts`:

* The timeout bar is the one where `i + 1 >= outcome.timeout_bars` (zero-based
  from the entry candle), so `barsHeld === timeout_bars` exactly.
* The exit price is that candle's **close** — a real printed price from a
  **closed** candle. Never an extreme, never a target, never an interpolation.
* `rMultiple = (directional move from entry to that close) / risk − fees`.
* On the timeout candle itself **SL and the final TP still take priority**,
  resolved by the same deterministic intrabar policy used everywhere
  (`outcome.sl_priority_on_ambiguous_bar`, default `true`).
* **No future candle is touched.** The function returns at the timeout bar, and
  the caller only ever passes candles up to the current index.
* A positive TIMEOUT R is *unrealised drift booked at the bar limit*. It must
  never be presented as a target being hit.

**Dataset boundary ⇒ OPEN, never TIMEOUT.** If the data runs out before the
timeout elapses, `trackOutcome()` returns `null` and the runner records the
trade as `OPEN`, preserving entry, stop and targets with `exitPrice = null`,
`exitCandleTime = null`, `rMultiple = 0`. Inventing a timeout there would
fabricate an exit price the market never printed.

Both runners now do this identically — `src/replay/runner.ts` (V1) and
`src/replay/v2-runner.ts` (V2). Before this fix V2 **silently discarded** the
trailing open position, which made the window edge asymmetric between the two
engines.

### 12.2 Reported metrics — two different "win rates"

The audit of `b8825d1` showed the same strategy could be described as having a
10% or a 47.5% win rate depending on which definition was used silently. The
report therefore prints both, under distinct names, and uses neither the word
"win rate" nor a `%` sign for evidence:

| metric | definition |
|---|---|
| `tpExitRate` | `TP exits / closed trades` |
| `positiveRRate` | `trades with R > 0 / closed trades` (includes profitable timeouts) |
| `slRate` | `SL exits / closed trades` |
| `timeoutRate` | `TIMEOUT exits / closed trades` |
| `openCount` | trades still running at the window edge — **excluded from every closed metric** |
| `expectancy` | mean R over **all closed** exits |
| `expectancyExTimeout` | mean R over closed exits **excluding TIMEOUT** — a *diagnostic sensitivity* metric |

`expectancyExTimeout` answers one question: does the edge survive without
mark-to-market at the bar limit? It is a diagnostic, not the headline, and
`scripts/v1-vs-v2.ts` keeps it as an automatic integrity gate.

`OPEN` trades carry no realised R and are excluded from `n`, expectancy, profit
factor, drawdown and every rate above.

### 12.3 Per-trade target diagnostics

Every V2 replay trade records, for later analysis on real history: `setupKind`,
`direction`, `entryPrice`, `stopLoss`, `riskDistance`, `riskAtr`, `atrAtSetup`,
`stopAnchor`, `stopReason`, `tp1Price/tp1Source/tp1R/tp1AtrDistance` (and the
same for TP2/TP3), `firstTargetR`, `nextStructuralR`, `finalTargetR`,
`timeoutBars`, `rangeBrokenSide`, `result`, `exitPrice`, `barsHeld`,
`rMultiple`.

### 12.4 Evidence is not probability

`evidence` is a 0..1 weighted aggregate of the ten component scores. It is
**not** a probability and **not** a percentage.

* `evidence` — 0..1, the value the engine actually gates on.
* `displayEvidence` — `round(evidence * 100)`, for display only, rendered
  **without** a `%` sign.
* `notProbability: true` — a literal marker on every V2 trade so no downstream
  report can quietly reinterpret the number.
* `ReplayTrade.score` still carries `displayEvidence` for compatibility with V1
  tooling. That is the *only* reason it exists on a V2 trade.

Calibration has never been performed, so no probability language is permitted
anywhere in the UI or the reports.

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
| `v2.min_room_r` | 1.5 | room-to-target floor (FINAL target) |
| `v2.min_first_target_r` | 0.5 | room-to-target floor (FIRST target) |
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

`fixtures/` is **synthetic** — a seeded PRNG (`scripts/make-fixtures.mjs`), not
market data. Binance egress is blocked from the build environment, so every
number below measures the engines against a generator. **Nothing here is
evidence of an edge**, and no parameter was selected using any of it.

### 15.2 V1 vs V2 after the methodology fixes

6 symbols x 15m/1h/4h, `npx tsx scripts/v1-vs-v2.ts --tf=15m,1h,4h`.
OPEN trades are listed but excluded from every closed statistic.

| slice | engine | closed | open | tpExitRate | positiveRRate | expectancy | excl. TIMEOUT | PF | maxDD |
|---|---|---|---|---|---|---|---|---|---|
| TRAIN | V1 | 382 | 15 | 23.82% | 28.53% | −0.0239R | −0.0849R (n=359) | 0.969 | −33.69 |
| TRAIN | V2 | 98 | 12 | 26.53% | 56.12% | +0.7872R | +0.7256R (n=60) | 2.765 | −10.40 |
| VALID | V1 | 128 | 14 | 27.34% | 31.25% | +0.0737R | +0.0430R (n=123) | 1.098 | −31.78 |
| VALID | V2 | 29 | 13 | 17.24% | 58.62% | +0.5655R | +0.2413R (n=16) | 2.272 | −6.13 |
| TEST | V1 | 144 | 13 | 23.61% | 27.78% | −0.0796R | −0.1124R (n=138) | 0.900 | −24.88 |
| TEST | V2 | 45 | 8 | 24.44% | 48.89% | +0.5635R | +0.2938R (n=31) | 2.064 | −6.33 |

TEST exit composition — V1: TP 34, SL 104, TIMEOUT 6, OPEN 13.
V2: TP 11, SL 20, TIMEOUT 14, OPEN 8.

V2 selectivity rose sharply after the room floors were added: **91.5–92.3% of
evaluations now return WAIT** (previously ~52%).

### 15.3 Target geometry — the pathology is gone

The point of the re-run was not profitability but whether the ladder still
produces unreachable targets.

| slice | TP1 R median | final R median | final R max | >5R | >10R | >20R |
|---|---|---|---|---|---|---|
| TRAIN | 1.03 | 3.00 | 14.76 | 10.2% | 5.1% | 0.0% |
| VALID | 1.09 | 3.00 | 15.10 | 17.2% | 6.9% | 0.0% |
| TEST | 1.06 | 3.00 | 21.03 | 31.1% | 11.1% | 2.2% |

Before / after on the TEST slice:

| | before (`b8825d1`) | after |
|---|---|---|
| final R median | 8.40 | **3.00** |
| final R p75 | 21.31 | **6.49** |
| final R max | 45.19 | **21.03** |
| share > 10R | 50.0% | **11.1%** |
| share > 20R | 30.0% | **2.2%** |
| TIMEOUT share | 42.5% | **31.1%** |
| expectancy excl. TIMEOUT | **−0.1332R** | **+0.2938R** |

The 10R–45R cluster is gone, and the edge no longer inverts when time exits are
removed. A small tail above 10R remains where a genuinely wide range still sits
ahead of a tight structural stop; that is a real market geometry rather than the
old artefact, so it is left alone rather than capped.

### 15.4 Why V2 is STILL not activated

**It is not activated, and these numbers are not a reason to activate it.**

1. The data is synthetic. A generator has no order flow, no liquidity, no
   session structure. Beating V1 here says nothing about the market.
2. The samples are tiny — 45 closed TEST trades for V2.
3. Timeouts still account for 31.1% of V2 exits.
4. No parameter has ever been validated on real history.

Activation requires the same comparison on **real Binance Spot candles**, run by
an operator in an environment with market-data egress. Until then `v2.enabled`
stays `false` and V1 remains the production strategy.

## Part 16 — Current limitations

1. **No real market data.** Everything above is synthetic. The whole comparison
   must be repeated on real Binance Spot history before any activation.
2. **The V2 target ladder is structurally repaired but still unvalidated.** The
   10R-45R artefact is gone (§15.3), yet the corrected ladder has only been
   exercised against a generator. Whether the nearest-levels rule picks *useful*
   targets is a question only real history can answer.
3. **Component weights are untuned by design** and should be fitted only on
   real data, with a held-out TEST slice. They were deliberately NOT touched by
   the methodology fixes, and neither were `min_evidence` / `min_net_evidence`.
4. **`outcome.timeout_bars = 48`** still ends 31% of V2 trades. That share fell
   from 42.5% once the targets came closer, but a time exit remains the second
   most common way a V2 trade finishes.
5. **Selectivity is now very high** — over 91% of evaluations return WAIT after
   the first-target room floor was added. On real data this may prove too
   strict; `v2.min_first_target_r` is the knob, and it must be examined on real
   history rather than on fixtures.
6. **Partial exits, breakeven stops and trailing are deliberately absent.** Exit
   models will be compared only after real data is available, so today a TP1
   touch realises nothing.
7. **No retracement entry model** — only the reproducible OPEN N+1 baseline.
8. **RSI divergence** uses a simple two-extreme comparison.
9. **V2 is not wired into the strategy worker**, by design.
10. **Browser verification of the UI diagnostics is not possible** in this
    sandbox (Playwright downloads blocked), so the HTF panel fix in §7.1 is
    verified by tests and by code inspection only.

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

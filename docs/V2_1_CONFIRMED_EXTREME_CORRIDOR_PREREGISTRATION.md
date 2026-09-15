# V2.1 — "CONFIRMED EXTREME CORRIDOR ENTRY" — PRE-REGISTRATION

**Written and committed BEFORE any TRAIN research is run for this model.**

No performance number for this design exists yet. Every rule, threshold, filter
and metric below is fixed now and may not be revised after results are seen.
Frozen V2 (`4839074`) is not modified; this is a separate research path and the
baseline stays byte-identical.

| pinned | value |
|---|---|
| frozen strategy | `4839074` (unchanged) |
| prior stage | limit-entry TRAIN results, commit `4b25bbb` |
| dataset | `c3c1dce` |
| development slice | **TRAIN only** |
| VALIDATION | after candidate freeze, **once** |
| TEST (2022–2025) | **USED — excluded from this work** |
| future window (2026-H1) | not downloaded, not inspected |

---

## 0. Status of the previous stage

Models **B (RETEST)**, **C (FVG)** and **D (OB∩FVG)** are **REJECTED**. No
VALIDATION will be run on them. The two findings that motivate this design are
carried forward as measured facts, not assumptions:

1. **Fee-in-R is the dominant term.** `feeR = fee% × price / stopDistance`, so a
   tight stop is arithmetically fatal. Baseline TRAIN median stop is **0.2951 %**
   of price, with **22.34 %** of trades under 0.10 % and **47.13 %** under
   0.20 %. Limit entries made this *worse* by filling closer to the stop
   (model B median stop **0.0657 %**, net **−5.32 R**).
2. **Waiting for a retracement forfeits the winners.** Setups missed by the
   limit models had a baseline mean of **+0.78 R** — price ran to TP1 without
   returning. Any entry rule that waits must be judged on
   *expectancy per original actionable setup*, never per filled trade alone.

This design responds to both: it does **not** wait for a retracement below the
confirmation price, and it **refuses** trades whose stop is too tight to survive
fees.

---

## 1. Causality contract (binding)

Everything below is computed from the **CLOSED confirmation candle N** and bars
before it. The corridor is published at N and can only be filled at **N+1 or
later**.

Explicitly forbidden: any use of N+1 high/low to build the corridor, any future
pivot, any future FVG/OB, any level chosen because price later returned to it,
and any retroactive fill. Each of these is asserted by a test (§9).

---

## 2. Confirmation trigger — "Confirmed Extreme"

A setup exists only at a **confirmed structural extreme**, never at a bare price
level. Two mutually exclusive paths, both already computed causally by the
frozen engine:

### 2a. REVERSAL — Sweep + Reclaim + Displacement

All of the following, read from the frozen `SweepEvent` and `Displacement` on
the setup at N:

| condition | field | requirement |
|---|---|---|
| a liquidity extreme was swept | `sweep.level` | pool `kind ∈ {SWING, EQUAL, CLUSTER}` |
| direction matches | `sweep.direction` | `== setup.direction` |
| price reclaimed the level | `sweep.reclaimed` | `=== true` |
| reclaim was prompt | `sweep.reclaimBars` | `!== null` and `<= 3` |
| genuine penetration | `sweep.penetrationAtr` | `>= 0.10` (frozen `v2.sweep_min_penetration_atr`) |
| rejection wick | `sweep.wickRatio` | `>= 0.25` (frozen `v2.sweep_min_wick_ratio`) |
| displacement away from the extreme | `displacement.direction` | `== setup.direction` |
| displacement magnitude | `displacement.bodyAtr` | `>= 0.60` (frozen `v2.displacement_min_body_atr`) |

**EQH/EQL specifically**: `LiquidityPool.kind === 'EQUAL'` identifies equal
highs/lows. Pool `kind` is recorded on every setup so EQH/EQL and plain swing
reactions are reported **separately** (§7); no rule differs between them.

### 2b. CONTINUATION — Body Close + Hold

| condition | field | requirement |
|---|---|---|
| a level was broken | `breakout.level` | present |
| direction matches | `breakout.direction` | `== setup.direction` |
| **body** closed beyond | `breakout.closeBeyondAtr` | `>= 0.25` (frozen `v2.breakout_min_close_atr`) |
| it was a body, not a wick | `breakout.bodyRatio` | `>= 0.50` |
| price **held** beyond | `breakout.held` | `=== true` |
| hold was observed | `breakout.holdBars` | `>= 1` |
| no immediate failure | `breakout.immediateReclaim` | `=== false` |

Every threshold above is a **frozen V2 parameter reused unchanged**. None is
newly tuned. The only genuinely new gates are `reclaimBars <= 3`,
`bodyRatio >= 0.50` and `holdBars >= 1`, fixed here and never swept.

---

## 3. Entry corridor (causal, executable)

The corridor is centred on the **close of confirmation candle N** — not on a
retracement level, and not on OPEN N+1.

```
centre     = close(N)
halfWidth  = clamp(CORRIDOR_ATR_FRAC * ATR(N), 1 tick, CORRIDOR_MAX_PCT * close(N))
corridorLo = quantize(centre - halfWidth, tickSize)
corridorHi = quantize(centre + halfWidth, tickSize)
```

Fixed now, not swept:

| constant | value | reason |
|---|---|---|
| `CORRIDOR_ATR_FRAC` | **0.10** | the design audit showed a fixed tick count is meaningless across symbols (5 ticks = 0.0011 ATR on BTC vs 0.2545 ATR on SOL); ATR is the only scale-free unit |
| `CORRIDOR_MAX_PCT` | **0.15 %** | hard cap so a volatility spike cannot create an absurd corridor |
| tick quantisation | per symbol | BTC/ETH/BNB/SOL 0.01, XRP 0.0001, DOGE 0.00001 (measured empirically) |

**Fill rule (conservative, unchanged in spirit from the previous stage).**
The order is a corridor, not a limit below price, so it fills when price is
*inside* the band on any bar from N+1 onward:

- LONG fills when `candle.low <= corridorHi`, at price
  `min(open(bar), corridorHi)` — never better than the corridor's worse edge.
- SHORT fills when `candle.high >= corridorLo`, at price
  `max(open(bar), corridorLo)`.

If bar N+1 opens **inside** the corridor, the fill is that open — this is the
realistic fill and it keeps the model close to the baseline rather than
manufacturing an advantage. If N+1 gaps **beyond** the corridor in the trade's
favour, that is a **MISSED** setup, not a better fill.

**Expiry: 3 bars.** A "confirmed extreme" is a statement about *now*; if the
corridor is not touched within 3 bars the confirmation is stale → `EXPIRED`.
(Deliberately much shorter than the rejected limit models' 12 bars, because this
design does not wait for a retracement.)

**Cancel:** structural SL breached before fill → `CANCELLED`.
**Ambiguity:** one bar both fills and breaches the SL → `CANCELLED` (the
unfavourable reading), consistent with frozen
`outcome.sl_priority_on_ambiguous_bar = true`.

---

## 4. Fee Drag Guard (the central mechanism)

A setup is **rejected before entry** unless its structural stop clears both
floors:

```
stopDistance = |entry − structuralStop|
REQUIRE  stopDistance >= 0.35% * entry
   AND   stopDistance >= 0.50 * ATR(N)
```

Rationale, from measured data rather than preference — fee-in-R at the frozen
0.1 % round trip:

| stop distance | fee in R |
|---|---|
| 0.05 % | 2.000 R |
| 0.10 % | 1.000 R |
| 0.20 % | 0.500 R |
| **0.35 %** | **0.286 R** |
| 0.50 % | 0.200 R |

The 0.35 % floor caps fee drag at **0.286 R** per trade. The 0.5 ATR floor
prevents the same mistake in volatility terms when price is high but ranging.

**The stop is NEVER widened to satisfy the guard.** Moving a structural stop to
pass a filter would destroy the structural claim and manufacture a better R by
fiat. Setups that fail the guard are **skipped and counted** as
`REJECTED_FEE_GUARD`.

> **Scope warning, registered in advance.** ~75 % of baseline TRAIN trades have
> stops under 0.50 % of price and ~47 % under 0.20 %. This guard will therefore
> reject a **large majority** of setups. Expectancy per surviving trade will
> almost certainly rise *purely because fee-in-R shrinks*. That would not be an
> edge. **`expectancy per original actionable setup` is the primary metric** and
> the per-trade figure is secondary — the same discipline that exposed model B.

---

## 5. Confluence filter

Evaluated on the frozen indicator contexts at N. A setup must score **>= 3 of 4**:

| # | component | LONG condition | SHORT condition |
|---|---|---|---|
| 1 | **Volume** | `vol.rvol > 1.2` | same |
| 2 | **RSI** | `rsi.bullishDivergence` **or** `rsi.rsi <= 45` | `rsi.bearishDivergence` **or** `rsi.rsi >= 55` |
| 3 | **MACD inflection** | `macd.crossUp` **or** `macd.histogramSlope > 0` | `macd.crossDown` **or** `macd.histogramSlope < 0` |
| 4 | **EMA trend** | `ema.alignment === 'BULLISH'` | `ema.alignment === 'BEARISH'` |

Fixed choices, stated so they cannot drift: the threshold is **3 of 4** (not
4 of 4, which the structural audit suggests would be far too rare, and not 2 of
4, which would barely filter); `rvol > 1.2` is the user-specified value;
the RSI zone bounds 45/55 are the frozen `rsiBucket` boundaries already used in
V2 reporting. **No component weight is fitted.**

For CONTINUATION, criterion 4 (EMA alignment) is the trend-agreement leg; for
REVERSAL it is deliberately *counter*-trend-tolerant — alignment is simply one
of four votes, so a reversal can qualify on volume + RSI + MACD alone. This is
recorded now to prevent a post-hoc "reversals need different rules" change.

---

## 6. Everything inherited unchanged from frozen V2

Stop level and anchor, target ladder, `risk.min_rr`, `outcome.timeout_bars = 48`,
exit model (**final rung only** — H1 was tested and NOT validated, so no partial
and no breakeven), one-position-at-a-time, HTF mapping, evidence weights,
`min_evidence` / `min_net_evidence`, and all indicator periods.

Post-fill, risk / risk-ATR / risk-% and every target R are **recomputed from the
actual fill**. If the recomputed geometry is invalid (stop on the wrong side, no
target ahead, or `rr1 < risk.min_rr`) the trade is **not taken** and is counted
as `REJECTED_GEOMETRY`.

---

## 7. State machine and terminal states

```
SETUP_CONFIRMED → PENDING_ENTRY → FILLED → {TP | SL | TIMEOUT | OPEN}
                                ↘ MISSED     (gapped away / TP1 hit first)
                                ↘ EXPIRED    (3 bars, corridor untouched)
                                ↘ CANCELLED  (structural invalidation, or ambiguous same-bar)
SETUP_CONFIRMED ↘ REJECTED_FEE_GUARD      (stop below the floor)
                ↘ REJECTED_CONFLUENCE     (< 3 of 4)
                ↘ REJECTED_GEOMETRY       (post-fill geometry invalid)
```

A terminated setup is never reopened, and no `MISSED`/`EXPIRED`/`CANCELLED`
record may later become `FILLED`.

---

## 8. Metrics fixed in advance

Baseline **A = frozen OPEN N+1**, which must pass the fidelity gate (reproduce
the frozen TRAIN baseline exactly) before any comparison is reported.

Per model: confirmed setups, each rejection bucket with counts, PENDING, FILLED,
fill rate, MISSED, EXPIRED, CANCELLED, AMBIGUOUS, closed, OPEN, TP/SL/TIMEOUT,
**gross expectancy per FILLED trade**, **gross expectancy per ORIGINAL
ACTIONABLE SETUP (primary)**, gross median R, gross PF, gross total R, max
drawdown R, positiveRRate, median and p25/p75 stop %, median stop ATR, and the
share of trades under 0.10 / 0.20 / 0.50 %.

**Gross is reconstructed explicitly** as `grossR = storedR + (0.1/100) × entry /
riskPerUnit`, because `trackOutcome` returns an R already net of the frozen fee
and any entry change moves fee-in-R. Costs: GROSS primary, then analytic
sensitivity at **2 / 5 / 10 / 20 bps** round-trip. **No maker discount** is
assumed.

Breakdowns, always with n: REVERSAL vs CONTINUATION, LONG vs SHORT, per symbol,
per timeframe, and **EQH/EQL vs SWING vs CLUSTER** pool kind.

### Mandatory anti-bias checks (registered now)

1. **MISSED analysis** — for every missed/rejected setup, report the baseline
   OPEN N+1 outcome, so the model cannot look good merely by declining trades.
2. **Selection bias** — compare baseline outcomes for setups the model FILLED
   vs did NOT fill.
3. **Fee-guard decomposition** — report the baseline outcome of the setups the
   Fee Drag Guard rejects, separately from those it admits. This is the specific
   trap for this design: if the guard's benefit is entirely "fewer trades with
   smaller fee", it must be visible.

---

## 9. Required tests before results are reported

`PENDING → FILLED / MISSED / EXPIRED / CANCELLED`; same-bar ambiguity → CANCELLED;
LONG and SHORT fills; corridor quantised to tickSize; corridor never wider than
`CORRIDOR_MAX_PCT`; Fee Drag Guard rejects a sub-floor stop and **never widens
it**; confluence scoring at exactly 2/3/4 votes; no look-ahead (fill index
strictly > setup index); and the Model A fidelity gate.

---

## 10. Selection protocol

TRAIN only. After TRAIN, **at most one** variant is carried forward, chosen on
expectancy per original actionable setup, fill rate, cost geometry, drawdown,
outlier dependence and structural rationale — **not** on highest per-trade
expectancy. The choice and its reason are committed **before** VALIDATION runs.

If no variant shows a convincing advantage over baseline A →
**`CORRIDOR_ENTRY_REJECTED_ON_TRAIN`**.

VALIDATION runs **once**; afterwards no threshold, corridor width, expiry, fee
floor, confluence rule or fill policy may change. Permitted final statuses:
`CORRIDOR_ENTRY_REJECTED_ON_TRAIN`, `CORRIDOR_ENTRY_NOT_VALIDATED`,
`CORRIDOR_ENTRY_VALIDATED_FOR_V2_1`. `PRODUCTION_READY` remains forbidden.

**v2.enabled = false. LIVE_TRADING_ENABLED = false. V2.1 is research only.**

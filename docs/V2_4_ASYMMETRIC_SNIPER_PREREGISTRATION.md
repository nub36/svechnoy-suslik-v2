# V2.4 — ASYMMETRIC SNIPER ENGINE — PRE-REGISTRATION

**Written and committed BEFORE any V2.4 research is run.** No V2.4 performance
number exists. Every rule and threshold below is fixed now and may not be
revised after results are seen.

Frozen V2 (`4839074`) is not modified. V2.4 is a separate research path.

| pinned | value |
|---|---|
| frozen strategy | `4839074` (unchanged) |
| prior stage | V2.3 TRAIN, `2ee06d1` (`V2_3_REJECTED_ON_TRAIN`) |
| dataset | `c3c1dce` |
| development slice | **TRAIN only** |
| VALIDATION | once, after candidate freeze |
| TEST (2022–2025) | **USED — excluded** |

---

## 0. CIRCULARITY — now compounding, stated plainly

V2.3 already reused TRAIN to test a TRAIN-derived hypothesis. **V2.4 does it a
third time**, and the specific new rule — the LONG asymmetry — is derived
directly from a V2.3 TRAIN result:

> V2.3 S-cor: LONG **+0.0325** (n=769) vs SHORT **+0.1392** (n=728).

Filtering LONGs because LONGs underperformed *on the data we are about to
re-measure* is textbook overfitting pressure. The result will be biased upward
by construction.

**Two prior V2.3 premises already failed to reproduce** (the +0.0785 reversal
figure came in at +0.0585; the "R-multiple targets are better" finding reversed
outright). That is the base rate for TRAIN-derived leads in this project: **2 of
3 did not survive contact with a re-run.**

A positive TRAIN result here is therefore **not evidence the design works**. The
only meaningful confirmation is the untouched VALIDATION split. This is recorded
now so it cannot be quietly dropped if the numbers look attractive.

### Statistical power

V2.3 S-cor produced 1,497 closed trades. V2.4 adds a LONG-side filter, so the
LONG leg will shrink — expected total order **1,000–1,400**, with LONG possibly
**under 400**. Most subgroup cells will be under 100. **No subgroup with n < 100
may support a conclusion**, and the headline remains underpowered.

---

## 1. Scope

| item | value |
|---|---|
| setups | **REVERSAL only — CONTINUATION OFF** |
| timeframes | 15m, 30m, 1h, 4h |
| symbols | the 6 frozen symbols |
| slice | TRAIN |

## 2. Base sniper filter — both sides (unchanged from V2.3)

Read from the frozen `SweepEvent` at **CLOSED N**:

| # | condition | requirement |
|---|---|---|
| 1 | swept a real extreme | pool kind ∈ {SWING, EQUAL, CLUSTER} |
| 2 | directional | `sweep.direction == setup.direction` |
| 3 | causal reclaim | `sweep.reclaimed === true` |
| 4 | prompt | `sweep.reclaimBars <= 3` |
| 5 | penetration | `sweep.penetrationAtr >= 0.10` (frozen) |
| 6 | rejection wick | `sweep.wickRatio >= 0.25` (frozen) |
| 7 | **body reclaim** | `sweep.bodyRatio >= 0.35` |
| 8 | **volume surge** | `sweep.rvol > 1.2` |

Carried over verbatim. No threshold swept. This filter was measured in V2.3 to
select setups with baseline gross **+0.2663** vs **−0.0036** for those declined,
and to cut max drawdown from −505.8R to −32.7R.

## 3. LONG confluence asymmetry (the one new rule)

A **LONG** must additionally satisfy **at least one** of three HTF-bullish legs.
SHORTs are unaffected — no symmetric SHORT gate is added, and none may be added
later.

| leg | condition | source |
|---|---|---|
| **a. HTF EMA200** | `close(N) > EMA200` computed on the **bounded HTF series** | `buildEmaContext` over `closedHtfCandles(...)` |
| **b. HTF structure** | any available `HtfContext.bias === 'BULLISH'` | frozen `buildHtfContexts` |
| **c. RSI divergence** | `rsi.bullishDivergence === true` | frozen `RsiContext` |

**Causality.** Leg (b) and (c) are frozen fields already computed at N. Leg (a)
is *not* exposed by the engine (`buildEmaContext` runs on the LTF window only),
so it is computed in research code by applying the **frozen** `buildEmaContext`
to the **same causally-bounded HTF candles** the engine uses — `closedHtfCandles`
admits only HTF bars whose close time ≤ the evaluated bar's close time. No
future HTF bar can enter. This is asserted by a test.

The primary HTF for leg (a) is the **first** entry of the frozen `HTF_MAP` for
the trading timeframe. If that series is unavailable or has fewer than 200
closed bars, leg (a) evaluates to **false** (never true-by-default).

**Registered risk:** this gate is derived from TRAIN LONG underperformance (§0).
It is therefore ablated separately (`S-noasym`) so its true contribution is
visible rather than assumed.

## 4. Structural SMC targets — no R-multiple fallback

```
TP1 = nearest opposing structural liquidity ahead of entry
      (INTERNAL_LIQUIDITY or RANGE_EDGE)
    → else EQUILIBRIUM (range 50 %)
    → else SKIP the setup (NO_STRUCTURAL_TP)
TP2/TP3 = next structural rungs beyond TP1, distance-ordered
```

**No fixed R-multiple rung is ever emitted.** This reverses V2.3's ladder, which
was measured to hurt reversals (+0.0585 → +0.0112).

Consequence accepted in advance: without a 1.5R TP1, `rr1 < risk.min_rr` becomes
possible again. Those setups are **rejected and counted** (`REJECTED_RR1`);
`risk.min_rr` is **not** lowered to accommodate them.

## 5. Execution — corridor, maker post-only

```
centre    = close(N)
halfWidth = clamp(0.10 × ATR(N), 1 tick, 0.15 % × close(N))
```

Tick-quantized. Fill only from **N+1**. Conservative fill: LONG
`min(open, corridorHigh)`, SHORT `max(open, corridorLow)` — never better than
the worse edge. Expiry **3 bars** → EXPIRED. SL breached before fill → CANCELLED.
Frozen TP1 hit before fill → MISSED (never chased). One bar doing both fill and
SL → **CANCELLED** (unfavourable), per frozen
`sl_priority_on_ambiguous_bar = true`.

**Post-only caveat, registered honestly:** a true post-only order would be
*rejected* if it would cross the book, and OHLC data cannot detect that. This
simulation therefore assumes the resting order fills whenever price trades into
the corridor. That is **optimistic** relative to real post-only behaviour, and
the direction of the bias is stated here rather than discovered later.

**Fee model:** entry **2 bps maker**, exit **5 bps taker**, per leg on that
leg's own notional. Exit is taker because SL and TIMEOUT are market events. No
maker rebate. Reported environments: GROSS (0), **FUT_4 (2/5 — headline)**,
**FUT_7 (5/5 — stress)**, SPOT (5/5 taker = 10 bps) for continuity.

> Naming note: the task labels the headline "FUT_4 (2/5 bps)" and the stress
> "FUT_7 (5/5 bps)". Those are the arithmetic definitions used here: headline
> = 2 bps maker entry + 5 bps taker exit; stress = 5 bps + 5 bps. The labels are
> kept for continuity with earlier reports even though 2+5 = 7 bps notionally.

## 6. Ablation (fixed in advance)

| arm | description |
|---|---|
| **A** | frozen baseline, all setups, OPEN N+1 — fidelity anchor |
| **S-base** | reversals only, frozen targets, OPEN N+1 |
| **S-struct** | reversals only, **structural targets**, OPEN N+1 |
| **S-cor** | S-struct + corridor |
| **S-asym** | S-cor + **LONG asymmetry** ← the full V2.4 engine |
| **S-noasym** | S-cor without the asymmetry (isolates the new rule) |

`S-asym vs S-noasym` isolates the LONG gate; `S-cor vs S-struct` isolates entry;
`S-struct vs S-base` isolates targets.

## 7. Success criteria (fixed)

**Primary:** positive net expectancy **per FILLED trade AND per ORIGINAL
ACTIONABLE SETUP** under **FUT_4 (2/5)**.

**Robustness, all three required:**
1. Still positive per filled trade under the **FUT_7 (5/5)** stress.
2. Gross expectancy remains positive **after removing the top 1 % of trades**.
3. LONG and SHORT legs both individually non-negative on gross, each with
   **n ≥ 100**.

Criterion 2 is decisive: V2.3's headline collapsed from +0.0844 to +0.0196 when
15 of 1,497 trades were removed, and that is the failure mode this design must
avoid.

**Failure is the expected outcome** given §0 and the project's base rate. If the
criteria are not met the status is `V2_4_REJECTED_ON_TRAIN`.

## 8. Metrics and mandatory anti-bias checks

Per arm: actionable setups, every rejection bucket, PENDING/FILLED/MISSED/
EXPIRED/CANCELLED, fill rate, closed, TP/SL/TIMEOUT, gross expectancy per filled
and per setup, median R, PF, total R, max drawdown, positiveRRate, stop %
quantiles, stop ATR, fill latency, net expectancy in all environments on **both**
denominators.

Gross reconstructed as `grossR = storedR + (0.1/100) × entry / risk`.

Breakdowns with n: **LONG vs SHORT**, **timeframe**, **symbol**, HTF alignment,
pool kind, TP1 basis, and **which LONG leg fired** (EMA200 / structure /
divergence).

Mandatory:
1. **Outlier sensitivity** — ex-top-1, ex-top-5, ex-top-1 %.
2. **Selection bias** — baseline gross of FILLED vs DECLINED setups.
3. **Asymmetry decomposition** — baseline gross of the LONGs the new gate
   *rejects* vs those it *admits*. If the rejected LONGs were better, the gate
   is destroying edge, exactly as V2.1's Fee Drag Guard did.
4. **Sample-size honesty** — n on every row; no n<100 subgroup may decide.

## 9. Required tests

Model A fidelity; all 8 base filter conditions with boundaries; continuation
proven disabled; LONG asymmetry accepting on each leg independently and
rejecting when all three fail; SHORT unaffected by the asymmetry; HTF EMA200
computed only from causally-bounded HTF bars (**no future HTF candle**);
structural target selection incl. the `NO_STRUCTURAL_TP` skip and proof no
R-multiple rung is emitted; corridor quantisation and terminal states; same-bar
ambiguity → CANCELLED; **no look-ahead** (fill index strictly > setup index);
appending future candles does not change emitted trades; per-leg fee arithmetic.

## 10. Selection protocol and permitted statuses

TRAIN only. At most **one** arm may be carried forward, on net expectancy per
actionable setup, outlier robustness and sample adequacy — **not** on highest
per-trade expectancy. Choice and reason committed **before** VALIDATION.

Permitted statuses: `V2_4_REJECTED_ON_TRAIN`, `V2_4_NOT_VALIDATED`,
`V2_4_VALIDATED_FOR_RESEARCH`. **`PRODUCTION_READY` is forbidden.**

**v2.enabled = false. LIVE_TRADING_ENABLED = false. Research only.**

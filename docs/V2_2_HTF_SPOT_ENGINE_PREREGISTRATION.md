# V2.2 — HTF-FOCUSED SPOT ENGINE — PRE-REGISTRATION

**Written and committed BEFORE any V2.2 research is run.** No performance number
for this design exists. Every scope decision, threshold and metric below is
fixed now and may not be revised after results are seen.

Frozen V2 (`4839074`) is not modified. V2.2 is a separate research path; the
baseline stays byte-identical.

| pinned | value |
|---|---|
| frozen strategy | `4839074` (unchanged) |
| prior stage | timeframe × cost diagnostic, commit `dccf751` |
| V2.1 corridor status | `CORRIDOR_ENTRY_REJECTED_ON_TRAIN` (`374b335`) |
| dataset | `c3c1dce` |
| development slice | **TRAIN only** |
| VALIDATION | once, after candidate freeze |
| TEST (2022–2025) | **USED — excluded** |
| future window (2026-H1) | not downloaded, not inspected |

---

## 1. Findings this design is built on (all measured, TRAIN)

### 1.1 The timeframe threshold — the scope decision

Break-even round-trip cost, i.e. the fee at which net expectancy = 0:

| arm | 1m | 5m | 15m | 30m | **1h** | **4h** | **1d** |
|---|---|---|---|---|---|---|---|
| A (frozen baseline) | 0.51 | −0.02 | −0.20 | −0.57 | 0.49 | **16.95** | **215.61** |
| FULL (V2.1 stack) | 0.18 | −0.42 | 5.15 | 4.53 | **15.79** | **76.45** | **468.67** |

Binance Spot is **10 bps** round trip. **Sub-hourly trading is arithmetically
dead**: at 1m the baseline pays 0.9132 R in fees against a +0.0468 R gross edge
— costs are 19.5× the edge, and the deficit is structural because
`feeR = fee% × price / stopDistance`.

**V2.2 therefore trades only 1h and 4h.** 1d is excluded as a *trading*
timeframe (TRAIN n=132 baseline / 45 filtered — far too thin to support a
decision) but is retained as HTF context.

### 1.2 Target placement is the dominant mechanical blocker

In the V2.1 FULL arm, **176,707 of 234,478 published corridors (75.36 %)** were
rejected at fill on `rr1 < risk.min_rr`. Three quarters of all confirmed,
fee-cleared, confluence-passing setups died because TP1 sat too close relative
to the stop. This is the single largest correctable loss in the funnel.

### 1.3 The reversal path is blocked by `no_displacement`, not by hold

**Correcting the task brief on a point of fact.** `hold_too_short` (639,450
rejections) is a **CONTINUATION** gate — `breakout.holdBars` — and it cannot
block reversals, which never reach it. The actual reversal blocker is
**`no_displacement`: 205,534 rejections**, the requirement that a directional
`Displacement` object exist with `bodyAtr >= 0.60` on the same bar as the
sweep/reclaim.

Result: the V2.1 reversal path produced **445 closed trades out of 56,486
(0.8 %)**. Both gates are addressed below, each for its own path, rather than
removing the one the brief named.

### 1.4 A design premise was contradicted

EQH/EQL was the **worst** pool kind (−0.0035) and CLUSTER the best (+0.0218).
V2.2 therefore does **not** privilege EQH/EQL; pool kind is recorded and
reported, never used as a gate.

---

## 2. Scope

| item | value |
|---|---|
| trading timeframes | **1h, 4h** (only) |
| HTF context | **4h and 1d**, via the frozen `HTF_MAP`, closed bars only |
| symbols | the 6 frozen symbols |
| slice | TRAIN for development |

Registered consequence: TRAIN sample is **~5,369 baseline trades** (1h 4,344 +
4h 1,025). This is two orders of magnitude smaller than the 1m-dominated
corpus. Every result must therefore carry n, and no subgroup with n < 100 may
be used to justify a decision.

---

## 3. Change 1 — RR target placement

**Problem:** TP1 too close to the stop → 75.36 % `rr1` rejection.

**Fix (fixed now):** TP1 is placed at the **nearest opposing structural
liquidity level ahead of entry**, and where none exists within the search
window, at **range equilibrium**. Concretely, from the frozen `buildTargets`
candidate set, TP1 = the nearest candidate whose basis is `INTERNAL_LIQUIDITY`
or `RANGE_EDGE`; if neither exists ahead of entry, TP1 = `EQUILIBRIUM`; if that
too is unavailable or behind entry, **the setup is skipped** (`NO_STRUCTURAL_TP`).

**The R-multiple fallback is removed.** In V2.1 a 1R/2R/3R ladder was emitted
whenever structure gave nothing, which manufactured targets that were close to
the stop by construction and then failed the `rr1` gate. V2.2 refuses the trade
instead of inventing a level.

**`risk.min_rr` is NOT changed.** It stays at the frozen value of 1. The fix is
to place TP1 structurally, not to lower the bar it must clear. Lowering
`min_rr` would be exactly the kind of post-hoc accommodation this protocol
exists to prevent.

TP2 and TP3 keep the frozen next-structural-level logic. The exit model remains
**final rung only** (H1 tested, NOT validated — no partial, no breakeven).

**Pre-registered success criterion:** the `rr1` rejection rate must fall below
**40 %** of published setups (from 75.36 %). If it does not, this change failed.

## 4. Change 2 — Reversal confirmation

**Problem:** `no_displacement` (205,534) reduces reversals to 0.8 % of trades.

**Fix (fixed now):** the reversal trigger becomes **sweep + body reclaim +
RVOL**, dropping the separate `Displacement` object requirement and replacing it
with a body-reclaim test computed from the sweep candle itself:

| condition | field | requirement |
|---|---|---|
| directional sweep | `sweep.direction` | `== setup.direction` |
| reclaimed | `sweep.reclaimed` | `=== true` |
| prompt reclaim | `sweep.reclaimBars` | `<= 3` (unchanged) |
| genuine penetration | `sweep.penetrationAtr` | `>= 0.10` (frozen) |
| rejection wick | `sweep.wickRatio` | `>= 0.25` (frozen) |
| **body reclaim** | `sweep.bodyRatio` | **`>= 0.35`** (new, replaces displacement) |
| **participation** | `sweep.rvol` | **`> 1.2`** (new, same constant as confluence) |

Causality is unchanged: every field is on the `SweepEvent` already computed at
CLOSED N. This is **not** a loosening to "whatever passes" — it swaps one
structural requirement (a separate displacement bar) for two cheaper ones on the
sweep candle itself, both of which the brief named explicitly.

**Continuation `hold_too_short` is relaxed in the same spirit and separately
reported:** `breakout.holdBars >= 1` is replaced by
`breakout.immediateReclaim === false` alone. Holding is then evidenced by the
absence of an immediate failure rather than by an extra bar of confirmation
latency. `bodyRatio >= 0.50` and `closeBeyondAtr >= 0.25` are unchanged.

**Pre-registered success criterion:** reversals must reach at least **10 %** of
closed trades (from 0.8 %). If the reversal path stays below that, it is
declared structurally unavailable in this engine and reported as such.

## 5. Carried over unchanged from V2.1

- **Fee Drag Guard**: `stop >= 0.35 % of price AND >= 0.5 ATR`. The stop is
  **never widened** to pass; failing setups are skipped and counted.
  *Registered caveat:* the V2.1 anti-bias check showed this guard rejects setups
  whose baseline gross was ~5× better than those it admits. It is retained
  because at 1h/4h natural stops are already far wider (median 1.30 % / 2.81 %),
  so it should bind on very few setups — and **the ablation must confirm that**.
- **Confluence >= 3 of 4**: RVOL > 1.2, RSI divergence-or-zone, MACD inflection,
  EMA alignment. Unchanged.
- **Corridor entry**: centred on `close(N)`, `halfWidth = clamp(0.10×ATR,
  1 tick, 0.15 %)`, tick-quantized, expiry 3 bars, conservative fill, same-bar
  ambiguity → CANCELLED. Retained because its measured defect was *no edge to
  preserve*, not a mechanical fault: 1-bar median latency and only 277 missed
  winners.
- Stop anchor and level, `risk.min_rr`, `timeout_bars = 48`, one-position-at-a-
  time, HTF mapping, evidence weights, indicator periods: all frozen.

## 6. Ablation (fixed in advance)

| arm | description |
|---|---|
| **A** | frozen baseline, OPEN N+1, no gates — fidelity anchor |
| **A-htf** | baseline restricted to 1h/4h only (isolates the scope change) |
| **T** | A-htf + structural TP1 placement |
| **R** | A-htf + new reversal/continuation confirmation |
| **TR** | A-htf + both changes |
| **TRG** | TR + Fee Drag Guard + confluence |
| **FULL** | TRG + corridor entry |

**A-htf vs A** isolates timeframe scope; **T vs A-htf** isolates target
placement; **R vs A-htf** isolates confirmation; **FULL vs TRG** isolates entry.

## 7. Metrics and anti-bias checks

Primary metric: **gross expectancy per ORIGINAL ACTIONABLE SETUP**, unchanged
from V2.1 — it charges a model for the setups it declines.

Per arm: actionable setups, each rejection bucket, PENDING, FILLED, fill rate,
MISSED, EXPIRED, CANCELLED, closed, TP/SL/TIMEOUT, gross expectancy per filled
and per setup, median R, PF, total R, max drawdown, positiveRRate, stop %
quantiles, stop ATR, and **net expectancy at 0/2/5/10/20 bps** with **no maker
discount**. Gross reconstructed as `storedR + (0.1/100) × entry / risk`.

Breakdowns, always with n: REVERSAL vs CONTINUATION, LONG vs SHORT, 1h vs 4h,
per symbol, per HTF alignment state, and pool kind (reported, never a gate).

Mandatory, registered now:
1. **MISSED analysis** — baseline outcome of every declined setup.
2. **Selection bias** — baseline outcomes for FILLED vs NOT-FILLED.
3. **Fee-guard decomposition** — baseline outcome of setups the guard rejects
   vs admits, repeating the V2.1 check that exposed the edge-removal problem.
4. **Sample-size honesty** — every table carries n; no subgroup with n < 100 may
   support a conclusion.

## 8. Required tests before any result is reported

Model A fidelity gate (must reproduce the frozen TRAIN baseline exactly on the
1h/4h series); structural TP1 selection including the `NO_STRUCTURAL_TP` skip
and proof no R-multiple fallback is emitted; reversal confirmation accept/reject
for each condition including the new `bodyRatio >= 0.35` and `rvol > 1.2`;
continuation confirmation with the relaxed hold rule; corridor terminal states;
same-bar ambiguity; no look-ahead (fill index strictly > setup index).

## 9. Selection protocol and permitted statuses

TRAIN only. At most **one** variant is carried forward, chosen on expectancy per
actionable setup, fill rate, cost geometry, drawdown, outlier dependence and
structural rationale — **not** on highest per-trade expectancy. The choice and
its reason are committed **before** VALIDATION runs. VALIDATION runs **once**;
afterwards no threshold may change.

Permitted final statuses: `V2_2_REJECTED_ON_TRAIN`, `V2_2_NOT_VALIDATED`,
`V2_2_VALIDATED_FOR_RESEARCH`. **`PRODUCTION_READY` remains forbidden.**

### Prior expectation, registered honestly

The two changes above address **mechanical funnel losses**, not the absence of
edge. Every study so far has found V2's gross edge to be ~0.03 R per trade and
has shown that entry/filter rearrangements redistribute cost rather than create
alpha. Fixing target placement and reversal confirmation should materially
increase *trade count* at 1h/4h; there is **no measured basis** to expect it to
create edge. If gross expectancy per actionable setup does not improve on
TRAIN, the honest outcome is `V2_2_REJECTED_ON_TRAIN`.

**v2.enabled = false. LIVE_TRADING_ENABLED = false. V2.2 is research only.**

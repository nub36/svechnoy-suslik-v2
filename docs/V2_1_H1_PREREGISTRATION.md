# H1 EXIT-MODEL STUDY — PRE-REGISTRATION

**Written and committed BEFORE any comparative TRAIN result was computed.**

This document fixes the exit models, the intrabar ordering rules, and the fee
model. Nothing here may be revised after seeing results. No strategy code is
changed by this study: signals, entries, stops, targets, evidence, thresholds
and HTF logic all remain exactly as frozen at `4839074`. Only **post-hoc
accounting** of already-recorded trades is performed.

---

## 1. TP SEMANTICS (verified in frozen code before registering models)

From `buildTargets` (`src/strategy/v2/engine.ts`) and `trackOutcome`
(`src/outcome/tracker.ts`):

- A trade carries **1, 2 or 3** target rungs. `buildTargets` collects structural
  candidates ahead of entry, de-duplicates them by cluster identity and by
  `clusterTolAtr` proximity, caps at 3, and falls back to R-multiples only where
  structure gave nothing. It can return fewer than 3 when the fallback would
  land behind or inside an existing rung.
- `takeProfits` is sorted by **distance from entry ascending** in `trackOutcome`.
  So **TP1 = nearest rung, TP2 = middle rung, TP3 = furthest rung.**
- **Only the FINAL rung closes the position.** `trackOutcome` computes
  `finalRung = tps.length - 1` and exits `TP` only when `tpIndex >= finalRung`.
  Touching TP1 or TP2 is a milestone with no accounting effect — this is exactly
  the behaviour H1 interrogates.
- "TP1 reached" in this study means: **the high (LONG) or low (SHORT) of a candle
  at or after the entry candle touches or crosses the TP1 price.** Only candles
  with `openTime >= entryCandleTime` are examined. The entry price itself is the
  OPEN of candle N+1 (`resolveEntry`), and targets were computed on closed candle
  N, so every target pre-exists its own fill. **No look-ahead.**

### Observed target-count distribution (TRAIN+VALIDATION, n=440,437)

| rungs | n | share |
|---|---|---|
| 1 | 31,973 | 7.26 % |
| 2 | 36,651 | 8.32 % |
| 3 | 371,813 | 84.42 % |

TRAIN only (n=328,872): 1 rung 7.53 %, 2 rungs 8.63 %, 3 rungs 83.84 %.

**Consequence registered in advance:** for the 7.26 % of trades with a single
rung, TP1 *is* the final rung, so Models B, C and D are by construction
**identical to Model A** on those trades. Any aggregate difference between models
therefore comes from the ~92.7 % with 2+ rungs. This is stated now so the
diluted effect size cannot later be presented as a surprise.

---

## 2. EXIT MODELS (fixed, no other variants may be tested)

Let `E` = entry price, `S` = original stop, `R = |E − S|`, `F` = final rung
price, `T1` = TP1 price. Direction-aware throughout.

**MODEL A — CURRENT (frozen baseline).**
Position closes only at the final rung, the original stop, or TIMEOUT. This
reproduces `trackOutcome` exactly and is validated against the stored
`rMultiple` before use.

**MODEL B — FULL EXIT AT TP1.**
100 % of the position closes the first time TP1 is touched. Until TP1 the
original stop applies. If TP1 is never touched, the trade resolves by the
original SL or TIMEOUT exactly as in A.

**MODEL C — PARTIAL 50 % AT TP1 + REMAINDER TO FINAL.**
On the first touch of TP1, 50 % closes at T1. The remaining 50 % continues
toward the final rung with the **original stop unchanged** (explicitly NOT moved
to breakeven). If the final rung is not reached, the remaining half closes at the
original SL or at TIMEOUT.

**MODEL D — PARTIAL 50 % AT TP1 + BREAKEVEN ON REMAINDER.**
On the first touch of TP1, 50 % closes at T1. The stop for the remaining 50 %
moves to `E` (breakeven). The remainder continues toward the final rung. If price
returns to `E` first, the remainder closes at `E` (gross 0 R on that half, but
still charged fees — see §4).

**Fixed by instruction:** the partial fraction is **50 %** and is not searched.
No 25/33/60/70/75 variant is computed. No trailing stop. No TP2-specific
management. Targets themselves are never modified.

---

## 3. INTRABAR CAUSALITY RULES (deterministic, fixed in advance)

Only candles with `openTime >= entryCandleTime` are examined, in chronological
order. Within a single candle OHLC cannot reveal the true path, so a conservative
deterministic ordering is imposed **before** seeing results:

**R1 — SL and TP1 on the same bar (pre-TP1 phase).** SL wins. This inherits the
frozen `outcome.sl_priority_on_ambiguous_bar = true` policy ("assume the worst
case"). The trade is a stop-out in every model; no partial is booked.

**R2 — SL and the FINAL rung on the same bar (Models A and C, post-TP1 or no
partial).** SL wins, same policy.

**R3 — TP1 and the FINAL rung on the same bar.** The partial at TP1 is booked
first, then the final rung closes the remainder on that same bar. Rationale: the
rungs are ordered by distance from entry, so price must traverse T1 to reach F.
This is the only ordering consistent with geometry and it is not result-driven.

**R4 — Model D, breakeven and the final rung on the same bar (post-TP1).**
**Breakeven wins** — the worst case for the remainder, consistent with R1/R2.
Price must retrace to `E` and then travel to `F`; assuming the adverse leg
completes first is the conservative reading.

**R5 — Model D, the TP1 bar itself.** The breakeven stop becomes active only on
candles **strictly after** the bar on which TP1 was touched. Activating it on the
same bar would let one candle both trigger the partial and stop the remainder on
information that bar cannot order.

**R6 — TIMEOUT.** Unchanged at `outcome.timeout_bars = 48`, counted from the
entry candle. Any position still open at the timeout bar closes at that bar's
CLOSE. In C and D the already-booked TP1 half is unaffected.

**R7 — Dataset boundary.** If the series ends before resolution, the trade is
treated as it was in the original run (it does not contribute a closed outcome).

---

## 4. FEE MODEL (explicit, and deliberately NOT the old one-lump formula)

The frozen tracker charges a single lump `fee_pct` against **entry notional**,
which silently assumes exactly two legs. Partial exits add a third leg, so
reusing that formula blindly would under-charge Models C and D and bias the
comparison in favour of the hypothesis. Instead:

Let `c` = **per-side** cost as a fraction of that leg's notional. A "round-trip
equivalent of `B` bps" means `B` bps split across two sides, i.e. `c = B / 2`
bps per side. Costs are charged per leg, on that leg's own notional, and
converted to R by dividing by `R = |E − S|`:

```
feeR(legPrice, weight) = (c / 10000) * legPrice * weight / R
```

Legs charged per model (weights are fractions of the original position):

| model | entry leg | TP1 leg | final / SL / BE / TIMEOUT leg |
|---|---|---|---|
| A | 1.0 @ E | — | 1.0 @ exit |
| B | 1.0 @ E | 1.0 @ T1 (if reached) | 1.0 @ exit (if TP1 not reached) |
| C | 1.0 @ E | 0.5 @ T1 (if reached) | 0.5 @ exit (or 1.0 if TP1 not reached) |
| D | 1.0 @ E | 0.5 @ T1 (if reached) | 0.5 @ exit (or 1.0 if TP1 not reached) |

So Models C and D pay **three** legs when TP1 is reached, and Model B pays two
legs but at a nearer exit price. Model A always pays two.

Sensitivity is reported at round-trip-equivalent **0, 2, 5, 10, 20 bps**, fixed
in advance. The primary H1 comparison is conducted on **GROSS** (0 bps) first, as
instructed; costs are then layered on. No fee assumption is selected by result.

**Note on comparability with earlier work.** The previous reports used the
frozen one-lump formula `feeR = (fee_pct/100) * E / R`, which at
`fee_pct = 0.1` equals the 10 bps column only for Model A and only approximately
(it charges both legs at the entry price rather than at each leg's own price).
Model A gross figures here are validated against the stored `rMultiple`, so the
baseline is anchored; the net columns are on the new, more accurate leg-based
model and are not required to reproduce the old numbers exactly.

---

## 5. PROTOCOL

1. All model development and comparison on **TRAIN only**.
2. After TRAIN, **one** candidate model is selected on robustness, drawdown,
   outlier dependence, cost sensitivity and economic simplicity — explicitly
   **not** on highest expectancy. The reason is written down **before** the
   candidate's VALIDATION numbers are computed.
3. VALIDATION is run **once**, comparing Model A against the single candidate.
4. No return to TRAIN afterwards to adjust fractions or rules.
5. The 2022–2025 TEST split is **USED** and is not touched. The proposed 2026-H1
   window remains untouched and undownloaded.
6. If the TRAIN improvement does not carry to VALIDATION → `H1_NOT_VALIDATED`.
   If it does → `H1_VALIDATED_FOR_V2_1`, which is **not** a production-readiness
   claim.

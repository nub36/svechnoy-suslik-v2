# V3.0 HTF LIQUIDATION TRAP — VALIDATION RESULTS

## Status: `V3_0_VALIDATED_PENDING_TEST` — PASS, on the letter of all three criteria

**The first strategy in this programme to clear a pre-registered validation test
with a net-positive result at realistic Binance futures fees.**

One run, as frozen. TEST not read for signal generation. `src/` byte-identical to
`4839074`; the candidate file is byte-identical to the one tested on TRAIN.

| pinned | value |
|---|---|
| frozen engine | `4839074` |
| candidate commit | `5674e65` — `research/v30_htf_trap.ts` sha256 `a821757f…` |
| pre-registration | `6d735df` — committed **before** any validation code existed |
| valid artifact | `artifacts/research/v30/v30-validation-metrics.json` |
| boundary audit | `artifacts/research/v30/v30-validation-boundary-audit.json` |
| data manifest | `artifacts/research/v30/v30-validation-dataset-manifest.json` |
| dataset | `c3c1dce` |
| slice | VALIDATION · 1H execution · 4H structure · 6 symbols |
| TEST (2025-03-14 … 2025-12-31) | **not read for signals — see §6** |
| TEST (2026-H1) | **UNSPENT** |

---

## 1. PASS / FAIL

| criterion (registered in §3 of the pre-registration) | required | actual | result |
|---|---|---|---|
| **Primary:** net R/trade @2/5 bps | > 0 | **+0.0580** | ✅ |
| **Robustness 1:** gross > 0 after a top-1 % trim | > 0 | **+0.0364** | ✅ |
| **Robustness 2:** net R/trade under 5/5 bps stress | > 0 | **+0.0291** | ✅ |

# ==> PASS

Every criterion was fixed before the run and none was re-weighted afterwards.

## 2. Headline table

| metric | VALIDATION | TRAIN | change |
|---|---|---|---|
| **n** | **537** | 1,585 | 34 % of TRAIN (window is 33 % of it) |
| TP1 hit rate | 47.30 % | 48.26 % | −0.96 pt |
| Full TP2 hit rate | 14.15 % | 17.35 % | −3.20 pt |
| Positive-R rate | 48.60 % | 50.73 % | −2.13 pt |
| Median stop (% of price) | 1.2799 % | 1.2520 % | +0.03 pt |
| Fee drag @2/5 bps | 0.0673 R | 0.0732 R | −0.0059 |
| Fee drag @5/5 bps | 0.0961 R | 0.1046 R | −0.0085 |
| **Gross R/trade** | **+0.1253** | **+0.1726** | **−27.4 %** |
| **Net R/trade @2/5** | **+0.0580** | **+0.0994** | **−41.6 %** |
| Net R/trade @5/5 | +0.0291 | +0.0680 | −57 % |
| Profit factor | 1.2438 | 1.3538 | −0.11 |
| Max drawdown | −25.94 R | −37.18 R | better |
| Median R | **−1.0000** | +0.0179 | **sign flip** |
| Avg win / avg loss | +1.3146 / −0.9994 | +1.3022 / −0.9901 | stable |
| Median bars held | 7 | 7 | identical |

Funnel: 691 traps detected → 537 filled (**77.7 %**), 130 cancelled, 24 rejected
on geometry, 0 expired, 0 unresolved.

Exits: SL 275 · **TP1_THEN_BE 157** · TP2 76 · TP1_THEN_TIMEOUT 21 · TIMEOUT 8.

**Gross retained 72.6 % of its TRAIN value.** For scale: V2.3 retained 23 %,
V2.4 inverted, V2.8 retained 33 %.

## 3. ⚠️ My registered prediction was wrong — in the favourable direction

The pre-registration committed a falsifiable forecast rather than a formality:

| | registered | actual |
|---|---|---|
| gross R/trade | +0.04 … +0.08 (central +0.06) | **+0.1253** |
| implied net @2/5 | ≈ −0.01 R | **+0.0580** |
| verdict | "the primary criterion FAILS, narrowly" | **PASS** |
| n | ≈ 530 | 537 ✅ |

**The forecast was wrong and it was wrong on the side that flatters the result.**
That cuts both ways and both are recorded here:

- The programme's historical mean retention of ~30 % did **not** apply. V3.0 lost
  ~27 % of its gross edge, not ~70 %.
- But the registered *mechanism* remains falsified (§4), so the result still rests
  on a model of *why* the edge exists that has not been demonstrated. An outcome
  better than predicted is not evidence that the reasoning was right.

## 4. The registered mechanism failed again — the edge is not in the stop

The V3.0 thesis was that anchoring the stop behind a **4H** sweep wick would widen
the denominator and cut fee-in-R. On VALIDATION the stop is **1.2799 %** of price
against TRAIN's 1.2520 % — statistically the same number, and still the same as
the 1H-based V2.8 (~1.30 %). Fee drag stayed at 0.067 R.

So for the second time: **the mechanism did not engage, and the result is carried
by gross edge and sample size, not by stop geometry.** The partial exit still
costs three legs. Anything that describes V3.0 as "the wide-stop strategy" is
wrong, and this document should be cited against such a description.

## 5. ⚠️ The reservation that matters most

**Outlier sensitivity:**

| | gross | after removing the top 1 % |
|---|---|---|
| TRAIN | +0.1726 | +0.0983 (16 trades) |
| **VALIDATION** | **+0.1253** | **+0.0364 (6 trades)** |
| VALIDATION, top 5 only | +0.1253 | **+0.0462** |

Robustness criterion 1 is met — +0.0364 is > 0 — but **it is below the 0.0673 R
fee drag**. Read plainly: after removing the best 1 % of trades the strategy is
**net-negative, not net-positive**, and removing only the best five trades flips
net @2/5 to 0.0462 − 0.0673 = **−0.021** R.

This is the same failure mode the V2.8 validation flagged (a criterion satisfied
on its letter while the result does not survive a small trim), and it is stated
here in the same place and the same size. The difference is that V3.0 has 537
trades rather than 98, so the trim removes 6 trades rather than 1 — a materially
less fragile statement, but not a robust one.

Related: **median R is −1.0000.** The typical trade is a full stop-out; the
positive expectancy lives entirely in the upper tail (avg win +1.31 R). This is a
low-win-rate, tail-carried profile, and it is exactly the profile that trims
badly.

## 6. ⚠️ Slice-boundary effect — disclosed, measured, immaterial

Found while writing this report, i.e. **after** the single registered run.

A position is managed for up to `TIMEOUT_BARS = 50` bars after its fill, so a
trade filling near the end of the window is resolved on bars **beyond** it. For
the VALIDATION slice those bars belong to TEST. This is inherited behaviour — the
TRAIN driver does the same against VALIDATION, and the V2.x trainers before it
(`v28_gross_only.ts` and others) also managed positions past their slice boundary
— but the pre-registration did not anticipate it.

Measured by `research/v30_boundary_audit.ts`, which re-runs each slice through the
**same** `runSlice()` with a trace hook and **aborts unless the aggregates
reproduce the committed artifacts exactly** (they do, both slices):

| slice | fills whose management window crosses the boundary | outcomes actually decided beyond it | share of trades | share of gross R |
|---|---|---|---|---|
| **VALID** | 2 | **1** | 0.19 % | −1.49 % |
| TRAIN | 4 | 4 | 0.25 % | +0.71 % |

The single affected VALIDATION trade is `DOGEUSDT` SHORT, filled
2025-03-14T16:00Z and stopped 22 bars in (`barsHeld = 22`), i.e. on the
2025-03-15T13:00Z candle — one day inside TEST. Sensitivity:

| net @2/5 bps | value |
|---|---|
| **registered** | **+0.0580** |
| excluding the affected trade | +0.0600 |
| worst case: affected trade charged as −1 R + fees | +0.0580 |

**The leak is one trade, it is a loser, and removing it improves the result.**
Signal generation never touches a post-boundary bar (asserted by tests, §8).
The verdict is unaffected in every direction. Both TRAIN and VALIDATION numbers
in this repository carry the same property; it is now quantified rather than
suspected.

## 7. Subgroups — the rule that was fixed in advance

The pre-registration fixed, before the run, that **no cell with n < 100 may
support a conclusion** and that at n ≈ 530 every per-symbol cell would be below
that.

**Direction** (both usable):

| direction | n | gross |
|---|---|---|
| LONG | 230 | +0.0837 |
| SHORT | 307 | +0.1564 |

Both positive, with SHORT the stronger side — the project's one recurring
directional finding reappeared here after inverting in the V2.8 validation.

**Symbol** (diagnostic only):

| symbol | n | gross |
|---|---|---|
| ETHUSDT | 101 | **+0.4684** |
| BNBUSDT | 77 | +0.4272 |
| DOGEUSDT | 75 | +0.0402 |
| BTCUSDT | 107 | −0.0129 |
| SOLUSDT | 90 | −0.0685 |
| XRPUSDT | 87 | **−0.0966** |

Dispersion from −0.0966 to +0.4684 across cells of n ≈ 90 is what noise at that
sample size looks like. Only BTC and ETH clear n = 100, and barely. **No symbol
conclusion is drawn**, in either direction.

## 8. Protocol compliance

- Pre-registration committed at `6d735df` **before** `research/v30_validate.ts`
  existed and before any VALIDATION figure had been computed.
- **Candidate frozen:** `git diff` on `research/v30_htf_trap.ts` against `5674e65`
  is empty; its sha256 is still `a821757ff0319a100a8a9087da1bdd137abb1df0785493d644ad4d87f05dc4cd`.
- **Harness fidelity gate (§5 of the pre-registration): PASSED.** The new driver
  reproduced `artifacts/research/v30/v30-train-metrics.json` **exactly** —
  `mismatches: []`, `exact: true`, recorded inside the validation artifact.
  The validation window was read only after that gate cleared.
- **Exactly one** validation run. No re-runs, no variants, no parameter changes.
- **Hard TEST guard:** 6 series checked, `safe: true`, recorded in the artifact;
  asserted by tests.
- **Data integrity:** the frozen dataset `c3c1dce` was re-cloned and re-ingested
  from the original monthly ZIPs for the V3.0 scope (1H + 4H, 6 symbols) — 576
  archives, 262,974 candles: 0 duplicate timestamps, 0 out-of-order rows, 0
  invalid OHLC, 0 invalid volumes, and exactly 1 gap per 1H series (the
  2023-03-24 Binance halt). Recorded in
  `artifacts/research/v30/v30-validation-dataset-manifest.json`.
- **Frozen engine:** `git diff 4839074 HEAD -- src/` is empty, verified in a
  full (unshallowed) checkout with `4839074` present and confirmed an ancestor of
  this commit.
- `v2.enabled = false` · `LIVE_TRADING_ENABLED = false`.
- Gates: typecheck ✅ · **1,137 tests passed / 31 skipped** ✅ · build ✅.

## 9. What this does and does not establish

**Does:** the candidate's positive expectancy survived an unseen slice at
realistic futures fees with 537 trades, both directions positive, and with the
same mechanical behaviour (avg win +1.31 vs +1.30, avg loss −1.00 vs −0.99,
median bars held 7 vs 7) as on TRAIN. It is the second candidate in the programme
to clear a pre-registered validation, and the first to do it net of fees.

**Does not:**

1. **Establish robustness.** On the registered trim the result is net-negative;
   five trades decide the sign of net expectancy. The pass is real, the margin is
   not comfortable.
2. **Confirm the mechanism.** The stop did not widen — the same falsification as
   on TRAIN, now reproduced out of sample (§4).
3. **Survive the typical trade.** Median R = −1.00. This needs the tail.
4. **Account for execution reality.** Post-only fills remain optimistic (OHLC
   cannot detect a crossing rejection), and spread/slippage are not modelled
   beyond the stated fee schedule.
5. **See TEST.** The 2022–25 TEST slice is **spent but unread for signal
   generation**, and the 2026-H1 window remains unspent. Nothing here licenses
   deployment.

## 10. Verdict

# `V3_0_VALIDATED_PENDING_TEST`

All three pre-registered criteria met on an unseen slice: net **+0.0580 R** per
trade at 2/5 bps over 537 trades, profit factor 1.2438, max drawdown −25.94 R,
both directions positive, 72.6 % gross retention against a registered prediction
of ~30 %.

Recorded honestly alongside it: the registered prediction **failed** (helpfully),
the registered mechanism **failed** (again), the outlier trim leaves the result
**below the fee line**, the median trade is a full stop, and one boundary trade
was resolved on a TEST candle.

**Recommended next step, and it is a decision rather than an automatic one:**
spend the untouched 2022–25 TEST slice exactly once, on the frozen candidate, with
the success criteria registered beforehand — *or* treat the outlier dependence in
§5 as disqualifying for now. This document does not hide which way the evidence
leans: it leans "worth one more run", not "promising enough to relax".

**TEST (2022–25) unread for signals · TEST (2026-H1) unspent ·
`v2.enabled = false` · `LIVE_TRADING_ENABLED = false` · `PRODUCTION_READY`
forbidden.**

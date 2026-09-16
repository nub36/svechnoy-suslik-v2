# V3.0 — HTF LIQUIDATION TRAP — VALIDATION PRE-REGISTRATION

**Written and committed BEFORE any VALIDATION code is written and BEFORE any
VALIDATION number exists.** No validation figure has been computed at this
commit. Every rule, threshold, window and verdict below is fixed now and may not
be revised after results are seen.

| pinned | value |
|---|---|
| frozen engine | `4839074` — `src/` must stay byte-identical |
| candidate commit | `5674e65` (V3.0 TRAIN) |
| candidate file | `research/v30_htf_trap.ts` — sha256 `a821757ff0319a100a8a9087da1bdd137abb1df0785493d644ad4d87f05dc4cd` |
| TRAIN results | `5674e65` / `docs/V3_0_TRAIN_RESULTS.md` |
| dataset | `c3c1dce` (Binance Spot klines 2022-01 … 2025-12) |
| slice | **VALIDATION only** |
| TEST (2025-03-14 … 2025-12-31) | **USED — must not be read, run or inspected** |
| TEST (2026-H1) | **UNSPENT — not touched** |

---

## 0. Purpose and the registered prior — a prediction, not a formality

V3.0 produced the strongest TRAIN result of the programme: n = 1,585, gross
+0.1726 R, net **+0.0994 R** at the 2/5 bps headline, 57 % edge retention after
trimming the top 1 %. It is the first candidate that clears realistic Binance
futures fees.

It is also the candidate whose **registered mechanism was falsified**: the stop
did not widen (median 1.2520 % of price vs V2.8's ~1.30 %) and fee drag got
*worse* (0.0732 R vs ~0.0538 R), because the partial exit pays three legs. The
edge came from better signal quality and a 5× larger sample, not from the
geometry the pre-registration predicted.

**Registering a quantitative forecast now, so that this run can falsify a
prediction rather than merely add a number.** The programme's out-of-sample
record:

| candidate | TRAIN gross | VALIDATION gross | retention |
|---|---|---|---|
| V2.3 | +0.1295 | +0.0298 | 23 % |
| V2.4 | +0.2023 | **−0.1098** | inverted |
| V2.8 | +0.1462 | +0.0488 | 33 % |

Mean retention ≈ 30 % (one of three inverted). Applied to V3.0's +0.1726 the
honest central forecast is:

| forecast | value |
|---|---|
| expected gross R/trade | **+0.04 … +0.08** (central ≈ +0.06) |
| expected fee drag @2/5 | ≈ 0.07 R (per-trade, sample-independent) |
| implied net @2/5 | **≈ −0.01 R, i.e. marginally on the wrong side of the fee line** |
| expected n | ≈ 500 |

**Registered prediction: the primary criterion FAILS, narrowly.** A PASS is
therefore informative rather than expected; either outcome must be reported
against this prediction.

Sample-size arithmetic: the slice is the middle 20 % of each 1h series
(7,013 candles of 35,063), one third of the TRAIN window (21,037 candles).
TRAIN's 1,585 fills scale to **n ≈ 530** (registered range 400–650).

## 1. The frozen candidate — bit-for-bit as tested

Nothing in the candidate may change. `research/v30_htf_trap.ts` is **not edited**;
the validation driver imports its exported primitives (`confirmedLevels`,
`bodyRatio`, `detectTrap`, `manageTrade`, `legFeeR`, all constants and types) and
implements only the *window* differently.

| # | element | value |
|---|---|---|
| 1 | structure | 4H swings, `findSwingsV2`, `strength = engine.swing_lookback = 3` |
| 2 | level eligibility | pivot usable only from `confirmedIndex = index + 3` |
| 3 | HTF bound | 4H context bounded by `closedHtfCandles(..., closeTime)` |
| 4 | trap | 1H pierce of the confirmed 4H level **and** close back inside |
| 5 | body ratio | `\|close − open\| / (high − low) >= 0.35` |
| 6 | volume | `RVOL > 1.25` (strict), 1H volume ÷ 20-period average |
| 7 | corridor | `centre = close(N)`, `half = 0.10 × ATR(1H,14)`, fills from N+1 |
| 8 | fill price | worse edge: LONG `min(open, zoneHigh)`, SHORT `max(open, zoneLow)` |
| 9 | expiry | 3 bars unfilled → `EXPIRED` |
| 10 | stop | sweep wick ± `0.15 × ATR(1H)` |
| 11 | TP1 | 4H range equilibrium, close 50 % |
| 12 | TP2 | opposing 4H swing level, close the remainder |
| 13 | breakeven | after TP1, stop on the remainder → entry |
| 14 | timeout | `TIMEOUT_BARS = 50` (entry bar = bar 1) |
| 15 | intrabar | R1 stop before targets · R2 TP1 then TP2 · R3 BE strictly after the TP1 bar · R4 stop never moves back · R5 timeout counts the entry bar |
| 16 | same-bar fill + stop | `CANCELLED` (unfavourable) |
| 17 | fees | per leg, no rebate: `GROSS` 0/0 · **`FUT_4` 2/5 bps (headline)** · `SPOT` 5/5 bps (stress) |
| 18 | position model | one at a time per series |
| 19 | symbols | BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT, DOGEUSDT |
| 20 | execution / structure TF | 1H / 4H |

## 2. Window

Per-series boundaries taken from the **frozen** `splits.json`
(`artifacts/research/v2-real-20260915-080338/splits.json`,
`policy` = chronological 60/20/20 by candle index):

| slice | from | to |
|---|---|---|
| VALIDATION (1h, all six symbols) | 2024-05-26T14:00:00Z | 2025-03-14T18:00:00Z |
| TEST 1h | 2025-03-14T19:00:00Z | 2025-12-31T23:00:00Z |

Warm-up is identical to TRAIN: iteration starts at 1H index 60 and indicators are
built from the full series prefix `h1[0..i]`, so ATR(14) and RVOL(20) are fully
warmed before the first in-window bar. No bar before `validFromMs` may create or
fill a trade; no bar at or after `testFromMs` may be read.

## 3. Success criteria — identical to TRAIN, not re-weighted

**Primary:** **net R/trade > 0 under the headline 2/5 bps model.**

**Robustness (required for any positive verdict):**
1. Gross still positive after removing the top 1 % of trades.
2. Net still positive under the 5/5 bps stress.

**Anything else is FAIL.** No criterion may be relaxed, substituted or given a
different weight after the numbers are seen.

## 4. Subgroup rule — fixed in advance at this sample size

Expected n ≈ 530 means roughly **80 fills per symbol** and **≈ 265 per
direction**. Registered in advance:

- **no subgroup with n < 100 may support a conclusion** — and at this sample size
  **every per-symbol cell will be below 100**, so symbols are *diagnostic only*;
- direction cells (≈265 each) remain usable;
- the outlier trim removes the top 1 % ≈ 5 trades.

Registering this now so that "XRP looked weak" or "DOGE carried it" cannot be
introduced after the fact as a finding.

## 5. Harness fidelity — required BEFORE the validation window is read

The validation driver is new code. To prove it changes **only the window** and
nothing else, it must first be run with `--slice=train` and must reproduce
`artifacts/research/v30/v30-train-metrics.json` **exactly**.

- If the reproduction is not exact, the validation run is **aborted**. The
  discrepancy is investigated and reported; nothing is "adjusted".
- Only after an exact TRAIN reproduction may the driver be run once with
  `--slice=valid`.
- The comparison result is recorded in the validation artifact.

This is the anti-tuning control for this task: it turns "we did not change the
strategy" from an assertion into a reproducible check.

## 6. Hard TEST guard

The driver aborts if, for any in-scope series, `validToMs >= testFromMs`. The
guard is asserted by tests and its status is recorded in the artifact. TEST is
not read in this task.

## 7. Metrics to report

n · TP1 hit rate · full TP2 hit rate · positive-R rate · stop distance
(% of price: p25/median/p75) · fee drag in R · gross R/trade · net R/trade at
2/5 bps · net at 5/5 bps · profit factor · max drawdown R · median R · avg
win / avg loss · median bars held · exit-reason mix · funnel (signals, filled,
cancelled, rejected, expired, unresolved) · outlier sensitivity (ex-top-1,
ex-top-5, ex-top-1 %) · breakdowns by direction and by symbol with n on every
row.

Additionally, and explicitly as **diagnostics only** (never as pass/fail):

- the TRAIN → VALIDATION comparison against the registered forecast in §0;
- whether the *third* leg (partial exit) is what carries or destroys the result
  here.

## 8. Protocol

1. **Exactly one** validation run. No re-runs, no variants, no parameter sweeps.
2. No criterion relaxed or substituted after results are seen.
3. `git diff 4839074 -- src/` must remain empty.
4. `research/v30_htf_trap.ts` must remain byte-identical to the pinned sha256.
5. Data must be genuine Binance Spot klines from the frozen dataset; no
   synthetic, extrapolated or substituted input under any circumstances.
6. The artifact `artifacts/research/v30/v30-validation-metrics.json` and the
   report `docs/V3_0_VALIDATION_RESULTS.md` are written from the single run.

## 9. Permitted verdicts

- `V3_0_REJECTED_ON_VALIDATION` — any criterion missed.
- `V3_0_VALIDATED_PENDING_TEST` — all three criteria met.

`PRODUCTION_READY` is **forbidden**. A VALIDATION pass licenses **only** a
decision about whether the untouched 2022–25 TEST slice is to be spent; it does
not license deployment, and `v2.enabled` stays `false`,
`LIVE_TRADING_ENABLED` stays `false`.

## 10. What each outcome will mean

| outcome | reading |
|---|---|
| net > 0 @2/5 **and** both robustness checks | the first candidate in the programme with a validated, fee-beating edge; TEST becomes the next decision |
| net > 0 but a robustness check fails | TRAIN reproduced in sign but not in robustness — same failure mode as V2.8 (one-trade dependence), no promotion |
| gross > 0 but net <= 0 | the edge is real but smaller than the fee drag: this is the **registered prediction**, and it means the fee floor — not the signal — is the binding constraint |
| gross <= 0 | outright rejection; the TRAIN result was slice-specific |

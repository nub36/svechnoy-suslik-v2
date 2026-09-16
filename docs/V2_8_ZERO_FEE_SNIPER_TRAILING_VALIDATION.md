# V2.8 ZERO-FEE SNIPER + TRAILING — VALIDATION PRE-REGISTRATION

**Committed BEFORE the validation replay is written or run.** No VALIDATION
number exists at this commit. Nothing below may change afterwards.

| pinned | value |
|---|---|
| frozen V2 strategy | `4839074` (unchanged, incl. `src/outcome/tracker.ts`) |
| V2.8 TRAIN results | `54243a7` |
| dataset | `c3c1dce` |
| VALIDATION | to be run **once**, immediately after this commit |
| TEST (2022–2025) | **USED — must not be run or inspected** |
| future window (2026-H1) | not downloaded |

---

## 1. The frozen candidate

**Sniper entry + V2.5 trailing exit, zero fees.**

### Entry — 8-condition sniper filter, reversals only

Read from the frozen `SweepEvent` at **CLOSED N**; continuation disabled.

| # | condition | value | source |
|---|---|---|---|
| 1 | swept a real extreme | pool kind ∈ {SWING, EQUAL, CLUSTER} | `corridor-entry.ts` |
| 2 | directional | `sweep.direction == setup.direction` | — |
| 3 | causal reclaim | `sweep.reclaimed === true` | — |
| 4 | prompt reclaim | `RECLAIM_MAX_BARS = 3` | `v24-engine.ts` |
| 5 | penetration | `MIN_PENETRATION_ATR = 0.10` | `v24-engine.ts` |
| 6 | rejection wick | `MIN_WICK_RATIO = 0.25` | `v24-engine.ts` |
| 7 | **body reclaim** | `MIN_BODY_RATIO = 0.35` | `v24-engine.ts` |
| 8 | **volume surge** | `MIN_RVOL = 1.2` (strict `>`) | `v24-engine.ts` |

Entry price: **OPEN of N+1** via the frozen `resolveEntry`. No corridor, no LONG
asymmetry (failed VALIDATION in V2.4 and is **not** reintroduced).

### Exit — V2.5 trailing, verbatim

| constant | value | source |
|---|---|---|
| `BREAKEVEN_R` | 1.0 | `v25-trailing.ts` |
| `TRAIL_DISTANCE_R` | 1.0 | `v25-trailing.ts` |
| `TRAIL_STEP_R` | 0.25 | `v25-trailing.ts` |
| `TIMEOUT_BARS` | 10 | `v25-trailing.ts` |

Initial stop: the **frozen structural stop** (0.25 ATR buffer). No take-profit
ladder. Intrabar rules R1–R5 unchanged from `aad5be5`.

### Fees — ZERO

All commission set to **0**. Every figure is gross R. This is the explicit
premise of the study: a 0 %-fee or full-rebate venue.

### Implementation hashes (SHA-256, first 16 hex)

| file | hash |
|---|---|
| `scripts/real-data/v25-trailing.ts` | `fe6c307ee53273ed…` |
| `scripts/real-data/v24-engine.ts` | `6f930e48998bdfbd…` |
| `research/v28_gross_only.ts` | `bb237f47ad7cd342…` |

## 2. TRAIN result being tested

| metric | TRAIN (Trail arm) |
|---|---|
| n | 317 |
| win rate | 50.79 % |
| **gross R/trade** | **0.1462** |
| profit factor | 1.3508 |
| max drawdown R | −16.16 |
| median R | +0.0364 |
| avg win / avg loss | +1.1088 / −0.8471 |
| gross after removing top 1 % | 0.0536 |

## 3. Pre-registered success criteria

**PASS requires BOTH:**

1. **Gross R/trade > 0** on VALIDATION.
2. **Profit factor > 1.0** on VALIDATION.

Reported alongside as diagnostics only, **not** part of pass/fail: n, win rate,
max drawdown, median R, avg win/loss, outlier sensitivity, and the LONG/SHORT,
timeframe and symbol breakdowns.

**Anything else is FAIL.** No criterion may be relaxed, re-weighted or
substituted after the numbers are seen. Exactly **one** validation run — no
re-runs, no variants, no parameter changes.

Outcome mapping:
- both met → `V2_8_VALIDATED_FOR_RESEARCH`
- otherwise → `V2_8_NOT_VALIDATED`

`PRODUCTION_READY` remains forbidden. Validation here would mean only that the
design survived one unseen split **at zero fees** — it would still be unprofitable
at Binance futures rates, as V2.6/V2.7 measured.

## 4. Caveats carried forward

1. **Zero fees is an assumption, not a result.** TRAIN measured fee drag at
   0.1555 R/trade at 2/5 bps, which exceeds the 0.1462 R gross edge. This
   candidate is only viable on a venue charging effectively nothing.
2. **Small sample.** TRAIN n = 317. VALIDATION is a shorter window (~20 % of
   history vs 60 %), so expect roughly **n ≈ 100–160**. Most subgroup cells will
   fall below 100, and **no subgroup with n < 100 may support a conclusion**.
3. **Outlier fragility.** TRAIN gross fell from 0.1462 to 0.0536 when the top
   1 % was removed — 63 % of the edge sat in ~3 trades. Outlier sensitivity is
   reported on VALIDATION and is expected to be decisive.
4. **Selection context.** Trail was chosen from a 7-arm comparison on TRAIN. It
   was *not* the top arm by raw gross (SMC was, at 0.1490); it was picked for
   its shape and robustness. The multiple-comparison bias still applies.
5. **Prior base rate.** Of the TRAIN-derived candidates carried to VALIDATION so
   far, V2.4 failed comprehensively. Expect failure.

## 5. Protocol constraints for the run

- VALIDATION window only, per-series boundaries from the frozen `splits.json`
  (`validFromMs` … `validToMs`).
- A hard **TEST-safety guard**: abort if any series' `validToMs` is not strictly
  less than its `testFromMs`.
- 15m, 30m, 1h, 4h · BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT, DOGEUSDT.
- **No file under `src/` may change**; `git diff 4839074 -- src/` must stay empty.
- `v2.enabled = false`, `LIVE_TRADING_ENABLED = false`.

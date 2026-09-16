# V2.8 — FINAL UNTOUCHED TEST (2026-H1) — PRE-REGISTRATION

**Committed BEFORE any attempt to access 2026 data.** No 2026 number exists at
this commit, and — see §6 — none could be produced.

| pinned | value |
|---|---|
| frozen V2 strategy | `4839074` (unchanged, incl. `src/outcome/tracker.ts`) |
| candidate freeze | `852167c` |
| VALIDATION result | `1d4d575` (`V2_8_VALIDATED_FOR_RESEARCH`) |
| TRAIN dataset | `c3c1dce` (2022-01 … 2025-12) |
| run date (UTC) | 2026-09-16 |
| test window | **2026-01-01 … 2026-06-30 UTC** |

---

## 1. The frozen candidate — bit-for-bit as validated

No parameter may change. Exactly one test run.

### Entry — sniper filter, reversals only (continuation disabled)

| # | condition | value |
|---|---|---|
| 1 | swept a real extreme | pool kind ∈ {SWING, EQUAL, CLUSTER} |
| 2 | directional | `sweep.direction == setup.direction` |
| 3 | causal reclaim | `sweep.reclaimed === true` |
| 4 | prompt reclaim | `RECLAIM_MAX_BARS = 3` |
| 5 | penetration | `MIN_PENETRATION_ATR = 0.10` |
| 6 | rejection wick | `MIN_WICK_RATIO = 0.25` |
| 7 | **body reclaim** | `MIN_BODY_RATIO = 0.35` |
| 8 | **volume surge** | `MIN_RVOL = 1.2` (strict `>`) |

Entry price: **OPEN of N+1** (frozen `resolveEntry`). No corridor, no LONG
asymmetry.

### Exit — V2.5 trailing, verbatim

| constant | value |
|---|---|
| `BREAKEVEN_R` | 1.0 |
| `TRAIL_DISTANCE_R` | 1.0 |
| `TRAIL_STEP_R` | 0.25 |
| `TIMEOUT_BARS` | 10 |

Initial stop: frozen structural stop (0.25 ATR buffer). No TP ladder. Intrabar
rules R1–R5 unchanged.

### Scope

15m, 30m, 1h, 4h × BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT, DOGEUSDT
= 24 series, 2026-01-01 … 2026-06-30 UTC.

## 2. Primary hypothesis (zero fees)

**PASS requires BOTH:**

1. **Gross R/trade > 0**
2. **Profit factor > 1.0**

## 3. Secondary diagnostics (not pass/fail)

n, win rate, max drawdown, median R, avg win/loss; trimmed gross excluding the
top 1 %; net R under **FUT_4 (2 bps maker / 5 bps taker)** and **FUT_7
(5/5 bps)**; fee drag in R; breakdowns by LONG/SHORT, timeframe and symbol, each
with n. **No subgroup with n < 100 may support a conclusion.**

## 4. Reference results being tested against

| metric | TRAIN | VALIDATION |
|---|---|---|
| n | 317 | 98 |
| win rate | 50.79 % | 44.90 % |
| gross R/trade | +0.1462 | +0.0488 |
| profit factor | 1.3508 | 1.1087 |
| max drawdown R | −16.16 | −8.11 |
| gross ex-top-1 % | +0.0536 | **−0.0143** |

## 5. Protocol

- **Exactly one** test run. No re-runs, no variants, no parameter changes.
- No criterion relaxed or substituted after seeing results.
- `git diff 4839074 -- src/` must remain empty.
- Data must be genuine Binance klines for the window, with causal ordering and
  gap accounting verified before any replay — **no synthetic or substituted
  data under any circumstances**.

---

## 6. EXECUTION BLOCKED — 2026-H1 data cannot be acquired

The test **was not run**, because the required data does not exist in this
environment and cannot be obtained. Verified before writing any test code:

| check | result |
|---|---|
| frozen dataset `c3c1dce` coverage | 2022-01 … **2025-12** — latest file `*-2025-12.zip` |
| any `*2026*` file in the dataset repo | **none** |
| dataset repo upstream `origin/main` | still `c3c1dce`, not updated |
| candle cache coverage (BTC/ETH 1h) | first 2022-01-01, **last 2025-12-31** |
| any 2026 `.zip`/`.csv`/`.bin` anywhere on disk | **none** |
| `data.binance.vision` | DNS resolves, TCP connects, **session filtered — HTTP 000** |
| `api.binance.com`, `api1.binance.com`, `fapi.binance.com` | **HTTP 000** |
| `api.bybit.com`, `api.kraken.com` | **HTTP 000** |
| `github.com` (control) | **HTTP 200** |

GitHub is reachable while every exchange host fails at the same point, with DNS
resolving and TCP connecting before the session is dropped. That is a **sandbox
egress allowlist**, not a transient outage or a credential problem.

### Why the run was not attempted anyway

Executing the driver over an empty window would return **n = 0** and a
meaningless "0 trades" report that could later be mistaken for a genuine test of
the untouched period. Worse, any workaround — synthesising candles, extrapolating
from 2025, or substituting another venue's data — would **burn the one untouched
test window on fabricated input**. The window is single-use by construction; it
cannot be reclaimed once a result is recorded against it.

**The 2026-H1 window therefore remains UNSPENT and still untouched.** The
candidate frozen at `852167c` is unchanged and remains eligible for exactly one
future test.

### What is needed to proceed

Any one of the following unblocks the run:

1. **Egress allowlist** for `data.binance.vision` (monthly klines are sufficient;
   no API key required).
2. **Dataset repo updated** with 2026-01 … 2026-06 for the 6 symbols × 7
   timeframes, pushed to a commit that can be pinned as the new frozen hash.
3. **Manual upload** of the 144 monthly ZIPs (6 symbols × 4 timeframes × 6
   months, or 7 timeframes if HTF context is wanted) into the workspace.

On receipt of the data the procedure is mechanical: ingest → verify manifest
(duplicate/out-of-order/invalid-OHLC/gap accounting) → run the frozen driver
once → report against §2.

**Status: `V2_8_FINAL_TEST_BLOCKED_NO_DATA`.** Not a pass, not a fail — the test
did not occur.

**TEST window untouched. `v2.enabled=false`, `LIVE_TRADING_ENABLED=false`.
`PRODUCTION_READY` forbidden.**

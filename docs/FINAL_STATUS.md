# FINAL STATUS — SMC V2 RESEARCH PROGRAMME

**Research phase closed.** Final strategy: **V2.8 Zero-Fee Sniper + Trailing**.

| pinned | value |
|---|---|
| frozen engine | `4839074` — `src/` byte-identical throughout |
| final candidate freeze | `852167c` |
| validation result | `1d4d575` — `V2_8_VALIDATED_FOR_RESEARCH` |
| dataset | `c3c1dce` — Binance Spot klines 2022-01 … 2025-12 |
| tests | 1,090 passing |

---

## 1. What was built

A research programme testing whether an SMC (Smart Money Concepts) strategy can
produce a tradeable edge on Binance, evaluated on **16,681,073 real klines**
across 6 symbols × 7 timeframes × 48 months.

**Method, applied to every stage without exception:**

- Chronological TRAIN (60 %) / VALIDATION (20 %) / TEST (20 %) split, frozen
  before the first comparison.
- Every hypothesis **pre-registered and committed before the run** — parameters,
  success criteria and anti-bias checks fixed in advance.
- The trading engine (`src/`) frozen at `4839074` and **never modified**; all
  research lives in `scripts/real-data/` and `research/`.
- Mandatory anti-bias checks each stage: same-entry invariants, outlier
  sensitivity, selection-bias decomposition, and an `n < 100` rule barring thin
  subgroups from supporting conclusions.

## 2. What was tested

Eight strategy generations. Seven rejected, one validated.

| Strategy | Hypothesis | Outcome |
|---|---|---|
| V2.1 | Limit/corridor entry beats market entry | ❌ Fill rate 24 %, tighter stops inflated fee-in-R |
| V2.2 | Fix funnel losses (rr1 rejection, dead reversals) | ❌ Both "fixes" backfired |
| V2.3 | Pure reversal sniper with R-multiple targets | ❌ 77 % of edge in 1 % of trades |
| V2.4 | Asymmetric LONG filter | ❌ Passed TRAIN, **inverted** on validation |
| V2.5 | Trailing exit beats fixed targets | ⚠️ Beat baseline, still net-negative |
| V2.6 | Best entry + best exit | ❌ −0.0092 R/trade after fees |
| V2.7 | Bigger targets dilute commission | ❌ **Arithmetically disproven** |
| **V2.8** | Best entry + best exit at **zero fees** | ✅ **VALIDATED** |

## 3. What was proven

### 3.1 Commission is set by stop distance, not target distance

```
feeR = fee% × price / stopDistance
```

V2.7 measured fee drag at **0.1555 R across all five target levels — spread
0.0000**. The take-profit does not appear in the formula. This invalidates the
common intuition that larger targets dilute commission when expectancy is
measured in R.

### 3.2 The sniper entry filter is the one component with real value

Sweep + body reclaim (`bodyRatio ≥ 0.35`) + volume surge (`rvol > 1.2`) selects
setups with baseline gross **+0.2663** versus **−0.0036** for those it declines,
and cuts max drawdown from **−505.8 R to −32.7 R**.

### 3.3 Entry filtering and exit management do not compose

Trailing alone: **+0.0472**. Trailing on top of the sniper filter: **−0.0028**.
Both harvest the same favourable excursion.

### 3.4 Commission, not signal quality, is the binding constraint

Best gross edge ever measured: **~0.15 R/trade**. Fee drag at Binance futures
rates on the same population: **~0.1555 R/trade**.

### 3.5 TRAIN-derived hypotheses usually fail

Three of four failed to reproduce. V2.4 is the clearest case: it passed every
TRAIN criterion, then inverted out of sample — including its selection filter
becoming *anti*-selective (rejecting the best trades).

## 4. Final recommendation

**V2.8 for zero-fee or full-rebate venues only.**

| Metric | TRAIN | VALIDATION |
|---|---|---|
| n | 317 | 98 |
| Gross R/trade | +0.1462 | **+0.0488** |
| Profit factor | 1.3508 | **1.1087** |
| Win rate | 50.79 % | 44.90 % |
| Max drawdown | −16.16 R | −8.11 R |

Both pre-registered criteria (gross > 0, PF > 1.0) were met on unseen data.

## 5. Known limitations — read before porting

1. **Not profitable at real fees.** Validation gross +0.0488 R against ~0.1555 R
   of drag at 2/5 bps: a deficit of ~0.107 R/trade.
2. **One trade from zero.** At n=98, removing the single best trade flips
   validation gross to **−0.0143**.
3. **Negative median trade** on validation (−0.1270). The average is carried by
   the upper tail.
4. **The SHORT leg inverted.** Stronger in every earlier study; **−0.1525** on
   validation while LONG carried the result.
5. **No subgroup is decisive** — every validation cell has n < 100.
6. **Small absolute sample.** 317 TRAIN / 98 validation trades.
7. **Post-only fills modelled optimistically.** OHLC cannot detect a crossing
   rejection, so fills are assumed whenever price enters the zone.

## 6. Untouched test window — 2026-H1

**Status: UNSPENT.** The final test was pre-registered
(`V2_8_FINAL_UNTOUCHED_TEST_2026_PREREGISTRATION.md`) but **could not run**:

- The frozen dataset ends **2025-12**; no 2026 file exists locally or upstream.
- `data.binance.vision`, `api.binance.com`, `fapi`, Bybit and Kraken all return
  **HTTP 000** (DNS resolves, TCP connects, session filtered) while `github.com`
  returns 200 — a **sandbox egress allowlist**.

Running on an empty window would have produced a meaningless `n = 0` result, and
synthesising data would have burned a single-use window on fabricated input. The
window remains available for exactly one future test.

**To unblock:** allowlist `data.binance.vision`, or update the dataset repo with
2026-01…06 and pin a new commit, or upload the monthly ZIPs manually.

## 7. Instructions for the porting agent

### Port this

| Component | Source | Notes |
|---|---|---|
| Sniper entry filter | `scripts/real-data/v24-engine.ts` → `baseSniper()` | 8 conditions, all required |
| Trailing exit | `scripts/real-data/v25-trailing.ts` → `simulateTrailing()` | Includes intrabar rules R1–R5 |
| Pool-kind recovery | `scripts/real-data/corridor-entry.ts` → `extremePoolKind()` | Reproduces the engine's exact window |
| Fee model | `research/v27_rr_test.ts` → `feeR()` | Per-leg, no rebate |
| Reference runner | `research/v28_gross_only.ts` | Wires it together |

### Do not port

- V2.4's LONG asymmetry (failed validation — known overfit).
- V2.7's RR-target search (arithmetically disproven).
- The Fee Drag Guard as an active gate (removes edge with cost; measured inert).
- The confluence filter (removes ~95 % of setups; duplicates the RVOL gate).

### Preserve these invariants

1. **Never modify the frozen engine.** Verify with `git diff 4839074 -- src/`.
2. **Keep intrabar rules R1–R5 exactly.** Relaxing them inflates backtests
   without changing live results.
3. **Entry is the OPEN of bar N+1**, never the close of bar N — that would be
   look-ahead.
4. **Same-bar SL+TP resolves to SL.**
5. **HTF context must use only closed HTF bars** with
   `closeTime ≤ evaluated bar's closeTime`.
6. **Report `ex-top-1 %` beside every gross figure.** Several strategies looked
   profitable until trimmed.
7. **Never fabricate market data.** Report the blocker instead.

### Recommended first step

Reproduce the V2.8 validation result (n = 98, gross +0.0488, PF 1.1087) in the
new repository before changing anything. If the port cannot reproduce it, the
port is wrong — not the strategy.

## 8. Honest closing assessment

This programme found a **small, fragile, fee-sensitive edge**. V2.8 is the only
strategy that survived out-of-sample testing, and it does so only under a
zero-fee assumption, on 98 trades, with a result that a single trade can erase.

That is a genuine result worth preserving — and it is **not** a deployable
trading system. `PRODUCTION_READY` was forbidden throughout and remains so. The
responsible next step is more data (the untouched 2026-H1 window, once
reachable), not live capital.

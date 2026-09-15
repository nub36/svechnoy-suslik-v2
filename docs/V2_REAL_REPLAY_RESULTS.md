# V2 REAL REPLAY — RESULTS

**Status: `V2_NOT_BETTER`**

Run ID `v2-real-20260915-080338` · TEST first viewed `2026-09-15T09:55:30.412Z`

> **Headline.** On 16.68M real Binance Spot candles, **neither engine has an
> edge**. V1 TEST expectancy −0.9098R, V2 −0.8237R: V2 loses less, but both are
> heavily negative and the difference is not evidence of a working strategy.
> The dominant cause is not signal quality — it is the **fee model**, which
> charges a round-trip fee on NOTIONAL and converts it to R by dividing by stop
> distance. Median fee burden on TEST is **0.70R per trade**, mean **1.14R**.
> With the fee removed, V2's gross expectancy is **+0.05R** — indistinguishable
> from zero. The strategy is neither profitable nor catastrophic; it is
> **noise being taxed to death**.

---

## A. Dataset provenance

| item | value |
|---|---|
| repository | https://github.com/nub36/svechnoy-suslik-binance-data.git |
| dataset commit | `c3c1dcecfe2784a147f591f2b5b4526cbf99df9f` |
| original source | https://data.binance.vision/data/spot/monthly/klines/ |
| exchange / market / quote | Binance / Spot / USDT |
| symbols | BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT, DOGEUSDT |
| timeframes | 1m, 5m, 15m, 30m, 1h, 4h, 1d |
| period | 2022-01-01 .. 2025-12-31 inclusive |

## B. Dataset commit and integrity

**2016 / 2016 ZIPs present and verified** (336 per symbol, 288 per timeframe).
Every archive was opened, its CSV name checked against symbol/timeframe/month,
its schema validated, and its SHA-256 recorded in `zip-checksums.json`.

| check | result |
|---|---|
| ZIP files | 2016 (expected 2016) ✅ |
| total candles | 16,681,073 |
| duplicate openTime | **0** |
| out-of-order openTime | **0** |
| invalid OHLC | **0** |
| invalid volume | **0** |
| gaps | 31 (625 missing candles) |
| non-canonical closeTime | 30 |

### Timestamp units — the ×1000 trap is real in this dataset

The archives genuinely **mix units**. Detected per file by magnitude:

| file | raw openTime | unit | normalised UTC |
|---|---|---|---|
| `BTCUSDT-1m-2022-01` | `1640995200000` | ms (13 digits) | 2022-01-01T00:00:00Z |
| `BTCUSDT-15m-2024-06` | `1717200000000` | ms | 2024-06-01T00:00:00Z |
| `ETHUSDT-1h-2025-12` | `1764547200000000` | **µs (16 digits)** | 2025-12-01T00:00:00Z |

Every series in this dataset contains **both** eras (`units=ms+us`). Values that
match neither magnitude band raise rather than being guessed, and the three
mandated spot checks are asserted in `tests/real-data-tooling.test.ts`.

### Gaps are real, not parser artifacts

All 31 gaps trace to **two** real events:

- **2023-03-24 12:39:41.646Z** — appears **simultaneously in all 6 symbols and
  every timeframe** (80×1m, 16×5m, 5×15m, 2×30m, 1×1h). Verified in the raw CSV:
  BTCUSDT 1h jumps 12:00 → 14:00. The 30 non-canonical `closeTime` values are
  the *same* event — the interrupted candle closes early at 12:39:41.646 instead
  of its scheduled boundary. A Binance-wide halt, not a bug.
- **2023-02-14 16:38→16:40Z** — one missing SOLUSDT 1m candle.

**No gap was backfilled.** No synthetic candle exists anywhere in this run.

## C. Candle counts per series

All 6 symbols are identical in shape: 1m = 2,103,760 (SOLUSDT 2,103,759),
5m = 420,752, 15m = 140,251, 30m = 70,126, 1h = 35,063, 4h = 8,766, 1d = 1,461.
Full per-series detail in `dataset-manifest.json`.

## D. Exact split boundaries

Chronological 60/20/20 **by candle index**, per series, no shuffle, fixed before
any comparison. Identical calendar boundaries across all symbols:

| tf | TRAIN | VALIDATION | TEST |
|---|---|---|---|
| 1m | 2022-01-01 → 2024-05-26 (1,262,256) | → 2025-03-14 (420,752) | → 2025-12-31 (420,752) |
| 5m | 2022-01-01 → 2024-05-26 (252,451) | → 2025-03-14 (84,150) | → 2025-12-31 (84,151) |
| 15m | 2022-01-01 → 2024-05-26 (84,150) | → 2025-03-14 (28,050) | → 2025-12-31 (28,051) |
| 30m | 2022-01-01 → 2024-05-26 (42,075) | → 2025-03-14 (14,025) | → 2025-12-31 (14,026) |
| 1h | 2022-01-01 → 2024-05-26 (21,037) | → 2025-03-14 (7,013) | → 2025-12-31 (7,013) |
| 4h | 2022-01-01 → 2024-05-26 (5,259) | → 2025-03-14 (1,753) | → 2025-12-31 (1,754) |
| 1d | 2022-01-01 → 2024-05-25 (876) | → 2025-03-13 (292) | → 2025-12-31 (293) |

Verified non-overlapping and exhaustive across all 42 series.

## E. Hashes

| artifact | SHA-256 |
|---|---|
| settings.json | `92311c4f9a96bc2e6922fc952aacc53ae473ffb22bcb6749b11c2a0cfa0cd3f9` |
| splits.json | `a44eed9ae3ad036853f14845113e392c434081301b21647398a4a3af2ab84f0b` |
| dataset-manifest.json | `e31d739fc21d82331a45b366512c87ea9b296d2ae32f41933303ea7877cee39e` |
| zip-checksums.json | `7c36e62ec8e028daed311fa2683efccb81c0b5d73c2d9d42f065bd587af748fc` |

Settings came from `Settings.fromDefaults()` (frozen registry), **not** the
production DB.

## F. TEST_FIRST_VIEW_AT

`2026-09-15T09:55:30.412Z` — recorded automatically on the first TEST
computation, after the protocol, manifest, checksums, settings and splits all
existed and were hashed. **TEST is now USED.** Nothing was tuned afterwards.

## G/H. V1 and V2 core metrics

| slice | engine | closed | OPEN | TP | SL | TIMEOUT | tpExit% | posR% | expectancy | total R | PF | maxDD R |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| TRAIN | V1 | 659,992 | 38 | 145,879 | 463,618 | 50,495 | 22.10 | 26.18 | **−0.8212** | −542,018 | 0.391 | −542,025 |
| TRAIN | V2 | 328,872 | 22 | 43,277 | 204,660 | 80,935 | 13.16 | 25.74 | **−0.7289** | −239,721 | 0.416 | −239,721 |
| VALID | V1 | 231,999 | 40 | 53,790 | 163,931 | 14,278 | 23.19 | 26.90 | **−0.7067** | −163,957 | 0.441 | −163,957 |
| VALID | V2 | 111,565 | 26 | 15,669 | 70,271 | 25,625 | 14.04 | 26.20 | **−0.6862** | −76,558 | 0.442 | −76,558 |
| **TEST** | **V1** | 241,008 | 41 | 56,883 | 170,964 | 13,161 | 23.60 | 26.02 | **−0.9098** | −219,259 | 0.363 | −219,261 |
| **TEST** | **V2** | 112,707 | 33 | 15,646 | 71,802 | 25,259 | 13.88 | 25.74 | **−0.8237** | −92,832 | 0.390 | −92,834 |

Bars held: V1 mean 13.1 / median 8; V2 mean 19.9 / median 12.
Expectancy excluding TIMEOUT (**DIAGNOSTIC SENSITIVITY ONLY**): V1 −0.9879R,
V2 −1.1594R — both *worse*, so neither engine's result is propped up by time exits.

Results are **consistent across all three slices**, so this is not a TEST-period
accident.

### Why the losses are this large: the fee model dominates

`trackOutcome` computes `feeR = (fee_pct / 100) × entryPrice / riskPerUnit`.
The fee is charged on **notional**, then divided by **stop distance** — so the
cost in R depends on how tight the stop is as a fraction of price, and is
unbounded as stops tighten.

Measured on V2 TEST: feeR median **0.70R**, mean **1.14R**, p90 **2.51R**,
max **46.3R**. Mean R of an SL exit is **−2.34R**, not ≈−1R.

Removing the fee (diagnostic reconstruction, `gross = net + feeR`):

| tf | n | net avg R | **gross avg R** | fee per trade |
|---|---|---|---|---|
| 1m | 85,752 | −0.9816 | **+0.0643** | 1.0459 |
| 5m | 17,034 | −0.4172 | **+0.0121** | 0.4294 |
| 15m | 5,418 | −0.1823 | **+0.0379** | 0.2202 |
| 30m | 2,712 | −0.1592 | **−0.0099** | 0.1493 |
| 1h | 1,390 | −0.0978 | **−0.0011** | 0.0967 |
| 4h | 347 | +0.0370 | **+0.0845** | 0.0476 |
| 1d | 54 | −0.1189 | **−0.1026** | 0.0162 |
| **ALL** | **112,707** | **−0.8237** | **+0.0526** | **0.8762** |

Two conclusions, and they must be read together:

1. **The headline loss is overwhelmingly a cost artefact.** Net expectancy
   tracks the fee burden almost exactly, and improves monotonically with
   timeframe as the fee shrinks (1m −0.98R → 4h +0.04R).
2. **Removing the fee does not reveal an edge.** Gross expectancy is +0.05R
   overall and oscillates around zero per timeframe, with 1d actually negative.
   This is noise, not a suppressed signal. Whether the fee model is realistic is
   a separate question from whether the strategy works — and on this evidence
   **it does not work either way**.

## I. V2 TEST breakdowns

**By timeframe** — monotone in the fee burden:

| tf | n | tpExit% | posR% | avg R | median R | total R | PF |
|---|---|---|---|---|---|---|---|
| 1m | 85,752 | 13.84 | 25.20 | −0.9816 | −1.4605 | −84,176 | 0.338 |
| 5m | 17,034 | 13.96 | 27.13 | −0.4172 | −1.2031 | −7,107 | 0.584 |
| 15m | 5,418 | 14.01 | 27.96 | −0.1823 | −1.1082 | −988 | 0.779 |
| 30m | 2,712 | 13.75 | 28.13 | −0.1592 | −1.0743 | −432 | 0.795 |
| 1h | 1,390 | 14.75 | 27.99 | −0.0978 | −1.0543 | −136 | 0.867 |
| 4h | 347 | 15.27 | 29.39 | **+0.0370** | −1.0257 | +13 | 1.054 |
| 1d | 54 | 14.81 | 24.07 | −0.1189 | −1.0081 | −6 | 0.832 |

4h is the only positive cell, on **n=347** and **total +13R** — far too small and
too marginal to mean anything. It is reported, not claimed.

**By symbol:** BTCUSDT −1.36R (worst), BNBUSDT −1.06R, ETHUSDT −0.79R,
XRPUSDT −0.68R, SOLUSDT −0.55R, DOGEUSDT −0.51R. All negative, n≈18.5–19k each.

**LONG vs SHORT:** LONG n=32,757 avg −0.6189R, tpExit 8.82%; SHORT n=79,950
avg −0.9075R, tpExit 15.96%. Strongly asymmetric — V2 takes **2.4× more SHORTs**
and they perform worse.

**REVERSAL vs CONTINUATION:** CONTINUATION n=98,606 avg −0.8092R;
REVERSAL n=14,101 avg −0.9248R. Both negative.

**HTF alignment:** ALIGNED n=47,430 −0.7834R · COUNTER_TREND n=29,094 −0.8793R ·
NEUTRAL n=36,129 −0.8328R · UNKNOWN n=54 −0.1189R. Alignment helps slightly but
does not rescue anything.

**HTF coverage (evaluations):** ALIGNED 34.0%, COUNTER_TREND 30.2%,
NEUTRAL 32.1%, **UNKNOWN 3.7%** — low UNKNOWN confirms HTF history was
genuinely available; context was not faked.

## J. Evidence association (NOT calibration)

| bucket | n | avg R | median R | posR% | tpExit% | timeout% |
|---|---|---|---|---|---|---|
| 0.45–0.50 | 20,225 | −1.0034 | −1.5061 | 22.57 | 15.69 | — |
| 0.50–0.60 | 38,536 | −0.9934 | −1.4837 | 23.40 | 15.42 | — |
| 0.60–0.70 | 24,361 | −0.8606 | −1.3611 | 25.55 | 14.70 | — |
| 0.70–0.80 | 16,186 | −0.5532 | −1.0778 | 29.47 | 11.70 | — |
| 0.80–1.00 | 13,399 | **−0.3236** | −0.3209 | **33.11** | 7.90 | — |

**Spearman(evidence, realised R) = +0.2131** on n=112,707.

This is the most encouraging result in the run: evidence is **monotonically
associated** with outcome across all five pre-registered buckets, and the top
bucket loses a third as much as the bottom one. Evidence is **not** a
probability and no calibration was performed. But the ordering is real, and it
survives on unseen data — that is a genuine, if narrow, positive signal about
the evidence model, even though every bucket still loses money.

## K. Target / risk diagnostics (TEST)

| distribution | min | p25 | median | p75 | p90 | p95 | max |
|---|---|---|---|---|---|---|---|
| TP1 R | 1.0 | 1.054 | 1.428 | 2.200 | 3.536 | 4.765 | 54.96 |
| final target R | 1.500 | 3.0 | 3.139 | 5.290 | 8.431 | 11.37 | 88.02 |
| risk distance (ATR) | 0.25 | 1.125 | 1.619 | 2.634 | 7.150 | 14.50 | 88.39 |

Final target share: **>5R 27.4%**, **>10R 6.9%**, **>20R 0.96%**.

Trades flagged for inspection (**not corrected**): final target >10R → **38,408**;
risk distance <0.5 ATR → **16,795**. Lists in `target-diagnostics.json`.

**Timeout rate by final-target bucket** shows the ladder problem clearly:

| final target | n | timeout% | avg R |
|---|---|---|---|
| <2R | 3,313 | 14.04 | −0.5338 |
| 2–5R | 78,542 | 27.63 | −0.5728 |
| 5–10R | 23,114 | 10.68 | −1.2058 |
| 10–20R | 6,652 | 8.19 | −2.0259 |
| >20R | 1,086 | 7.64 | **−4.3512** |

Distant targets do not time out more — they get **stopped out** on the way, and
average R degrades monotonically with target distance. The p90 risk distance of
7.15 ATR (max 88) also indicates the structural stop is sometimes placed
absurdly far away. Both are recorded for a future cycle; **neither was touched
here.**

## L. TIMEOUT sensitivity (TEST)

| engine | TIMEOUT n | positive | negative | avg R | median R | total R | exp (all) | exp (ex-TIMEOUT) | sign flips |
|---|---|---|---|---|---|---|---|---|---|
| V1 | 13,161 | 8,926 | 4,235 | +0.4432 | +0.4586 | +5,833 | −0.9098 | −0.9879 | no |
| V2 | 25,259 | 13,622 | 11,637 | +0.3388 | +0.0564 | +8,559 | −0.8237 | −1.1594 | no |

TIMEOUT exits are *mildly positive* for both engines, so excluding them makes
results **worse**. No sign flip. The edge is not TIMEOUT-dependent — there is no
edge to be dependent.

## M. Outlier sensitivity (TEST)

| engine | as measured | ex top 1 | ex top 5 | ex top 1% | top 1% share of gross positive R |
|---|---|---|---|---|---|
| V1 | −0.9098R | −0.9098R | −0.9098R | −0.9484R (−2,411) | 5.64% |
| V2 | −0.8237R | −0.8241R | −0.8250R | −0.9177R (−1,128) | 16.12% |

Removing the best trades makes both engines worse. The result is **not** carried
by a few extreme winners — it is a broad, consistent loss.

## N. WAIT analysis (TEST)

1,201,228 evaluations → LONG 254,750 · SHORT 195,290 · **WAIT 751,188 (62.5%)**.

| decisive reason | count |
|---|---|
| insufficient evidence | 452,937 |
| no valid target | 162,922 |
| insufficient net evidence | 91,627 |
| no liquidity event | 43,702 |
| insufficient room-to-target | 0 |
| no structural stop | 0 |
| invalid/stale range | 0 |
| other | 0 |

Three categories are **exactly zero**. That is a reporting artifact worth noting:
the classifier keys on the engine's *last* WAIT reason, and those conditions are
evaluated earlier in the ladder, so they are always overwritten. Diagnostic only;
no threshold was changed.

## O. V1 score normalization — the 25/25=100 hypothesis

**The hypothesis is CONFIRMED on real data.**

availableWeight distribution: min 18, p25 30, median 45, p75 60, max 100.
Normalized score: min 55.0, median 73.8, p90 94, max 100.

Cross-tab (TEST, closed trades):

| availableWeight | score | n | avg R | median R | posR% | tpExit% | PF |
|---|---|---|---|---|---|---|---|
| <30 | <70 | 9,039 | −0.9911 | −1.5259 | 26.31 | 24.43 | 0.338 |
| <30 | 70–90 | 23,244 | −0.9889 | −1.4702 | 25.89 | 23.73 | 0.339 |
| **<30** | **90–100** | **23,174** | **−0.8940** | −1.4194 | 25.90 | 23.36 | 0.370 |
| 30–50 | <70 | 29,911 | −0.9364 | −1.5152 | 26.32 | 24.26 | 0.353 |
| 30–50 | 70–90 | 53,073 | −1.0260 | −1.4780 | 25.79 | 24.02 | 0.327 |
| 30–50 | 90–100 | 8,787 | −1.4012 | −1.5008 | 23.41 | 22.76 | 0.237 |
| >50 | <70 | 47,544 | −0.8212 | −1.4624 | 26.12 | 23.42 | 0.391 |
| >50 | 70–90 | 44,602 | −0.7319 | −1.2821 | 26.42 | 23.01 | 0.428 |
| **>50** | **90–100** | **1,634** | **−0.0824** | −1.0446 | **30.17** | 20.99 | **0.893** |

The decisive comparison: a 90–100 score means something **completely different**
depending on how much weight was available.

- **score 90–100 with availableWeight <30: n=23,174, avg −0.8940R, PF 0.370**
- **score 90–100 with availableWeight >50: n=1,634, avg −0.0824R, PF 0.893**

A "high-confidence" V1 signal backed by little evidence is **~11× worse in avg R**
than one backed by substantial evidence — and the low-weight variant is
**14× more common**. Normalising by `availableWeight` lets 25/25 print as 100 and
be treated identically to 90/100.

Consistent with this, `Spearman(normalized score, R) = +0.0294` is nearly zero
while `Spearman(availableWeight, R) = +0.0801` is almost 3× stronger: **raw
evidence mass predicts outcome better than V1's headline score.**

**V1 was not modified.** This is diagnostic only.

## P. Correctness / invariant results

**Liquidity lifecycle invariant: `INVARIANT_HELD`.**

A SWEPT or CONSUMED pool was never used as a future target: **0 violations**
across **357,467 evaluations** and **1,010,661 targets** (790,023 liquidity-sourced).
Pool census: FRESH 3,537,213 · TOUCHED 37,001 · SWEPT 848,751 · CONSUMED 8,326,920.

### A correctness bug WAS found — in the audit, not the strategy

The first audit reported **312,866 violations**. That was **my measurement code,
not V2**. Two defects:

1. **Wrong window.** `evaluateV2` builds pools from `visible.slice(-lookback)`
   (300 bars); the audit re-derived them over the full 360-bar evaluation slice,
   producing a different pool set and comparing incomparable objects.
2. **Wrong scope.** It flagged any target merely *near* a taken pool. Only
   `INTERNAL_LIQUIDITY` rungs are pool-sourced; `EQUILIBRIUM` (range mid),
   `RANGE_EDGE` (far boundary) and `R_MULTIPLE` are geometric levels. Those three
   bases accounted for **245,783** of the flags.

The corrected audit reproduces the engine's exact window and checks only
pool-sourced rungs. `buildTargets` does apply `if (p.resting === false) continue`,
and `tests/real-data-tooling.test.ts` now asserts directly — for both LONG and
SHORT — that swept/consumed pools are excluded and resting ones admitted, so the
audit can actually fail if the filter ever regresses.

**This bug was in research tooling, not in trading logic or in any measured
quantity.** No trade, R value or metric depends on it. The run is therefore
**not** invalidated. Had it been a strategy defect, the status would have been
`INVALIDATED_BY_CORRECTNESS_BUG`.

## Q. Statistical caution

- V2 is **not** declared better. It loses less than V1 (−0.8237R vs −0.9098R) but
  both are deeply negative; "less bad" is not an edge.
- V2's advantage is partly **selectivity, not skill**: it takes 112,707 trades
  where V1 takes 241,008, and holds longer (median 12 vs 8 bars).
- V2's tpExitRate (13.88%) is **worse** than V1's (23.60%). Its targets are hit
  less often; it survives on fewer, smaller losses.
- Consistency is high across symbols, timeframes and all three slices — this is a
  stable negative result, not sampling noise.
- The single positive cell (4h, +0.037R, n=347, +13R total) is too small to
  support any claim.

## R. Commits

| item | commit |
|---|---|
| frozen V2 strategy | `48390748ff1ed1f08b104206c3430142059d7430` (`4839074`) |
| research tooling | see `git log` for this document's commit |
| dataset | `c3c1dcecfe2784a147f591f2b5b4526cbf99df9f` (`c3c1dce`) |

`git diff 4839074 -- src/` is **empty**: all trading logic is byte-identical to
the freeze. Verified individually for `src/strategy/v2`,
`src/strategy/state-machine.ts`, `src/outcome/tracker.ts`, `src/replay`,
`src/strategy` and `src/core/settings.ts`.

Gates: typecheck **pass** · vitest **933 passed / 31 skipped** · build **pass**.
Safety: `v2.enabled=false` · V2 absent from `src/workers/` ·
`LIVE_TRADING_ENABLED=false` · FORWARD_TEST history untouched.

## S. Final status

# `V2_NOT_BETTER`

V2 does not beat V1 in any way that supports activation. Both engines are
strongly negative on unseen real data, across every symbol and timeframe, in all
three slices, and the result is robust to removing outliers and to excluding
TIMEOUT exits.

Two findings are worth carrying forward, and neither was acted on here:

1. **The fee model is the dominant term** and should be examined before any
   further strategy work — it currently makes sub-hourly trading arithmetically
   impossible (median 0.70R, mean 1.14R per trade). But note that removing it
   entirely still leaves expectancy at ≈0.00R, so this is a *precondition* for
   an edge, not a hidden edge.
2. **The evidence model shows real monotone association** with outcome
   (Spearman +0.21, clean ordering across all five pre-registered buckets), and
   **V1's normalisation is measurably harmful** (90–100 score at low
   availableWeight: −0.894R vs −0.082R at high weight).

`PRODUCTION_READY` is forbidden and would be indefensible here.

**No parameters were tuned. No strategy code was changed. V2 remains disabled
and research-only.**

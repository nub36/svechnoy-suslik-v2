# READ-ONLY AUDIT — real Binance experiment

**Nothing was re-run, re-tuned, or modified.** No strategy engine was invoked; no
candle was replayed. Every number below is derived arithmetically from the trade
artifacts already saved by run `v2-real-20260915-080338`.

| pinned identifier | value | verified |
|---|---|---|
| frozen V2 strategy | `4839074` | `git diff 4839074 -- src/` is **empty** |
| pre-registration | `6e2d080` | in history |
| results | `9970ae0` | = HEAD |
| dataset | `c3c1dce` | recorded in run-metadata |
| TEST_FIRST_VIEW_AT | `2026-09-15T09:55:30.412Z` | recorded in run-metadata |
| run ID | `v2-real-20260915-080338` | |
| settings SHA-256 | `92311c4f9a96bc2e6922fc952aacc53ae473ffb22bcb6749b11c2a0cfa0cd3f9` | **recomputed, matches** |
| dataset manifest SHA-256 | `e31d739fc21d82331a45b366512c87ea9b296d2ae32f41933303ea7877cee39e` | **recomputed from file bytes, matches** |
| zip-checksums SHA-256 | `7c36e62ec8e028daed311fa2683efccb81c0b5d73c2d9d42f065bd587af748fc` | recomputed |

### One discrepancy found, and it is benign

`dataset-manifest.sha256` (written by `run-ingest.ts`) contains
`e09efb25...c10c9`, which does **not** match the file. That sidecar hashed the
in-memory object via `JSON.stringify(manifestDoc)` (compact, no indent) while
the file was written with `indent=2`; the protocol and `run-metadata.json`
instead hash the **file bytes**, giving `e31d739f...ee39e`. I recomputed
`sha256(file bytes)` and it reproduces `e31d739f...` exactly, so the manifest
is **unmodified**. Two hashing conventions, one file — a cosmetic defect in the
sidecar, not tampering. Not fixed, per instructions.

### Artifact non-modification

| file | mtime (UTC) | vs TEST_FIRST_VIEW_AT 09:55:30 |
|---|---|---|
| `v1-trades.jsonl` | 2026-09-15 09:00:16 | **before** |
| `v2-trades.jsonl` | 2026-09-15 09:00:16 | **before** |
| `settings.json` | 2026-09-15 08:17:00 | before |
| `splits.json` | 2026-09-15 08:17:00 | before |
| `dataset-manifest.json` | 2026-09-15 08:04:45 | before |

Both raw trade files predate the first TEST view by ~55 minutes and are
byte-identical to their committed state (`git status` clean for all tracked
artifacts). They were **not** regenerated for this audit.

---

## §1. FEE MODEL

### Values actually used (from the frozen `settings.json` snapshot)

| setting | value |
|---|---|
| `outcome.fee_pct` | **0.1** |
| `risk.min_rr` | 1 |
| `outcome.timeout_bars` | 48 |
| `outcome.sl_priority_on_ambiguous_bar` | true |

### Unit: 0.1 means 0.1 %, NOT 10 % — proved by code

Registry (`src/core/settings.ts:851`):

```ts
key: 'outcome.fee_pct', label: 'Round-trip fee %',
description: 'Simulated taker fee applied to PnL (entry + exit).', default: 0.1
```

`src/outcome/tracker.ts:162-163`:

```ts
const grossPct = pnlPct(direction, entryPrice, exitPrice);
const netPct   = grossPct - feePct;           // round-trip fee
```

`pnlPct` returns `(move / entry) * 100`, i.e. a **percentage number** (5 means
5 %). `feePct` is subtracted directly from that quantity, so it must be in the
same unit: **percent**. Therefore `0.1` = **0.1 % = 10 bps**. If it meant 10 %,
the subtraction would be dimensionally wrong by 100x.

### The exact transaction-cost formula

`src/outcome/tracker.ts:168`:

```ts
const feeR = riskPerUnit > 0 ? (feePct / 100) * entryPrice / riskPerUnit : 0;
rMultiple  = round(grossR - feeR, 6);
```

with `riskPerUnit = |entryPrice - stopLoss|`.

| question | answer |
|---|---|
| fee charged on entry? | Not separately — one lump sum |
| fee charged on exit? | Not separately — one lump sum |
| round trip? | **Yes**, `0.1 %` is the combined entry+exit charge |
| same for TP / SL / TIMEOUT? | **Yes** — `finish()` is the single exit path for all three |
| does it use exitPrice / actual notional? | **No** — cost is `fee% x entryPrice` only |
| applied anywhere else? | **No** — `fee_pct` appears only in `tracker.ts` |

### Does it match real Binance Spot semantics?

**Approximately, and it is conservative in one way and wrong in another.**

Real Binance Spot charges a fee on **each** side, against that side's own
notional: `fee = rate x (entryQty x entryPrice) + rate x (exitQty x exitPrice)`.
Spot taker is 0.1 % **per side** (0.2 % round trip at VIP0 without BNB discount);
maker is 0.1 %, and BNB payment or VIP tiers reduce both.

The model instead charges `0.1 %` **once**, against the **entry** notional only.

1. **Magnitude.** At 0.1 % round trip the model is roughly **half** the VIP0
   taker cost of 0.2 %. So the run is, if anything, *optimistic* on fee level.
2. **Base.** Ignoring `exitPrice` means a winning trade is under-charged and a
   losing trade over-charged, since the exit notional differs from entry. For
   the stop distances here (median 0.18 %) that error is second-order — well
   under a basis point — and is negligible next to point 1.

So the formula is a reasonable, slightly optimistic first-order approximation.
It is **not** the source of the negative result: §6 shows even 0 bps yields
~+0.05R.
## §2. REAL TRADE FEE EXAMPLES (V2 TEST, one per timeframe)

| tf | symbol | dir | entry | exit | SL | riskPerUnit | risk% | fee_pct | gross R | fee R | net R | exit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1m | BTCUSDT | SHORT | 84663.28 | 84285.14 | 84753.37131826192 | 90.0913 | 0.1064% | 0.1 | 4.1973 | 0.9397 | 3.2575 | TP |
| 5m | BTCUSDT | SHORT | 83783.01 | 84240.00242843313 | 84240.00242843313 | 456.9924 | 0.5454% | 0.1 | -1.0000 | 0.1833 | -1.1833 | SL |
| 15m | BTCUSDT | SHORT | 84057.01 | 83822.6 | 84988.3646099363 | 931.3546 | 1.1080% | 0.1 | 0.2517 | 0.0903 | 0.1614 | TIMEOUT |
| 30m | BTCUSDT | LONG | 84136.53 | 83657.9844579199 | 83657.9844579199 | 478.5455 | 0.5688% | 0.1 | -1.0000 | 0.1758 | -1.1758 | SL |
| 1h | BTCUSDT | SHORT | 83891.37 | 84791.4690888428 | 84791.4690888428 | 900.0991 | 1.0729% | 0.1 | -1.0000 | 0.0932 | -1.0932 | SL |
| 4h | BTCUSDT | SHORT | 82410.01 | 83916.17776738467 | 83916.17776738467 | 1506.1678 | 1.8277% | 0.1 | -1.0000 | 0.0547 | -1.0547 | SL |
| 1d | BTCUSDT | SHORT | 79163.24 | 90195.98611624695 | 90195.98611624695 | 11032.7461 | 13.9367% | 0.1 | -1.0000 | 0.0072 | -1.0072 | SL |

## §3. STOP GEOMETRY — riskPercent = |entry-SL|/entry*100 (V2 TEST)

| scope | n | min | p10 | p25 | median | p75 | p90 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|---|---|---|
| ALL | 112,707 | 0.0022 | 0.0517 | 0.0932 | 0.1847 | 0.4299 | 1.1601 | 2.0139 | 5.6825 | 104.8526 |
| 1m | 85,752 | 0.0022 | 0.0449 | 0.0784 | 0.1441 | 0.2838 | 0.7180 | 1.3588 | 2.9859 | 35.4634 |
| 5m | 17,034 | 0.0104 | 0.1106 | 0.1883 | 0.3358 | 0.6492 | 1.6623 | 3.1999 | 6.7460 | 104.8526 |
| 15m | 5,418 | 0.0326 | 0.2179 | 0.3600 | 0.6414 | 1.2027 | 3.0975 | 6.1571 | 11.9764 | 42.8664 |
| 30m | 2,712 | 0.0336 | 0.3197 | 0.5302 | 0.9309 | 1.7140 | 4.1064 | 8.6126 | 16.5806 | 45.9351 |
| 1h | 1,390 | 0.0832 | 0.4991 | 0.8123 | 1.3476 | 2.3865 | 5.9529 | 11.4306 | 21.6868 | 38.5718 |
| 4h | 347 | 0.2686 | 0.9884 | 1.7997 | 2.9357 | 4.7254 | 13.0091 | 23.1748 | 37.8755 | 48.2745 |
| 1d | 54 | 1.3658 | 2.7211 | 4.7550 | 9.0552 | 13.9367 | 32.1056 | 45.0199 | 61.4429 | 85.0030 |

| scope | <0.05% | <0.10% | <0.20% | <0.50% | <1.00% |
|---|---|---|---|---|---|
| ALL | 9.43% | 27.31% | 52.83% | 78.01% | 88.35% |
| 1m | 12.09% | 34.21% | 63.37% | 85.99% | 92.77% |
| 5m | 1.54% | 7.97% | 27.29% | 66.51% | 84.09% |
| 15m | 0.07% | 1.61% | 8.53% | 38.52% | 69.32% |
| 30m | 0.07% | 0.18% | 3.21% | 23.08% | 53.06% |
| 1h | 0.00% | 0.07% | 0.50% | 10.14% | 33.88% |
| 4h | 0.00% | 0.00% | 0.00% | 1.73% | 10.66% |
| 1d | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |

## §4. GROSS VS NET per slice

| slice | engine | n | gross exp | fee drag | net exp | gross totalR | net totalR | gross PF | net PF |
|---|---|---|---|---|---|---|---|---|---|
| train | V1 | 659,992 | 0.0333 | 0.8545 | -0.8212 | 21956.55 | -542018.10 | 1.0471 | 0.3905 |
| train | V2 | 328,872 | 0.0350 | 0.7639 | -0.7289 | 11505.15 | -239721.25 | 1.0539 | 0.4160 |
| validation | V1 | 231,999 | 0.0492 | 0.7560 | -0.7067 | 11423.32 | -163957.08 | 1.0694 | 0.4413 |
| validation | V2 | 111,565 | 0.0472 | 0.7335 | -0.6862 | 5270.87 | -76558.08 | 1.0723 | 0.4416 |
| test | V1 | 241,008 | 0.0509 | 0.9606 | -0.9098 | 12256.95 | -219258.65 | 1.0714 | 0.3625 |
| test | V2 | 112,707 | 0.0526 | 0.8762 | -0.8237 | 5923.83 | -92831.66 | 1.0797 | 0.3900 |

## §5. GROSS VS NET BY TIMEFRAME (TEST)

| tf | engine | n | gross exp | fee drag | net exp | gross PF | net PF |
|---|---|---|---|---|---|---|---|
| 1m | V1 | 188,530 | 0.0614 | 1.1476 | -1.0862 | 1.0860 | 0.3079 |
| 1m | V2 | 85,752 | 0.0643 | 1.0459 | -0.9816 | 1.0976 | 0.3383 |
| 5m | V1 | 33,215 | 0.0238 | 0.3713 | -0.3476 | 1.0337 | 0.6434 |
| 5m | V2 | 17,034 | 0.0121 | 0.4294 | -0.4172 | 1.0183 | 0.5842 |
| 15m | V1 | 10,609 | -0.0013 | 0.1825 | -0.1838 | 0.9982 | 0.7804 |
| 15m | V2 | 5,418 | 0.0379 | 0.2202 | -0.1823 | 1.0580 | 0.7794 |
| 30m | V1 | 5,278 | 0.0083 | 0.1224 | -0.1142 | 1.0118 | 0.8561 |
| 30m | V2 | 2,712 | -0.0099 | 0.1493 | -0.1592 | 0.9850 | 0.7950 |
| 1h | V1 | 2,666 | -0.0570 | 0.0818 | -0.1388 | 0.9211 | 0.8227 |
| 1h | V2 | 1,390 | -0.0011 | 0.0967 | -0.0978 | 0.9984 | 0.8671 |
| 4h | V1 | 618 | 0.0151 | 0.0371 | -0.0221 | 1.0213 | 0.9700 |
| 4h | V2 | 347 | 0.0845 | 0.0476 | 0.0370 | 1.1295 | 1.0537 |
| 1d | V1 | 92 | 0.0035 | 0.0138 | -0.0103 | 1.0048 | 0.9860 |
| 1d | V2 | 54 | -0.1026 | 0.0162 | -0.1189 | 0.8518 | 0.8316 |

## §6. ANALYTIC FEE SENSITIVITY (TEST)

Formula. A round-trip cost of `B` bps on notional converts to R per trade as:

```
feeR_i(B) = (B / 10000) * entryPrice_i / riskPerUnit_i
netR_i(B) = grossR_i - feeR_i(B)
expectancy(B) = mean_i(grossR_i) - (B/10000) * mean_i(entryPrice_i / riskPerUnit_i)
```

The frozen setting `outcome.fee_pct = 0.1` (%) equals **10 bps**.

| round-trip | V1 expectancy | V2 expectancy |
|---|---|---|
| 0 bps | 0.0509 | 0.0526 |
| 2 bps | -0.1413 | -0.1227 |
| 5 bps | -0.4294 | -0.3855 |
| 10 bps | -0.9098 | -0.8237 |
| 20 bps | -1.8704 | -1.6999 |

V2 by timeframe:

| tf | n | 0 bps | 2 bps | 5 bps | 10 bps | 20 bps |
|---|---|---|---|---|---|---|
| 1m | 85,752 | 0.0643 | -0.1449 | -0.4586 | -0.9816 | -2.0276 |
| 5m | 17,034 | 0.0121 | -0.0737 | -0.2026 | -0.4172 | -0.8466 |
| 15m | 5,418 | 0.0379 | -0.0061 | -0.0722 | -0.1823 | -0.4025 |
| 30m | 2,712 | -0.0099 | -0.0398 | -0.0846 | -0.1592 | -0.3086 |
| 1h | 1,390 | -0.0011 | -0.0204 | -0.0494 | -0.0978 | -0.1944 |
| 4h | 347 | 0.0845 | 0.0750 | 0.0607 | 0.0370 | -0.0106 |
| 1d | 54 | -0.1026 | -0.1059 | -0.1107 | -0.1189 | -0.1351 |

## §7. GROSS EDGE ROBUSTNESS (TEST)

V1 gross expectancy: **0.0509** (n=241,008)
V2 gross expectancy: **0.0526** (n=112,707)

**V2 by direction**

| group | n | gross exp | net exp | gross PF | gross posR% |
|---|---|---|---|---|---|
| LONG | 32,757 | 0.0335 | -0.6189 | 1.0633 | 33.54 |
| SHORT | 79,950 | 0.0604 | -0.9075 | 1.0847 | 26.67 |

**V2 by setup kind**

| group | n | gross exp | net exp | gross PF | gross posR% |
|---|---|---|---|---|---|
| CONTINUATION | 98,606 | 0.0538 | -0.8092 | 1.0833 | 29.39 |
| REVERSAL | 14,101 | 0.0442 | -0.9248 | 1.0584 | 23.59 |

**V2 by symbol**

| group | n | gross exp | net exp | gross PF | gross posR% |
|---|---|---|---|---|---|
| BTCUSDT | 18,919 | 0.1074 | -1.3582 | 1.1636 | 28.64 |
| ETHUSDT | 19,091 | 0.0247 | -0.7883 | 1.0367 | 27.40 |
| BNBUSDT | 18,523 | 0.0539 | -1.0584 | 1.0823 | 29.02 |
| SOLUSDT | 18,610 | 0.0407 | -0.5464 | 1.0624 | 29.29 |
| XRPUSDT | 18,996 | 0.0348 | -0.6754 | 1.0524 | 28.54 |
| DOGEUSDT | 18,568 | 0.0540 | -0.5107 | 1.0825 | 29.16 |

**V2 by timeframe**

| group | n | gross exp | net exp | gross PF | gross posR% |
|---|---|---|---|---|---|
| 1m | 85,752 | 0.0643 | -0.9816 | 1.0976 | 28.74 |
| 5m | 17,034 | 0.0121 | -0.4172 | 1.0183 | 28.38 |
| 15m | 5,418 | 0.0379 | -0.1823 | 1.0580 | 28.61 |
| 30m | 2,712 | -0.0099 | -0.1592 | 0.9850 | 28.58 |
| 1h | 1,390 | -0.0011 | -0.0978 | 0.9984 | 28.20 |
| 4h | 347 | 0.0845 | 0.0370 | 1.1295 | 29.68 |
| 1d | 54 | -0.1026 | -0.1189 | 0.8518 | 24.07 |

## §8. V2 EVIDENCE BUCKETS (TEST) — association only, NOT probability

| bucket | n | gross exp | net exp | median gross R | median net R | gross posR% | net posR% |
|---|---|---|---|---|---|---|---|
| 0.45-0.50 | 20,225 | 0.0786 | -1.0034 | -1.0000 | -1.5061 | 24.43 | 22.57 |
| 0.50-0.60 | 38,536 | 0.0607 | -0.9934 | -1.0000 | -1.4837 | 25.53 | 23.40 |
| 0.60-0.70 | 24,361 | 0.0663 | -0.8606 | -1.0000 | -1.3611 | 28.45 | 25.55 |
| 0.70-0.80 | 16,186 | 0.0279 | -0.5532 | -1.0000 | -1.0777 | 33.76 | 29.47 |
| 0.80-1.00 | 13,399 | -0.0056 | -0.3236 | -0.2106 | -0.3209 | 38.35 | 33.11 |

Spearman(evidence, GROSS R) = **0.1333**  (n=112,707)
Spearman(evidence, NET R)   = **0.2131**

## §9. V1 SCORE NORMALIZATION MATRIX (TEST)

| availableWeight | score | n | gross avg R | net avg R | gross med R | net med R | posR% | TP exit% | gross PF | net PF |
|---|---|---|---|---|---|---|---|---|---|---|
| <30 | <70 | 9,039 | 0.0769 | -0.9911 | -1.0000 | -1.5259 | 28.61 | 24.43 | 1.1085 | 0.3382 |
| <30 | 70-90 | 23,244 | 0.0544 | -0.9889 | -1.0000 | -1.4701 | 28.27 | 23.73 | 1.0763 | 0.3392 |
| <30 | 90-100 | 23,174 | 0.0426 | -0.8940 | -1.0000 | -1.4194 | 27.95 | 23.36 | 1.0595 | 0.3695 |
| 30-50 | <70 | 29,911 | 0.0662 | -0.9364 | -1.0000 | -1.5152 | 28.41 | 24.26 | 1.0931 | 0.3530 |
| 30-50 | 70-90 | 53,073 | 0.0689 | -1.0260 | -1.0000 | -1.4780 | 28.64 | 24.02 | 1.0972 | 0.3270 |
| 30-50 | 90-100 | 8,787 | 0.0291 | -1.4012 | -1.0000 | -1.5008 | 27.84 | 22.76 | 1.0407 | 0.2365 |
| >50 | <70 | 47,544 | 0.0341 | -0.8212 | -1.0000 | -1.4624 | 27.59 | 23.42 | 1.0474 | 0.3906 |
| >50 | 70-90 | 44,602 | 0.0384 | -0.7319 | -1.0000 | -1.2820 | 28.28 | 23.01 | 1.0541 | 0.4283 |
| >50 | 90-100 | 1,634 | 0.0517 | -0.0824 | -1.0000 | -1.0445 | 30.66 | 20.99 | 1.0765 | 0.8928 |

**Head-to-head (the 25/25=100 test), on GROSS R:**

- score 90-100 AND availableWeight <30 : n=23,174, gross exp **0.0426**, gross PF 1.0595
- score 90-100 AND availableWeight >50 : n=1,634, gross exp **0.0517**, gross PF 1.0765

Spearman(normalized score, GROSS R) = **-0.0004**  (n=241,008)
Spearman(raw score, GROSS R)        = **-0.0013**  (n=241,008)
Spearman(availableWeight, GROSS R)  = **-0.0008**

## §10. TIMEOUT GROSS/NET (V2 TEST)

| set | n | gross avg R | net avg R | gross total R | net total R |
|---|---|---|---|---|---|
| TIMEOUT only | 25,259 | 0.6927 | 0.3388 | 17497.81 | 8558.94 |
| all CLOSED | 112,707 | 0.0526 | -0.8237 | 5923.83 | -92831.66 |
| excluding TIMEOUT | 87,448 | -0.1324 | -1.1594 | -11573.98 | -101390.61 |

## §11. OUTLIER SENSITIVITY on GROSS R (TEST)

| engine | n | gross totalR | gross exp | ex top1 exp | ex top5 exp | ex top1% exp | top1% share of gross positive |
|---|---|---|---|---|---|---|---|
| V1 | 241,008 | 12256.95 | 0.0509 | 0.0508 | 0.0508 | 0.0211 (−2,411) | 3.93% |
| V2 | 112,707 | 5923.83 | 0.0526 | 0.0520 | 0.0508 | -0.0550 (−1,128) | 15.03% |

---

## §8b. Why the evidence association shrinks on GROSS R

The net-R correlations are inflated by **fee geometry**, not by predictive skill:

| relationship (V2 TEST, n=112,707) | Spearman |
|---|---|
| evidence vs **riskPercent** (stop width) | **+0.3437** |
| evidence vs **feeR** | **−0.3437** |
| evidence vs **GROSS R** | **+0.1333** |
| evidence vs NET R | +0.2131 |

High-evidence setups systematically carry **wider stops**, so they are charged a
smaller fee in R units. That mechanical relationship inflates the net-R
association. Roughly **37 %** of the headline +0.2131 is fee geometry rather than
outcome prediction. A real but weaker association (+0.1333) survives on gross R.

## §9b. The V1 25/25=100 effect on GROSS R

| relationship (V1 TEST, n=241,008) | vs NET R | vs GROSS R |
|---|---|---|
| normalized score | +0.0294 | **−0.0004** |
| raw score | — | **−0.0013** |
| availableWeight | +0.0801 | **−0.0008** |
| availableWeight vs feeR | — | −0.1361 |

On gross R **all three collapse to zero**. V1's apparent "availableWeight
predicts outcome" finding was **entirely** a fee artifact: higher availableWeight
correlates with wider stops (feeR ρ=−0.136), and wider stops pay less fee.

The head-to-head narrows correspondingly:

| cell | n | net exp | **gross exp** |
|---|---|---|---|
| score 90–100, availableWeight <30 | 23,174 | −0.8940 | **+0.0426** |
| score 90–100, availableWeight >50 | 1,634 | −0.0824 | **+0.0517** |

An ~11x net gap becomes a ~1.2x gross gap on a 14x-smaller sample. **The
25/25=100 normalization concern is NOT confirmed as an edge-destroying defect on
gross outcomes.** It remains true that V1's normalized score carries no
predictive information at all (ρ ≈ 0.000) — but neither does raw score or
availableWeight. The problem is not that normalization loses evidence mass; it
is that **none of V1's score components predict anything.**

This corrects the stronger claim made in `docs/V2_REAL_REPLAY_RESULTS.md` §O,
which was computed on net R only.

---

## §13. ANSWERS

**A. Is the fee model technically correct?**
Internally consistent and dimensionally sound: `0.1` is unambiguously 0.1 %
(10 bps), applied once as a round trip, identically for TP/SL/TIMEOUT. One
simplification: it charges `fee% x entryPrice` and ignores `exitPrice`, so the
exit leg is priced at entry notional. For these stop distances that error is
sub-basis-point. Not a bug in any measured quantity.

**B. Does it match real Binance Spot commission?**
Partially. Binance Spot is ~0.1 % **per side** (≈0.2 % round trip, VIP0, no BNB
discount). The model charges 0.1 % **total**, i.e. roughly **half** the realistic
taker cost, and against entry notional only. The run is therefore *optimistic*
on fees, not pessimistic.

**C. V2 TEST gross expectancy:** **+0.0526 R** (n=112,707), gross PF 1.0797.

**D. V2 TEST net expectancy at the frozen setting:** **−0.8237 R**, net PF 0.3900.

**E. Is there a stable gross edge across symbols/timeframes?**
**No.** The gross edge is uniformly tiny and not robust:
- All 6 symbols positive but in a narrow, near-zero band (+0.025 to +0.107 R;
  PF 1.04–1.16).
- Timeframes are **not** consistent: 30m (−0.0099), 1h (−0.0011) and 1d
  (−0.1026) are **negative**; 4h is the best (+0.0845) on only n=347.
- **Decisive:** removing the top 1 % of winners flips V2's gross expectancy from
  **+0.0526 to −0.0550**, and 15.03 % of all gross positive R comes from that
  1 %. V1 stays positive (+0.0211) but its top 1 % is only 3.93 % of gross
  positive R.

So V2's gross "edge" is a thin positive average produced by a small tail of
large winners on top of a slightly negative body — not a stable edge.

**F. How much of the negative result is transaction costs?**
Essentially all of it. V2 TEST: gross +0.0526 → net −0.8237; the fee drag is
**0.8762 R per trade** (§4). Net expectancy tracks fee drag almost exactly
across every timeframe. But this does **not** mean a profitable strategy is
hiding underneath: at 0 bps expectancy is ~+0.05R and turns negative once the
top 1 % is removed.

**G. Are structural stops too narrow relative to costs?**
**Yes, decisively, on low timeframes.** V2 TEST median stop is **0.1847 %** of
price; **52.83 %** of all trades have a stop under 0.20 %, and **27.31 %** under
0.10 %. On 1m the median is 0.1441 % and **34.21 %** of trades sit under 0.10 %.
A 0.10 % round-trip fee against a 0.10 % stop is a full **1.0 R** of cost before
the market moves. The `<0.05 %` bucket (12.09 % of 1m trades) implies ≥2 R of
fees. Sub-hourly trading is arithmetically impossible at this cost/stop ratio.

**H. Does the evidence association survive removing the fee effect?**
**Partially.** Spearman falls from **+0.2131 (net)** to **+0.1333 (gross)** —
about 37 % of it was fee geometry (evidence vs stop width ρ=+0.34). A weaker
association does survive. But bucket gross expectancy is **not** monotone: 0.45–0.50
is +0.0786 while the top bucket 0.80–1.00 is **−0.0056**, i.e. the *highest*
evidence bucket has the *worst* gross expectancy. What rises monotonically with
evidence is the gross positive-rate (24.43 % → 38.35 %): high evidence wins more
often but earns less per win. The clean monotone ordering reported in the
results doc is a **net-R** phenomenon.

**I. Is the V1 25/25=100 problem confirmed on gross outcomes?**
**No — it is refuted in its original form.** On gross R the low-weight vs
high-weight gap at score 90–100 shrinks from ~11x to ~1.2x (+0.0426 vs +0.0517),
and Spearman(normalized score, gross R) = **−0.0004**, Spearman(availableWeight,
gross R) = **−0.0008**. The earlier net-R finding was a fee artifact. The valid
residual conclusion is weaker but still important: **no V1 score component —
normalized, raw, or availableWeight — has any association with gross outcome.**

**J. Is there any basis to consider frozen V2 better than V1?**
**No.** Gross expectancy is statistically indistinguishable (V1 +0.0509 vs V2
+0.0526) despite V2 trading less than half as often. V2's gross edge does not
survive removing its top 1 % of winners (−0.0550) whereas V1's does (+0.0211).
V2's gross PF (1.0797) barely exceeds V1's (1.0714). V2's advantage in **net**
terms comes from wider stops paying proportionally less fee, which is a
position-sizing property, not superior signal quality. The
`V2_NOT_BETTER` verdict stands, and this audit strengthens it.

---

**No strategy, parameter, setting, or existing artifact was modified. V2 remains
`v2.enabled=false` and research-only; `LIVE_TRADING_ENABLED=false`.**

# STRATEGY ARCHIVE — V2.1 … V2.8

Master index of every strategy developed in this research programme. Each entry
links to a full specification with exact parameter values, verified against
source code and result artifacts (not from memory).

**Final strategy: [V2.8 Zero-Fee Sniper + Trailing](strategies/V2_8_ZERO_FEE_SNIPER_TRAILING.md)** ⭐

| pinned | value |
|---|---|
| frozen engine commit | `4839074` — `src/` must stay byte-identical |
| final candidate freeze | `852167c` |
| validation result | `1d4d575` (`V2_8_VALIDATED_FOR_RESEARCH`) |
| dataset | `c3c1dce` (Binance Spot klines, 2022-01 … 2025-12) |
| TRAIN | 2022-01-01 … 2024-05-26 (60 %) |
| VALIDATION | 2024-05-26 … 2025-03-14 (20 %) |
| TEST (2022–25) | **USED** — spent on the V1/V2 baseline study |
| TEST (2026-H1) | **UNSPENT** — blocked, no data available |

---

## The strategies

| # | Strategy | Entry | Exit | Status | Doc |
|---|---|---|---|---|---|
| V2.1a | Limit Entry (B/C/D) | Retest / FVG / OB∩FVG limit | Frozen SMC ladder | ❌ REJECTED | [→](strategies/V2_1_CORRIDOR_ENTRY.md) |
| V2.1b | Corridor Entry | `close(N) ± 0.10 ATR` | Frozen SMC ladder | ❌ REJECTED | [→](strategies/V2_1_CORRIDOR_ENTRY.md) |
| V2.2 | HTF Spot Engine | Body reclaim + RVOL | Structural only | ❌ REJECTED | [→](strategies/V2_2_HTF_SPOT_ENGINE.md) |
| V2.3 | Sniper Reversal | Sniper filter | Fixed 1.5R / 2.5R | ❌ REJECTED | [→](strategies/V2_3_SNIPER_REVERSAL.md) |
| V2.4 | Asymmetric Sniper | Sniper + LONG HTF gate | Structural SMC | ❌ FAILED VALIDATION | [→](strategies/V2_4_ASYMMETRIC_SNIPER.md) |
| V2.5 | Trailing Stop | All baseline entries | Breakeven + trail | ⚠️ EXIT MODULE | [→](strategies/V2_5_TRAILING_STOP.md) |
| V2.6 | Sniper + Trailing | Sniper filter | Breakeven + trail | ❌ REJECTED (fees) | [→](strategies/V2_6_SNIPER_TRAILING.md) |
| V2.7 | RR Optimization | Sniper filter | Fixed 1.5–4.0R | ❌ REJECTED | [→](strategies/V2_7_RR_OPTIMIZATION.md) |
| **V2.8** | **Zero-Fee Sniper + Trailing** | **Sniper filter** | **Breakeven + trail** | ✅ **VALIDATED** | [**→**](strategies/V2_8_ZERO_FEE_SNIPER_TRAILING.md) |

## Headline results

| Strategy | Sample | Gross R/trade | Net R/trade @2/5 bps | Verdict |
|---|---|---|---|---|
| Baseline (frozen V2) | 30,888 | −0.0015 | −0.1257 | no edge |
| V2.1 limit (best, D) | — | +0.4325 | −0.9386 | fill rate 21 %, cost explosion |
| V2.1 corridor FULL | 56,492 | +0.0076 | — | 24.09 % fill, guard killed edge |
| V2.2 FULL | — | +0.0083 | — | both criteria failed |
| V2.3 S-cor | 1,497 | +0.0844 | — | 77 % of edge in top 1 % |
| V2.4 S-asym (TRAIN) | 689 | +0.2023 | +0.0624 | passed TRAIN |
| V2.4 S-asym (VALID) | 234 | **−0.1098** | **−0.2350** | **failed validation** |
| V2.5 Trail | 30,867 | +0.0457 | −0.0786 | beat baseline, still negative |
| V2.6 Sniper+Trail | 317 | +0.1462 | −0.0092 | best gross, fees win |
| V2.7 best (RR40) | 317 | +0.1383 | −0.0172 | fee drag invariant |
| **V2.8 (TRAIN)** | **317** | **+0.1462** | n/a (zero fee) | PF 1.3508 |
| **V2.8 (VALIDATION)** | **98** | **+0.0488** | n/a (zero fee) | **PF 1.1087 — PASS** |

## The five findings that shaped the outcome

1. **Fee drag is set by stop distance, not target distance.**
   `feeR = fee% × price / stopDistance`. Measured invariant at **0.1555 R** across
   all five V2.7 target levels (spread 0.0000). Raising take-profit cannot reduce
   commission measured in R.
2. **The sniper entry filter is the single most valuable component.**
   +0.1505 gross vs baseline; selects setups whose baseline gross is **+0.2663**
   against **−0.0036** for those declined.
3. **Trailing exits and the sniper filter do not compose.** Trailing alone is
   worth +0.0472; stacked on the sniper filter it is **−0.0028**. Both harvest the
   same favourable excursion.
4. **TRAIN-derived hypotheses mostly fail.** Of four carried forward, three did
   not reproduce. V2.4 inverted completely out of sample.
5. **Commission is the binding constraint, not signal quality.** Best gross edge
   ever measured is ~0.15 R/trade against ~0.155 R of fees at Binance futures
   rates.

## Repository layout

| path | contents |
|---|---|
| `src/` | **FROZEN** engine — byte-identical to `4839074`, never modified |
| `scripts/real-data/` | V2.1–V2.6 research harnesses |
| `research/` | V2.7–V2.8 research harnesses |
| `tests/` | 1,090 passing tests incl. causality and no-look-ahead invariants |
| `artifacts/research/` | Machine-readable metrics for every run |
| `docs/strategies/` | Per-strategy specifications (this archive) |

## For the porting agent

Read in this order:

1. **[FINAL_STATUS.md](FINAL_STATUS.md)** — what was proven, what to port, limits.
2. **[strategies/V2_8_ZERO_FEE_SNIPER_TRAILING.md](strategies/V2_8_ZERO_FEE_SNIPER_TRAILING.md)** — the strategy to implement.
3. **[ADMIN_PANEL_SPEC.md](ADMIN_PANEL_SPEC.md)** — parameter surface for the UI.
4. The rejected strategies — to avoid repeating disproven approaches.

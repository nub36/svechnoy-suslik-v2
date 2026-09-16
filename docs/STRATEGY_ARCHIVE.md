# STRATEGY ARCHIVE — V2.1 … V3.0

Master index of every strategy developed in this research programme. Each entry
links to a full specification with exact parameter values, verified against
source code and result artifacts (not from memory).

**Lead candidate: [V3.0 HTF Liquidation Trap](strategies/V3_0_HTF_LIQUIDATION_TRAP.md)** ⭐
— `V3_0_PROMISING_PENDING_VALIDATION`. The first strategy in the programme to be
net-positive at realistic Binance futures fees (+0.0994 R/trade @2/5 bps, n = 1,585).
Frozen before validation: [V3_0_CANDIDATE_FREEZE.md](V3_0_CANDIDATE_FREEZE.md).

All V2.1 – V2.8 strategies are **REJECTED** or **SUPERSEDED** — none is a live
recommendation. V2.8 remains the only V2 strategy that passed a pre-registered
validation, but it only works at **zero fees** and is therefore superseded by
V3.0 as the lead candidate.

| pinned | value |
|---|---|
| frozen engine commit | `4839074` — `src/` must stay byte-identical |
| V2.8 candidate freeze | `852167c` |
| V2.8 validation result | `1d4d575` (`V2_8_VALIDATED_FOR_RESEARCH`) |
| V3.0 pre-registration | `6c2bf9e` |
| V3.0 TRAIN result | `5674e65` (`V3_0_PROMISING_PENDING_VALIDATION`) |
| V3.0 candidate freeze | this commit — [V3_0_CANDIDATE_FREEZE.md](V3_0_CANDIDATE_FREEZE.md) |
| V3.0 VALIDATION | **PENDING — not yet run** |
| dataset | `c3c1dce` (Binance Spot klines, 2022-01 … 2025-12) |
| TRAIN | 2022-01-01 … 2024-05-26 (60 %) |
| VALIDATION | 2024-05-26 … 2025-03-14 (20 %) |
| TEST (2022–25) | **USED** — spent on the V1/V2 baseline study |
| TEST (2026-H1) | **UNSPENT** — blocked, no data available |

---

## The strategies

| # | Strategy | Entry | Exit | Status | Doc |
|---|---|---|---|---|---|
| **V3.0** | **HTF Liquidation Trap** | **4H sweep + 1H reclaim, limit corridor** | **4H equilibrium (TP1) → BE → opposing 4H swing (TP2), 50-bar timeout** | ⏳ **VALIDATION PENDING** (lead candidate) | [**→**](strategies/V3_0_HTF_LIQUIDATION_TRAP.md) |
| V2.1a | Limit Entry (B/C/D) | Retest / FVG / OB∩FVG limit | Frozen SMC ladder | ❌ REJECTED (superseded) | [→](strategies/V2_1_CORRIDOR_ENTRY.md) |
| V2.1b | Corridor Entry | `close(N) ± 0.10 ATR` | Frozen SMC ladder | ❌ REJECTED (superseded) | [→](strategies/V2_1_CORRIDOR_ENTRY.md) |
| V2.2 | HTF Spot Engine | Body reclaim + RVOL | Structural only | ❌ REJECTED (superseded) | [→](strategies/V2_2_HTF_SPOT_ENGINE.md) |
| V2.3 | Sniper Reversal | Sniper filter | Fixed 1.5R / 2.5R | ❌ REJECTED (superseded) | [→](strategies/V2_3_SNIPER_REVERSAL.md) |
| V2.4 | Asymmetric Sniper | Sniper + LONG HTF gate | Structural SMC | ❌ FAILED VALIDATION (superseded) | [→](strategies/V2_4_ASYMMETRIC_SNIPER.md) |
| V2.5 | Trailing Stop | All baseline entries | Breakeven + trail | ⚠️ EXIT MODULE — SUPERSEDED | [→](strategies/V2_5_TRAILING_STOP.md) |
| V2.6 | Sniper + Trailing | Sniper filter | Breakeven + trail | ❌ REJECTED — fees (superseded) | [→](strategies/V2_6_SNIPER_TRAILING.md) |
| V2.7 | RR Optimization | Sniper filter | Fixed 1.5–4.0R | ❌ REJECTED (superseded) | [→](strategies/V2_7_RR_OPTIMIZATION.md) |
| V2.8 | Zero-Fee Sniper + Trailing | Sniper filter | Breakeven + trail | ⤴ **SUPERSEDED** by V3.0 (validated for research, zero-fee only) | [→](strategies/V2_8_ZERO_FEE_SNIPER_TRAILING.md) |

**Status legend / легенда:** ⏳ VALIDATION PENDING — frozen, one validation run
authorised · ⤴ SUPERSEDED — previously held the lead, no longer the recommendation ·
❌ REJECTED / FAILED VALIDATION — disproven, research only.

## Headline results

| Strategy | Sample | Gross R/trade | Net R/trade @2/5 bps | Verdict |
|---|---|---|---|---|
| **V3.0 HTF Trap (TRAIN)** | **1,585** | **+0.1726** | **+0.0994** | ⏳ **VALIDATION PENDING — first net-positive at real fees** |
| **V3.0 VALIDATION** | — | — | — | **not run yet** |
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
| V2.8 (TRAIN) | 317 | +0.1462 | n/a (zero fee) | PF 1.3508 |
| V2.8 (VALIDATION) | 98 | +0.0488 | n/a (zero fee) | **PF 1.1087 — PASS** |

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
   measured in the V2 programme is ~0.15 R/trade against ~0.155 R of fees at
   Binance futures rates.

## V3.0 update — position as of this commit

6. **4H anchoring broke the fee barrier — but not through the registered
   mechanism.** V3.0 (4H levels, 1H execution) produced **+0.1726 gross** and
   **+0.0994 net @2/5 bps on n = 1,585** — the first net-positive result at
   realistic futures fees. The pre-registered reason (a wider 4H stop cutting
   fee-in-R) was **falsified**: median stop 1.2520 % vs V2.8's ~1.30 %, and fee
   drag *worse* (0.0732 R vs ~0.0538 R) because the partial exit pays three legs.
   The edge came from a higher gross and a 5× larger sample.
7. **Robustness is the best in the programme.** Removing the top 1 % (16 of 1,585
   trades) retains **57 %** of the edge (+0.0983), versus 37 % for V2.8 TRAIN,
   23 % for V2.3, and negative for V2.8 VALIDATION.
8. **This is still an unvalidated TRAIN result.** Three of four prior
   TRAIN-derived candidates failed to reproduce. V3.0 is frozen at
   [V3_0_CANDIDATE_FREEZE.md](V3_0_CANDIDATE_FREEZE.md) pending exactly one
   VALIDATION run.

## Repository layout

| path | contents |
|---|---|
| `src/` | **FROZEN** engine — byte-identical to `4839074`, never modified |
| `scripts/real-data/` | V2.1–V2.6 research harnesses |
| `research/` | V2.7–V3.0 research harnesses (`v30_htf_trap.ts` = the lead candidate) |
| `tests/` | 1,116 passing tests incl. causality and no-look-ahead invariants |
| `artifacts/research/` | Machine-readable metrics for every run |
| `docs/strategies/` | Per-strategy specifications (this archive) |

## For the porting agent

Read in this order:

1. **[strategies/V3_0_HTF_LIQUIDATION_TRAP.md](strategies/V3_0_HTF_LIQUIDATION_TRAP.md)** — the lead candidate (VALIDATION PENDING).
2. **[V3_0_CANDIDATE_FREEZE.md](V3_0_CANDIDATE_FREEZE.md)** — what is frozen and why nothing may move.
3. **[ADMIN_PANEL_SPEC.md](ADMIN_PANEL_SPEC.md)** — parameter surface for the UI.
4. **[strategies/V2_8_ZERO_FEE_SNIPER_TRAILING.md](strategies/V2_8_ZERO_FEE_SNIPER_TRAILING.md)** — superseded; validated for research at zero fees only.
5. **[FINAL_STATUS.md](FINAL_STATUS.md)** — the closed V2 programme (historical).
6. The rejected V2.1–V2.7 strategies — to avoid repeating disproven approaches.

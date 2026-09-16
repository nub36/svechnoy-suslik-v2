# STRATEGY ARCHIVE — V2.1 … V3.3

Master index of every strategy developed in this research programme. Each entry
links to a full specification with exact parameter values, verified against
source code and result artifacts (not from memory).

**Lead candidate: [V3.0 HTF Liquidation Trap](strategies/V3_0_HTF_LIQUIDATION_TRAP.md)** ⭐
— **`V3_0_VALIDATED_FOR_RESEARCH`**. The first strategy in the programme to be
net-positive at realistic Binance futures fees on **both** TRAIN (+0.0994 R/trade
@2/5 bps, n = 1,585) **and** the unseen VALIDATION window (**+0.0600 R/trade**
@2/5 bps, n = 536). Frozen before validation:
[V3_0_CANDIDATE_FREEZE.md](V3_0_CANDIDATE_FREEZE.md); results:
[V3_0_VALIDATION_RESULTS.md](V3_0_VALIDATION_RESULTS.md). **Ported into the
site's engine and running in paper forward test** (`FORWARD_TEST`, `LIVE`
locked) — [V3_0_PRODUCTION_PORT.md](V3_0_PRODUCTION_PORT.md).

**[V3.1 HTF Trend Pullback & Mitigation](V3_1_HTF_TREND_PULLBACK_TRAIN_RESULTS.md)**
— the trend-following counterpart — was pre-registered, implemented and run on
TRAIN: **`V3_1_FALSIFIED_ON_TRAIN`** (net −0.1097 R/trade @2/5 bps, n = 158,
gross already negative at −0.0838). Its wide-stop mechanism worked (fee drag
0.0258 R, the lowest recorded) but the payoff geometry does not pay for it.

**[V3.2 Volume Climax & Absorption](V3_2_VOLUME_CLIMAX_TRAIN_RESULTS.md)** — the
flow-fade hypothesis — was pre-registered, implemented and run on TRAIN:
**`V3_2_FALSIFIED_ON_TRAIN`**. Its pre-registered primary variant has the
**highest TP1 hit rate in the programme (60.59 %) and the lowest fee drag of any
trend-independent fade (0.0538 R)**, yet loses **−0.0620 R/trade** because its
expectancy **before fees is zero** (−0.0082): TP1 sits a median 0.71 R away while
the stop is 1 R. Two pre-registered EMA50-TP1 sensitivity variants clear F1
(+0.0530 / +0.0108) but falsify the premise criterion F3 and are **not promoted**
(`V3_2_EMA50_VARIANT_UNPROMOTED`; a new pre-registration would be required, and
no unspent validation window remains).

**[V3.3 HTF Zone Mitigation & LTF Squeeze](V3_3_HTF_ZONE_MITIGATION_TRAIN_RESULTS.md)**
— the confluence hypothesis — was pre-registered, implemented and run on TRAIN and
**is the first strategy since V3.0 to PASS its pre-registered primary**:
**`V3_3_TRAIN_ONLY`** (net **+0.0267 R/trade** @2/5 bps, n = 6,957, TP1 hit
65.24 %, fee drag 0.0511 R, PF 1.2341; all six symbols positive gross). It is
**not validated and not to be ported**: without its best 1 % of trades the net is
negative, the strictest reading of the same entry rule fails F1, TRAIN is burned
data and no validation window remains.

All V2.1 – V2.8 strategies are **REJECTED** or **SUPERSEDED** — none is a live
recommendation. V2.8 was the only V2 strategy to pass a pre-registered validation,
but it only works at **zero fees** and is therefore superseded by V3.0 as the lead
candidate. **`PRODUCTION_READY` is forbidden for every strategy here, V3.0
included** — validation means one unseen split survived, not deployability.

| pinned | value |
|---|---|
| frozen engine commit | `4839074` — `src/` must stay byte-identical |
| V2.8 candidate freeze | `852167c` |
| V2.8 validation result | `1d4d575` (`V2_8_VALIDATED_FOR_RESEARCH`) |
| V3.0 pre-registration | `6c2bf9e` |
| V3.0 TRAIN result | `5674e65` (`V3_0_PROMISING_PENDING_VALIDATION`) |
| V3.0 candidate freeze | [V3_0_CANDIDATE_FREEZE.md](V3_0_CANDIDATE_FREEZE.md) |
| V3.0 VALIDATION result | [V3_0_VALIDATION_RESULTS.md](V3_0_VALIDATION_RESULTS.md) — **PASS** (`V3_0_VALIDATED_FOR_RESEARCH`) |
| V3.0 validation artifact | `artifacts/research/v30/v30-validation-metrics.json` |
| V3.1 pre-registration | `760b15f` + [amendment 1](V3_1_HTF_TREND_PULLBACK_PREREGISTRATION_AMENDMENT_1.md) |
| V3.1 TRAIN result | [V3_1_HTF_TREND_PULLBACK_TRAIN_RESULTS.md](V3_1_HTF_TREND_PULLBACK_TRAIN_RESULTS.md) — **F1 FALSIFIED** (`V3_1_FALSIFIED_ON_TRAIN`) |
| V3.1 TRAIN artifacts | `artifacts/research/v31/v31-train-metrics{,-samebar}.json` |
| V3.2 pre-registration | `b631fba` — [V3_2_VOLUME_CLIMAX_PREREGISTRATION.md](V3_2_VOLUME_CLIMAX_PREREGISTRATION.md) |
| V3.2 TRAIN result | [V3_2_VOLUME_CLIMAX_TRAIN_RESULTS.md](V3_2_VOLUME_CLIMAX_TRAIN_RESULTS.md) — **F1 FALSIFIED** (`V3_2_FALSIFIED_ON_TRAIN`) |
| V3.2 TRAIN artifacts | `artifacts/research/v32/v32-train-metrics*.json` (4 variants) |
| V3.3 pre-registration | `16728ef` + [amendment 1](V3_3_HTF_ZONE_MITIGATION_PREREGISTRATION_AMENDMENT_1.md) (`01cbc28`) |
| V3.3 TRAIN result | [V3_3_HTF_ZONE_MITIGATION_TRAIN_RESULTS.md](V3_3_HTF_ZONE_MITIGATION_TRAIN_RESULTS.md) — **F1 PASS, tail-fragile** (`V3_3_TRAIN_ONLY`) |
| V3.3 TRAIN artifacts | `artifacts/research/v33/v33-train-metrics-<window>-<stop>-<leg>.json` (8 runs) |
| dataset | `c3c1dce` (Binance Spot klines, 2022-01 … 2025-12) |
| TRAIN | 2022-01-01 … 2024-05-26 (60 %) |
| VALIDATION | 2024-05-26 … 2025-03-14 (20 %) |
| TEST (2022–25) | **USED** — spent on the V1/V2 baseline study |
| TEST (2026-H1) | **UNSPENT** — blocked, no data available |

---

## The strategies

| # | Strategy | Entry | Exit | Status | Doc |
|---|---|---|---|---|---|
| **V3.0** | **HTF Liquidation Trap** | **4H sweep + 1H reclaim, limit corridor** | **4H equilibrium (TP1) → BE → opposing 4H swing (TP2), 50-bar timeout** | ✅ **VALIDATED FOR RESEARCH** (lead candidate) | [**→**](strategies/V3_0_HTF_LIQUIDATION_TRAP.md) |
| V3.1 | HTF Trend Pullback & Mitigation | 4H trend + 1H pullback to value, displaced resumption | TP1 leg extreme → BE → 1.5 Fib extension, 60-bar timeout | ❌ **REJECTED — F1 falsified (loses before fees)** | [→](V3_1_HTF_TREND_PULLBACK_TRAIN_RESULTS.md) |
| V3.2 | Volume Climax & Absorption | ≥2 ATR expansion + RVOL ≥ 2.2 + rejection wick/engulfing, maker corridor | TP1 50 % of the cascade → BE → cascade origin, 48-bar timeout | ❌ **REJECTED — F1 falsified (pre-cost edge is zero)** | [→](V3_2_VOLUME_CLIMAX_TRAIN_RESULTS.md) |
| V3.3 | HTF Zone Mitigation & LTF Squeeze | fresh 4H OB/FVG mitigated on 1H + 1H exhaustion (RVOL ≥ 1.25, wick ≥ 35 % / reclaim) | TP1 leg equilibrium → BE → opposing 4H swing, 48-bar timeout | ⚠️ **TRAIN PASS — `V3_3_TRAIN_ONLY`** (tail-fragile, not validated) | [→](V3_3_HTF_ZONE_MITIGATION_TRAIN_RESULTS.md) |
| V2.1a | Limit Entry (B/C/D) | Retest / FVG / OB∩FVG limit | Frozen SMC ladder | ❌ REJECTED (superseded) | [→](strategies/V2_1_CORRIDOR_ENTRY.md) |
| V2.1b | Corridor Entry | `close(N) ± 0.10 ATR` | Frozen SMC ladder | ❌ REJECTED (superseded) | [→](strategies/V2_1_CORRIDOR_ENTRY.md) |
| V2.2 | HTF Spot Engine | Body reclaim + RVOL | Structural only | ❌ REJECTED (superseded) | [→](strategies/V2_2_HTF_SPOT_ENGINE.md) |
| V2.3 | Sniper Reversal | Sniper filter | Fixed 1.5R / 2.5R | ❌ REJECTED (superseded) | [→](strategies/V2_3_SNIPER_REVERSAL.md) |
| V2.4 | Asymmetric Sniper | Sniper + LONG HTF gate | Structural SMC | ❌ FAILED VALIDATION (superseded) | [→](strategies/V2_4_ASYMMETRIC_SNIPER.md) |
| V2.5 | Trailing Stop | All baseline entries | Breakeven + trail | ⚠️ EXIT MODULE — SUPERSEDED | [→](strategies/V2_5_TRAILING_STOP.md) |
| V2.6 | Sniper + Trailing | Sniper filter | Breakeven + trail | ❌ REJECTED — fees (superseded) | [→](strategies/V2_6_SNIPER_TRAILING.md) |
| V2.7 | RR Optimization | Sniper filter | Fixed 1.5–4.0R | ❌ REJECTED (superseded) | [→](strategies/V2_7_RR_OPTIMIZATION.md) |
| V2.8 | Zero-Fee Sniper + Trailing | Sniper filter | Breakeven + trail | ⤴ **SUPERSEDED** by V3.0 (validated for research, zero-fee only) | [→](strategies/V2_8_ZERO_FEE_SNIPER_TRAILING.md) |

**Status legend / легенда:** ✅ VALIDATED FOR RESEARCH — passed a pre-registered
validation on unseen data (NOT production-ready) · ⤴ SUPERSEDED — previously held
the lead, no longer the recommendation · ❌ REJECTED / FAILED VALIDATION —
disproven, research only.

## Headline results

| Strategy | Sample | Gross R/trade | Net R/trade @2/5 bps | Verdict |
|---|---|---|---|---|
| **V3.0 HTF Trap (TRAIN)** | **1,585** | **+0.1726** | **+0.0994** | first net-positive at real fees |
| **V3.0 HTF Trap (VALIDATION)** | **536** | **+0.1274** | **+0.0600** | ✅ **PASS — `V3_0_VALIDATED_FOR_RESEARCH`** |
| V3.1 Trend Pullback (TRAIN, primary) | 158 | −0.0838 | −0.1097 | ❌ **F1 falsified — loses before fees** |
| V3.1 Trend Pullback (TRAIN, same-bar) | 82 | −0.2540 | −0.2819 | ❌ F1 + F3 falsified (underpowered) |
| V3.2 Volume Climax (TRAIN, primary) | 307 | −0.0082 | −0.0620 | ❌ **F1 falsified — zero edge before fees** |
| V3.2 Volume Climax (TRAIN, TP1=EMA50) | 213 | +0.1104 | +0.0530 | ⚠️ passes F1, falsifies F3 — **unpromoted** |
| V3.2 Volume Climax (TRAIN, fast3+EMA50) | 97 | +0.0679 | +0.0108 | ⚠️ underpowered (n<100), fragile |
| **V3.3 Zone Mitigation (TRAIN, primary)** | **6,957** | **+0.0778** | **+0.0267** | ⚠️ **F1 PASS — tail-fragile (ex-top-1 % is net-negative)** |
| V3.3 (TRAIN, `first`+`protective`) | 600 | +0.0166 | −0.0253 | ❌ fails F1 under the strictest window reading |
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
8. **V3.0 reproduced out of sample — the programme's second ever PASS.**
   VALIDATION (2024-05 … 2025-03, unseen) gave **n = 536, gross +0.1274, net
   +0.0600 @2/5 bps, PF 1.2484** — both pre-registered criteria met on one frozen
   run. Decay from TRAIN: gross −26 %, net −40 %, inside the predicted range.
9. **The PASS is real but narrow, and it must be read with its caveats**
   ([V3_0_VALIDATION_RESULTS.md](V3_0_VALIDATION_RESULTS.md) §3, §5):
   3 of 6 symbols negative; only two symbol cells clear `n < 100` and they
   disagree in sign; removing the best 5 trades flips the net negative
   (ex-top-1 % gross +0.0384 vs 0.0673 R of fees). It is the best result the
   programme has produced and it is **not** a licence to deploy.

## Repository layout

| path | contents |
|---|---|
| `src/` | **FROZEN** engine — byte-identical to `4839074`, never modified |
| `scripts/real-data/` | V2.1–V2.6 research harnesses |
| `research/` | V2.7–V3.0 research harnesses (`v30_htf_trap.ts` = the lead candidate) |
| `tests/` | 1,116 passing tests incl. causality and no-look-ahead invariants |
| `research/v30_validate.ts` | V3.0 VALIDATION driver — window selection + TEST guard only |
| `artifacts/research/` | Machine-readable metrics for every run |
| `docs/strategies/` | Per-strategy specifications (this archive) |

## For the porting agent

Read in this order:

1. **[strategies/V3_0_HTF_LIQUIDATION_TRAP.md](strategies/V3_0_HTF_LIQUIDATION_TRAP.md)** — the lead candidate.
2. **[V3_0_VALIDATION_RESULTS.md](V3_0_VALIDATION_RESULTS.md)** — the PASS, the decay, and the four caveats that qualify it.
3. **[V3_0_CANDIDATE_FREEZE.md](V3_0_CANDIDATE_FREEZE.md)** — what was frozen and why nothing moved.
4. **[ADMIN_PANEL_SPEC.md](ADMIN_PANEL_SPEC.md)** — parameter surface for the UI.
5. **[strategies/V2_8_ZERO_FEE_SNIPER_TRAILING.md](strategies/V2_8_ZERO_FEE_SNIPER_TRAILING.md)** — superseded; validated for research at zero fees only.
6. **[FINAL_STATUS.md](FINAL_STATUS.md)** — the closed V2 programme (historical).
7. The rejected V2.1–V2.7 strategies — to avoid repeating disproven approaches.

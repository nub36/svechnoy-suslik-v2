# V2.4 ASYMMETRIC SNIPER ENGINE — TRAIN RESULTS

## Status: criteria **PASSED** on TRAIN — but this is **not** validation

`S-asym` is the first arm in this project to meet every preregistered
criterion. Per the pre-registration this does **not** license a positive status:
the only permitted outcomes are `V2_4_REJECTED_ON_TRAIN`,
`V2_4_NOT_VALIDATED`, `V2_4_VALIDATED_FOR_RESEARCH`, and the last requires
VALIDATION, which has **not** been run.

**Working status: criteria met on TRAIN, pending VALIDATION.**

TRAIN only. VALIDATION and TEST untouched. No rule changed after seeing results.
`git diff 4839074 -- src/` is empty.

| pinned | value |
|---|---|
| frozen strategy | `4839074` |
| pre-registration | `072490e` |
| dataset | `c3c1dce` |
| scope | 15m/30m/1h/4h · 6 symbols · 24 series · TRAIN |

---

## 1. Success criteria

Fee labels as defined in the pre-registration: **headline = 2 bps maker entry +
5 bps taker exit**; **stress = 5 + 5**.

| arm | setups | closed | head /fill | head /setup | stress /fill | ex-top-1 % | PASS |
|---|---|---|---|---|---|---|---|
| A (baseline) | 106,994 | 30,888 | −0.1257 | −0.0363 | −0.1790 | −0.0932 | ❌ |
| S-base | 337,810 | 836 | −0.0980 | −0.0002 | −0.1651 | −0.0397 | ❌ |
| S-struct | 337,330 | 908 | −0.1102 | −0.0003 | −0.1753 | −0.0566 | ❌ |
| S-cor | 337,343 | 829 | +0.0046 | +0.0000 | −0.0543 | +0.0439 | ❌ |
| **S-asym** | 338,273 | **689** | **+0.0624** | **+0.0001** | **+0.0025** | **+0.1069** | ✅ |
| S-noasym | 337,343 | 829 | +0.0046 | +0.0000 | −0.0543 | +0.0439 | ❌ |

All four S-asym criteria pass, including both direction legs non-negative with
n ≥ 100 (LONG n=287, SHORT n=402).

## 2. Outlier robustness — the criterion V2.3 failed

| measure | S-asym | (V2.3 S-cor for contrast) |
|---|---|---|
| gross expectancy | **+0.2023** | +0.0844 |
| excluding best 1 | +0.1846 | +0.0786 |
| excluding best 5 | +0.1296 | +0.0592 |
| **excluding top 1 %** | **+0.1069** | **+0.0196** |
| trades removed | 7 of 689 | 15 of 1,497 |

V2.3 lost ~77 % of its edge to 1 % of trades. S-asym retains **53 %**
(+0.2023 → +0.1069) and stays comfortably positive. This is a materially
different robustness profile, and it is the single strongest reason to take the
result seriously.

## 3. Ablation — where the gain comes from

| step | gross /fill | delta |
|---|---|---|
| A (baseline) | −0.0015 | — |
| + sniper filter (S-base) | +0.0585 | **+0.0600** |
| + structural targets (S-struct) | +0.0417 | −0.0168 |
| + corridor (S-cor) | +0.1419 | **+0.1002** |
| + LONG asymmetry (S-asym) | **+0.2023** | **+0.0604** |

Max drawdown falls from **−505.8R (A)** to **−24.6R (S-asym)**; PF rises from
0.998 to **1.299**.

Note the structural-targets step is **negative** (−0.0168). It was adopted
because V2.3's R-multiple ladder was worse, and it is still better than that —
but it is not additive on its own. The two genuine contributors are the
**corridor** and the **asymmetry**.

## 4. Anti-bias checks

| group | n | baseline gross |
|---|---|---|
| setups S-asym FILLED | 241 | **+0.3316** |
| setups S-asym DECLINED | 30,505 | −0.0051 |
| **LONGs rejected by the asymmetry gate** | 50 | **−0.2339** |

The decisive check: the asymmetry gate rejects LONGs whose **baseline** gross was
**−0.2339**. It removes genuinely bad trades — the opposite of V2.1's Fee Drag
Guard, which rejected setups that were ~5× *better* than those it kept. The gate
is doing real work, not just shrinking the sample.

## 5. Breakdowns (S-asym) — n<100 rule applied

**LONG vs SHORT**

| direction | n | gross |
|---|---|---|
| SHORT | 402 | **+0.2937** |
| LONG | 287 | +0.0743 |

The asymmetry narrowed but did not eliminate the gap. SHORT remains ~4× better.

**Timeframe**

| TF | n | gross |
|---|---|---|
| 15m | 384 | +0.0901 |
| 30m | 173 | +0.3816 |
| 1h | 101 | +0.1189 |
| 4h | **31** | +0.8635 — **n<100, NOT decisive** |

**Symbol** — all six positive, all n ≥ 100:

| symbol | n | gross |
|---|---|---|
| BTCUSDT | 112 | +0.3249 |
| BNBUSDT | 109 | +0.2846 |
| ETHUSDT | 101 | +0.2131 |
| DOGEUSDT | 123 | +0.1864 |
| XRPUSDT | 115 | +0.1326 |
| SOLUSDT | 129 | +0.0953 |

Consistency across all six symbols with no negative cell is the second-strongest
signal here.

**Which LONG leg fired** — and a problem:

| leg | n | gross |
|---|---|---|
| NONE (SHORTs) | 402 | +0.2937 |
| HTF_EMA200 | 157 | +0.2422 |
| **HTF_STRUCTURE** | 110 | **−0.1919** |
| RSI_DIVERGENCE | **20** | +0.2201 — n<100 |

**The `HTF_STRUCTURE` leg is negative on n=110.** The LONG gate passes overall
only because `HTF_EMA200` (+0.2422) outweighs it. This is a real weakness:
one of the three OR-legs admits losing trades. **It is reported, not fixed** —
removing it now would be exactly the TRAIN-fitting the pre-registration warns
against, and it must be carried into VALIDATION as-is.

**Pool kind** — EQUAL +0.2328 (n=214), CLUSTER +0.2286 (n=114), SWING +0.1759
(n=361). All positive; EQH/EQL no longer the worst, reversing the V2.1
observation.

**HTF alignment** — ALIGNED +0.2975 (332), NEUTRAL +0.1266 (232),
COUNTER_TREND +0.0898 (125). Monotone and sensible.

## 6. Net expectancy across fee environments (per filled trade)

| arm | GROSS | 2/2 bps | **headline 2/5** | **stress 5/5** |
|---|---|---|---|---|
| A | −0.0015 | −0.0725 | −0.1257 | −0.1790 |
| S-cor | +0.1419 | +0.0634 | +0.0046 | −0.0543 |
| **S-asym** | **+0.2023** | **+0.1224** | **+0.0624** | **+0.0025** |

S-asym is the first arm positive in **every** environment — but the stress case
is **+0.0025**, essentially breakeven. On a 5/5 taker-both-sides basis this
design has no meaningful margin.

## 7. Funnel and execution

- Setups 338,273 → FILLED **689** (0.20 %). Extremely selective.
- Rejections: `continuation_disabled` 301,101 · `weak_body_reclaim` 27,394 ·
  `low_rvol` 8,055 · `rr1_below_min_rr` 625 · `long_no_htf_bullish_confluence` 339.
- Corridor fill rate of pending **90.42 %**, median latency **1 bar**, MISSED 0,
  EXPIRED 1, CANCELLED 69.
- Median stop **0.7097 %** of price (p25 0.391, p75 1.261), 1.359 ATR.
- TP1 basis was `INTERNAL_LIQUIDITY` for **100 %** of fills — equilibrium never
  had to be used as fallback.

## 8. Honest assessment

**What is genuinely encouraging:** all criteria met including the outlier test
that killed V2.3; every symbol positive with n ≥ 100; the asymmetry gate removes
measurably bad LONGs (−0.2339 baseline); drawdown down 20× from baseline; and
the result survives a 5/5 stress, if barely.

**What must temper it:**

1. **Circularity, as registered in §0 of the pre-registration.** The LONG gate
   was designed *because* V2.3 LONGs underperformed on this same TRAIN data.
   Some of the +0.0604 asymmetry gain is fitting, and there is no way to tell
   how much from TRAIN alone. The project base rate is poor: **2 of 3** prior
   TRAIN-derived leads failed to reproduce.
2. **n = 689** closed trades. Small.
3. **The `HTF_STRUCTURE` leg is negative** (−0.1919, n=110) — an internal
   inconsistency in the very rule being credited.
4. **Stress margin is ~zero** (+0.0025 at 5/5).
5. **Post-only fills are modelled optimistically**, as registered — a real
   post-only order can be rejected when it would cross, which OHLC cannot detect.

**Conclusion:** this is the first V2.x design worth spending the VALIDATION
split on. It is *not* evidence the strategy works. The pre-registration requires
the candidate and its rationale to be committed before VALIDATION runs, and that
is the next step — **not** taken in this task.

**No candidate formally selected. VALIDATION not run. TEST untouched.
`v2.enabled=false`, `LIVE_TRADING_ENABLED=false`.**

# V2.2 HTF-FOCUSED ENGINE — TRAIN RESULTS

## Status: `V2_2_REJECTED_ON_TRAIN`

**Both preregistered success criteria FAILED in the arms that matter.** TRAIN
only; VALIDATION and TEST untouched. No rule changed after seeing results.
`git diff 4839074 -- src/` is empty.

| pinned | value |
|---|---|
| frozen strategy | `4839074` |
| pre-registration | `1b4f09b` + Amendment 1 `3952061` |
| dataset | `c3c1dce` |
| scope | 15m, 30m, 1h, 4h (Amendment 1) — 24 series |

---

## 1. Success criteria — both failed

| arm | setups | closed | rr1 rejection | **< 40 %?** | reversal share | **≥ 10 %?** |
|---|---|---|---|---|---|---|
| A (baseline) | 106,994 | 30,888 | 71.12 % | ❌ | 19.89 % | ✅ |
| Ahtf | 106,994 | 30,888 | 71.12 % | ❌ | 19.89 % | ✅ |
| T (targets) | 170,177 | 32,768 | 60.71 % | ❌ | 23.95 % | ✅ |
| R (confirm) | 131,262 | 25,635 | 57.18 % | ❌ | **1.64 %** | ❌ |
| TR | 200,519 | 26,404 | 50.89 % | ❌ | **2.36 %** | ❌ |
| TRG | 304,169 | 5,628 | **10.01 %** | ✅ | **2.61 %** | ❌ |
| FULL | 304,306 | 5,323 | **10.02 %** | ✅ | **2.55 %** | ❌ |

The rr1 criterion is met **only** in TRG/FULL, and not by the target fix — it is
met because the Fee Drag Guard and confluence filter already removed ~95 % of
setups before the rr1 gate could see them. The target change alone (T) moved
rr1 rejection from 71.12 % to 60.71 %, nowhere near the 40 % target.

**The reversal criterion is failed by the very change designed to fix it.**

## 2. Change 2 backfired — the "unblock" is a net tightening

| arm | reversals closed | share | reversal gross expectancy |
|---|---|---|---|
| A (displacement rule) | 6,144 | 19.89 % | **−0.0270** |
| R (body reclaim + RVOL) | 421 | **1.64 %** | **+0.0785** |

Replacing the `Displacement` requirement with `sweep.bodyRatio >= 0.35` and
`sweep.rvol > 1.2` rejected **13,897 `weak_body_reclaim` + 3,848 `low_rvol`**
setups — far more than the displacement rule was rejecting at 15m–4h. The
premise that `no_displacement` was the binding reversal constraint was measured
on the **1m-dominated** V2.1 corpus; at these timeframes it does not hold.

One genuinely interesting result: the surviving reversals flip from **−0.0270 to
+0.0785** gross. The new gates *do* select better reversals — they just select
very few (n=421). That is a lead, not a validated finding, and n=421 across four
timeframes and six symbols is too thin to act on.

## 3. Change 1 backfired — the removed fallback was the best performer

TP1 basis, gross expectancy in arm A:

| TP1 basis | n | gross expectancy |
|---|---|---|
| **R_MULTIPLE** | 5,130 | **+0.0449** |
| INTERNAL_LIQUIDITY | 22,194 | −0.0058 |
| EQUILIBRIUM | 3,157 | −0.0381 |
| RANGE_EDGE | 407 | −0.0645 |

The 1R/2R/3R fallback we removed as "artificial" was the **only profitable TP1
basis**. Removing it (arm T) pushed those trades onto structural targets and
gross expectancy per filled trade fell from **−0.0015 → −0.0358**. Structural
TP1 placement is *worse* than the artificial ladder on this data.

## 4. Performance — GROSS

| arm | exp / filled | **exp / actionable setup** | median R | PF | total R | max DD | pos % |
|---|---|---|---|---|---|---|---|
| A | −0.0015 | **−0.0004** | −1.0000 | 0.9978 | −45 | −506 | 28.11 |
| T | −0.0358 | −0.0069 | −1.0000 | 0.9494 | −1,172 | −1,297 | 27.52 |
| R | +0.0096 | **+0.0019** | −1.0000 | 1.0148 | +246 | −264 | 29.11 |
| TR | −0.0308 | −0.0041 | −1.0000 | 0.9561 | −814 | −897 | 27.87 |
| TRG | −0.0396 | −0.0007 | −1.0000 | 0.9396 | −223 | −256 | 32.07 |
| FULL | +0.0083 | +0.0001 | −1.0000 | 1.0131 | +44 | −86 | 33.61 |

Best on the primary metric is **R (+0.0019)**, driven by the 421 high-quality
reversals. Every other arm is at or below zero. Note the baseline itself is
**−0.0004** at 15m–4h: this timeframe band has essentially no gross edge to
begin with, which limits what any entry or target change can achieve.

## 5. Performance — NET by fee environment

**Per filled trade:**

| arm | GROSS | SPOT 10 bps | FUT_7 | FUT_4 |
|---|---|---|---|---|
| A | −0.0015 | −0.1790 | −0.1257 | −0.0725 |
| R | +0.0096 | −0.1594 | −0.1087 | −0.0580 |
| TRG | −0.0396 | −0.1547 | −0.1201 | −0.0856 |
| **FULL** | +0.0083 | **−0.1057** | **−0.0715** | **−0.0373** |

**Per actionable setup (primary):**

| arm | GROSS | SPOT 10 bps | FUT_7 | FUT_4 |
|---|---|---|---|---|
| A | −0.0004 | −0.0517 | −0.0363 | −0.0209 |
| R | +0.0019 | −0.0311 | −0.0212 | −0.0113 |
| **FULL** | +0.0001 | **−0.0018** | **−0.0013** | **−0.0007** |

**No arm is net-positive in any fee environment, including the 4 bps
maker-heavy futures best case.** Moving from Spot 10 bps to FUT_4 roughly halves
the loss per filled trade but never crosses zero, because the underlying gross
edge at 15m–4h is ~0.

## 6. Why the futures environment does not rescue it

The timeframe diagnostic predicted 15m/30m would be "viable" at 4 bps based on
break-even costs of 5.15 and 4.53 bps computed on the **V2.1 FULL** arm. That
prediction is not reproduced here: the V2.2 arms have different (mostly
negative) gross edge at those timeframes, so there is no positive edge for the
lower fee to preserve. The cheaper fee environment is necessary but not
sufficient — it cannot manufacture edge that is not there.

## 7. Sample-size honesty (preregistered rule)

TRG/FULL closed-trade counts by timeframe: 15m 2,866/2,716 · 30m 1,628/1,534 ·
1h 908/859 · **4h 226/214**. The 4h cells are near the n<100-per-subgroup
boundary once split by direction or setup kind, and no conclusion here rests on
them. The reversal lead (n=421) is explicitly flagged as underpowered.

## 8. Verdict

# `V2_2_REJECTED_ON_TRAIN`

Both fixes addressed **mechanical funnel losses** and both were measured to
backfire on their own terms:

- **Target placement**: removing the R-multiple fallback removed the only
  profitable TP1 basis (+0.0449) and worsened gross expectancy per filled trade
  from −0.0015 to −0.0358. rr1 rejection fell only to 60.71 %, not below 40 %.
- **Reversal confirmation**: the replacement gates are *stricter* than the rule
  they replaced, cutting reversal share from 19.89 % to 1.64 % — the opposite of
  the ≥10 % criterion.

This matches the prior expectation registered before the run: these were
funnel fixes, and there was no measured basis to expect them to create edge.
The result confirms it — the 15m–4h band has a baseline gross expectancy of
−0.0004 per setup, so there is essentially nothing for an entry or target change
to amplify.

**The one lead worth recording** (not acting on): the V2.2 reversal gates select
reversals with **+0.0785** gross expectancy versus **−0.0270** for the frozen
rule. If reversals are ever revisited, selectivity of that kind — not volume —
is where the signal appears to be. It needs a much larger sample before it could
support any decision.

**No candidate selected. VALIDATION not run. TEST untouched.
`v2.enabled=false`, `LIVE_TRADING_ENABLED=false`.**

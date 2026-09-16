# V2.3 SNIPER REVERSAL ENGINE — TRAIN RESULTS

## Status: `V2_3_REJECTED_ON_TRAIN`

**Every arm failed the preregistered success criteria.** TRAIN only; VALIDATION
and TEST untouched. No rule changed after seeing results.
`git diff 4839074 -- src/` is empty.

| pinned | value |
|---|---|
| frozen strategy | `4839074` |
| pre-registration | `d78c3cc` |
| dataset | `c3c1dce` |
| scope | 15m, 30m, 1h, 4h · 6 symbols · 24 series · TRAIN |

---

## 1. Success criteria — all arms FAIL

Required: **net > 0 per FILLED trade AND per ACTIONABLE SETUP, in BOTH FUT_4 and
FUT_7.**

| arm | setups | closed | FUT_4 /fill | FUT_4 /setup | FUT_7 /fill | FUT_7 /setup | PASS |
|---|---|---|---|---|---|---|---|
| A (baseline) | 106,994 | 30,888 | −0.0725 | −0.0209 | −0.1257 | −0.0363 | ❌ |
| S-base | 337,810 | 836 | −0.0309 | −0.0001 | −0.0980 | −0.0002 | ❌ |
| S-tgt | 333,296 | 1,589 | −0.0623 | −0.0003 | −0.1173 | −0.0006 | ❌ |
| **S-cor** | 333,283 | 1,497 | **+0.0164** | +0.0001 | **−0.0345** | −0.0002 | ❌ |
| S-full | 333,984 | 1,276 | +0.0113 | +0.0000 | −0.0235 | −0.0001 | ❌ |
| S-noguard | 333,283 | 1,497 | +0.0164 | +0.0001 | −0.0345 | −0.0002 | ❌ |

S-cor and S-full are net-positive **per filled trade at FUT_4 only**. Both are
negative at FUT_7 — the headline maker/taker model for this design — and both
are ≈0.0001 per actionable setup, i.e. indistinguishable from zero on the
denominator that charges a model for the setups it declines.

The pre-registration deliberately required both denominators in both
environments precisely to prevent a per-trade-only result being read as success.
That guard did its job here.

## 2. The FUT_4 result is not robust — outlier dependence is decisive

S-cor, gross R:

| measure | value |
|---|---|
| gross expectancy | **+0.0844** |
| excluding best 1 trade | +0.0786 |
| excluding best 5 | +0.0592 |
| **excluding top 1 % (15 trades)** | **+0.0196** |
| closed n | 1,497 |

**Removing 15 trades out of 1,497 destroys ~77 % of the edge.** The FUT_4
per-trade figure of +0.0164 is smaller than that swing, so it does not survive
the robustness check the pre-registration named as decisive at this sample size.

## 3. Selection bias — the filter picks genuinely better setups

| group | n | baseline gross mean |
|---|---|---|
| setups S-cor FILLED | 273 | **+0.2663** |
| setups S-cor DECLINED | 29,980 | −0.0036 |
| rejected by Fee Drag Guard | 0 | — |

This is the one clearly positive finding. The sniper filter selects setups whose
**baseline** gross expectancy is +0.2663 versus −0.0036 for everything it
declines. It is identifying real quality, not merely trading less.

Note the Fee Drag Guard rejected **zero** setups here — at 15m–4h with reversal
stops, the 0.35 %/0.5 ATR floors never bind. That is why S-full and S-noguard
differ only via the corridor path, and it retires the V2.1 concern that the
guard removes edge: in this scope it is simply inert.

## 4. Gross performance and ablation

| arm | gross /fill | gross /setup | PF | median R | max DD | pos % |
|---|---|---|---|---|---|---|
| A | −0.0015 | −0.0004 | 0.998 | −1.0000 | −505.8 | 28.11 |
| S-base | +0.0585 | +0.0001 | 1.082 | −1.0000 | −33.6 | 27.39 |
| S-tgt | +0.0112 | +0.0001 | 1.017 | −1.0000 | −63.1 | 31.21 |
| **S-cor** | **+0.0844** | +0.0004 | **1.129** | −1.0000 | **−32.7** | 33.33 |
| S-full | +0.0577 | +0.0002 | 1.090 | −1.0000 | −32.4 | 34.33 |

Ablation reading:

- **Sniper filter (A → S-base): strongly positive.** −0.0015 → +0.0585 per
  trade, with max drawdown collapsing from −505.8R to −33.6R. The filter works.
- **R-multiple ladder (S-base → S-tgt): negative.** +0.0585 → +0.0112. Restoring
  1.5R/2.5R targets *hurt* on reversals, which contradicts the V2.2 observation
  that motivated it. TP1 at 1.5R does eliminate rr1 rejection by construction,
  but the trades it admits are worse.
- **Corridor entry (S-tgt → S-cor): positive.** +0.0112 → +0.0844, the largest
  single improvement.
- **Fee Drag Guard (S-cor → S-full): slightly negative and inert** (0 rejections
  by the guard itself; the small delta comes from sequencing).

## 5. Breakdowns (S-cor) — with the n<100 rule applied

**LONG vs SHORT**

| direction | n | gross |
|---|---|---|
| LONG | 769 | +0.0325 |
| SHORT | 728 | **+0.1392** |

**Timeframe**

| TF | n | gross |
|---|---|---|
| 15m | 824 | +0.0668 |
| 30m | 411 | +0.0689 |
| 1h | 200 | +0.0663 |
| 4h | **62** | +0.4796 — **n<100, not decisive** |

Remarkably flat across 15m–1h, which is itself informative: the sniper filter's
benefit is not timeframe-specific.

**Symbol**

| symbol | n | gross |
|---|---|---|
| BTCUSDT | 244 | +0.1753 |
| DOGEUSDT | 255 | +0.1634 |
| ETHUSDT | 231 | +0.1061 |
| SOLUSDT | 289 | +0.0341 |
| BNBUSDT | 269 | +0.0177 |
| XRPUSDT | 209 | +0.0134 |

All six positive, though the spread (0.0134 → 0.1753) on n≈200–290 each is wide
enough that per-symbol ranking should not be trusted.

## 6. Net expectancy across all fee environments (per filled trade)

| arm | GROSS | SPOT 10 bps | FUT_7 | FUT_4 |
|---|---|---|---|---|
| A | −0.0015 | −0.1790 | −0.1257 | −0.0725 |
| S-base | +0.0585 | −0.1651 | −0.0980 | −0.0309 |
| S-tgt | +0.0112 | −0.1724 | −0.1173 | −0.0623 |
| **S-cor** | +0.0844 | −0.0855 | −0.0345 | **+0.0164** |
| S-full | +0.0577 | −0.0583 | −0.0235 | +0.0113 |

Even the best arm loses money on Spot (−0.0855) and at the realistic
maker-entry/taker-exit futures model (−0.0345). Only the both-legs-maker best
case turns positive, and only before the outlier check.

## 7. The circularity caveat, restated

As registered in §0 of the pre-registration: reversals-only and the R-multiple
ladder were both chosen from **TRAIN observations made after V2.2 was scored**.
V2.3 re-measures a hypothesis on the data that generated it, which inflates
results. Two of the three inherited premises did not even reproduce:

- the +0.0785 reversal figure (n=421) became **+0.0585** at S-base;
- the "R-multiple targets are better" finding **reversed** — the ladder made
  reversals worse.

That is a useful warning about acting on small-sample TRAIN observations.

## 8. Verdict

# `V2_3_REJECTED_ON_TRAIN`

No arm meets the criteria. The best arm is net-positive only in the most
optimistic fee environment, only on the per-trade denominator, and only before
removing 15 outlier trades.

**What genuinely works and is worth carrying forward:**

1. **The sniper reversal filter selects real quality** — setups it takes have a
   baseline gross of +0.2663 vs −0.0036 for those it declines, and it cuts max
   drawdown from −505.8R to −32.7R. This is the strongest single positive signal
   any V2.x study has produced.
2. **The corridor entry adds materially** (+0.0112 → +0.0844).
3. **The Fee Drag Guard is inert at 15m–4h** (zero rejections) and can be
   retired from this scope.

**What does not work:** the R-multiple ladder on reversals, and the economics
overall — at ~1,500 trades with 77 % of the edge in 1 % of them, and losses at
both Spot and FUT_7, there is no basis for progression.

**No candidate selected. VALIDATION not run. TEST untouched.
`v2.enabled=false`, `LIVE_TRADING_ENABLED=false`.**

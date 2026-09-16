# V2.4 S-asym — VALIDATION RESULTS

## Status: `V2_4_NOT_VALIDATED`

**FAIL against both pre-registered criteria.** One validation run, as frozen.
TEST untouched. No parameter changed — `git diff 53c9ad8` is empty for the
candidate files.

| pinned | value |
|---|---|
| frozen V2 strategy | `4839074` (unchanged) |
| candidate freeze | `53c9ad8` (committed **before** this run) |
| TRAIN results | `8e07352` |
| dataset | `c3c1dce` |
| slice | VALIDATION only · 15m/30m/1h/4h · 6 symbols · 24 series |
| TEST | **not run, not inspected** |

---

## 1. Pass/fail against the frozen criteria

Criteria (frozen at `53c9ad8`): under the headline **2 bps maker / 5 bps taker**
model, net expectancy must be **> 0 per FILLED trade AND per ACTIONABLE SETUP**.

| arm | setups | closed | head 2/5 /fill | head 2/5 /setup |
|---|---|---|---|---|
| A (baseline) | 36,229 | 9,928 | −0.0588 | −0.0161 |
| **S-asym** | 115,773 | **234** | **−0.2350** | **−0.0005** |

| criterion | required | actual | result |
|---|---|---|---|
| net per FILLED > 0 | > 0 | **−0.2350** | ❌ |
| net per SETUP > 0 | > 0 | **−0.0005** | ❌ |

# ==> FAIL

This is not a marginal miss. Per filled trade the candidate is **−0.2350**,
versus **+0.0624** on TRAIN — a swing of **−0.2974 R**.

## 2. Gross edge did not survive at all

The failure is not a fee-model artefact. **Gross expectancy itself inverted:**

| metric | TRAIN | VALIDATION |
|---|---|---|
| closed trades | 689 | 234 |
| **gross / filled** | **+0.2023** | **−0.1098** |
| gross PF | 1.2989 | **0.8559** |
| head 2/5 / fill | +0.0624 | −0.2350 |
| head 2/5 / setup | +0.0001 | −0.0005 |
| stress 5/5 / fill | +0.0025 | −0.2886 |
| ex-top-1 % | +0.1069 | **−0.2540** |
| positive-R rate | 31.20 % | 23.08 % |
| TP rate | 19.88 % | 17.09 % |

Profit factor fell below 1.0. The outlier check, which S-asym passed on TRAIN,
now shows the result is negative *before* and *after* removing the top 1 %
(3 trades) — there is no tail carrying it; the body itself is losing. SL rate
was **75.64 %**.

## 3. Every component inverted

**Direction**

| leg | TRAIN | VALIDATION |
|---|---|---|
| LONG | +0.0743 (n=287) | **−0.2668** (n=98) |
| SHORT | +0.2937 (n=402) | **+0.0033** (n=136) |

SHORT — the strongest TRAIN leg — collapsed to breakeven. LONG went sharply
negative despite the asymmetry gate built specifically to protect it.

**LONG asymmetry legs — the rule the whole design was built on**

| leg | TRAIN | VALIDATION |
|---|---|---|
| HTF_EMA200 | +0.2422 (n=157) | **−0.1985** (n=59) |
| HTF_STRUCTURE | −0.1919 (n=110) | **−0.2953** (n=33) |
| RSI_DIVERGENCE | +0.2201 (n=20) | **−0.7812** (n=6) |

**All three legs are negative on VALIDATION.** The `HTF_EMA200` leg, which
carried the TRAIN result and justified keeping the known-bad `HTF_STRUCTURE`
leg, reversed from +0.2422 to −0.1985.

**Timeframe**

| TF | TRAIN | VALIDATION |
|---|---|---|
| 15m | +0.0901 (384) | −0.0397 (130) |
| 30m | +0.3816 (173) | −0.2495 (65) |
| 1h | +0.1189 (101) | −0.2878 (29) |
| 4h | +0.8635 (31) | +0.4024 (10) |

Only 4h stayed positive, on **n=10** — far below the n≥100 rule and not
interpretable.

**Symbol** — TRAIN had all six positive; VALIDATION has **four of six negative**
(BTC +0.1330, BNB +0.0335, XRP −0.0383, ETH −0.2338, SOL −0.2627, DOGE −0.3238).
Every cell is n<100 and none is individually decisive, but the direction of the
shift is unambiguous.

## 4. The anti-bias check reversed too

| group | TRAIN baseline gross | VALIDATION baseline gross |
|---|---|---|
| setups FILLED | **+0.3316** (n=241) | **−0.1863** (n=76) |
| setups DECLINED | −0.0051 (n=30,505) | **+0.0508** (n=9,810) |
| LONGs rejected by asymmetry | **−0.2339** (n=50) | **+0.5259** (n=12) |

On TRAIN the filter selected good setups and the gate rejected bad LONGs. On
VALIDATION **both inverted**: the setups it picked were worse than average, and
the LONGs the asymmetry gate threw away were the best ones in the sample
(+0.5259). The selection mechanism is not merely weak out-of-sample — it is
**anti-selective**.

## 5. Why this happened — the caveats were correct

All four frozen caveats materialised:

1. **Circularity (the decisive one).** The LONG asymmetry was designed *because*
   V2.3 LONGs underperformed on TRAIN. That gain was fitting, and it did not
   transfer: LONG went +0.0743 → −0.2668. The project base rate is now **3 of 4**
   TRAIN-derived leads failing to reproduce.
2. **Small sample.** TRAIN n=689 → VALIDATION n=234, close to the forecast
   150–250. Neither is enough to establish a real edge.
3. **Thin stress margin.** +0.0025 at 5/5 was breakeven; on VALIDATION it is
   −0.2886.
4. **Post-only optimism.** Still present and still optimistic, so the true result
   is no better than reported.

The pre-registration's refusal to patch the negative `HTF_STRUCTURE` leg was
vindicated in an unexpected way: removing it would not have saved the run, since
`HTF_EMA200` reversed too.

## 6. Protocol compliance

- Candidate frozen and pushed at `53c9ad8` **before** the validation driver was
  written; `git diff 53c9ad8` is empty for the candidate files.
- **Exactly one** validation run. No re-runs, no variants, no parameter changes.
- No criterion relaxed or substituted after seeing results.
- A hard **TEST-safety guard** in the driver aborts if any window's `validToMs`
  is not strictly less than that series' `testFromMs`; all 24 series verified
  before the run, and it never fired. TEST was never read.
- Gates: typecheck ✅ · 1054 tests ✅ · build ✅ ·
  `git diff 4839074 -- src/` empty · `v2.enabled=false` ·
  `LIVE_TRADING_ENABLED=false`.

## 7. Conclusion

# `V2_4_NOT_VALIDATED`

The most promising V2.x design failed its single out-of-sample test
comprehensively: gross expectancy inverted, profit factor fell below 1, all
three LONG-confluence legs turned negative, and the selection filter became
anti-selective.

Four successive TRAIN-derived hypotheses (V2.1 limit entry, V2.2 funnel fixes,
V2.3 sniper, V2.4 asymmetry) have now produced no validated edge. The consistent
finding across every study remains: **V2's gross edge is ~0.03 R per trade, and
re-arranging entries, targets or filters redistributes cost without creating
alpha.**

Per protocol this is where the line is drawn. `PRODUCTION_READY` is forbidden
and nothing here approaches it. The untouched TEST split and the 2026-H1 window
remain unspent — which is the correct outcome, since there is no candidate worth
spending them on.

**TEST untouched. `v2.enabled=false`. `LIVE_TRADING_ENABLED=false`.**

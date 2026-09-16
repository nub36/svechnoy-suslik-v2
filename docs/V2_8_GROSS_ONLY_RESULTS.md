# V2.8 — PURE ALPHA (ZERO-FEE) EXIT COMPARISON — TRAIN

**All fees set to ZERO.** Every number below is gross R. Seven exit strategies
on one identical set of **317 sniper entries**.

TRAIN only. VALIDATION and TEST untouched. `src/` byte-identical to `4839074`.

| pinned | value |
|---|---|
| frozen V2 strategy | `4839074` |
| prior stage | V2.7, `965fb15` |
| dataset | `c3c1dce` |
| entries | V2.6/V2.7 sniper filter (`bodyRatio >= 0.35`, `rvol > 1.2`), reversals only |
| scope | 15m/30m/1h/4h · 6 symbols · TRAIN · n = 317 |

---

## 1. The comparison table

| Arm | n | Win Rate % | Gross R/trade | Profit Factor | Max Drawdown R |
|---|---|---|---|---|---|
| **SMC** | 317 | 17.98 | **0.1490** | 1.2113 | −21.98 |
| Trail | 317 | 50.79 | 0.1462 | **1.3508** | **−16.16** |
| RR15 | 317 | 42.27 | 0.0773 | 1.1378 | −9.73 |
| RR20 | 317 | 33.12 | 0.0994 | 1.1633 | −11.21 |
| RR25 | 317 | 27.76 | 0.1260 | 1.1957 | −11.28 |
| RR30 | 317 | 21.77 | 0.1017 | 1.1505 | −11.65 |
| RR40 | 317 | 16.40 | 0.1383 | 1.1973 | −14.20 |

*Win Rate = share hitting the target (TP for SMC/fixed arms, trail-exit for
Trail). Positive-R rate is reported separately below, since a Trail or TIMEOUT
exit can finish positive without hitting a target.*

**Same-entry invariant: PASS** — all seven arms resolved the identical 317-entry
set, verified by comparing entry fingerprints, not just counts.

## 2. Headline answer, with the important caveat

**By raw gross R/trade the winner is SMC (0.1490)**, with Trail essentially tied
(0.1462, a 1.9 % gap on n=317 — statistically indistinguishable).

**But that ranking does not survive outlier removal, and the reversal is
dramatic:**

| Arm | gross | ex-top-1 | ex-top-5 | **ex-top-1 %** | **edge retained** |
|---|---|---|---|---|---|
| SMC | 0.1490 | 0.1049 | 0.0060 | 0.0292 | **19.6 %** |
| Trail | 0.1462 | 0.1172 | 0.0394 | 0.0536 | 36.7 % |
| RR15 | 0.0773 | 0.0728 | 0.0545 | 0.0591 | 76.5 % |
| RR20 | 0.0994 | 0.0934 | 0.0690 | 0.0752 | 75.7 % |
| **RR25** | 0.1260 | 0.1185 | 0.0880 | **0.0957** | **76.0 %** |
| RR30 | 0.1017 | 0.0925 | 0.0552 | 0.0646 | 63.5 % |
| RR40 | 0.1383 | 0.1260 | 0.0764 | 0.0889 | 64.3 % |

**Removing just 5 trades out of 317 collapses SMC from 0.1490 to 0.0060** — it
retains under 20 % of its edge and is effectively flat. RR25 retains 76 % and
becomes the best arm at 0.0957.

**So there are two defensible answers:**

- **Maximum raw gross → SMC (0.1490)**, but it is a lottery-ticket distribution:
  57 TP exits, 222 stop-outs, median R = −1.0000, and nearly all the profit in a
  handful of very large winners (avg win **+3.01R**).
- **Most reliable gross → RR25 (0.1260 raw, 0.0957 after outlier removal)**, the
  best risk-adjusted-for-luck choice and the only arm above 0.09 post-trim.

Given n=317 and 7 arms tested, **RR25 is the more honest recommendation** — SMC's
top spot rests on ~5 trades.

## 3. Distribution shapes

| Arm | positive-R % | avg win | avg loss | median R | median bars | exits |
|---|---|---|---|---|---|---|
| SMC | 28.39 | +3.0095 | −0.9851 | −1.0000 | 10 | TP 57 / SL 222 / TO 38 |
| Trail | **50.79** | +1.1088 | **−0.8471** | **+0.0364** | 6 | TRAIL 130 / SL 119 / TO 68 |
| RR15 | 43.53 | +1.4666 | −0.9938 | −1.0000 | 6 | TP 134 / SL 177 / TO 6 |
| RR25 | 34.70 | +2.2187 | −0.9860 | −1.0000 | 8 | TP 88 / SL 203 / TO 26 |
| RR40 | 28.71 | +2.9226 | −0.9829 | −1.0000 | 10 | TP 52 / SL 221 / TO 44 |

**Trail is the only arm with a positive median trade** (+0.0364) and the only one
that reduces average loss below 1R (−0.8471, because breakeven stops cut losers).
It also has the best profit factor (1.3508) and smallest drawdown (−16.16R). If
the objective were smooth equity rather than maximum gross, Trail wins outright.

The fixed-RR arms are **not monotone** in target: 1.5R → 0.0773, 2.5R → 0.1260,
3.0R → **0.1017**, 4.0R → 0.1383. A real RR effect should be smooth; the dip at
3.0R is noise at this sample size and a warning against over-reading the exact
peak.

## 4. Subgroups — n<100 rule applied

**Direction** (both legs ≥ 100, usable):

| arm | LONG (n=188) | SHORT (n=129) |
|---|---|---|
| SMC | +0.0708 | **+0.2630** |
| Trail | +0.1097 | +0.1995 |
| RR25 | +0.0803 | +0.1926 |

SHORT outperforms LONG under every exit — consistent with V2.3/V2.4/V2.6.

**Timeframe** — only 15m (n=179) clears n≥100:

| arm | 15m (179) | 30m (97) | 1h (33) | 4h (8) |
|---|---|---|---|---|
| SMC | +0.0682 | +0.4349 | −0.3104 | +0.3867 |
| Trail | +0.1338 | +0.2558 | −0.0617 | −0.0456 |
| RR25 | +0.0983 | +0.2013 | −0.0963 | +0.7500 |

1h is negative under every arm; 30m looks strongest but is below the threshold.
**No timeframe conclusion beyond 15m is supportable.**

**Symbol** — every cell is n<100 (42–64). Spreads are wide and inconsistent
across arms (e.g. SOL: SMC −0.0772, Trail −0.0998, RR25 **+0.1608**). **No symbol
conclusion is supportable.**

## 5. What this means alongside the fee studies

Gross alpha on the sniper population is real but small: the best exit extracts
**~0.15 R/trade**, and the most robust extracts **~0.10–0.13 R/trade**.

For context, measured fee drag on this same population was **0.1555 R/trade** at
2/5 bps. So:

- At **0 %** fees, every arm is profitable, best ≈ **+0.15 R/trade**.
- At **2/5 bps**, nothing clears the bar (V2.7 confirmed: best net −0.0172).

**The break-even fee for this strategy is roughly 0.13–0.15 R/trade of cost**,
i.e. it needs an environment where round-trip commission is under ~90 % of what
Binance futures charges on this trade population. That is a demanding
requirement, not an easy one — a full maker-rebate or zero-fee venue, and even
then the surviving margin after the outlier trim (≈0.096 R for RR25) is thin.

## 6. Protocol

- Fees **zero** in every calculation. The SMC arm's gross is recovered exactly by
  adding back the frozen 0.1 % lump fee (`grossR = storedR + 0.1% × entry/risk`),
  the identity verified across 1.69M trades in the earlier fee audit.
- Entries **unchanged** from V2.6/V2.7; same-entry invariant verified.
- All new code in `research/`; `git diff 4839074 -- src/` **empty**.
- Gates: typecheck ✅ · **1090 tests** ✅ · build ✅ · `v2.enabled=false` ·
  `LIVE_TRADING_ENABLED=false`.
- **Multiple comparisons:** 7 arms tested on one split. The winner's margin is an
  upper bound, not an unbiased estimate. Nothing here is validated — TRAIN only.

## 7. Verdict

**Best pure-alpha exit, raw:** **SMC** (0.1490 R/trade) — but 80 % of that edge
sits in 5 trades.

**Best pure-alpha exit, robust:** **RR25** (0.1260 raw / 0.0957 after removing
the top 1 %) — it keeps three-quarters of its edge under trimming, where SMC
keeps one-fifth.

**Best risk-adjusted shape:** **Trail** — PF 1.3508, drawdown −16.16R, positive
median trade, 50.79 % win rate, at a gross only 1.9 % below SMC.

If the goal is literally "maximize gross R and ignore everything else", the
answer is SMC. If the goal is an exit that will still look like this out of
sample, **RR25 or Trail are the defensible picks**, and I would not bet on SMC's
0.1490 reproducing.

**TEST untouched. `v2.enabled=false`, `LIVE_TRADING_ENABLED=false`.**

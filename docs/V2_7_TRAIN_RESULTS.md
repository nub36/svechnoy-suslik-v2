# V2.7 TARGET RR OPTIMIZATION — TRAIN RESULTS

## Status: `V2_7_REJECTED_ON_TRAIN`

**No RR level is net-positive.** The best arm (RR40) reaches **−0.0172 R/trade**
— better than the worst arm (RR15, −0.0782) but still a loss, and worse than V2.6's −0.0092.

TRAIN only. VALIDATION and TEST untouched. `src/` byte-identical to `4839074`.

| pinned | value |
|---|---|
| frozen V2 strategy | `4839074` |
| pre-registration | `d9394b1` |
| dataset | `c3c1dce` (re-cloned, manifest verified identical) |
| scope | 15m/30m/1h/4h · 6 symbols · TRAIN · n = 317 sniper entries |

---

## 1. The comparison table

| Arm | n | Win Rate % | Gross R/trade | Fee R/trade | **Net R/trade** | Net R/setup |
|---|---|---|---|---|---|---|
| RR15 | 317 | 42.27 | 0.0773 | 0.1555 | −0.0782 | −0.0782 |
| RR20 | 317 | 33.12 | 0.0994 | 0.1555 | −0.0560 | −0.0560 |
| RR25 | 317 | 27.76 | 0.1260 | 0.1555 | −0.0295 | −0.0295 |
| RR30 | 317 | 21.77 | 0.1017 | 0.1555 | −0.0538 | −0.0538 |
| **RR40** | 317 | 16.40 | **0.1383** | 0.1555 | **−0.0172** | **−0.0172** |

**BEST: RR40 at −0.0172 R/trade — NEGATIVE.**

Per the pre-registration, "a peak is only meaningful if it is positive; an arm
that is merely least-negative is reported as a failure to find a profitable
target". RR40 is the least-negative arm, **not** an optimum.

## 2. The stated mechanism was arithmetically wrong — confirmed

The hypothesis was: *"if we aim for bigger targets, the commission becomes a
smaller fraction of the profit."*

**Fee drag is identical to four decimal places across all five arms:**

| arm | RR15 | RR20 | RR25 | RR30 | RR40 |
|---|---|---|---|---|---|
| fee R/trade | 0.1555 | 0.1555 | 0.1555 | 0.1555 | 0.1555 |

**Measured spread: 0.0000.**

This is exactly what §1 of the pre-registration predicted, and it follows from
the formula: `feeR = fee% × price / risk`. Fee-in-R depends on **entry price and
stop distance only**. Where the take-profit sits does not enter it. Moving TP
from 1.5R to 4.0R cannot reduce commission *as a fraction of R*, because R is
defined by the stop, not the target.

Commission per trade is a **fixed** ~0.1555 R tax on this entry population. The
only way a higher target helps is by raising **gross** expectancy — which is an
empirical win-rate/payoff question, not a fee question.

## 3. What higher targets actually did

| arm | win rate | avg win | avg loss | gross PF | exits (TP/SL/TIMEOUT) |
|---|---|---|---|---|---|
| RR15 | 42.27 % | +1.4666 | −0.9938 | 1.1378 | 134 / 177 / 6 |
| RR20 | 33.12 % | +1.8564 | −0.9852 | 1.1633 | 105 / 192 / 20 |
| RR25 | 27.76 % | +2.2187 | −0.9860 | 1.1957 | 88 / 203 / 26 |
| RR30 | 21.77 % | +2.4633 | −0.9867 | 1.1505 | 69 / 213 / 35 |
| RR40 | 16.40 % | +2.9226 | −0.9829 | 1.1973 | 52 / 221 / 44 |

The trade-off behaves exactly as theory says: win rate falls 42 % → 16 %, average
win rises 1.47R → 2.92R. Gross expectancy does improve overall (0.0773 → 0.1383),
so wider targets *are* net-favourable on this population — just not by enough.
Note the average win is always **well below** the nominal target (2.92R at a 4.0R
target), because timeouts close at market: TIMEOUT exits grow from 6 to 44 as the
target recedes.

**Gross would need to exceed 0.1555 R to break even.** RR40 reaches 0.1383 —
about 89 % of the way, and the curve is flattening.

## 4. The peak is not reliable

**Net expectancy is not monotone in RR:** RR25 (−0.0295) beats RR30 (−0.0538).
A true RR effect should be smooth; a dip at 3.0R that recovers at 4.0R is the
signature of noise at n = 317, where a handful of trades decides each cell.

**Outlier sensitivity confirms this — and it is severe:**

| arm | gross | ex-top-1 | ex-top-5 | ex-top-1 % |
|---|---|---|---|---|
| RR15 | 0.0773 | 0.0728 | 0.0545 | 0.0591 |
| RR25 | 0.1260 | 0.1185 | 0.0880 | 0.0957 |
| **RR40** | **0.1383** | 0.1260 | **0.0764** | 0.0889 |

Removing **five trades out of 317** cuts RR40's gross by 45 % (0.1383 → 0.0764),
which would push its net to roughly **−0.079** — worse than RR15. The apparent
advantage of high RR rests on a handful of large winners.

**Stress (5/5 taker both sides):** every arm deteriorates further — RR40
−0.0838, RR15 −0.1448. None approaches profitability.

**Multiple comparisons:** five arms were tested and the best reported. As
registered, RR40's margin is an upper bound, not an unbiased estimate.

## 5. Invariants and protocol

- **Same-entry invariant: PASS.** All five arms resolved an identical 317-entry
  set (verified by comparing entry fingerprints, not just counts).
- **Fee-drag invariance: PASS** (spread 0.0000), confirming §1.
- **Stop buffer:** the frozen **0.25 ATR** was used, not the 0.05 ATR in the
  brief. Recorded in §0.1 of the pre-registration before the run — the brief's
  own "same entries as V2.6" requirement controls, the stop defines R, and a
  tighter stop would have *inflated* fee-in-R and biased the study toward the
  hypothesis under test.
- **Timeout:** 50 bars as specified (frozen default is 48); applied identically
  to all arms.
- Gates: typecheck ✅ · **1090 tests** ✅ · build ✅ ·
  `git diff 4839074 -- src/` **empty** · `v2.enabled=false` ·
  `LIVE_TRADING_ENABLED=false`.

## 6. Verdict

# `V2_7_REJECTED_ON_TRAIN`

Raising the take-profit target **cannot** fix the commission problem, and the
data shows why in two distinct ways:

1. **Fee drag is invariant to the target** (0.1555 R in every arm, spread
   0.0000). The stated mechanism — "commission becomes a smaller fraction of a
   bigger win" — is arithmetically false when expectancy is measured in R, since
   R is set by the stop.
2. **Wider targets do lift gross** (0.0773 → 0.1383) but plateau below the
   0.1555 R fee wall, and the lift is carried by ~5 trades out of 317.

Combined with V2.6's finding that the sniper filter *raises* fee drag by
selecting tighter stops, the conclusion is now well-supported from several
angles: **on this entry population the commission is structural.** The
productive lever is not the target, the exit rule, or the entry filter in
isolation — it is **stop distance as a fraction of price**, which is what
determines fee-in-R in the first place.

**TEST untouched. `v2.enabled=false`, `LIVE_TRADING_ENABLED=false`.
`PRODUCTION_READY` forbidden.**

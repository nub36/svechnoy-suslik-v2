# V2.6 — SNIPER ENTRY + TRAILING EXIT

**Status: ❌ `V2_6_REJECTED_ON_TRAIN`** — net −0.0092 R/trade
· doc: `V2_6_TRAIN_RESULTS.md` · code: `scripts/real-data/v26-train.ts`

## What it does

First combination of the two best components: the sniper entry filter (V2.3) and
the trailing exit (V2.5), evaluated under **real Binance futures fees**. V2.8 is
this same strategy with fees set to zero.

## Entry logic

The 8-condition sniper filter, reversals only, entry at OPEN of N+1. No corridor
(deliberately omitted so entry-filter and exit-rule effects stay separable).

## Exit logic

V2.5 trailing verbatim — breakeven at +1R, trail 1R from peak MFE, 0.25R step,
10-bar timeout, no targets.

## Stop loss

Structural behind the sweep wick + **0.25 ATR**.

## Fee model

Per leg, no rebate: **2 bps maker entry + 5 bps taker exit**. Exits are charged
taker because trailing-stop and timeout exits are market events.

## Key parameters

Identical to V2.8 (see that document for the full table) except the fee model is
live rather than zero:

| Parameter | Value | Controls |
|---|---|---|
| `MIN_BODY_RATIO` | 0.35 | Sweep body reclaim |
| `MIN_RVOL` | 1.2 | Volume surge |
| `BREAKEVEN_R` | 1.0 | Breakeven trigger |
| `TRAIL_DISTANCE_R` | 1.0 | Trail distance |
| `TRAIL_STEP_R` | 0.25 | Trail step gate |
| `TIMEOUT_BARS` | 10 | +1R deadline |
| maker / taker bps | **2 / 5** | Fee model |

## Results — why it was rejected

| Arm | Entry | Exit | n | Gross | Net @2/5 |
|---|---|---|---|---|---|
| A | all | frozen | 30,888 | −0.0015 | −0.1257 |
| V25 | all | trailing | 30,867 | +0.0457 | −0.0786 |
| V26-frozen-exit | **sniper** | frozen | 317 | **+0.1490** | −0.0064 |
| **V26** | **sniper** | trailing | 317 | +0.1462 | **−0.0092** |

**The decisive 2×2 decomposition:**

| Component | Gross delta vs baseline |
|---|---|
| Entry filter alone | **+0.1505** |
| Exit rule alone | +0.0472 |
| Both together | +0.1477 |
| **Exit rule on top of the sniper filter** | **−0.0028** |

**Trailing contributes nothing once the sniper filter is applied.** Both harvest
the same favourable excursion — they do not compose. Evidence: trades never
reaching +1R fall from 63.61 % (all entries) to 58.36 % (sniper entries).

**Why the best gross still loses:** fee drag rose from 0.1243 to **0.1555 R/trade**
because the sniper filter selects tighter-stop setups, and
`feeR = fee% × price / stopDistance`. **The filter drags its own cost up with it.**

Also fragile: removing 5 of 317 trades cuts gross 73 % (+0.1462 → +0.0394).

## When to use

**Never at real fees.** Superseded by V2.8, which is the identical strategy
evaluated under the zero-fee assumption where it becomes viable.

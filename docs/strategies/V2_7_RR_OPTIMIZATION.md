# V2.7 — TARGET RR OPTIMIZATION

**Status: ❌ `V2_7_REJECTED_ON_TRAIN`** — all five arms net-negative
· doc: `V2_7_TRAIN_RESULTS.md` · code: `research/v27_rr_test.ts`

## What it does

Tests whether **larger take-profit targets** can overcome commission, on the
hypothesis that "bigger wins make the fee a smaller fraction of profit."

**That hypothesis is arithmetically false, and this study proves it empirically.**

## Entry logic

The 8-condition sniper filter, reversals only, entry at OPEN of N+1 — identical
entries to V2.6/V2.8 (verified by the same-entry invariant: all five arms
resolved the identical 317-entry set).

## Exit logic

Five fixed take-profit arms, 100 % of position, **no trailing, no partials**:

| Arm | Take-profit |
|---|---|
| RR15 | entry ± 1.5 × risk |
| RR20 | entry ± 2.0 × risk |
| RR25 | entry ± 2.5 × risk |
| RR30 | entry ± 3.0 × risk |
| RR40 | entry ± 4.0 × risk |

Bar-by-bar: SL hit → −1R · TP hit → +multiplier R · **same bar both → SL wins**
(conservative) · neither within 50 bars → close at market.

## Stop loss

Structural behind the sweep wick + **0.25 ATR**.

> **Spec note:** the task brief requested a 0.05 ATR buffer *and* "same entries as
> V2.6". These contradict — V2.6 uses the frozen 0.25 ATR. The frozen value was
> kept, because the stop defines `R`, so changing it would break comparability,
> and a tighter stop would have *inflated* fee-in-R, biasing the study toward the
> hypothesis under test.

## Key parameters

| Parameter | Value | Type | Controls | Impact if changed |
|---|---|---|---|---|
| RR multiplier | 1.5 / 2.0 / 2.5 / 3.0 / 4.0 | number | Target distance | The variable under test |
| `MAX_BARS` | 50 | integer | Horizon before market close | Frozen default is 48; 50 used as specified, identical across arms |
| `MAKER_BPS` | 2 | number | Entry fee | — |
| `TAKER_BPS` | 5 | number | Exit fee | — |
| same-bar TP+SL | SL wins | policy | Ambiguity resolution | Slightly disadvantages high-RR arms |

## Results

| Arm | n | Win Rate | Gross R | **Fee R** | Net R |
|---|---|---|---|---|---|
| RR15 | 317 | 42.27 % | 0.0773 | **0.1555** | −0.0782 |
| RR20 | 317 | 33.12 % | 0.0994 | **0.1555** | −0.0560 |
| RR25 | 317 | 27.76 % | 0.1260 | **0.1555** | −0.0295 |
| RR30 | 317 | 21.77 % | 0.1017 | **0.1555** | −0.0538 |
| RR40 | 317 | 16.40 % | 0.1383 | **0.1555** | −0.0172 |

## ⭐ Key finding — the most important result in the programme

**Fee drag is identical to four decimal places across all five arms. Spread: 0.0000.**

```
feeR = fee% × entryPrice / stopDistance
```

Fee-in-R depends on **entry price and stop distance only**. The take-profit does
not appear in the formula. Moving TP from 1.5R to 4.0R changes commission by
**exactly zero**, because `R` is defined by the **stop**, not the target.

What higher targets *actually* change is the win-rate/payoff trade-off: win rate
falls 42 % → 16 % while average win rises 1.47R → 2.92R. Gross does improve
(0.0773 → 0.1383) but plateaus at ~89 % of the 0.1555 fee wall.

**The peak is unreliable:** net expectancy is non-monotone (RR25 −0.0295 beats
RR30 −0.0538), and removing 5 of 317 trades cuts RR40's gross 45 %.

## When to use

**Never.** The mechanism is arithmetically disproven. **The productive lever is
stop distance as a fraction of price** — that is what sets fee-in-R.

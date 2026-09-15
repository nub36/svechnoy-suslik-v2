# H1 CANDIDATE SELECTION — REGISTERED BEFORE VALIDATION

**Written and committed BEFORE any VALIDATION number for the candidate was
computed.** TRAIN results only are visible at this point.

## What TRAIN showed

| model | gross exp | gross PF | posR% | maxDD R | TIMEOUT% | ex-top-1% exp | top1% share |
|---|---|---|---|---|---|---|---|
| A (current) | **0.0350** | **1.0539** | 28.81 | −1143.87 | 24.61 | −0.0682 | 14.99 % |
| B (full TP1) | 0.0149 | 1.0268 | **38.91** | −1126.48 | **14.76** | −0.0441 | **10.26 %** |
| C (50 % + orig stop) | 0.0249 | 1.0449 | 37.74 | −1064.20 | 24.61 | −0.0489 | 12.63 % |
| D (50 % + breakeven) | 0.0231 | 1.0415 | 38.91 | **−1001.33** | 20.60 | −0.0492 | 12.40 % |

**H1's proposed remedy is refuted on TRAIN.** Every alternative exit model has
*lower* gross expectancy than the current one. The ranking A > C > D > B is
stable across gross expectancy, PF, and every cost level (2/5/10/20 bps).

The path analysis explains why, and it is the opposite of the H1 premise:

| path group | n | A exp | B exp | C exp | D exp |
|---|---|---|---|---|---|
| never TP1 | 223,205 | −0.7611 | −0.7611 | −0.7611 | −0.7611 |
| TP1 only | 40,055 | −0.0072 | **1.5188** | 0.7558 | 0.9632 |
| reached TP2 | 22,218 | 0.8144 | **1.5423** | 1.1784 | 1.2262 |
| reached final | 43,394 | **3.7698** | 1.8363 | 2.8030 | 2.5731 |

Early exits do rescue the "TP1 only" bucket (−0.0072 → +1.5188, exactly the
giveback H1 predicted), but they cost far more in the "reached final" bucket
(3.7698 → 1.8363). The 43,394 trades that run all the way are worth more than
the 40,055 that stall, so capping them destroys more value than the stall
protects. **67.9 % of trades never reach TP1 at all**, and no exit model can
help those — the loss is concentrated where H1's mechanism has no leverage.

## Candidate selected for VALIDATION: **MODEL D**

Selected explicitly **NOT** on expectancy — on TRAIN, D is worse than A
(0.0231 vs 0.0350) and worse than C. The reason for choosing it anyway:

1. **Robustness / drawdown.** D has the **smallest max drawdown** of all four
   (−1001.33 R vs A's −1143.87 R), a 12.5 % reduction.
2. **Lowest outlier dependence among the partial models.** D's top 1 % of
   winners supply 12.40 % of positive R vs A's 14.99 %. A's edge is the most
   tail-dependent of the four, and the fee audit already showed A's gross edge
   flips negative once the top 1 % is removed.
3. **Highest positive rate** (38.91 %, tied with B) with a materially better
   expectancy than B — the best risk-profile trade-off among the alternatives.
4. **Economic simplicity.** Breakeven-after-partial is a standard, explainable
   rule with no new parameter beyond the pre-registered 50 %.
5. B is rejected despite the best TIMEOUT rate: it is the worst on expectancy
   and PF, and it caps the "reached final" bucket hardest (1.8363 vs 3.7698).
   C is rejected because D dominates it on drawdown and positive rate at
   near-identical expectancy.

**Prediction registered now:** given TRAIN, D is expected to **underperform A on
expectancy** in VALIDATION too. The purpose of the VALIDATION run is to test
whether the *drawdown and tail-dependence advantage* of D is a stable property
or a TRAIN artifact — and, decisively, whether H1's claimed expectancy
improvement appears anywhere. If D again fails to beat A on expectancy, H1 is
**NOT** validated.

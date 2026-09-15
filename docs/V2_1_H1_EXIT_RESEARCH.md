# H1 EXIT-MODEL RESEARCH — RESULT

## Status: `H1_NOT_VALIDATED`

**No strategy code was changed. No V2.1 was implemented. TEST was not touched.**

H1 proposed that the final-rung-only exit ladder gives back a substantial part
of favourable excursion, and that exiting earlier would recover it. The
mechanism is **real and measurable**, but the remedy **does not work**: every
alternative exit model tested is *worse* than the current one, on TRAIN and
again on VALIDATION.

| pinned | value |
|---|---|
| frozen V2 strategy | `4839074` (unchanged — `git diff 4839074 -- src/` empty) |
| pre-registration of models | `b0296c4` (`docs/V2_1_H1_PREREGISTRATION.md`) |
| candidate registered before VALIDATION | `bd3b826` (`docs/V2_1_H1_CANDIDATE.md`) |
| dataset | `c3c1dce` |
| TRAIN trades | 328,872 |
| VALIDATION trades | 111,565 |
| TEST | **USED, not touched by this study** |

---

## 1. TP semantics (verified before any computation)

Confirmed by reading the frozen code, not assumed:

- `buildTargets` returns **1, 2 or 3** rungs. Observed on TRAIN: 1 rung 7.53 %,
  2 rungs 8.63 %, 3 rungs 83.84 %.
- `trackOutcome` sorts `takeProfits` by **distance from entry ascending**, so
  **TP1 = nearest**, TP3/final = furthest.
- Only the **final** rung closes a position (`finalRung = tps.length - 1`;
  exit requires `tpIndex >= finalRung`). TP1/TP2 touches have no accounting
  effect. This is precisely what H1 targets.
- "TP1 reached" = a candle at or after the entry candle whose high (LONG) or
  low (SHORT) touches/crosses TP1. Entry is the OPEN of candle N+1 while targets
  were fixed on closed candle N. **No look-ahead.**

**Registered in advance:** for the 7.5 % single-rung trades, TP1 *is* the final
rung, so B/C/D are identical to A there by construction.

## 2-4. Models, intrabar rules, fees

Fixed in `docs/V2_1_H1_PREREGISTRATION.md` before results: Models A/B/C/D, the
50 % fraction (not searched), intrabar rules R1–R7 (SL wins ambiguous bars;
TP1 books before the final rung; in D breakeven wins ties and arms only on bars
strictly after the TP1 bar), and a **leg-based** fee model charging each leg on
its own notional at `bps/2` per side — so C and D correctly pay three legs
rather than being flattered by the frozen two-leg lump formula.

### Model A fidelity gate

Before trusting B/C/D, Model A was required to reproduce the frozen tracker:
recomputed Model A gross vs `storedRMultiple + frozenFeeR` on **all 328,872
TRAIN trades** → max difference **5.0e-7**, mismatches **0**.

This gate earned its keep: it caught a real bug in my simulator (on a TP1 touch
I skipped the same-bar TIMEOUT check, shifting TIMEOUT one bar late). Fixed
before any comparison was produced.

## 5-7. TRAIN RESULTS

### Exit-model comparison (GROSS first, then leg-based net)

| model | n | gross exp | gross med R | gross PF | posR% | maxDD R | TIMEOUT% | net@2bps | net@5bps | net@10bps | net@20bps |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 328,872 | 0.0350 | -1.0000 | 1.0539 | 28.81 | -1143.87 | 24.61 | -0.1178 | -0.3470 | -0.7289 | -1.4928 |
| B | 328,872 | 0.0149 | -1.0000 | 1.0268 | 38.91 | -1126.48 | 14.76 | -0.1379 | -0.3671 | -0.7490 | -1.5129 |
| C | 328,872 | 0.0249 | -1.0000 | 1.0449 | 37.74 | -1064.20 | 24.61 | -0.1278 | -0.3570 | -0.7390 | -1.5028 |
| D | 328,872 | 0.0231 | -1.0000 | 1.0415 | 38.91 | -1001.33 | 20.60 | -0.1297 | -0.3589 | -0.7408 | -1.5047 |

### TP1-conditional behaviour

| model | TP1 reached n | avg realized R on TP1 trades | TP1-reached but negative | share | avg giveback after TP1 |
|---|---|---|---|---|---|
| A | 105,074 | 1.7320 | 32,696 | 31.12% | 1.8304 |
| B | 105,074 | 1.6691 | 0 | 0.00% | 1.8933 |
| C | 105,074 | 1.7005 | 0 | 0.00% | 1.8619 |
| D | 105,074 | 1.6947 | 0 | 0.00% | 1.8677 |

### Exit-reason mix

- **A**: SL 62.23% · TIMEOUT 24.61% · TP 13.16%
- **B**: SL 53.29% · TP1 30.40% · TIMEOUT 14.76% · TP 1.55%
- **C**: SL 53.29% · TIMEOUT 14.76% · TP 13.16% · PARTIAL_TIMEOUT 9.85% · PARTIAL_SL 8.94%
- **D**: SL 53.29% · TIMEOUT 14.76% · BE 14.54% · TP 11.57% · PARTIAL_TIMEOUT 5.84%

### Path analysis — where favourable excursion is lost

| path group | n | mean MFE R | mean MAE R | A exp | B exp | C exp | D exp |
|---|---|---|---|---|---|---|---|
| never TP1 | 223,205 | 0.6112 | -1.2142 | -0.7611 | -0.7611 | -0.7611 | -0.7611 |
| TP1 only | 40,055 | 2.3371 | -1.0180 | -0.0072 | 1.5188 | 0.7558 | 0.9632 |
| reached TP2 | 22,218 | 3.4504 | -0.8751 | 0.8144 | 1.5423 | 1.1784 | 1.2262 |
| reached final | 43,394 | 4.7379 | -0.3797 | 3.7698 | 1.8363 | 2.8030 | 2.5731 |

### REVERSAL vs CONTINUATION (gross)

| setup | model | n | gross exp | PF | posR% |
|---|---|---|---|---|---|
| REVERSAL | A | 48,722 | 0.0191 | 1.0260 | 24.85 |
| REVERSAL | B | 48,722 | 0.0077 | 1.0122 | 36.06 |
| REVERSAL | C | 48,722 | 0.0134 | 1.0213 | 35.98 |
| REVERSAL | D | 48,722 | 0.0137 | 1.0217 | 36.06 |
| CONTINUATION | A | 280,150 | 0.0377 | 1.0596 | 29.49 |
| CONTINUATION | B | 280,150 | 0.0161 | 1.0297 | 39.40 |
| CONTINUATION | C | 280,150 | 0.0269 | 1.0496 | 38.05 |
| CONTINUATION | D | 280,150 | 0.0247 | 1.0455 | 39.40 |

### Outlier dependence (gross)

| model | exp | ex top1 | ex top5 | ex top 1% | top1% share of positive R |
|---|---|---|---|---|---|
| A | 0.0350 | 0.0348 | 0.0342 | -0.0682 | 14.99% |
| B | 0.0149 | 0.0148 | 0.0144 | -0.0441 | 10.26% |
| C | 0.0249 | 0.0248 | 0.0244 | -0.0489 | 12.63% |
| D | 0.0231 | 0.0229 | 0.0225 | -0.0492 | 12.40% |


---

## 8. CANDIDATE SELECTION (registered before VALIDATION — commit `bd3b826`)

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

---

## 9. VALIDATION — ONE RUN, Model A vs Model D

### Exit-model comparison (GROSS first, then leg-based net)

| model | n | gross exp | gross med R | gross PF | posR% | maxDD R | TIMEOUT% | net@2bps | net@5bps | net@10bps | net@20bps |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 111,565 | 0.0472 | -1.0000 | 1.0723 | 28.86 | -227.48 | 22.97 | -0.0994 | -0.3195 | -0.6862 | -1.4196 |
| D | 111,565 | 0.0312 | -1.0000 | 1.0560 | 39.23 | -255.53 | 19.24 | -0.1155 | -0.3355 | -0.7022 | -1.4357 |

### TP1-conditional behaviour

| model | TP1 reached n | avg realized R on TP1 trades | TP1-reached but negative | share | avg giveback after TP1 |
|---|---|---|---|---|---|
| A | 36,422 | 1.7570 | 11,515 | 31.62% | 1.7418 |
| D | 36,422 | 1.7079 | 0 | 0.00% | 1.7909 |

### Exit-reason mix

- **A**: SL 62.99% · TIMEOUT 22.97% · TP 14.04%
- **D**: SL 53.68% · BE 14.73% · TIMEOUT 13.67% · TP 12.36% · PARTIAL_TIMEOUT 5.57%

### Path analysis — where favourable excursion is lost

| path group | n | mean MFE R | mean MAE R | A exp | D exp |
|---|---|---|---|---|---|
| never TP1 | 74,999 | 0.5980 | -1.2131 | -0.7811 | -0.7811 |
| TP1 only | 13,184 | 2.3293 | -1.0383 | -0.0728 | 0.9579 |
| reached TP2 | 7,689 | 3.4321 | -0.8960 | 0.7368 | 1.2007 |
| reached final | 15,693 | 4.5040 | -0.3799 | 3.7688 | 2.5617 |

### REVERSAL vs CONTINUATION (gross)

| setup | model | n | gross exp | PF | posR% |
|---|---|---|---|---|---|
| REVERSAL | A | 14,969 | 0.0438 | 1.0586 | 24.32 |
| REVERSAL | D | 14,969 | 0.0308 | 1.0487 | 36.20 |
| CONTINUATION | A | 96,596 | 0.0478 | 1.0747 | 29.56 |
| CONTINUATION | D | 96,596 | 0.0313 | 1.0573 | 39.69 |

### Outlier dependence (gross)

| model | exp | ex top1 | ex top5 | ex top 1% | top1% share of positive R |
|---|---|---|---|---|---|
| A | 0.0472 | 0.0469 | 0.0457 | -0.0552 | 14.54% |
| D | 0.0312 | 0.0310 | 0.0302 | -0.0413 | 12.26% |


---

## VERDICT

### `H1_NOT_VALIDATED`

The TRAIN ranking reproduced exactly on VALIDATION, and the registered
prediction was correct: **Model D underperforms Model A on expectancy in both
splits.**

| metric | TRAIN A | TRAIN D | VALID A | VALID D | carried over? |
|---|---|---|---|---|---|
| gross expectancy | **0.0350** | 0.0231 | **0.0472** | 0.0312 | yes — D worse in both |
| gross PF | **1.0539** | 1.0415 | **1.0723** | 1.0560 | yes — D worse in both |
| positive rate | 28.81 % | **38.91 %** | 28.86 % | **39.23 %** | yes — D better in both |
| max drawdown R | −1143.87 | **−1001.33** | **−227.48** | −255.53 | **NO — reversed** |
| top 1 % share of positive R | 14.99 % | **12.40 %** | 14.54 % | **12.26 %** | yes — D better in both |

The single reason D was chosen — **its smaller max drawdown** — **did not
survive**. On VALIDATION D's drawdown is *worse* than A's (−255.53 vs −227.48),
a reversal of the TRAIN advantage. The drawdown benefit was a TRAIN artifact.

D's two surviving advantages (higher positive rate, lower tail dependence) are
real and replicate, but they are bought by giving up ~34 % of gross expectancy
in both splits. That is not an improvement; it is a different point on the same
losing curve. Under every cost assumption (2/5/10/20 bps) D remains behind A.

### Why H1's mechanism is real but its remedy fails

H1's premise is confirmed: **31.1 % of TRAIN trades that reach TP1 still end
negative** under the current model, with average giveback 1.83 R. Early exit
does capture that — the "TP1 only" bucket improves from −0.0072 to +1.5188 (B)
on TRAIN and −0.0728 to +0.9579 (D) on VALIDATION.

But the same rule truncates the winners. The "reached final" bucket falls from
**3.7698 → 1.8363** (B) and **3.7688 → 2.5617** (D on VALIDATION). Those 43,394
TRAIN / 15,693 VALIDATION trades carry more value than the stalled ones destroy.

The decisive number is elsewhere: **223,205 of 328,872 TRAIN trades (67.9 %)
never reach TP1 at all**, averaging −0.7611 R. Their outcome is *identical under
all four models* — no exit rule can touch them. The loss is concentrated exactly
where H1's mechanism has zero leverage, which is why redistributing outcomes
among the remaining 32 % cannot rescue the strategy.

**Implication for V2.1:** the exit ladder is not the primary defect. Effort
should go to H2 (stop geometry vs transaction cost) and H3 (selectivity —
avoiding the 67.9 % of entries that never see TP1), not to exit management.

**This does not make Model A good.** A's gross expectancy is +0.035/+0.047 R and
still flips negative once the top 1 % of winners is removed (−0.0682 TRAIN,
−0.0552 VALIDATION). The finding is that A is the *least bad* of four exit
accountings, not that it works.

### Protocol compliance

- Models, intrabar rules and fee model registered at `b0296c4`, **before** any
  comparative result.
- Candidate and its rationale registered at `bd3b826`, **before** its VALIDATION
  numbers existed, including an explicit prediction.
- VALIDATION run **once**. No return to TRAIN to adjust fractions or rules.
- Only 50 % was tested. No trailing, no TP2 management, no target changes.
- 2022–2025 TEST not used. Proposed 2026-H1 window untouched and undownloaded.
- `H1_VALIDATED_FOR_V2_1` is **not** claimed. Even had it been, it would not
  have implied production readiness.

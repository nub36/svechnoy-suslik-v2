# Structural entry audit — TRAIN

Confirmed directional setups examined: **4,424,057**

Distance quantiles come from a bounded reservoir (20,000 samples per
anchor); counts and rates are exact.

## Anchor availability and side-of-price validity

| anchor | exists | share | correct side (usable for LIMIT) | share | median dist (ATR) | median dist (%) | median width (ATR) |
|---|---|---|---|---|---|---|---|
| OB_FVG_OVERLAP | 167,070 | 3.78% | 164,859 | 3.73% | 1.3166 | 0.1461% | 0.2923 |
| OB | 1,284,148 | 29.03% | 1,068,998 | 24.16% | 1.0958 | 0.1240% | 0.7465 |
| FVG | 2,942,156 | 66.50% | 2,609,172 | 58.98% | 0.8626 | 0.0992% | 0.5539 |
| DISPLACEMENT_50 | 3,309 | 0.07% | 2,635 | 0.06% | 0.8737 | 1.1937% | 0.3392 |
| RETEST | 4,105,949 | 92.81% | 4,048,628 | 91.51% | 2.5022 | 0.3293% | 0.5000 |
| SWEEP_RECLAIM | 1,438,279 | 32.51% | 722,099 | 16.32% | 0.4919 | 0.0563% | 0.5000 |

### Usable-for-LIMIT rate by direction

| direction | n | OB_FVG_OVERLAP | OB | FVG | DISPLACEMENT_50 | RETEST | SWEEP_RECLAIM |
|---|---|---|---|---|---|---|---|
| LONG | 2,044,171 | 3.80% | 22.27% | 58.62% | 0.05% | 91.04% | 16.67% |
| SHORT | 2,379,886 | 3.66% | 25.79% | 59.28% | 0.07% | 91.92% | 16.02% |

### Usable-for-LIMIT rate by setup kind

| setup kind | n | OB_FVG_OVERLAP | OB | FVG | DISPLACEMENT_50 | RETEST | SWEEP_RECLAIM |
|---|---|---|---|---|---|---|---|
| CONTINUATION | 4,099,918 | 3.84% | 24.53% | 60.01% | 0.06% | 98.67% | 14.86% |
| REVERSAL | 324,139 | 2.28% | 19.57% | 45.90% | 0.03% | 1.04% | 34.82% |

### Usable-for-LIMIT rate by timeframe

| timeframe | n | OB_FVG_OVERLAP | OB | FVG | DISPLACEMENT_50 | RETEST | SWEEP_RECLAIM |
|---|---|---|---|---|---|---|---|
| 15m | 191,043 | 3.48% | 25.17% | 56.49% | 0.24% | 88.02% | 16.51% |
| 1d | 1,615 | 3.96% | 28.61% | 66.07% | 20.19% | 89.72% | 14.43% |
| 1h | 45,366 | 3.24% | 25.03% | 54.61% | 0.90% | 85.83% | 16.24% |
| 1m | 3,461,982 | 3.77% | 23.88% | 59.20% | 0.01% | 92.24% | 16.19% |
| 30m | 94,411 | 3.35% | 25.22% | 54.19% | 0.44% | 87.47% | 16.25% |
| 4h | 11,482 | 3.46% | 25.10% | 58.64% | 3.11% | 86.03% | 17.06% |
| 5m | 618,158 | 3.65% | 25.20% | 59.51% | 0.06% | 89.67% | 17.02% |

## Any usable anchor at all

Setups with at least one correct-side structural area: **4,290,394** (96.98% of confirmed setups)


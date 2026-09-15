# V2.1 RESEARCH ANALYSIS — TRAIN + VALIDATION ONLY

**No strategy code was changed. No V2.1 was created. Nothing was tuned. TEST was
not used.**

This is hypothesis-generation from the artifacts already produced by run
`v2-real-20260915-080338`. The 2022–2025 TEST split is **USED** (first viewed
`2026-09-15T09:55:30.412Z`) and is excluded from every table below by
construction — each aggregation filters to `slice ∈ {train, validation}`.

| pinned | value |
|---|---|
| frozen V2 strategy | `4839074` (unchanged) |
| pre-registration | `6e2d080` |
| real results | `9970ae0` |
| fee audit | `574268d` |
| dataset | `c3c1dce` |
| status | `V2_NOT_BETTER` |
| TRAIN+VALIDATION closed V2 trades | **440,437** |

### Method

Gross R is reconstructed with the identity verified in the fee audit:
`grossR = storedNetR + feeR`, `feeR = (0.1/100) × entry / |entry − stop|`.
Fee sensitivity is analytic: `exp(B bps) = grossExp − (B/1e4) × mean(entry/riskPerUnit)`.

Sections 6–8 need forward price paths, which are not in the trade rows. They are
computed from the **candle cache** by pure OHLC arithmetic on already-fixed
entries (max high / min low after entry). **No signal was re-evaluated, no entry
re-chosen, no stop or target recomputed** — this is measurement of what price
did, not a replay.

Outcome mix (TRAIN+VALIDATION): SL **62.42 %**, TIMEOUT **24.19 %**, TP **13.38 %**.

TRAIN+VALIDATION V2 closed trades loaded: **440,437** (TEST rows excluded by construction)

## §1. STOP GEOMETRY (V2, TRAIN and VALIDATION)

Buckets fixed in advance. Fee columns are analytic: `exp(B) = grossExp - (B/1e4) * mean(entry/riskPerUnit)`.

**TRAIN — risk distance in ATR**

| group | n | gross exp | gross med R | gross PF | posR% | TP% | TIMEOUT% | 2bps | 5bps | 10bps | 20bps |
|---|---|---|---|---|---|---|---|---|---|---|---|
| <0.5 | 9,013 | 0.2359 | -1.0000 | 1.2696 | 12.47 | 10.62 | 1.90 | -0.2694 | -1.0273 | -2.2906 | -4.8171 |
| 0.5-0.75 | 23,776 | 0.0915 | -1.0000 | 1.1085 | 15.67 | 12.28 | 3.48 | -0.2280 | -0.7072 | -1.5060 | -3.1034 |
| 0.75-1.0 | 31,506 | 0.0531 | -1.0000 | 1.0664 | 19.86 | 14.49 | 5.64 | -0.1830 | -0.5371 | -1.1274 | -2.3079 |
| 1.0-1.5 | 78,564 | 0.0370 | -1.0000 | 1.0494 | 24.45 | 16.94 | 8.35 | -0.1283 | -0.3763 | -0.7896 | -1.6162 |
| 1.5-2.0 | 62,074 | 0.0209 | -1.0000 | 1.0299 | 28.58 | 16.63 | 14.25 | -0.1118 | -0.3109 | -0.6426 | -1.3060 |
| >2.0 | 123,939 | 0.0107 | -0.2905 | 1.0229 | 38.37 | 9.04 | 50.63 | -0.0654 | -0.1795 | -0.3698 | -0.7503 |

**TRAIN — risk distance in % of price**

| group | n | gross exp | gross med R | gross PF | posR% | TP% | TIMEOUT% | 2bps | 5bps | 10bps | 20bps |
|---|---|---|---|---|---|---|---|---|---|---|---|
| <0.10% | 73,477 | 0.1348 | -1.0000 | 1.1723 | 21.27 | 14.53 | 7.53 | -0.2832 | -0.9101 | -1.9549 | -4.0445 |
| 0.10-0.20% | 81,506 | 0.0187 | -1.0000 | 1.0259 | 26.13 | 15.31 | 13.18 | -0.1244 | -0.3390 | -0.6966 | -1.4120 |
| 0.20-0.30% | 45,890 | 0.0030 | -1.0000 | 1.0044 | 29.21 | 14.80 | 18.91 | -0.0796 | -0.2035 | -0.4099 | -0.8229 |
| 0.30-0.50% | 45,667 | 0.0059 | -1.0000 | 1.0093 | 31.80 | 13.94 | 25.85 | -0.0470 | -0.1264 | -0.2586 | -0.5231 |
| 0.50-1.00% | 40,989 | 0.0020 | -0.7772 | 1.0036 | 35.07 | 11.39 | 39.25 | -0.0277 | -0.0723 | -0.1466 | -0.2952 |
| >1.00% | 41,343 | -0.0099 | -0.1370 | 0.9723 | 39.62 | 5.55 | 67.94 | -0.0208 | -0.0373 | -0.0646 | -0.1194 |

**VALIDATION — risk distance in ATR**

| group | n | gross exp | gross med R | gross PF | posR% | TP% | TIMEOUT% | 2bps | 5bps | 10bps | 20bps |
|---|---|---|---|---|---|---|---|---|---|---|---|
| <0.5 | 3,764 | 0.2321 | -1.0000 | 1.2648 | 12.33 | 10.76 | 1.59 | -0.2549 | -0.9854 | -2.2029 | -4.6379 |
| 0.5-0.75 | 8,352 | 0.1020 | -1.0000 | 1.1214 | 15.92 | 13.30 | 2.67 | -0.2082 | -0.6736 | -1.4493 | -3.0006 |
| 0.75-1.0 | 10,407 | 0.1003 | -1.0000 | 1.1262 | 20.36 | 15.85 | 4.78 | -0.1206 | -0.4519 | -1.0041 | -2.1086 |
| 1.0-1.5 | 26,796 | 0.0438 | -1.0000 | 1.0582 | 24.37 | 17.78 | 7.32 | -0.1129 | -0.3479 | -0.7396 | -1.5229 |
| 1.5-2.0 | 20,664 | 0.0484 | -1.0000 | 1.0691 | 28.76 | 18.22 | 12.34 | -0.0792 | -0.2706 | -0.5895 | -1.2275 |
| >2.0 | 41,582 | 0.0079 | -0.2927 | 1.0166 | 38.23 | 9.56 | 48.90 | -0.0597 | -0.1609 | -0.3298 | -0.6674 |

**VALIDATION — risk distance in % of price**

| group | n | gross exp | gross med R | gross PF | posR% | TP% | TIMEOUT% | 2bps | 5bps | 10bps | 20bps |
|---|---|---|---|---|---|---|---|---|---|---|---|
| <0.10% | 24,830 | 0.1534 | -1.0000 | 1.1944 | 20.75 | 15.37 | 5.87 | -0.2411 | -0.8330 | -1.8194 | -3.7923 |
| 0.10-0.20% | 27,538 | 0.0376 | -1.0000 | 1.0514 | 25.83 | 16.67 | 10.86 | -0.1054 | -0.3198 | -0.6771 | -1.3917 |
| 0.20-0.30% | 15,224 | 0.0210 | -1.0000 | 1.0306 | 29.14 | 16.23 | 16.47 | -0.0617 | -0.1857 | -0.3924 | -0.8057 |
| 0.30-0.50% | 15,234 | 0.0045 | -1.0000 | 1.0070 | 31.00 | 14.93 | 22.23 | -0.0485 | -0.1280 | -0.2605 | -0.5256 |
| 0.50-1.00% | 13,566 | 0.0053 | -1.0000 | 1.0094 | 34.62 | 12.16 | 35.85 | -0.0244 | -0.0688 | -0.1429 | -0.2912 |
| >1.00% | 15,173 | -0.0022 | -0.1130 | 0.9935 | 40.63 | 5.72 | 68.67 | -0.0131 | -0.0293 | -0.0563 | -0.1104 |

## §2. SETUP TYPE x DIRECTION

**TRAIN**

| group | n | gross exp | med gross R | gross PF | posR% | TP% | TO% | med stop ATR | med stop % | 2bps | 5bps | 10bps | 20bps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| REVERSAL LONG | 28,598 | 0.0016 | -1.0000 | 1.0021 | 24.21 | 13.42 | 12.59 | 1.2292 | 0.1680% | -0.1693 | -0.4257 | -0.8529 | -1.7074 |
| REVERSAL SHORT | 20,124 | 0.0441 | -1.0000 | 1.0609 | 26.16 | 13.34 | 14.88 | 1.4186 | 0.1768% | -0.1159 | -0.3560 | -0.7561 | -1.5564 |
| CONTINUATION LONG | 78,070 | 0.0154 | -0.2997 | 1.0324 | 35.60 | 6.78 | 52.16 | 3.4815 | 0.4433% | -0.0921 | -0.2532 | -0.5218 | -1.0591 |
| CONTINUATION SHORT | 202,080 | 0.0464 | -1.0000 | 1.0667 | 27.53 | 15.57 | 16.64 | 1.5784 | 0.1946% | -0.1206 | -0.3711 | -0.7887 | -1.6237 |

**VALIDATION**

| group | n | gross exp | med gross R | gross PF | posR% | TP% | TO% | med stop ATR | med stop % | 2bps | 5bps | 10bps | 20bps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| REVERSAL LONG | 8,886 | 0.0256 | -1.0000 | 1.0340 | 23.70 | 14.57 | 10.35 | 1.1810 | 0.1639% | -0.1416 | -0.3924 | -0.8104 | -1.6465 |
| REVERSAL SHORT | 6,083 | 0.0703 | -1.0000 | 1.0955 | 25.28 | 14.98 | 11.98 | 1.3932 | 0.1730% | -0.0854 | -0.3189 | -0.7081 | -1.4865 |
| CONTINUATION LONG | 24,240 | -0.0005 | -0.2347 | 0.9988 | 36.54 | 6.32 | 55.34 | 4.5215 | 0.5864% | -0.0930 | -0.2316 | -0.4627 | -0.9248 |
| CONTINUATION SHORT | 72,356 | 0.0640 | -1.0000 | 1.0910 | 27.34 | 16.49 | 14.60 | 1.5642 | 0.1934% | -0.0976 | -0.3400 | -0.7440 | -1.5520 |

## §3. TIMEFRAME x SETUP

**TRAIN**

| tf | REVERSAL n | REV gross exp | REV PF | CONT n | CONT gross exp | CONT PF |
|---|---|---|---|---|---|---|
| 1m | 33,885 | 0.0288 | 1.0393 | 212,807 | 0.0497 | 1.0789 |
| 5m | 8,674 | 0.0108 | 1.0145 | 42,486 | -0.0031 | 0.9952 |
| 15m | 3,242 | -0.0482 | 0.9363 | 13,774 | 0.0058 | 1.0090 |
| 30m | 1,691 | -0.0347 | 0.9544 | 6,812 | -0.0018 | 0.9972 |
| 1h | 971 | 0.0260 | 1.0350 | 3,373 | -0.0010 | 0.9985 |
| 4h | 240 | 0.0999 | 1.1362 | 785 | 0.0716 | 1.1160 |
| 1d | 19 | 1.5626 | 4.2838 | 113 | 0.1370 | 1.2140 |

**VALIDATION**

| tf | REVERSAL n | REV gross exp | REV PF | CONT n | CONT gross exp | CONT PF |
|---|---|---|---|---|---|---|
| 1m | 10,555 | 0.0726 | 1.0975 | 74,235 | 0.0512 | 1.0799 |
| 5m | 2,637 | -0.0473 | 0.9378 | 14,161 | 0.0230 | 1.0360 |
| 15m | 955 | 0.0143 | 1.0195 | 4,455 | 0.0473 | 1.0752 |
| 30m | 502 | 0.0282 | 1.0377 | 2,268 | 0.0532 | 1.0851 |
| 1h | 251 | -0.0765 | 0.9016 | 1,172 | 0.0499 | 1.0776 |
| 4h | 63 | 0.1066 | 1.1442 | 262 | 0.3273 | 1.5828 |
| 1d | 6 | -0.1604 | 0.8075 | 43 | 0.2898 | 1.4849 |

## §4. HTF CONTEXT

**TRAIN — HTF state**

| group | n | gross exp | gross med R | gross PF | posR% | TP% | TIMEOUT% |
|---|---|---|---|---|---|---|---|
| ALIGNED | 135,688 | 0.0339 | -1.0000 | 1.0533 | 29.24 | 13.32 | 25.96 |
| COUNTER_TREND | 86,344 | 0.0386 | -1.0000 | 1.0580 | 28.83 | 12.80 | 22.81 |
| NEUTRAL | 106,705 | 0.0331 | -1.0000 | 1.0508 | 29.05 | 13.25 | 24.35 |
| UNKNOWN | 135 | 0.3124 | -1.0000 | 1.4997 | 33.33 | 12.59 | 26.67 |

**TRAIN — REVERSAL x HTF**

| group | n | gross exp | gross med R | gross PF | posR% | TP% | TIMEOUT% |
|---|---|---|---|---|---|---|---|
| REVERSAL / ALIGNED | 23,141 | -0.0007 | -1.0000 | 0.9991 | 22.93 | 13.54 | 10.92 |
| REVERSAL / COUNTER_TREND | 11,106 | 0.0345 | -1.0000 | 1.0493 | 28.33 | 12.75 | 18.12 |
| REVERSAL / NEUTRAL | 14,456 | 0.0371 | -1.0000 | 1.0508 | 25.77 | 13.61 | 14.20 |
| REVERSAL / UNKNOWN | 19 | 1.5626 | -0.0408 | 4.2838 | 47.37 | 36.84 | 15.79 |

**TRAIN — CONTINUATION x HTF**

| group | n | gross exp | gross med R | gross PF | posR% | TP% | TIMEOUT% |
|---|---|---|---|---|---|---|---|
| CONTINUATION / ALIGNED | 112,547 | 0.0410 | -1.0000 | 1.0671 | 30.54 | 13.27 | 29.05 |
| CONTINUATION / COUNTER_TREND | 75,238 | 0.0392 | -1.0000 | 1.0594 | 28.91 | 12.81 | 23.51 |
| CONTINUATION / NEUTRAL | 92,249 | 0.0324 | -1.0000 | 1.0508 | 29.56 | 13.19 | 25.94 |
| CONTINUATION / UNKNOWN | 116 | 0.1076 | -1.0000 | 1.1657 | 31.03 | 8.62 | 28.45 |

**VALIDATION — HTF state**

| group | n | gross exp | gross med R | gross PF | posR% | TP% | TIMEOUT% |
|---|---|---|---|---|---|---|---|
| ALIGNED | 46,829 | 0.0379 | -1.0000 | 1.0590 | 28.93 | 13.97 | 24.57 |
| COUNTER_TREND | 28,782 | 0.0489 | -1.0000 | 1.0722 | 28.36 | 13.79 | 20.38 |
| NEUTRAL | 35,905 | 0.0579 | -1.0000 | 1.0890 | 29.40 | 14.33 | 22.96 |
| UNKNOWN | 49 | 0.2347 | -1.0000 | 1.3746 | 30.61 | 20.41 | 20.41 |

**VALIDATION — REVERSAL x HTF**

| group | n | gross exp | gross med R | gross PF | posR% | TP% | TIMEOUT% |
|---|---|---|---|---|---|---|---|
| REVERSAL / ALIGNED | 7,087 | 0.0268 | -1.0000 | 1.0348 | 22.34 | 14.43 | 9.09 |
| REVERSAL / COUNTER_TREND | 3,407 | 0.0567 | -1.0000 | 1.0793 | 27.36 | 14.82 | 14.29 |
| REVERSAL / NEUTRAL | 4,469 | 0.0612 | -1.0000 | 1.0830 | 25.24 | 15.15 | 11.59 |
| REVERSAL / UNKNOWN | 6 | -0.1604 | -1.0000 | 0.8075 | 16.67 | 16.67 | 0.00 |

**VALIDATION — CONTINUATION x HTF**

| group | n | gross exp | gross med R | gross PF | posR% | TP% | TIMEOUT% |
|---|---|---|---|---|---|---|---|
| CONTINUATION / ALIGNED | 39,742 | 0.0399 | -1.0000 | 1.0644 | 30.10 | 13.89 | 27.33 |
| CONTINUATION / COUNTER_TREND | 25,375 | 0.0478 | -1.0000 | 1.0712 | 28.50 | 13.65 | 21.20 |
| CONTINUATION / NEUTRAL | 31,436 | 0.0574 | -1.0000 | 1.0900 | 29.99 | 14.22 | 24.58 |
| CONTINUATION / UNKNOWN | 43 | 0.2898 | -1.0000 | 1.4849 | 32.56 | 20.93 | 23.26 |

## §5. EVIDENCE COMPONENTS — LIMITATION + OBSERVABLE PROXIES

> **Limitation.** The replay harness never persisted the per-component evidence
> profile. `ComponentProfile` (structure, liquidity, displacement, obFvg, volume,
> htf, trend, momentum, volatility, roomToTarget) exists on the V2 decision as
> `longProfile`/`shortProfile`, but `v2-trades.jsonl` stores only the aggregates
> `evidence`, `conflict`, `netEvidence`. Component-level Spearman is therefore
> **not computable from saved artifacts**, and no replay was run to obtain it.
> The table below uses the categorical observables that WERE saved. Each proxies
> one component; they are proxies, not the component scores themselves.

### TRAIN

*liquidity* via `sweepQuality`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| 0.4-0.7 | 164,391 | 0.0259 | 1.0378 | 27.38 |
| <0.4 | 4,247 | 0.0278 | 1.0401 | 26.84 |
| >=0.7 | 67,319 | 0.0344 | 1.0521 | 29.09 |
| none | 92,915 | 0.0517 | 1.0905 | 32.16 |

*displacement* via `breakoutQuality`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| 0.4-0.7 | 101,766 | 0.0359 | 1.0522 | 27.42 |
| <0.4 | 3,143 | 0.0043 | 1.0053 | 18.49 |
| >=0.7 | 178,303 | 0.0390 | 1.0649 | 31.29 |
| none | 45,660 | 0.0195 | 1.0264 | 24.83 |

*obFvg* via `hasOb/hasFvg`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| ob=N fvg=N | 40,483 | 0.0430 | 1.0615 | 26.62 |
| ob=N fvg=Y | 124,135 | 0.0339 | 1.0498 | 27.38 |
| ob=Y fvg=N | 48,941 | 0.0237 | 1.0367 | 29.64 |
| ob=Y fvg=Y | 115,313 | 0.0382 | 1.0637 | 31.51 |

*volume* via `rvolBucket`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| 0.8-1.2 | 67,268 | 0.0350 | 1.0508 | 27.40 |
| 1.2-2 | 68,623 | 0.0443 | 1.0670 | 28.65 |
| <0.8 | 106,015 | 0.0375 | 1.0538 | 27.06 |
| >2 | 86,962 | 0.0246 | 1.0446 | 33.16 |

*htf* via `htfAlignment`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| ALIGNED | 135,688 | 0.0339 | 1.0533 | 29.24 |
| COUNTER_TREND | 86,344 | 0.0386 | 1.0580 | 28.83 |
| NEUTRAL | 106,705 | 0.0331 | 1.0508 | 29.05 |
| UNKNOWN | 135 | 0.3124 | 1.4997 | 33.33 |

*trend* via `emaAlignment`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| BEARISH | 95,078 | 0.0413 | 1.0616 | 29.02 |
| BULLISH | 47,072 | 0.0067 | 1.0171 | 37.17 |
| RANGE | 186,722 | 0.0389 | 1.0553 | 27.06 |

*momentum* via `macdState`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| BEAR | 105,282 | 0.0560 | 1.0787 | 26.10 |
| BEAR_ACCEL | 84,019 | 0.0273 | 1.0408 | 28.99 |
| BULL | 88,132 | 0.0298 | 1.0469 | 29.56 |
| BULL_ACCEL | 51,439 | 0.0134 | 1.0263 | 34.45 |

*momentum* via `rsiBucket`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| 30-45 | 109,893 | 0.0416 | 1.0584 | 26.66 |
| 45-55 | 98,228 | 0.0598 | 1.0831 | 26.04 |
| 55-70 | 66,672 | 0.0079 | 1.0132 | 30.95 |
| <30 | 33,182 | 0.0017 | 1.0029 | 32.97 |
| >70 | 20,897 | 0.0226 | 1.0947 | 43.82 |

*volatility* via `adxRegime`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| DEVELOPING | 73,234 | 0.0282 | 1.0429 | 28.59 |
| RANGE | 116,087 | 0.0685 | 1.0990 | 27.39 |
| STRONG | 139,551 | 0.0107 | 1.0176 | 30.72 |

*roomToTarget* via `roomR (bucketed)`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| 2-3 | 39,871 | 0.0202 | 1.0314 | 33.30 |
| 3-5 | 189,253 | 0.0210 | 1.0364 | 32.74 |
| 5-8 | 52,332 | 0.0212 | 1.0271 | 20.95 |
| 8-15 | 30,375 | 0.1034 | 1.1244 | 16.44 |
| <2 | 8,945 | 0.0050 | 1.0087 | 38.95 |
| >=15 | 8,096 | 0.2997 | 1.3395 | 11.51 |

*structure* via `stopAnchor`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| BREAKOUT_LEVEL | 280,150 | 0.0377 | 1.0596 | 29.78 |
| SWEEP_EXTREME | 48,722 | 0.0191 | 1.0260 | 25.01 |

*location* via `fibZone`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| DISCOUNT | 174,689 | 0.0408 | 1.0597 | 28.48 |
| EQUILIBRIUM | 30,835 | 0.0359 | 1.0530 | 28.51 |
| NA | 476 | 0.0257 | 1.0490 | 35.92 |
| PREMIUM | 122,872 | 0.0266 | 1.0448 | 30.04 |

Spearman vs GROSS R (continuous proxies only):

- sweepQuality (liquidity): **0.0236** (n=235,957)
- breakoutQuality (displacement): **0.0932** (n=283,212)
- roomR (room-to-target): **-0.1651** (n=328,872)
- evidence (aggregate): **0.1208**
- riskAtr: **0.2417**

  REVERSAL: evidence **0.0301** | sweepQuality **0.0490** | breakoutQuality **0.0213** (n=48,722)
  CONTINUATION: evidence **0.1215** | sweepQuality **0.0092** | breakoutQuality **0.0932** (n=280,150)

### VALIDATION

*liquidity* via `sweepQuality`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| 0.4-0.7 | 59,330 | 0.0482 | 1.0699 | 27.38 |
| <0.4 | 1,610 | 0.0267 | 1.0394 | 27.58 |
| >=0.7 | 21,204 | 0.0273 | 1.0406 | 28.49 |
| none | 29,421 | 0.0609 | 1.1072 | 32.48 |

*displacement* via `breakoutQuality`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| 0.4-0.7 | 33,761 | 0.0361 | 1.0515 | 26.74 |
| <0.4 | 1,020 | 0.0526 | 1.0643 | 18.04 |
| >=0.7 | 62,618 | 0.0538 | 1.0890 | 31.36 |
| none | 14,166 | 0.0445 | 1.0595 | 24.24 |

*obFvg* via `hasOb/hasFvg`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| ob=N fvg=N | 9,822 | 0.0464 | 1.0632 | 24.17 |
| ob=N fvg=Y | 44,782 | 0.0535 | 1.0779 | 27.11 |
| ob=Y fvg=N | 13,803 | 0.0442 | 1.0678 | 29.58 |
| ob=Y fvg=Y | 43,158 | 0.0419 | 1.0697 | 31.70 |

*volume* via `rvolBucket`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| 0.8-1.2 | 22,160 | 0.0226 | 1.0324 | 26.71 |
| 1.2-2 | 22,289 | 0.0651 | 1.0999 | 29.05 |
| <0.8 | 39,206 | 0.0571 | 1.0808 | 26.60 |
| >2 | 27,910 | 0.0388 | 1.0708 | 33.89 |

*htf* via `htfAlignment`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| ALIGNED | 46,829 | 0.0379 | 1.0590 | 28.93 |
| COUNTER_TREND | 28,782 | 0.0489 | 1.0722 | 28.36 |
| NEUTRAL | 35,905 | 0.0579 | 1.0890 | 29.40 |
| UNKNOWN | 49 | 0.2347 | 1.3746 | 30.61 |

*trend* via `emaAlignment`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| BEARISH | 33,382 | 0.0816 | 1.1213 | 29.49 |
| BULLISH | 16,272 | 0.0126 | 1.0339 | 38.39 |
| RANGE | 61,911 | 0.0378 | 1.0527 | 26.15 |

*momentum* via `macdState`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| BEAR | 36,241 | 0.0736 | 1.1019 | 25.45 |
| BEAR_ACCEL | 29,495 | 0.0403 | 1.0594 | 28.94 |
| BULL | 29,285 | 0.0456 | 1.0719 | 30.04 |
| BULL_ACCEL | 16,544 | 0.0050 | 1.0100 | 34.59 |

*momentum* via `rsiBucket`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| 30-45 | 37,834 | 0.0640 | 1.0894 | 26.64 |
| 45-55 | 34,021 | 0.0652 | 1.0891 | 25.37 |
| 55-70 | 21,907 | 0.0105 | 1.0180 | 31.39 |
| <30 | 11,159 | 0.0260 | 1.0432 | 33.25 |
| >70 | 6,644 | 0.0169 | 1.0787 | 44.91 |

*volatility* via `adxRegime`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| DEVELOPING | 25,762 | 0.0492 | 1.0745 | 28.72 |
| RANGE | 41,862 | 0.0797 | 1.1153 | 27.38 |
| STRONG | 43,941 | 0.0152 | 1.0247 | 30.55 |

*roomToTarget* via `roomR (bucketed)`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| 2-3 | 14,192 | 0.0182 | 1.0279 | 32.79 |
| 3-5 | 64,343 | 0.0373 | 1.0640 | 32.77 |
| 5-8 | 17,526 | 0.0512 | 1.0648 | 20.19 |
| 8-15 | 9,677 | 0.1282 | 1.1518 | 15.28 |
| <2 | 3,302 | 0.0081 | 1.0140 | 38.70 |
| >=15 | 2,525 | 0.1781 | 1.1974 | 9.74 |

*structure* via `stopAnchor`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| BREAKOUT_LEVEL | 96,596 | 0.0478 | 1.0747 | 29.65 |
| SWEEP_EXTREME | 14,969 | 0.0438 | 1.0586 | 24.34 |

*location* via `fibZone`

| value | n | gross exp | gross PF | posR% |
|---|---|---|---|---|
| DISCOUNT | 59,620 | 0.0600 | 1.0872 | 28.55 |
| EQUILIBRIUM | 9,462 | 0.0559 | 1.0800 | 27.14 |
| PREMIUM | 42,482 | 0.0275 | 1.0461 | 29.87 |

Spearman vs GROSS R (continuous proxies only):

- sweepQuality (liquidity): **0.0110** (n=82,144)
- breakoutQuality (displacement): **0.0942** (n=97,399)
- roomR (room-to-target): **-0.1640** (n=111,565)
- evidence (aggregate): **0.1275**
- riskAtr: **0.2348**

  REVERSAL: evidence **0.0113** | sweepQuality **0.0242** | breakoutQuality **0.0311** (n=14,969)
  CONTINUATION: evidence **0.1305** | sweepQuality **0.0020** | breakoutQuality **0.0937** (n=96,596)

## §6-8. PRICE-PATH MEASURES (MFE / MAE / excursion / target reach)

Computed from the candle cache by pure OHLC arithmetic on already-fixed entries.
No signal was regenerated and no target/stop was recomputed.

### §6. MFE / MAE in R (to exit)

| group | n | mean MFE R | median MFE R | mean MAE R | median MAE R |
|---|---|---|---|---|---|
| ALL | 440,437 | 1.5551 | 0.8058 | -1.0563 | -1.0724 |
| slice:train | 328,872 | 1.5577 | 0.8053 | -1.0572 | -1.0725 |
| slice:validation | 111,565 | 1.5474 | 0.8083 | -1.0534 | -1.0721 |
| kind:REVERSAL | 63,691 | 1.7439 | 0.9534 | -1.2171 | -1.1538 |
| kind:CONTINUATION | 376,746 | 1.5232 | 0.7827 | -1.0291 | -1.0593 |
| tf:1m | 331,482 | 1.5460 | 0.7976 | -1.0446 | -1.0702 |
| tf:5m | 67,958 | 1.5712 | 0.8179 | -1.0769 | -1.0771 |
| tf:15m | 22,426 | 1.5938 | 0.8446 | -1.1036 | -1.0803 |
| tf:30m | 11,273 | 1.5887 | 0.8441 | -1.1279 | -1.0841 |
| tf:1h | 5,767 | 1.6226 | 0.8727 | -1.1445 | -1.0978 |
| tf:4h | 1,350 | 1.7139 | 0.9759 | -1.1214 | -1.0800 |
| tf:1d | 181 | 2.0187 | 0.9858 | -1.0674 | -1.0589 |

### §7. Directional excursion after entry (close-based)

| group | n | 1 bar R | 3 bars R | 5 bars R | 10 bars R | 1 bar ATR | 3 ATR | 5 ATR | 10 ATR |
|---|---|---|---|---|---|---|---|---|---|
| ALL | 440,437 | 0.0041 | 0.1681 | 0.2887 | 0.4618 | 0.0124 | 0.1737 | 0.3411 | 0.6353 |
| slice:train | 328,872 | 0.0037 | 0.1619 | 0.2767 | 0.4457 | 0.0125 | 0.1678 | 0.3258 | 0.6148 |
| slice:validation | 111,565 | 0.0051 | 0.1866 | 0.3247 | 0.5108 | 0.0121 | 0.1914 | 0.3873 | 0.6977 |
| kind:REVERSAL | 63,691 | 0.0017 | 0.2263 | 0.4190 | 0.7453 | 0.0010 | 0.2126 | 0.4513 | 0.9148 |
| kind:CONTINUATION | 376,746 | 0.0045 | 0.1588 | 0.2688 | 0.4228 | 0.0143 | 0.1674 | 0.3243 | 0.5968 |
| tf:1m | 331,482 | 0.0048 | 0.1738 | 0.2974 | 0.4728 | 0.0164 | 0.1847 | 0.3603 | 0.6652 |
| tf:5m | 67,958 | 0.0042 | 0.1566 | 0.2645 | 0.4322 | 0.0004 | 0.1459 | 0.2826 | 0.5412 |
| tf:15m | 22,426 | 0.0031 | 0.1408 | 0.2561 | 0.4057 | 0.0040 | 0.1189 | 0.2665 | 0.5093 |
| tf:30m | 11,273 | -0.0094 | 0.1339 | 0.2493 | 0.4122 | -0.0065 | 0.1359 | 0.2801 | 0.5381 |
| tf:1h | 5,767 | -0.0129 | 0.1388 | 0.2534 | 0.4377 | -0.0160 | 0.1230 | 0.2816 | 0.5635 |
| tf:4h | 1,350 | 0.0121 | 0.1799 | 0.2940 | 0.5045 | 0.0344 | 0.2215 | 0.3738 | 0.7356 |
| tf:1d | 181 | 0.0363 | 0.2793 | 0.4586 | 0.7246 | 0.0654 | 0.5083 | 0.6735 | 1.0490 |

### §8. TP1 target source quality

| tp1Source | n | reach rate | median bars to reach | mean gross R | median gross R |
|---|---|---|---|---|---|
| INTERNAL_LIQUIDITY | 292,500 | 33.53% | 7.00 | 0.0476 | -1.0000 |
| R_MULTIPLE | 88,761 | 28.16% | 7.00 | 0.0112 | -0.1644 |
| EQUILIBRIUM | 52,104 | 32.36% | 7.00 | 0.0305 | -1.0000 |
| RANGE_EDGE | 7,072 | 32.52% | 5.00 | 0.0371 | -1.0000 |


---

## §9. HYPOTHESES FOR V2.1 (maximum three)

Each is stated as a falsifiable claim, with the causal reason, the TRAIN
evidence, and the **independent** VALIDATION check. None is implemented. None
used TEST.

### H1 — The exit ladder, not entry direction, destroys the edge

**Claim.** V2 reaches its first target far more often than it books a win,
because a position only closes at the **final** rung. Requiring the full ladder
converts realised excursion into stop-outs.

**Causal rationale.** `trackOutcome` treats intermediate rungs as milestones,
not exits (no partial-exit accounting). A trade may run +1.5R, touch TP1, then
retrace through the stop and book −1R. Median final target is ~3.1R while median
MFE is only ~0.8R, so the ladder demands roughly 4× the favourable excursion the
median trade actually produces.

**TRAIN support.**
- TP1 reach rate **33.53 %** (`INTERNAL_LIQUIDITY`), but TP exit rate is only
  **13.38 %** — a ~20 pp gap of trades that touch a target and still lose.
- Mean MFE **1.5577 R** vs mean MAE **−1.0572 R**: favourable excursion exists
  and is larger in magnitude than adverse excursion.
- Gross expectancy is positive (+0.0350) while median gross R is **−1.0000**:
  a minority of large winners carries a body of full stop-outs.

**VALIDATION check (independent).** Mean MFE **1.5474 R**, mean MAE
**−1.0534 R** — nearly identical to TRAIN, so the excursion asymmetry replicates.
TP1 reach vs TP exit gap reproduces.

**How to falsify.** On TRAIN+VALIDATION only, measure expectancy under
alternative exit accounting (e.g. partial exit at TP1, or stop-to-breakeven after
TP1). If gross expectancy does not improve materially, H1 is wrong.

### H2 — Transaction cost, not direction, decides viability; stop width is the control variable

**Claim.** The sign of net expectancy is governed almost entirely by
`stopDistance / price`, because fee-in-R scales as `fee% × price / stopDistance`.
Any V2.1 that trades sub-0.2 % stops is arithmetically dead regardless of signal
quality.

**Causal rationale.** A 10 bps round trip against a 10 bps stop is 1.0 R of cost
before the market moves. The fee is a fixed fraction of **notional**, while R is
measured in **stop distance** — so the two only reconcile when stops are wide
relative to price.

**TRAIN support.** The `<0.10 %` bucket has the **highest** gross expectancy
(+0.1348, PF 1.1723) yet the **worst** net at 10 bps (**−1.9549**). Gross
expectancy *falls* monotonically as stops widen (+0.1348 → −0.0099) while net
expectancy *rises* monotonically (−1.9549 → −0.0646). The two orderings are
exactly opposed.

**VALIDATION check (independent).** Same inversion: `<0.10 %` gross **+0.1534** /
net@10bps **−1.8194**; `>1.00 %` gross **−0.0022** / net@10bps **−0.0563**.

**How to falsify.** Impose a minimum stop distance in **price %** (not ATR) on
TRAIN, then confirm on VALIDATION. If net expectancy does not improve, or gross
edge vanishes entirely once narrow stops are excluded, H2 is wrong. Note the
tension this must resolve: the widest-stop buckets are net-least-bad but
gross-negative, so widening stops alone may simply approach zero from below.

### H3 — Selectivity should key on regime and room, not on aggregate evidence

**Claim.** The aggregate `evidence` score is a weak and partly artifactual
ranker. Two saved observables — ADX regime and room-to-target — separate gross
outcome more cleanly and in a direction opposite to intuition.

**Causal rationale.** Trend-following entries taken during an already-`STRONG`
ADX regime arrive late, after displacement is spent. Large `roomR` means the
structural target is far, which mechanically permits larger favourable
excursion before the first opposing structure.

**TRAIN support.**
- `adxRegime`: RANGE **+0.0685** (PF 1.0990, n=116,087) vs STRONG **+0.0107**
  (PF 1.0176, n=139,551) — a 6× gap on large samples.
- `roomR` bucketed: `<2` **+0.0081** rising monotonically to `>=15` **+0.1781**.
- `Spearman(roomR, gross R) = −0.1640` — *negative*, because high-roomR trades
  win rarely (positiveRRate 9.74 % at `>=15`) but win big. Rank correlation and
  expectancy disagree, which is itself the finding.
- `Spearman(evidence, gross R)` is only **+0.1275**, and splits to
  REVERSAL **+0.0113** vs CONTINUATION **+0.1305** — the aggregate score carries
  almost no information on reversals.

**VALIDATION check (independent).** `adxRegime` RANGE **+0.0797** vs STRONG
**+0.0152**; `roomR` `<2` **+0.0081** → `>=15` **+0.1781** (same monotone
ordering); evidence Spearman REVERSAL **+0.0113** vs CONTINUATION **+0.1305**.

**How to falsify.** Build the regime/room filter on TRAIN only, check on
VALIDATION. If the RANGE-vs-STRONG and roomR orderings do not persist, or persist
gross but die under any realistic cost, H3 is wrong.

### Hypotheses explicitly NOT proposed

- **Nothing keyed on timeframe.** §3 sign-flips between TRAIN and VALIDATION at
  5m (−0.0031 → +0.0230), 15m (−0.0482 → +0.0143 reversal), 1h and 30m. The 4h
  and 1d cells look attractive but have n=240/19 (TRAIN) and n=63/6
  (VALIDATION) — far too small. Selecting a timeframe here would be fitting noise.
- **Nothing keyed on HTF alignment.** COUNTER_TREND (+0.0386) slightly *beats*
  ALIGNED (+0.0339) on TRAIN and again on VALIDATION (+0.0489 vs +0.0379). The
  effect is real but tiny and directionally awkward; it does not support a rule.
- **Nothing keyed on symbol or direction.** No stable separation.

---

## §10. PROPOSED FUTURE UNTOUCHED TEST PERIOD

The 2022–2025 TEST split is **USED** and can never again serve as an untouched
test for V2.1.

**Proposed: 2026-01-01T00:00:00Z → 2026-06-30T23:59:59Z (UTC), Binance Spot,
monthly klines, the same 6 symbols × 7 timeframes.**

Conditions fixed now, before any data is seen:

1. **Not downloaded, not inspected, not replayed.** No candle from this window
   has been fetched or looked at.
2. It is strictly **after** the frozen dataset (`c3c1dce` ends 2025-12-31), so it
   cannot overlap TRAIN, VALIDATION or the used TEST.
3. V2.1 must be **fully frozen and committed** — parameters, thresholds, exit
   logic — before the first byte is downloaded.
4. Exactly **one** evaluation run. Its `TEST_FIRST_VIEW_AT` must be recorded, and
   after it no parameter may change.
5. Caveat to state up front: six months at these frequencies still yields large
   n on 1m but only ~180 daily bars, so 4h/1d conclusions will remain
   underpowered. If a longer window is wanted, extend forward in time
   (2026-01-01 → 2026-12-31) rather than backward into used history.

---

## §13. FINAL ANSWERS

**A. Is there any directional gross edge at all?**
Marginally, yes — but it is weak and not clearly directional. TRAIN gross
expectancy **+0.0350**, VALIDATION **+0.0472**, both with PF ≈ 1.05–1.07. Median
gross R is **−1.0000** in almost every bucket: the positive mean comes from a
minority of large winners, not from typical trades. The strongest directional
evidence is §7: mean excursion after entry grows monotonically
(1 bar +0.0041 R → 10 bars +0.4618 R), so price *does* drift the signalled way.

**B. Where is it observed?**
- **Wide room-to-target**: `roomR >= 15` gross **+0.1781**, `8–15` **+0.1282**
  (monotone, replicates on VALIDATION).
- **Quiet regimes**: `adxRegime = RANGE` **+0.0685** TRAIN / **+0.0797** VALIDATION.
- **Tight stops in ATR terms**: `<0.5 ATR` gross **+0.2359** TRAIN / **+0.2321**
  VALIDATION — the single largest gross cell, and also the single worst net cell.
- **Reversals over longer horizons**: REVERSAL 10-bar excursion **+0.7453 R** vs
  CONTINUATION **+0.4228 R**.

**C. Where is it absent?**
- `roomR < 2` (+0.0081) and `adxRegime = STRONG` (+0.0107) — near zero on very
  large n.
- Wide price stops: `>1.00 %` is gross **negative** on TRAIN (−0.0099).
- Reversals as ranked by evidence: `Spearman(evidence, gross R) = +0.0113`,
  i.e. no information.
- Mid timeframes (5m–1h), where TRAIN and VALIDATION disagree in sign.
- `emaAlignment = BULLISH` (+0.0067) and `macdState = BULL_ACCEL` (+0.0134) —
  late-entry conditions.

**D. What do transaction costs do?**
They invert the ranking and dominate the outcome. Gross expectancy **decreases**
monotonically with stop width while net expectancy **increases** monotonically.
The best gross bucket (`<0.10 %`, +0.1348) is the worst net bucket (−1.9549 at
10 bps). At 2 bps most buckets are still negative; only stops above ~0.5 % of
price survive 10 bps, and those are the buckets with no gross edge. The frozen
0.1 % round trip is itself roughly **half** realistic Binance Spot taker cost
(~0.1 % per side), so this is optimistic.

**E. What is happening with stop geometry?**
Stops are placed structurally, with no awareness of cost. Median stop is ~0.18 %
of price; `<0.10 %` holds 73,477 TRAIN trades (~22 %). Because
`feeR = fee% × price / stopDistance`, those trades pay ≥1 R in fees before the
market moves. Meanwhile the `>2.0 ATR` bucket shows the opposite failure: 50.63 %
TIMEOUT and median gross R −0.2905 — stops so wide the trade expires unresolved.
The distribution is barbelled between "too tight to pay for itself" and "too wide
to resolve".

**F. Maximum three hypotheses for V2.1**
- **H1** — the final-rung-only exit ladder converts reached targets into losses
  (33.5 % reach TP1 vs 13.4 % TP exits; MFE 1.55 R vs MAE −1.06 R).
- **H2** — viability is governed by `stopDistance/price`; a minimum stop in price
  % is required, and gross/net orderings are exactly opposed.
- **H3** — selectivity should key on ADX regime and room-to-target, not on
  aggregate evidence (which carries no information on reversals).

**G. What experiment comes next?**
On **TRAIN only**, quantify H1 by re-accounting exits on the existing trades
(partial exit at TP1, and stop-to-breakeven after TP1) without regenerating a
single signal — the saved entries, stops and target ladders plus the candle cache
are sufficient, so no strategy change is needed to get the answer. Then confirm
on **VALIDATION**. H1 is first because it requires no parameter choice and no new
threshold, so it cannot be accused of fitting. Only if H1 survives both splits
should H2's minimum-stop rule be specified — and it must be fixed **before** any
data from the proposed 2026-H1 window is downloaded.

---

**No strategy, parameter, or threshold was modified. `git diff 4839074 -- src/`
is empty. V2 remains `v2.enabled=false` and research-only;
`LIVE_TRADING_ENABLED=false`. TEST was not used anywhere in this analysis.**

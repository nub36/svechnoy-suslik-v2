# TIMEFRAME × COST DIAGNOSTIC — TRAIN ONLY

**Question:** at which timeframe does a 0.1 % Binance Spot round-trip fee stop
destroying the gross edge?

TRAIN only. VALIDATION and TEST untouched. No strategy code changed —
`git diff 4839074 -- src/` is empty. No parameter tuned; this is measurement.

| pinned | value |
|---|---|
| frozen strategy | `4839074` |
| dataset | `c3c1dce` (re-cloned, manifest verified bit-identical) |
| slice | TRAIN, per-series boundaries from frozen `splits.json` |
| arms | **A** = frozen baseline (OPEN N+1, no gates) · **FULL** = extreme + fee guard + confluence + corridor |

Gross is reconstructed exactly as `grossR = storedR + (0.1/100) × entry / risk`,
since `trackOutcome` returns an R already net of the frozen fee.

---

## 1. ARM A — the natural stop geometry

| TF | n | median stop % | stop ATR | fee drag R | **gross R** | **net R @0.1 %** | gross PF | **break-even bps** | survives 10 bps |
|---|---|---|---|---|---|---|---|---|---|
| 1m | 246,693 | 0.1874 | 1.716 | **0.9132** | +0.0468 | **−0.8664** | 1.0727 | 0.51 | ❌ |
| 5m | 51,160 | 0.3676 | 1.506 | 0.4001 | −0.0007 | −0.4008 | 0.9989 | −0.02 | ❌ |
| 15m | 17,016 | 0.6535 | 1.440 | 0.2200 | −0.0045 | −0.2245 | 0.9933 | −0.20 | ❌ |
| 30m | 8,503 | 0.9432 | 1.427 | 0.1465 | −0.0084 | −0.1549 | 0.9875 | −0.57 | ❌ |
| 1h | 4,344 | 1.3044 | 1.394 | 0.1032 | +0.0051 | −0.0982 | 1.0075 | 0.49 | ❌ |
| **4h** | 1,025 | 2.8145 | 1.395 | 0.0462 | **+0.0782** | **+0.0321** | 1.1214 | **16.95** | ✅ |
| **1d** | 132 | 8.8304 | 1.503 | 0.0159 | **+0.3422** | **+0.3263** | 1.5549 | **215.61** | ✅ |

## 2. ARM FULL — with all three filters and the corridor

| TF | n | median stop % | stop ATR | fee drag R | **gross R** | **net R @0.1 %** | gross PF | **break-even bps** | survives 10 bps |
|---|---|---|---|---|---|---|---|---|---|
| 1m | 38,375 | 0.7762 | 6.132 | 0.1394 | +0.0026 | −0.1368 | 1.0072 | 0.18 | ❌ |
| 5m | 10,699 | 1.1533 | 3.311 | 0.1071 | −0.0045 | −0.1117 | 0.9900 | −0.42 | ❌ |
| 15m | 3,971 | 1.6728 | 2.812 | 0.0817 | +0.0421 | −0.0396 | 1.0905 | 5.15 | ❌ |
| 30m | 2,104 | 2.0675 | 2.549 | 0.0668 | +0.0303 | −0.0365 | 1.0617 | 4.53 | ❌ |
| **1h** | 1,037 | 2.7962 | 2.466 | 0.0507 | **+0.0801** | **+0.0294** | 1.1629 | **15.79** | ✅ |
| **4h** | 255 | 6.0488 | 2.510 | 0.0224 | **+0.1710** | **+0.1486** | 1.3684 | **76.45** | ✅ |
| **1d** | 45 | 18.4047 | 2.164 | 0.0093 | **+0.4350** | **+0.4257** | 1.9735 | **468.67** | ✅ |

---

## 3. The answer

### Baseline: the threshold is **4h**

Arm A survives a 0.1 % round trip **only at 4h and 1d**. The crossover is sharp
and monotone in fee drag:

```
1m   fee drag 0.9132 R   ->  net -0.8664
5m               0.4001  ->       -0.4008
15m              0.2200  ->       -0.2245
30m              0.1465  ->       -0.1549
1h               0.1032  ->       -0.0982      <- still negative
4h               0.0462  ->       +0.0321      <- FIRST SURVIVING TF
1d               0.0159  ->       +0.3263
```

**Break-even round-trip cost** (the fee at which net expectancy = 0) makes the
margin explicit:

| TF | 1m | 5m | 15m | 30m | 1h | **4h** | **1d** |
|---|---|---|---|---|---|---|---|
| break-even bps | 0.51 | −0.02 | −0.20 | −0.57 | 0.49 | **16.95** | **215.61** |

Binance Spot is **10 bps** round trip (0.05 % per side taker, or 20 bps at
VIP0 without BNB). Only 4h (16.95) and 1d (215.61) clear it — and 4h clears
10 bps but **not** the 20 bps VIP0 case.

### With filters: the threshold moves down one step, to **1h**

Arm FULL survives at **1h, 4h and 1d**. The Fee Drag Guard forces a wider stop
(1m median 0.1874 % → 0.7762 %), which cuts 1m fee drag from 0.9132 R to
0.1394 R — an 85 % reduction. That is a real mechanical improvement.

But it buys only **one timeframe step**, and it does so by discarding most of
the sample: 1m drops from 246,693 to 38,375 trades (−84 %), 4h from 1,025 to
255 (−75 %). At 1h the surviving net expectancy is **+0.0294 R** on n=1,037.

### Sub-hourly trading is arithmetically dead on Spot

At 1m the baseline pays **0.9132 R in fees per trade** against a gross edge of
**+0.0468 R** — costs are **19.5×** the edge. Even after the Fee Drag Guard
cuts drag to 0.1394 R, the gross edge falls to +0.0026 R and costs are still
**54×** the edge. No entry rule tested can close a gap of that size; the only
lever that works is trading a slower timeframe.

---

## 4. Honest caveats

- **Small n where it matters.** The surviving cells are thin: A/4h n=1,025,
  A/1d n=132, FULL/1h n=1,037, FULL/4h n=255, FULL/1d n=45. The 1d figures in
  particular (+0.3263 A, +0.4257 FULL) rest on 132 and 45 trades and should not
  be treated as reliable point estimates.
- **This is TRAIN.** These thresholds are descriptive of the development slice.
  Nothing here has been validated, and the corridor design was already recorded
  as `CORRIDOR_ENTRY_REJECTED_ON_TRAIN`.
- **FULL's higher gross at 15m–1d is partly selection.** It keeps ~16–25 % of
  setups, and the earlier anti-bias check showed the Fee Drag Guard rejects
  setups whose *baseline* gross was ~5× better than those it admits. The
  per-trade improvement is therefore not evidence of added skill.
- **No maker discount assumed.** Limit-style entries are charged the same as
  market, as pre-registered.

## 5. Conclusion

**Spot fees stop destroying the edge at 4h for the baseline strategy, and at 1h
once the Fee Drag Guard widens stops.** Below that, fee drag exceeds gross edge
by one to two orders of magnitude, and the deficit is structural rather than a
tuning problem: `feeR = fee% × price / stopDistance`, so short timeframes with
naturally tight stops cannot pay a fixed notional fee.

The actionable implication — stated as a finding, not a recommendation to act —
is that any future V2.1 work on Binance Spot should be evaluated on **1h and
above**, and that 1m/5m research is unlikely to be worth further effort unless
the cost model itself changes (maker rebates, fee tier, or a venue with lower
taker fees).

---

## 6. ACKNOWLEDGED FINDING (carried into V2.2 scope)

**Binance Spot at 10 bps round trip is mathematically viable only on >= 1h.**

- Frozen baseline: survives at **4h** (break-even 16.95 bps) and **1d**
  (215.61 bps). 1h is marginally negative (0.49 bps break-even vs 10 bps cost).
- With the Fee Drag Guard widening stops: survives from **1h** (15.79 bps),
  **4h** (76.45) and **1d** (468.67).
- Every sub-hourly cell fails, several with a *negative* break-even (5m −0.02,
  15m −0.20, 30m −0.57), meaning they are unprofitable even at zero fees.

This is now a binding scope constraint, recorded in
`docs/V2_2_HTF_SPOT_ENGINE_PREREGISTRATION.md`: **V2.2 trades 1h and 4h only**,
with 4h/1d used as HTF context. 1d is excluded as a trading timeframe on sample
grounds (TRAIN n=132 baseline / 45 filtered), not on performance grounds.

VALIDATION and TEST remain strictly untouched by this diagnostic.

# V2.7 — TARGET RR OPTIMIZATION — PRE-REGISTRATION

**Written and committed BEFORE any V2.7 result is computed.** No V2.7 number
exists at this commit. Every rule below is fixed now and may not be revised
after results are seen.

| pinned | value |
|---|---|
| frozen V2 strategy | `4839074` (unchanged, incl. `src/outcome/tracker.ts`) |
| prior stage | V2.6 TRAIN, `e89cf1e` (`V2_6_REJECTED_ON_TRAIN`) |
| dataset | `c3c1dce` |
| development slice | **TRAIN only** |
| TEST (2022–2025) | **USED — excluded** |

---

## 0. TWO SPECIFICATION CONFLICTS, RESOLVED BEFORE THE RUN

### 0.1 Stop-loss buffer: 0.05 ATR vs "same as V2.6"

The task says the structural SL is *"behind the sweep wick + 0.05 ATR buffer"*
**and** *"same as V2.6"*. These contradict: V2.6 used the **frozen** engine's
stop, whose buffer is `v2.stop_buffer_atr = 0.25` (registry default, consumed by
`src/strategy/v2/engine.ts`).

**Resolution, fixed now: use the frozen 0.25 ATR stop, exactly as V2.6 did.**

Reasons: (a) the task's own controlling instruction is *"Use the SAME entry
signals as V2.6. Do not change entries"*, and the stop is what defines `R`, so
changing it would change every entry's risk and break comparability with the
V2.6 baseline this study is meant to extend; (b) 0.05 ATR is not a frozen
parameter and adopting it would be an unregistered parameter change; (c) a
tighter stop mechanically **increases** fee-in-R (`feeR = fee% × price / risk`),
which is precisely the failure mode V2.6 identified — adopting it would bias the
study toward the hypothesis being tested.

The 0.05 ATR variant is **not** tested here. Doing so would be a second free
parameter on top of the five RR arms.

### 0.2 Timeout horizon: 50 bars

The task specifies *"if neither hit within 50 bars → close at market"*. The
frozen `outcome.timeout_bars` is **48**. 50 is used as specified, and the
2-bar difference from the frozen default is recorded here so the deviation is
visible rather than silent. It applies identically to all five arms, so it
cannot favour any one of them.

---

## 1. Hypothesis and prior

**User hypothesis:** larger targets make commission a smaller fraction of the
win, so a higher RR should turn V2.6's −0.009 R net into a positive number.

**Registered prior — this is unlikely to work as stated.** Fee-in-R is
`fee% × price / risk`. It depends on **entry price and stop distance only**. It
is *completely independent of where the take-profit sits.* Raising TP from 1.5R
to 4.0R therefore changes **fee drag by exactly zero** — the 0.1555 R/trade
measured in V2.6 will be identical in all five arms (up to exit-price effects on
the taker leg, which are second-order).

What a higher TP actually changes is the **win-rate / payoff trade-off**: fewer
wins, each larger. Expectancy improves only if the market reaches the further
target often enough to compensate. That is a genuine empirical question and is
worth measuring — but the stated *mechanism* ("commission becomes a smaller
fraction") is arithmetically incorrect and is recorded as such in advance.

**Supporting evidence already in hand:** V2.6 measured `shareNeverReached1R =
58.36 %` — well over half of sniper trades never reach even +1R. Those trades
cannot reach 1.5R, let alone 4.0R, so raising the target cannot help them; it
can only change outcomes for the minority that already run.

**Expected outcome:** net expectancy is roughly flat-to-declining in RR, with
any peak at the low end. Recorded before the run.

---

## 2. Entry — unchanged from V2.6

Sniper filter, reversals only, continuation disabled. All 8 conditions read from
the frozen `SweepEvent` at **CLOSED N**:

| # | condition | requirement |
|---|---|---|
| 1 | swept a real extreme | pool kind ∈ {SWING, EQUAL, CLUSTER} |
| 2 | directional | `sweep.direction == setup.direction` |
| 3 | causal reclaim | `sweep.reclaimed === true` |
| 4 | prompt | `sweep.reclaimBars <= 3` |
| 5 | penetration | `sweep.penetrationAtr >= 0.10` |
| 6 | rejection wick | `sweep.wickRatio >= 0.25` |
| 7 | **body reclaim** | `sweep.bodyRatio >= 0.35` |
| 8 | **volume surge** | `sweep.rvol > 1.2` |

Entry price: **OPEN of N+1** (frozen `resolveEntry`). No corridor, no LONG
asymmetry. Expected **n ≈ 317**, matching V2.6 exactly.

## 3. Exit arms — five fixed targets, no trailing

`risk = |entry − SL|`, `SL` = frozen structural stop (§0.1).

| arm | take-profit |
|---|---|
| `RR15` | entry ± 1.5 × risk |
| `RR20` | entry ± 2.0 × risk |
| `RR25` | entry ± 2.5 × risk |
| `RR30` | entry ± 3.0 × risk |
| `RR40` | entry ± 4.0 × risk |

100 % of the position exits at TP. **No trailing, no partials, no breakeven** —
this isolates pure RR.

Bar-by-bar from the entry bar:
- SL hit → **−1R**
- TP hit → **+multiplier R**
- **Same bar hits both → SL wins** (conservative, mirrors frozen
  `outcome.sl_priority_on_ambiguous_bar = true`). Recorded in advance because
  it systematically disadvantages the higher-RR arms slightly, and that
  direction of bias must be known.
- Neither within **50 bars** → close at that bar's CLOSE, actual R.

## 4. Fee model

Per leg, no rebate: **entry 2 bps maker, exit 5 bps taker**.

```
feeR = (2bps × entryPrice + 5bps × exitPrice) / risk
```

Reported: `GROSS` (0), **`FUT_4` = 2/5 (headline)**, `SPOT` = 5/5 (stress).

## 5. Scope

15m, 30m, 1h, 4h · BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT, DOGEUSDT ·
**TRAIN only**.

## 6. Success criterion

**Best net expectancy per trade AND per setup under 2/5 bps**, and identification
of the optimal RR peak.

A peak is only meaningful if it is **positive**; an arm that is merely
"least negative" is reported as a failure to find a profitable target, not as an
optimum. Permitted statuses: `V2_7_REJECTED_ON_TRAIN` (no arm net-positive),
`V2_7_PROMISING_PENDING_VALIDATION` (some arm net-positive and robust).
`PRODUCTION_READY` forbidden.

## 7. Mandatory checks

1. **Same-entry invariant** — all five arms must resolve an identical entry set
   (same n, same entry times/prices). Any divergence aborts the comparison.
2. **Fee-drag invariance** — fee drag must be near-identical across arms,
   confirming §1: if it varies materially with RR, the stated mechanism would
   have merit and that must be reported honestly.
3. **Outlier sensitivity** — ex-top-1, ex-top-5, ex-top-1 %. At n≈317 a few
   trades dominate, and higher-RR arms concentrate more value in fewer wins.
4. **Monotonicity** — report whether net expectancy is monotone in RR or has an
   interior peak; an interior peak on n≈317 with 5 arms tested is likely noise
   and must be labelled as such.
5. **Sample honesty** — n on every row; **no subgroup with n < 100 may support a
   conclusion**. With ~317 trades over 5 arms, most subgroups will be below it.

## 8. Implementation constraints

- **No file under `src/` may change.** `git diff 4839074 -- src/` must stay
  empty; the gate is reported with the results.
- New code lives in `research/` as the task directs.
- **Multiple-comparisons caveat, registered now:** testing 5 arms and reporting
  the best invites selection bias. The winner is the best of five on one split;
  its TRAIN margin is an upper bound, not an unbiased estimate.

**v2.enabled = false. LIVE_TRADING_ENABLED = false. Research only.**

# V3.0 HTF LIQUIDATION TRAP — TRAIN RESULTS

## Status: `V3_0_PROMISING_PENDING_VALIDATION`

**The first strategy in this programme to be net-positive at real Binance
futures fees**, on the largest sample any candidate has produced.

TRAIN only. VALIDATION and TEST untouched. `src/` byte-identical to `4839074`.

| pinned | value |
|---|---|
| frozen engine | `4839074` |
| pre-registration | `6c2bf9e` |
| dataset | `c3c1dce` |
| scope | 1H execution · 4H structure · 6 symbols · TRAIN |

---

## 1. Headline result

| Metric | Value |
|---|---|
| **n** | **1,585** |
| TP1 hit rate | 48.26 % |
| Full TP2 hit rate | 17.35 % |
| Positive-R rate | 50.73 % |
| Median stop distance | **1.2520 % of price** |
| **Fee drag @2/5 bps** | **0.0732 R** |
| **Gross R/trade** | **+0.1726** |
| **Net R/trade @2/5 bps** | **+0.0994** ✅ |
| Net R/trade @5/5 bps | +0.0680 |
| **Profit factor** | **1.3538** |
| Max drawdown | −37.18 R |

### Criteria

| Requirement | Result |
|---|---|
| Primary: net > 0 @2/5 bps | **+0.0994** ✅ |
| Robustness 1: gross > 0 after trimming top 1 % | **+0.0983** ✅ |
| Robustness 2: net > 0 under 5/5 stress | **+0.0680** ✅ |

**All three met.**

## 2. ⚠️ My thesis was wrong — the edge comes from somewhere else

The pre-registration argued V3.0 would win by **widening the stop** and cutting
fee-in-R. That is **not what happened**:

| | V2.8 (1H stop) | V3.0 (4H-wick stop) |
|---|---|---|
| Median stop % of price | ~1.30 % | **1.2520 %** |
| Fee drag @2/5 bps | ~0.0538 R | **0.0732 R** |

**The stop did not widen, and fee drag got *worse*, not better.** The extra cost
comes from the partial exit: V3.0 pays **three legs** (entry, TP1, final) where
V2.8 pays two.

So the registered mechanism failed. The actual drivers are:

1. **Higher gross edge** — +0.1726 vs +0.1462 for V2.6/V2.8 on the same fee basis.
2. **5× the sample** — 1,585 trades vs 317. This matters more than the gross
   difference: the estimate is far less fragile, and the 0.0732 R fee is now
   comfortably covered by a 0.1726 R gross rather than marginally missed.

The 4H anchoring helped — but through **signal quality and trade frequency**,
not through the stop geometry I predicted. Recording this because the
pre-registered reasoning was falsified even though the outcome was favourable.

## 3. Robustness

| measure | value |
|---|---|
| gross | +0.1726 |
| ex-top-1 | +0.1665 |
| ex-top-5 | +0.1451 |
| **ex-top-1 % (16 trades)** | **+0.0983** |
| **edge retained** | **57.0 %** |

Removing 16 of 1,585 trades retains **57 %** of the edge. For comparison:
V2.3 retained 23 %, V2.8-TRAIN 37 %, V2.8-VALIDATION went *negative*. This is
the most robust result the programme has produced.

Even after the trim, gross (+0.0983) still exceeds the 2/5 fee drag (0.0732).

## 4. Trade shape

| metric | value |
|---|---|
| Avg win | +1.3022 R |
| Avg loss | −0.9901 R |
| Median R | +0.0179 |
| Median bars held | 7 |

Exits: SL 772 · **TP1_THEN_BE 410** · TP2 275 · TP1_THEN_TIMEOUT 80 · TIMEOUT 48.

The partial-exit structure is doing real work: 410 trades banked TP1 then exited
at breakeven — losses converted to scratches. **Median R is positive**, which
only V2.5 and V2.8-TRAIN achieved before.

## 5. Funnel

| stage | count |
|---|---|
| Trap signals detected | 2,015 |
| Corridors published | 2,015 |
| **Filled** | **1,585 (78.7 %)** |
| Cancelled (stop before fill / ambiguous) | 330 |
| Rejected on geometry | 100 |
| Expired unfilled | 0 |

A 78.7 % fill rate versus 24.09 % for the V2.1 corridor — centring on the reclaim
close, rather than waiting for a retracement, fills reliably.

## 6. Breakdowns — every cell above n=100

**Direction** — remarkably symmetric, the first time in this programme:

| direction | n | gross |
|---|---|---|
| LONG | 796 | +0.1736 |
| SHORT | 789 | +0.1717 |

**Symbol** — all six positive, all n ≥ 238:

| symbol | n | gross |
|---|---|---|
| SOLUSDT | 259 | +0.2841 |
| ETHUSDT | 268 | +0.2520 |
| BTCUSDT | 259 | +0.2517 |
| BNBUSDT | 295 | +0.1387 |
| DOGEUSDT | 266 | +0.0648 |
| XRPUSDT | 238 | +0.0386 |

**This is the first result where no subgroup falls below the n<100 rule.** Every
cell is usable, and every cell is positive.

## 7. Honest caveats

1. **TRAIN only.** Not validated. V2.4 passed TRAIN with +0.2023 gross and then
   *inverted* to −0.1098 out of sample. This result means nothing until it
   survives VALIDATION.
2. **The registered mechanism was falsified** (§2). An unexpected win is weaker
   evidence than a predicted one, because it means the model of *why* it works is
   not yet correct.
3. **Margin over fees is real but not large** — 0.1726 gross against 0.0732 drag.
   At a 10 bps round trip (SPOT taker) the margin narrows to +0.0680.
4. **Post-only fill optimism.** A real post-only order can be rejected when it
   would cross; OHLC cannot detect that. Fills are assumed whenever price enters
   the corridor.
5. **Spread and slippage are not modelled** beyond the stated fee schedule.
6. **XRP and DOGE are marginal** (+0.0386, +0.0648) — barely above the fee line.

## 8. Protocol compliance

- Pre-registration committed at `6c2bf9e` **before** any V3.0 code existed.
- No parameter changed after seeing results.
- Causality asserted by tests: 4H pivots used only from `confirmedIndex`
  (right-bars printed), 4H context bounded by `closedHtfCandles`, corridor fills
  only from N+1, same-bar ambiguity always resolved against the trade.
- Gates: typecheck ✅ · **1,116 tests** ✅ · build ✅ ·
  `git diff 4839074 -- src/` **empty** · `v2.enabled=false` ·
  `LIVE_TRADING_ENABLED=false`.

## 9. Verdict

# `V3_0_PROMISING_PENDING_VALIDATION`

The strongest TRAIN result of the programme: net-positive at realistic futures
fees, 1,585 trades, 57 % outlier retention, and every direction and symbol cell
positive with usable n.

**Next step: one VALIDATION run**, with the candidate frozen exactly as tested
and success criteria fixed beforehand. Given that three of four prior
TRAIN-derived candidates failed to reproduce — and that this one's *mechanism*
was falsified even as its result succeeded — validation should be treated as a
genuine coin-flip, not a formality.

**TEST untouched. `v2.enabled=false`, `LIVE_TRADING_ENABLED=false`.
`PRODUCTION_READY` forbidden.**

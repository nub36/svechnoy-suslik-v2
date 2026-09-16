# V2.2 PRE-REGISTRATION — AMENDMENT 1 (scope + fee environments)

**Committed BEFORE the V2.2 TRAIN run. No V2.2 result exists yet.**

The base pre-registration (`1b4f09b`) fixed V2.2 scope at **1h and 4h only**,
justified by Binance **Spot** economics (10 bps round trip). This amendment
extends scope to **15m, 30m, 1h, 4h** and adds a second fee environment.

## Why this is a legitimate extension, not a post-hoc loosening

No V2.2 performance number has been computed. The extension is driven by a
**new cost environment**, not by a result. The measured break-even round-trip
costs from `dccf751` make the case explicit:

| TF | break-even (FULL arm) | Spot 10 bps | Futures 7 bps | Futures 4 bps |
|---|---|---|---|---|
| 15m | 5.15 bps | dead | dead | **viable** |
| 30m | 4.53 bps | dead | dead | **viable** |
| 1h | 15.79 bps | **viable** | **viable** | **viable** |
| 4h | 76.45 bps | **viable** | **viable** | **viable** |

15m and 30m are arithmetically dead on Spot but sit **above** the 4 bps
maker-heavy futures cost. Testing them is therefore only meaningful in the
futures environment, and they are reported in both so the difference is visible.

**The Spot conclusion is unchanged and not reopened:** on Spot 10 bps, only
1h and 4h are viable. That finding stands.

## Fee environments (fixed now, per-leg, no result-driven selection)

`feeR = (makerBps/1e4 × entryPrice + takerBps/1e4 × exitPrice) / riskPerUnit`

| label | entry | exit | round trip | rationale |
|---|---|---|---|---|
| **GROSS** | 0 | 0 | 0 bps | edge before costs |
| **SPOT** | 5 bps | 5 bps | 10 bps | Binance Spot taker both sides |
| **FUT_7** | 2 bps (maker) | 5 bps (taker) | 7 bps | corridor fills maker, exit taker |
| **FUT_4** | 2 bps (maker) | 2 bps (maker) | 4 bps | best case, both legs maker |

The corridor is a resting limit order, so **maker on entry is the realistic
assumption** for FUT_7. The exit is charged **taker** because SL and TIMEOUT
exits are market events; only FUT_4 assumes a maker exit, and it is reported as
a best case, not the headline.

**No maker rebate (negative fee) is assumed anywhere.**

## Unchanged by this amendment

Every other rule in `docs/V2_2_HTF_SPOT_ENGINE_PREREGISTRATION.md` stands
verbatim: the two success criteria (rr1 rejection < 40 %, reversal share ≥ 10 %),
the primary metric (gross expectancy per **original actionable setup**), the
seven-arm ablation, the four anti-bias checks, the n<100 rule, `risk.min_rr`
unchanged at 1, exit model final-rung-only, and the permitted final statuses.

1d remains excluded as a trading timeframe on sample grounds (TRAIN n=132/45).

VALIDATION and TEST remain untouched.

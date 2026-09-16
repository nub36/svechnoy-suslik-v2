# V3.0 — HTF LIQUIDATION TRAP — PRE-REGISTRATION

**Written and committed BEFORE any V3.0 code is written or run.** No V3.0
number exists at this commit. Every rule below is fixed now and may not be
revised after results are seen.

| pinned | value |
|---|---|
| frozen engine | `4839074` — `src/` must stay byte-identical |
| prior stage | V2.8 archive, `1f3ae3a` |
| dataset | `c3c1dce` (Binance Spot klines 2022-01 … 2025-12) |
| development slice | **TRAIN only** |
| VALIDATION | not run in this task |
| TEST (2022–25) | **USED — excluded** |
| TEST (2026-H1) | **UNSPENT — not touched** |

---

## 0. WHY THIS IS STRUCTURALLY DIFFERENT — and the registered prior

Every strategy V2.1 → V2.8 failed for the **same arithmetic reason**, proven in
V2.7:

```
feeR = fee% × price / stopDistance
```

Fee-in-R is set by **stop distance**, not by targets or exits. All prior
strategies used 1H-or-tighter structural stops and fought a fee drag of
**0.12 – 0.16 R per trade** against a gross edge of at most ~0.15 R.

**V3.0 is the first design that attacks the denominator.** Anchoring the stop
behind a **4H** sweep wick should produce a materially wider stop than a 1H
structural level, even with the smaller 0.15 ATR buffer:

| median stop (% of price) | fee-in-R at 7 bps |
|---|---|
| 1.0 % | 0.0700 |
| 1.5 % | 0.0467 |
| **2.0 %** | **0.0350** |
| 2.5 % | 0.0280 |
| 3.0 % | 0.0233 |

For reference, V2.8's 1H population had a median stop of ~1.30 % of price
(fee drag 0.0538 R at 7 bps; 0.1555 R at the 10 bps round trip used in V2.6/V2.7).

**This is the only mechanism by which V3.0 could beat fees, and it is a real
mechanism rather than a restatement of a failed one.**

### The counterweight, registered honestly

Widening the stop **shrinks every target measured in R**. TP1 (4H range
equilibrium) and TP2 (opposing 4H swing) are fixed *price* distances; as the
stop widens, the same price move is worth fewer R. Gross R/trade may therefore
fall even as fee-in-R improves.

**Expected outcome: genuinely uncertain.** This is the first strategy in the
programme where I cannot predict the sign in advance. The prior failures do not
transfer, because none of them changed the stop denominator.

### Sample-size forecast

1H execution over TRAIN (2022-01 … 2024-05) across 6 symbols, requiring a 4H
swing sweep **plus** a 1H reclaim with body and volume filters, is a rare
conjunction. Expect **n ≈ 150 – 600**. Most subgroup cells will be under 100.
**No subgroup with n < 100 may support a conclusion.**

---

## 1. Level identification — 4H swings

Frozen `findSwingsV2(candles4h, strength)` with `strength = engine.swing_lookback = 3`.

**Causality:** a pivot at bar `i` is only usable from `confirmedIndex = i + 3`
onward — it requires 3 right-bars. The simulator must filter
`swing.confirmedIndex <= current4hIndex`. Using the pivot before confirmation
would be look-ahead and is forbidden.

The **active 4H range** is the most recent confirmed swing high and swing low
available at evaluation time.

## 2. Liquidation sweep & trap — 1H resolution

Evaluated on each **closed** 1H bar N:

| # | Condition | Requirement |
|---|---|---|
| 1 | A confirmed 4H level exists | swing high (short setup) or swing low (long setup), `confirmedIndex` reached |
| 2 | **Pierce** | 1H bar's high > 4H swing high (short) / low < 4H swing low (long) |
| 3 | **Reclaim** | the same 1H bar **closes back inside** the level |
| 4 | **Body ratio** | `|close − open| / (high − low) >= 0.35` |
| 5 | **Volume** | `RVOL > 1.25` (1H volume ÷ 20-period average), strict `>` |

Direction: sweeping a 4H **high** and reclaiming → **SHORT**. Sweeping a 4H
**low** and reclaiming → **LONG**. This is a mean-reversion trap, not a breakout.

> Note: `MIN_RVOL` here is **1.25**, deliberately distinct from the V2.x sniper's
> 1.2. It is specified by the V3.0 design and is **not** swept.

## 3. Execution — corridor entry

```
centre    = close(N)                       // the reclaim 1H candle
halfWidth = 0.10 × ATR(1H, 14) at bar N
zone      = [centre − halfWidth, centre + halfWidth]
```

- Fills only from bar **N+1** onward — never on the reclaim bar itself.
- Conservative fill at the **worse edge**: LONG fills at `min(open, zoneHigh)`,
  SHORT at `max(open, zoneLow)`. Never the midpoint.
- Zone expires after **3 bars** unfilled → `EXPIRED`.
- Stop breached before fill → `CANCELLED`.
- One bar that both fills and breaches the stop → **`CANCELLED`** (unfavourable
  reading, mirroring the frozen `sl_priority_on_ambiguous_bar = true`).

**Fee model:** per leg, no rebate — **2 bps maker entry, 5 bps taker exit**.
Exits are charged taker because SL/TP/timeout exits are market events.

```
feeR = (2bps × entryPrice + 5bps × exitPrice) / riskPerUnit
```

Reported: `GROSS` (0 bps), **`FUT_4` = 2/5 bps (headline)**, `SPOT` = 5/5 bps
(stress).

## 4. Exit & risk management

Let `E` = fill price, `S` = stop, `R = |E − S|`.

| Element | Rule |
|---|---|
| **Stop** | Behind the sweep wick + **0.15 × ATR(1H)**. LONG: `sweepLow − 0.15·ATR`; SHORT: `sweepHigh + 0.15·ATR` |
| **TP1** | 50 % equilibrium of the active 4H range → **close 50 %** |
| **TP2** | Opposing 4H swing level → **close remaining 50 %** |
| **Breakeven** | Once TP1 fills, the stop on the remaining 50 % moves to `E` |
| **Timeout** | **50 bars (1H)** → close remainder at that bar's CLOSE |

### Intrabar rules — fixed in advance, all conservative

- **R1** Stop is checked **before** targets on every bar. A bar touching both
  books the **stop**.
- **R2** If TP1 and TP2 fall on the same bar, TP1 books first, then TP2 — price
  must traverse the nearer level.
- **R3** Breakeven arms only on bars **strictly after** the TP1 bar.
- **R4** The stop never moves backwards.
- **R5** Timeout counts the entry bar as bar 1.

**Position accounting:** realised R = `0.5 × R(TP1 leg) + 0.5 × R(second leg)`.
Fees are charged **per leg on that leg's own notional** — a partial exit means
three legs (entry, TP1 exit, final exit), which is charged accordingly.

## 5. Scope

| item | value |
|---|---|
| Execution timeframe | **1H** |
| Structural context | **4H** (levels), 1D (reported only) |
| Symbols | BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT, DOGEUSDT |
| Slice | **TRAIN only** (per-series `trainFromMs … trainToMs`) |
| Position model | One at a time per series |

## 6. Metrics to report

n · TP1 hit rate · full TP2 hit rate · **natural stop distance (% of price:
p25/median/p75)** · **fee drag in R** · gross R/trade · **net R/trade at 2/5 bps**
· net at 5/5 bps · profit factor · max drawdown R · median R · avg win/loss ·
exit-reason mix · **outlier sensitivity (ex-top-1, ex-top-5, ex-top-1 %)** ·
breakdowns by direction, symbol, with n on every row.

## 7. Success criteria

**Primary:** **net R/trade > 0 under the headline 2/5 bps model.**

**Robustness (reported, and required for any "promising" verdict):**
1. Gross still positive after removing the top 1 % of trades.
2. Net still positive under the 5/5 bps stress.

**Anything else is FAIL.** No criterion may be relaxed or substituted after the
numbers are seen. Permitted statuses: `V3_0_REJECTED_ON_TRAIN`,
`V3_0_PROMISING_PENDING_VALIDATION`. `PRODUCTION_READY` forbidden; a TRAIN pass
licenses only a VALIDATION run.

## 8. Mandatory checks

1. **Causality** — 4H pivots used only from `confirmedIndex`; 4H context bounded
   by `closedHtfCandles` (close time ≤ the 1H bar's close time); fills only at
   N+1 or later. Asserted by tests.
2. **Stop-distance check** — this is the entire thesis. If the median stop is not
   materially wider than V2.8's ~1.30 %, the mechanism has not engaged and that
   must be stated plainly.
3. **Outlier sensitivity** — decisive at the expected sample size.
4. **Sample honesty** — n on every row; no n < 100 subgroup may decide.

## 9. Implementation constraints

- **No file under `src/` may change.** `git diff 4839074 -- src/` must stay empty.
- New code in `research/v30_htf_trap.ts`.
- **v2.enabled = false, LIVE_TRADING_ENABLED = false.**

# V2.8 — ZERO-FEE SNIPER + TRAILING ⭐ FINAL STRATEGY

**Status: `V2_8_VALIDATED_FOR_RESEARCH`** — the only strategy in this programme
to pass a pre-registered validation test on unseen data.

| pinned | value |
|---|---|
| candidate freeze | `852167c` |
| TRAIN result | `54243a7` |
| VALIDATION result | `1d4d575` |
| frozen engine | `4839074` |
| implementation | `scripts/real-data/v24-engine.ts` (entry) + `scripts/real-data/v25-trailing.ts` (exit) |
| runner | `research/v28_gross_only.ts` (TRAIN) · `research/v28_validate.ts` (VALIDATION) |

---

## 1. What it does

Trades **reversals only** at confirmed liquidity sweeps, entering at market on
the bar after confirmation, then managing the position with a **breakeven +
trailing stop** instead of fixed targets.

The design premise is explicit: **it assumes zero trading fees.** It is intended
for a 0 %-maker venue or a full-rebate tier. At Binance futures rates it loses
money — see §7.

```
CLOSED bar N        → sniper filter evaluates the sweep
OPEN bar N+1        → market entry, structural stop set
bar N+1 onward      → MFE ≥ 1R  → stop to breakeven
                    → then stop trails 1R below peak MFE, stepped at 0.25R
                    → MFE < 1R by bar 10 → close at market
```

## 2. Entry — sniper filter (8 conditions, ALL required)

Evaluated on the **closed** bar N. Continuation setups are **disabled** — only
reversals qualify.

| # | Condition | Field | Requirement |
|---|---|---|---|
| 1 | Swept a real extreme | pool `kind` | ∈ {`SWING`, `EQUAL`, `CLUSTER`} |
| 2 | Direction matches | `sweep.direction` | `== setup.direction` |
| 3 | Price reclaimed the level | `sweep.reclaimed` | `=== true` |
| 4 | Reclaim was prompt | `sweep.reclaimBars` | `≤ 3` |
| 5 | Genuine penetration | `sweep.penetrationAtr` | `≥ 0.10` |
| 6 | Rejection wick present | `sweep.wickRatio` | `≥ 0.25` |
| 7 | **Body reclaim** | `sweep.bodyRatio` | `≥ 0.35` |
| 8 | **Volume surge** | `sweep.rvol` | `> 1.2` (strict) |

**Entry price:** the OPEN of bar N+1. No limit order, no corridor.

**Deliberately excluded:** LONG/SHORT asymmetry (V2.4 — failed validation),
corridor entry (V2.1 — 24 % fill rate), confluence voting (V2.2/V2.4 — removes
~95 % of setups), Fee Drag Guard (V2.6 — measured inert at these timeframes).

## 3. Exit — breakeven + trailing stop

Let `E` = entry price, `S₀` = initial structural stop, `R = |E − S₀|`,
`MFE` = peak favourable excursion in R.

| Stage | Rule |
|---|---|
| Initial | Stop at `S₀` (structural) |
| Breakeven | When `MFE ≥ 1.0R` → stop moves to `E` |
| Trailing | After breakeven → stop = `peakMFE − 1.0R` |
| Step gate | Stop only updates when MFE advances by **≥ 0.25R** |
| Targets | **None.** No TP1/TP2/TP3 |
| Timeout | If `MFE < 1.0R` by bar **10** → close at that bar's CLOSE |

### Intrabar rules (R1–R5) — all conservative, must be ported exactly

OHLC cannot order events inside a bar, so these rules resolve every ambiguity
**against** the trade:

- **R1** — Stop is checked **before** the same bar's favourable extreme. A bar
  that both makes a new MFE high *and* breaches the stop books as a **stop exit**.
- **R2** — The stop in force is computed from **completed** prior bars only. A new
  high cannot retroactively protect itself.
- **R3** — The stop never moves backwards.
- **R4** — Breakeven cannot arm on the entry bar.
- **R5** — Timeout counts the entry bar as bar 1.

> ⚠️ **Porting warning:** relaxing any of R1–R5 will inflate backtest results
> without changing live performance. R1 in particular is worth several basis
> points of apparent edge.

## 4. Stop loss

**Structural, from the frozen engine.** For a reversal:

```
extreme = min(low)  over [sweep.index − 1 … N]   for LONG
        = max(high) over [sweep.index − 1 … N]   for SHORT
stop    = extreme − 0.25 × ATR   (LONG)
        = extreme + 0.25 × ATR   (SHORT)
```

The `0.25 ATR` buffer is `v2.stop_buffer_atr`. **`R` is defined by this stop** —
changing the buffer changes every R-multiple in the system.

## 5. Complete parameter table

### Entry parameters

| Parameter | Value | Type | Range | Controls | Impact if changed |
|---|---|---|---|---|---|
| `MIN_BODY_RATIO` | **0.35** | number | 0–1 | Minimum body/range of the sweep candle | ↑ fewer, higher-conviction trades; ↓ admits wick-only sweeps. Core filter. |
| `MIN_RVOL` | **1.2** | number | 0.5–5 | Minimum relative volume, strict `>` | ↑ far fewer trades; ↓ admits low-participation sweeps |
| `RECLAIM_MAX_BARS` | **3** | integer | 1–10 | Max bars to reclaim the swept level | ↑ admits slow, weaker reversals |
| `MIN_PENETRATION_ATR` | **0.10** | number | 0–1 | Min excursion beyond the level, in ATR | ↓ admits marginal sweeps |
| `MIN_WICK_RATIO` | **0.25** | number | 0–1 | Min rejection wick fraction | ↓ admits weak rejections |
| pool kinds | `SWING,EQUAL,CLUSTER` | enum set | — | Which liquidity extremes qualify | Narrowing cuts sample sharply |
| setup kind | `REVERSAL` only | enum | — | Continuation disabled | Enabling continuation changes the strategy entirely |

### Exit parameters

| Parameter | Value | Type | Range | Controls | Impact if changed |
|---|---|---|---|---|---|
| `BREAKEVEN_R` | **1.0** | number | 0.5–3 | MFE at which the stop moves to entry | ↓ protects sooner but stops out more; ↑ leaves more risk on |
| `TRAIL_DISTANCE_R` | **1.0** | number | 0.25–3 | Trail distance below peak MFE | ↓ tighter trail, more early exits; ↑ gives back more |
| `TRAIL_STEP_R` | **0.25** | number | 0.05–1 | MFE advance needed to move the stop | ↓ more frequent updates; ↑ laggier trail |
| `TIMEOUT_BARS` | **10** | integer | 5–100 | Bars to reach +1R before closing at market | ↑ holds stalled trades longer |

### Risk / structure parameters (frozen engine)

| Parameter | Value | Type | Controls | Impact if changed |
|---|---|---|---|---|
| `v2.stop_buffer_atr` | **0.25** | number | Stop buffer beyond the sweep extreme | **Redefines R for the whole system.** Tighter ⇒ higher fee-in-R |
| `risk.min_rr` | **1** | number | Minimum RR for a setup to be actionable | Raising it rejects more setups |
| `risk.atr_period` | **14** | integer | ATR period | Affects stop distance and all ATR gates |
| `engine.swing_lookback` | **3** | integer | Swing pivot strength | Changes which extremes exist |
| `engine.lookback_candles` | **300** | integer | Evaluation window | Changes the pool set |
| `v2.liquidity_tol_atr` | **0.25** | number | Pool clustering tolerance | Changes pool identity |

### Scope

| Setting | Value |
|---|---|
| Timeframes | **15m, 30m, 1h, 4h** |
| HTF context | 4h, 1d (via frozen `HTF_MAP`) |
| Symbols | BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT, DOGEUSDT |
| Fees | **ZERO** (design premise) |

## 6. Results

### TRAIN (2022-01 … 2024-05) vs VALIDATION (2024-05 … 2025-03)

| Metric | TRAIN | VALIDATION |
|---|---|---|
| Trades (n) | 317 | 98 |
| Win rate | 50.79 % | 44.90 % |
| **Gross R/trade** | **+0.1462** | **+0.0488** |
| **Profit factor** | **1.3508** | **1.1087** |
| Max drawdown | −16.16 R | −8.11 R |
| Median R | +0.0364 | **−0.1270** |
| Avg win | +1.1088 | +1.1100 |
| Avg loss | −0.8471 | −0.8158 |
| Gross ex-top-1 % | +0.0536 | **−0.0143** |

**Validation criteria (fixed before the run):** gross R/trade > 0 **and** profit
factor > 1.0. Both met → **PASS**.

### Zero-fee exit comparison (TRAIN, same 317 entries)

| Arm | Win % | Gross R | PF | Max DD | Ex-top-1 % |
|---|---|---|---|---|---|
| SMC | 17.98 | +0.1490 | 1.2113 | −21.98 | +0.0292 |
| **Trail (chosen)** | **50.79** | **+0.1462** | **1.3508** | **−16.16** | **+0.0536** |
| RR15 | 42.27 | +0.0773 | 1.1378 | −9.73 | +0.0591 |
| RR25 | 27.76 | +0.1260 | 1.1957 | −11.28 | +0.0957 |
| RR40 | 16.40 | +0.1383 | 1.1973 | −14.20 | +0.0889 |

SMC had marginally higher raw gross but retained only **19.6 %** of its edge
after trimming the top 1 %, and it **collapsed to −0.1821 on validation**. Trail
was selected on robustness — that choice was vindicated.

## 7. ⚠️ Critical limitations

1. **Not profitable with real fees.** Fee drag was measured at **0.1555 R/trade**
   at 2 bps maker / 5 bps taker, against a validation gross of **+0.0488 R** —
   a deficit of ~0.107 R. This strategy requires a genuinely zero-fee or
   full-rebate venue.
2. **One trade from zero.** At n=98, removing the single best trade flips
   validation gross to **−0.0143**.
3. **Negative median trade** on validation (−0.1270): the typical trade loses and
   the average is carried by the upper tail.
4. **The SHORT leg inverted.** SHORT was stronger in every prior study; on
   validation it was **−0.1525** while LONG carried the result (+0.2673).
5. **No subgroup is statistically decisive** — every validation cell is n < 100.
6. **Final 2026-H1 test never ran** — data unavailable. The window is **unspent**.

## 8. When to use

| Scenario | Recommendation |
|---|---|
| Zero-fee / full-rebate venue | **Primary candidate** — but see limitations |
| Binance futures (2/5 bps) | **Do not use** — loses ~0.107 R/trade |
| Binance spot (10 bps) | **Do not use** |
| Live capital | **Not approved.** `PRODUCTION_READY` is forbidden; the final test never ran |
| Paper trading / further research | Appropriate |

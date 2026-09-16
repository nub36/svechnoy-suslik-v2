# ADMIN PANEL — CONFIGURATION SPECIFICATION

Specification for a strategy-switching admin panel. Every parameter below was
read from source (`scripts/real-data/*.ts`, `research/*.ts`, `src/core/settings.ts`),
not from memory.

> ⚠️ **Safety defaults that must ship disabled:** `v2.enabled = false` and
> `LIVE_TRADING_ENABLED = false`. No strategy here is approved for live capital.

---

## 1. Strategy selector

Dropdown. Default: **V2.8**.

| Value | Label | Status | Selectable |
|---|---|---|---|
| `V2_8` | V2.8 Zero-Fee Sniper + Trailing ⭐ | VALIDATED | ✅ default |
| `V2_5` | V2.5 Trailing Stop (exit module) | Promising | ✅ |
| `V2_6` | V2.6 Sniper + Trailing (real fees) | Rejected | ⚠️ research only |
| `V2_7` | V2.7 RR Optimization | Rejected | ⚠️ research only |
| `V2_3` | V2.3 Sniper Reversal | Rejected | ⚠️ research only |
| `V2_4` | V2.4 Asymmetric Sniper | **Failed validation** | ⚠️ show overfit warning |
| `V2_2` | V2.2 HTF Spot Engine | Rejected | ⚠️ research only |
| `V2_1` | V2.1 Corridor / Limit Entry | Rejected | ⚠️ research only |

**UI requirement:** selecting anything other than `V2_8` or `V2_5` must show a
banner: *"This strategy was rejected in research. Historical results are negative.
Research use only."* For `V2_4` add: *"Failed out-of-sample validation — results
inverted. Known overfit."*

---

## 2. Shared entry parameters — sniper filter

Used by **V2.3, V2.4, V2.6, V2.7, V2.8**.

| Parameter | Type | Default | Min | Max | Description | Impact warning |
|---|---|---|---|---|---|---|
| `sniper.minBodyRatio` | number | **0.35** | 0.0 | 1.0 | Minimum body-to-range ratio of the sweep candle. High values demand a decisive reclaim, not just a wick. | **Core filter.** Raising cuts trade count sharply; lowering admits wick-only sweeps that historically lose. |
| `sniper.minRvol` | number | **1.2** | 0.5 | 5.0 | Minimum relative volume on the sweep candle. Strict `>`. | Raising reduces sample below usable size; lowering admits low-participation sweeps. |
| `sniper.reclaimMaxBars` | integer | **3** | 1 | 10 | Maximum bars allowed to reclaim the swept level. | Raising admits slow, weaker reversals. |
| `sniper.minPenetrationAtr` | number | **0.10** | 0.0 | 1.0 | Minimum excursion beyond the liquidity level, in ATR. | Lowering admits marginal sweeps that never took real liquidity. |
| `sniper.minWickRatio` | number | **0.25** | 0.0 | 1.0 | Minimum rejection-wick fraction of the sweep candle. | Lowering admits weak rejections. |
| `sniper.poolKinds` | multi-enum | **SWING, EQUAL, CLUSTER** | — | — | Which liquidity extreme types qualify. | Narrowing cuts sample. EQH/EQL (`EQUAL`) measured *worst* in V2.1 but positive in V2.8 — do not gate on it. |
| `sniper.setupKind` | enum | **REVERSAL** | REVERSAL / CONTINUATION / BOTH | — | Which setup types are eligible. | V2.8 is reversal-only. Enabling CONTINUATION is a different strategy entirely. |

---

## 3. Exit parameters — trailing stop

Used by **V2.5, V2.6, V2.8**.

| Parameter | Type | Default | Min | Max | Description | Impact warning |
|---|---|---|---|---|---|---|
| `trail.breakevenR` | number | **1.0** | 0.5 | 3.0 | Peak favourable excursion (in R) at which the stop moves to entry. | Lowering protects sooner but causes more breakeven stop-outs on noise. **63.6 % of trades never reach +1R** and are unaffected by this. |
| `trail.distanceR` | number | **1.0** | 0.25 | 3.0 | Trail distance below peak MFE, in R. | Tighter → more early exits; wider → gives back more of each winner. |
| `trail.stepR` | number | **0.25** | 0.05 | 1.0 | MFE advance required before the stop is moved again. | Smaller → more frequent updates; larger → laggier trail. |
| `trail.timeoutBars` | integer | **10** | 5 | 100 | Bars allowed to reach +1R before closing at market. | Raising holds stalled trades longer and increases TIMEOUT exits. |

**Non-configurable (hard-coded, must not be exposed):** intrabar rules R1–R5.
Relaxing them inflates backtests without changing live results.

---

## 4. Exit parameters — fixed R targets

Used by **V2.3, V2.7**.

| Parameter | Type | Default | Min | Max | Description | Impact warning |
|---|---|---|---|---|---|---|
| `target.tp1R` | number | **1.5** | 0.5 | 10.0 | First take-profit as a multiple of risk. | Must exceed `risk.minRr` or every setup is rejected. **Does not affect fee-in-R** — see V2.7. |
| `target.tp2R` | number | **2.5** | 1.0 | 20.0 | Second target cap; structure substitutes if nearer. | — |
| `target.maxBars` | integer | **50** | 5 | 200 | Horizon before closing at market. | Frozen engine default is 48. |

---

## 5. Exit parameters — structural SMC targets

Used by **V2.1, V2.2, V2.4**.

| Parameter | Type | Default | Description | Impact warning |
|---|---|---|---|---|
| `target.allowRMultipleFallback` | boolean | **false** | Emit 1R/2R/3R rungs when structure supplies nothing. | V2.2 measured `R_MULTIPLE` as the **only profitable TP1 basis** (+0.0449). Disabling it made results worse. Treat `false` as the *researched* setting, not the better one. |
| `target.equilibriumFallback` | boolean | **true** | Use range midpoint when no liquidity target exists. | Disabling skips more setups. |

---

## 6. Corridor / limit entry

Used by **V2.1, V2.4**.

| Parameter | Type | Default | Min | Max | Description | Impact warning |
|---|---|---|---|---|---|---|
| `corridor.enabled` | boolean | **false** | — | — | Rest a limit order instead of market-filling at OPEN N+1. | Measured 24.09 % fill rate. V2.8 does **not** use it. |
| `corridor.atrFraction` | number | **0.10** | 0.01 | 1.0 | Zone half-width in ATR. | Wider → more fills, worse average price. |
| `corridor.maxPct` | number | **0.0015** | 0.0001 | 0.01 | Hard cap on half-width as a fraction of price (0.15 %). | Prevents absurd zones during volatility spikes. |
| `corridor.expiryBars` | integer | **3** | 1 | 50 | Bars before an unfilled order expires. | Raising increases fills but acts on staler confirmation. |

---

## 7. Fee Drag Guard

Used by **V2.1 corridor, V2.4**. Measured **inert** at 15m–4h (zero rejections in V2.6).

| Parameter | Type | Default | Min | Max | Description | Impact warning |
|---|---|---|---|---|---|---|
| `feeGuard.enabled` | boolean | **false** | — | — | Reject setups whose stop is too tight to survive fees. | ⚠️ V2.1 measured it rejecting setups whose gross was **~5× better** than those it admitted. It removes cost *and* edge. |
| `feeGuard.minStopPct` | number | **0.0035** | 0.0 | 0.02 | Minimum stop distance as a fraction of price (0.35 %). | Raising rejects the majority of setups. |
| `feeGuard.minStopAtr` | number | **0.50** | 0.0 | 3.0 | Minimum stop distance in ATR. | Second, volatility-relative floor. |

**Hard rule:** the stop is **never widened** to satisfy the guard. Failing setups
are skipped. Widening would manufacture a better R by fiat.

---

## 8. Confluence filter

Used by **V2.1 corridor, V2.2**. **Not** used by V2.8.

| Parameter | Type | Default | Min | Max | Description | Impact warning |
|---|---|---|---|---|---|---|
| `confluence.enabled` | boolean | **false** | — | — | Require N of 4 confirmation votes. | Measured to remove ~95 % of setups. |
| `confluence.minVotes` | integer | **3** | 0 | 4 | Votes required. | 4 is far too rare; 2 barely filters. |
| `confluence.rvolMin` | number | **1.2** | 0.5 | 5.0 | Volume vote threshold. | Duplicates `sniper.minRvol` — double-counts volume if both are on. |
| `confluence.rsiLongMax` | number | **45** | 0 | 100 | RSI zone bound for longs. | — |
| `confluence.rsiShortMin` | number | **55** | 0 | 100 | RSI zone bound for shorts. | — |

---

## 9. Risk & structure (frozen engine settings)

| Parameter | Type | Default | Min | Max | Description | Impact warning |
|---|---|---|---|---|---|---|
| `v2.stop_buffer_atr` | number | **0.25** | 0.0 | 3.0 | Buffer beyond the structural invalidation level, in ATR. | 🔴 **Redefines `R` for the entire system.** Tighter stop ⇒ higher fee-in-R. This is the single most consequential parameter. |
| `risk.min_rr` | number | **1.0** | 0.5 | 5.0 | Minimum reward:risk for a setup to be actionable. | Raising rejects more setups; lowering admits poor geometry. |
| `risk.atr_period` | integer | **14** | 5 | 100 | ATR period. | Affects stop distance and every ATR-relative gate. |
| `engine.swing_lookback` | integer | **3** | 2 | 10 | Swing pivot strength. | Changes which extremes exist at all. |
| `engine.lookback_candles` | integer | **300** | 100 | 1000 | Evaluation window length. | Changes the liquidity pool set. |
| `v2.liquidity_tol_atr` | number | **0.25** | 0.05 | 1.0 | Pool clustering tolerance in ATR. | Changes pool identity and target de-duplication. |
| `outcome.timeout_bars` | integer | **48** | 10 | 200 | Frozen-engine timeout. | Distinct from `trail.timeoutBars`. |
| `outcome.sl_priority_on_ambiguous_bar` | boolean | **true** | — | — | SL wins when one bar touches both SL and TP. | 🔴 **Do not disable.** Setting `false` produces optimistic, unrealisable backtests. |

---

## 10. Fee model selector

| Value | Label | Maker bps | Taker bps | Round trip | Notes |
|---|---|---|---|---|---|
| `ZERO` | Zero fee / full rebate | 0 | 0 | 0 | **V2.8 design premise.** Only environment where it is profitable. |
| `FUT_MAKER_TAKER` | Futures 2/5 bps | 2 | 5 | 7 bps | Realistic futures: maker entry, taker exit. V2.8 loses ~0.107 R/trade here. |
| `FUT_TAKER_BOTH` | Futures 5/5 bps | 5 | 5 | 10 bps | Stress case. |
| `SPOT_TAKER` | Spot 10 bps | 5 | 5 | 10 bps | Binance Spot taker both sides. |
| `CUSTOM` | Custom | user | user | — | Free entry, **must not allow negative values** (no rebate modelling). |

**Formula to implement exactly:**
```
feeR = (makerBps/10000 × entryPrice + takerBps/10000 × exitPrice) / riskPerUnit
```
**Display warning:** *"Fee-in-R depends on stop distance, not target distance.
Raising take-profit does not reduce commission."*

---

## 11. Timeframe selector

Multi-select. Default: **15m, 30m, 1h, 4h**.

| Value | Selectable | Note |
|---|---|---|
| 1m, 5m | ⚠️ warn | Break-even cost is **negative** — unprofitable even at zero fees |
| 15m | ✅ | Only timeframe with n ≥ 100 in validation |
| 30m, 1h, 4h | ✅ | Default set |
| 1d | ⚠️ warn | Sample too thin (n = 8–45) |

---

## 12. Symbol selector

Multi-select. Default: **all six**.

BTCUSDT · ETHUSDT · BNBUSDT · SOLUSDT · XRPUSDT · DOGEUSDT

**Warning to display:** *"No per-symbol conclusion is statistically supported —
every validation symbol cell had n < 100."*

---

## 13. Implementation requirements

1. **Never write to `src/`.** The frozen engine must stay byte-identical to
   `4839074`; verify with `git diff 4839074 -- src/`.
2. **Persist a parameter snapshot** (hash + values) with every run, as this
   repository does via `settings.sha256`.
3. **Expose read-only result fields:** n, win rate, gross R/trade, profit factor,
   max drawdown, **gross excluding top 1 %**, fee drag, net R/trade.
4. **Always show `ex-top-1 %` beside gross.** Several strategies here looked
   profitable until trimmed; this field is the single best fragility indicator.
5. **Show `n` on every table row** and grey out any subgroup with n < 100.

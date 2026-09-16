# ADMIN PANEL — CONFIGURATION SPECIFICATION

Specification for a strategy-switching admin panel. Every parameter below was
read from source (`scripts/real-data/*.ts`, `research/*.ts`, `src/core/settings.ts`),
not from memory.

**Lead candidate:** `V3_0` HTF Liquidation Trap (§2) — `V3_0_VALIDATED_FOR_RESEARCH`
([validation report](V3_0_VALIDATION_RESULTS.md): net +0.0600 R/trade @2/5 bps,
n = 536). The V2.x surface below is retained as the record of what was measured;
none of it is a recommendation.

> **IMPLEMENTATION STATUS (2026-09-16).** This specification is now implemented
> in the site for **V3.0 only**; see
> [V3_0_PRODUCTION_PORT.md](V3_0_PRODUCTION_PORT.md) for the port, the parity
> evidence and the operating rules. Two deviations are deliberate and are
> recorded in §1 and §14: the V2.x rows are **research-only** (never ported into
> the pipeline, so the selector does not offer them) and the "never write to
> `src/`" rule of the research phase is superseded by the port instruction,
> replaced by a hash pin plus a port-parity harness.

> ⚠️ **Safety defaults that must ship disabled:** `v2.enabled = false` and
> `LIVE_TRADING_ENABLED = false`. No strategy here is approved for live capital.

---

## 1. Strategy selector

Dropdown. Default: **V3.0**.

| Value | Label | Status | Selectable |
|---|---|---|---|
| `V3_0` | **V3.0 HTF Liquidation Trap** ⭐ | **VALIDATED FOR RESEARCH** (TRAIN + VALIDATION) | ✅ **default** |
| `V3_3` | V3.3 HTF Zone Mitigation & LTF Squeeze | `V3_3_TRAIN_ONLY` — **not validated, not ported** | ⚠️ **research only** (see the note below) |
| `V2_8` | V2.8 Zero-Fee Sniper + Trailing | SUPERSEDED (validated for research, zero-fee only) | ✅ |
| `V2_5` | V2.5 Trailing Stop (exit module) | Superseded | ✅ |
| `V2_6` | V2.6 Sniper + Trailing (real fees) | Rejected | ⚠️ research only |
| `V2_7` | V2.7 RR Optimization | Rejected | ⚠️ research only |
| `V2_3` | V2.3 Sniper Reversal | Rejected | ⚠️ research only |
| `V2_4` | V2.4 Asymmetric Sniper | **Failed validation** | ⚠️ show overfit warning |
| `V2_2` | V2.2 HTF Spot Engine | Rejected | ⚠️ research only |
| `V2_1` | V2.1 Corridor / Limit Entry | Rejected | ⚠️ research only |

**Implementation note (deviation, deliberate).** The site can only run what is
implemented in `src/` — currently `V3_0` and the original `V1_SMC` engine. The
V2.x rows and **V3.3** were produced by standalone research harnesses
(`scripts/real-data/`, `research/`) and were never ported into the production
pipeline. Offering them in a live dropdown would let an operator select a
strategy that emits nothing, so the admin panel lists them as **research-only**
(`researchOnlyStrategies` in `/api/admin/strategy`) instead of selectable. All
of their warnings are kept verbatim below for the record / for the day one of
them is ported.

**V3.3 specifically.** It is the second-best hypothesis this programme has
produced and the only one besides V3.0 to pass its pre-registered primary — but
it is **TRAIN-only** (TRAIN is burned data), its edge lives in the top 1 % of
trades, and it has **no `v33.*` settings, no route and no engine wiring**. It must
be shown in the selector as *"V3.3 — TRAIN pass, not validated, not implemented in
the engine"*, with the §2b parameter table presented as a **proposal for a future
port**, never as live inputs. Porting it is a separate decision that requires its
own forward-test pre-registration; a live dropdown entry before that would be
exactly the overstatement the programme forbids.

**UI requirement:**

- Selecting `V3_0` must show a banner: *"VALIDATION PASSED on aggregate
  (net +0.0600 R/trade @2/5 bps, n = 536) — 3 of 6 symbols negative, outlier
  fragility documented. Forward test only; PRODUCTION_READY is forbidden."*
- Selecting `V2_8` or `V2_5` must show: *"Superseded by V3.0 HTF Liquidation
  Trap."*
- Selecting anything other than `V3_0`, `V2_8` or `V2_5` must show a banner:
  *"This strategy was rejected in research. Historical results are negative.
  Research use only."* For `V2_4` add: *"Failed out-of-sample validation —
  results inverted. Known overfit."*

---

## 2. V3.0 HTF Liquidation Trap — parameters

**Lead candidate. Status `V3_0_VALIDATED_FOR_RESEARCH`** (validation PASS on
n = 536; results: [V3_0_VALIDATION_RESULTS.md](V3_0_VALIDATION_RESULTS.md)).

Full specification: [strategies/V3_0_HTF_LIQUIDATION_TRAP.md](strategies/V3_0_HTF_LIQUIDATION_TRAP.md).
Freeze record: [V3_0_CANDIDATE_FREEZE.md](V3_0_CANDIDATE_FREEZE.md).

> ⚠️ **FROZEN AS TESTED — these are the values that produced both the TRAIN and
> the VALIDATION result. Changing any of them produces a different, untested
> strategy.** In the
> research implementation (`research/v30_htf_trap.ts`) they are compile-time
> constants; in the site they are `v30.*` settings whose **defaults are exactly
> those constants** (`V30_FROZEN` in `src/strategy/v30/params.ts`, asserted by
> `tests/v30-port-parity.test.ts`). The wiring is authorised and implemented; the
> snapshot requirement is satisfied per signal: every V3.0 row stores its plan and
> its parameter values in `signals.breakdown.v30`, and the admin panel flags any
> deviation from the frozen values by key.

| Parameter | Type | Default | Min | Max | Description |
|----------|-----|--------|-----|------|----------|
| `v30.bodyRatioMin` | number | **0.35** | 0.10 | 0.80 | Мин. размер тела свечи возврата / Min. body/range of the reclaim candle |
| `v30.rvolMin` | number | **1.25** | 1.00 | 3.00 | Мин. всплеск объёма (strict `>`) / Min. volume surge |
| `v30.corridorATR` | number | **0.10** | 0.02 | 0.30 | Ширина коридора входа в ATR / Entry corridor half-width, in ATR |
| `v30.slBufferATR` | number | **0.15** | 0.05 | 0.50 | Буфер стоп-лосса за тенью выноса / Stop buffer beyond the sweep wick, in ATR |
| `v30.tp1Equilibrium` | number | **0.50** | 0.25 | 0.75 | Доля 4H ренджа для TP1 (0.50 = равновесие) / Share of the 4H range used for TP1 |
| `v30.breakevenTrigger` | string | **"tp1"** | — | — | Когда переносить стоп в безубыток / When to move the stop to breakeven |
| `v30.timeoutBars` | number | **50** | 10 | 100 | Таймаут в свечах 1H / Timeout in 1H bars |
| `v30.positionSplitTP1` | number | **0.50** | 0.25 | 0.75 | Доля позиции, закрываемая на TP1 / Fraction closed at TP1 |
| `v30.htfTimeframe` | enum | **"4h"** | `"1h"` · `"4h"` · `"1d"` | — | Старший ТФ для уровней / Higher timeframe for levels |
| `v30.ltfTimeframe` | enum | **"1h"** | `"15m"` · `"30m"` · `"1h"` | — | Рабочий ТФ для входа / Working timeframe for entry |

**Additional constants of the frozen candidate** (part of the tested
configuration, must be shown read-only rather than as free inputs):

| Constant | Value | Role |
|---|---|---|
| `corridor.expiryBars` (V3.0) | **3** | Corridor lifetime before `EXPIRED`. |
| fee model | **`FUT_MAKER_TAKER` 2/5 bps** | Maker entry, taker exit, charged per leg. |
| `engine.swing_lookback` | **3** | 4H pivot strength; a pivot is usable from `confirmedIndex = i + 3`. |
| `risk.atr_period` | **14** | ATR for the corridor half-width and the stop buffer. |
| `v2.volume_period` | **20** | RVOL averaging window. |
| intrabar rules R1–R5 | **as registered** | **Non-configurable. Do not expose** — relaxing them inflates backtests without changing live results. |

**Read-only result fields to display for V3.0** — show **both** windows side by
side, never TRAIN alone:

| field | TRAIN | VALIDATION |
|---|---|---|
| n | 1,585 | **536** |
| TP1 hit | 48.26 % | 47.39 % |
| TP2 hit | 17.35 % | 14.18 % |
| median stop | 1.2520 % | 1.2799 % |
| gross R/trade | +0.1726 | **+0.1274** |
| fee drag @2/5 | 0.0732 R | 0.0673 R |
| **net R/trade @2/5** | +0.0994 | **+0.0600** |
| net @5/5 | +0.0680 | +0.0312 |
| profit factor | 1.3538 | 1.2484 |
| max drawdown | −37.18 R | −25.94 R |
| **ex-top-1 % gross** | +0.0983 (57.0 % retained) | **+0.0384 (30.1 % retained)** |
| direction | LONG 796 (+0.1736) ≈ SHORT 789 (+0.1717) | LONG 230 (+0.0837) · SHORT 306 (+0.1602) |
| symbols | all six positive | ETH 101 (+0.4684) · BNB 77 (+0.4272) · DOGE 74 (+0.0542) · **BTC 107 (−0.0129)** · **SOL 90 (−0.0685)** · **XRP 87 (−0.0966)** |

Sources: `artifacts/research/v30/v30-train-metrics.json`,
`artifacts/research/v30/v30-validation-metrics.json`.

**UI warnings specific to V3.0:**

- *"VALIDATION PASSED on aggregate (+0.0600 R/trade @2/5 bps, n = 536), but
  3 of 6 symbols are negative and only two symbol cells clear n ≥ 100 — and they
  disagree in sign. Do not read this as per-symbol reliability."*
- *"Outlier fragility: removing the best 5 of 536 trades turns the net negative.
  Always display ex-top-1 % beside gross."*
- *"The pre-registered mechanism (wider 4H stop → lower fee-in-R) was falsified:
  the stop did not widen (1.28 % vs V2.8's ~1.30 %) and fee drag worsened because
  the partial exit pays three legs. The edge's true driver is still unmodelled."*

> ⚠️ **Never run V3.0 on the VALIDATION window again.** That budget is spent
> (exactly one run, 2026-09-16). A second look after any change would be fitting.

---

## 2b. V3.3 HTF Zone Mitigation & LTF Squeeze — parameters (PROPOSED, NOT IMPLEMENTED)

**Status `V3_3_TRAIN_ONLY`** — TRAIN pass only (net **+0.0267 R/trade** @2/5 bps,
n = 6,957, TP1 hit 65.24 %, fee drag 0.0511 R, PF 1.2341); **tail-fragile** and
**not validated**. Full specification:
[strategies/V3_3_HTF_ZONE_MITIGATION.md](strategies/V3_3_HTF_ZONE_MITIGATION.md).
Results: [V3_3_HTF_ZONE_MITIGATION_TRAIN_RESULTS.md](V3_3_HTF_ZONE_MITIGATION_TRAIN_RESULTS.md).

> ⚠️ **These parameters DO NOT EXIST in the settings registry.** There is no
> `v33.*` category in `src/core/settings.ts`, no admin route reading it, and no
> engine dispatch to a V3.3 strategy — the strategy lives only in
> `research/v33_zone_mitigation.ts` as compile-time constants. The table is the
> surface a **future port** would have to expose, and the admin panel may show it
> only under a *"not implemented — proposal"* heading. Rendering any of these as
> an editable input today would be a lie to the operator.

> ⚠️ **NOTHING HERE WAS SWEPT.** Every default is the pre-registered constant that
> produced the TRAIN artifact. The min/max columns are guard rails for a future
> UI, not a tested range: any other value produces a strategy that has never been
> measured, and the TRAIN figures above would no longer describe it.

| Parameter | Type | Default | Min | Max | Description |
|----------|-----|--------|-----|------|----------|
| `v33.bodyRatioMin` | number | **0.40** | 0.10 | 0.80 | Мин. тело свечи-возврата / Min. body/range of the reclaim branch |
| `v33.wickRatioMin` | number | **0.35** | 0.10 | 0.80 | Мин. доля тени-отказа / Min. rejection wick share of range |
| `v33.rvolMin` | number | **1.25** | 1.00 | 3.00 | Мин. всплеск объёма (включительно) / Min. volume surge, inclusive `>=` |
| `v33.closeTopFrac` | number | **0.70** | 0.55 | 0.95 | Закрытие в крайних 30 % диапазона / Close in the outer 30 % (mirror 0.30) |
| `v33.fvgFillMin` | number | **0.50** | 0.25 | 1.00 | Доля заполнения 4H FVG для митигации / FVG fill share required to mitigate |
| `v33.zoneType` | enum | **`"both"`** | `"both"` · `"ob"` · `"fvg"` | — | Какие 4H-зоны принимать / Which 4H zones are eligible |
| `v33.triggerWindow` | enum | **`"while"`** | `"while"` · `"first"` | — | Окно триггера / Trigger window — **`"first"` fails F1** (−0.0253) |
| `v33.stopAnchor` | enum | **`"zoneEdge"`** | `"zoneEdge"` · `"climax"` | — | Стоп за дальней структурой или только за тенью / Stop behind the further structure, or the wick only |
| `v33.tp1Leg` | enum | **`"displacement"`** | `"displacement"` · `"swing"` | — | Как измеряется нога для TP1 / Which leg defines TP1 |
| `v33.corridorATR` | number | **0.10** | 0.02 | 0.30 | Ширина коридора входа в ATR / Entry corridor half-width, in ATR |
| `v33.slBufferATR` | number | **0.15** | 0.05 | 0.50 | Буфер стопа за структурой / Stop buffer beyond the structure, in ATR |
| `v33.tp1Equilibrium` | number | **0.50** | 0.25 | 0.75 | Доля ноги для TP1 (0.50 = равновесие) / Share of the leg used for TP1 |
| `v33.timeoutBars` | number | **48** | 10 | 100 | Таймаут в свечах 1H / Timeout in 1H bars |
| `v33.positionSplitTP1` | number | **0.50** | 0.25 | 0.75 | Доля позиции, закрываемая на TP1 / Fraction closed at TP1 |
| `v33.htfTimeframe` | enum | **`"4h"`** | `"4h"` · `"1d"` | — | Старший ТФ для зон / Zone timeframe (1D was never read) |
| `v33.ltfTimeframe` | enum | **`"1h"`** | `"15m"` · `"30m"` · `"1h"` | — | Рабочий ТФ входа / Working timeframe for entry |

**Read-only result fields to display for V3.3** (always with the caveats, never
bare):

| field | value |
|---|---|
| n | **6,957** |
| TP1 hit | **65.24 %** |
| TP2 hit | 12.43 % |
| median stop | 1.6953 % of price |
| gross R/trade | **+0.0778** |
| fee drag @2/5 | 0.0511 R |
| **net R/trade @2/5** | **+0.0267** |
| net @5/5 | +0.0047 |
| profit factor / max drawdown | 1.2341 / −43.67 R |
| **ex-top-1 % gross** | **+0.0264 — BELOW the 0.0511 R fee** |
| directions | LONG 3,537 (+0.0382) · SHORT 3,420 (+0.1188) |
| symbols | all six positive gross (+0.038 … +0.107) |
| triggers rejected by geometry | 8,140 of 15,957 |

Source: `artifacts/research/v33/v33-train-metrics-while-protective-displacement.json`.

**UI warnings specific to V3.3 (all mandatory):**

- *"TRAIN ONLY — this strategy has never been validated. Removing the best 1 % of
  its trades leaves −0.0013 R/trade after fees: without its tail it loses money."*
- *"The trigger window is load-bearing: the strictest reading of the same rule
  (`first`) fails the primary criterion (−0.0253 R/trade)."*
- *"Not implemented in the engine — selecting it here would do nothing. Porting
  requires a separate decision and its own forward-test pre-registration."*
- *"Both research windows are spent. No validation on existing data is possible."*

**Additional constants of the tested configuration** (read-only, must not be
presented as inputs): `v2.displacement_min_body_atr = 0.6`,
`v2.fvg_min_size_atr = 0.15`, corridor expiry **3** bars, fee model **2/5 bps**,
`engine.swing_lookback = 3`, `risk.atr_period = 14`, `v2.volume_period = 20`,
warm-up **60** bars, intrabar rules **R1–R5** (non-configurable).

---

## 3. Shared entry parameters — sniper filter

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

## 4. Exit parameters — trailing stop

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

## 5. Exit parameters — fixed R targets

Used by **V2.3, V2.7**.

| Parameter | Type | Default | Min | Max | Description | Impact warning |
|---|---|---|---|---|---|---|
| `target.tp1R` | number | **1.5** | 0.5 | 10.0 | First take-profit as a multiple of risk. | Must exceed `risk.minRr` or every setup is rejected. **Does not affect fee-in-R** — see V2.7. |
| `target.tp2R` | number | **2.5** | 1.0 | 20.0 | Second target cap; structure substitutes if nearer. | — |
| `target.maxBars` | integer | **50** | 5 | 200 | Horizon before closing at market. | Frozen engine default is 48. |

---

## 6. Exit parameters — structural SMC targets

Used by **V2.1, V2.2, V2.4**.

| Parameter | Type | Default | Description | Impact warning |
|---|---|---|---|---|
| `target.allowRMultipleFallback` | boolean | **false** | Emit 1R/2R/3R rungs when structure supplies nothing. | V2.2 measured `R_MULTIPLE` as the **only profitable TP1 basis** (+0.0449). Disabling it made results worse. Treat `false` as the *researched* setting, not the better one. |
| `target.equilibriumFallback` | boolean | **true** | Use range midpoint when no liquidity target exists. | Disabling skips more setups. |

---

## 7. Corridor / limit entry

Used by **V2.1, V2.4**.

| Parameter | Type | Default | Min | Max | Description | Impact warning |
|---|---|---|---|---|---|---|
| `corridor.enabled` | boolean | **false** | — | — | Rest a limit order instead of market-filling at OPEN N+1. | Measured 24.09 % fill rate. V2.8 does **not** use it. |
| `corridor.atrFraction` | number | **0.10** | 0.01 | 1.0 | Zone half-width in ATR. | Wider → more fills, worse average price. |
| `corridor.maxPct` | number | **0.0015** | 0.0001 | 0.01 | Hard cap on half-width as a fraction of price (0.15 %). | Prevents absurd zones during volatility spikes. |
| `corridor.expiryBars` | integer | **3** | 1 | 50 | Bars before an unfilled order expires. | Raising increases fills but acts on staler confirmation. |

---

## 8. Fee Drag Guard

Used by **V2.1 corridor, V2.4**. Measured **inert** at 15m–4h (zero rejections in V2.6).

| Parameter | Type | Default | Min | Max | Description | Impact warning |
|---|---|---|---|---|---|---|
| `feeGuard.enabled` | boolean | **false** | — | — | Reject setups whose stop is too tight to survive fees. | ⚠️ V2.1 measured it rejecting setups whose gross was **~5× better** than those it admitted. It removes cost *and* edge. |
| `feeGuard.minStopPct` | number | **0.0035** | 0.0 | 0.02 | Minimum stop distance as a fraction of price (0.35 %). | Raising rejects the majority of setups. |
| `feeGuard.minStopAtr` | number | **0.50** | 0.0 | 3.0 | Minimum stop distance in ATR. | Second, volatility-relative floor. |

**Hard rule:** the stop is **never widened** to satisfy the guard. Failing setups
are skipped. Widening would manufacture a better R by fiat.

---

## 9. Confluence filter

Used by **V2.1 corridor, V2.2**. **Not** used by V2.8.

| Parameter | Type | Default | Min | Max | Description | Impact warning |
|---|---|---|---|---|---|---|
| `confluence.enabled` | boolean | **false** | — | — | Require N of 4 confirmation votes. | Measured to remove ~95 % of setups. |
| `confluence.minVotes` | integer | **3** | 0 | 4 | Votes required. | 4 is far too rare; 2 barely filters. |
| `confluence.rvolMin` | number | **1.2** | 0.5 | 5.0 | Volume vote threshold. | Duplicates `sniper.minRvol` — double-counts volume if both are on. |
| `confluence.rsiLongMax` | number | **45** | 0 | 100 | RSI zone bound for longs. | — |
| `confluence.rsiShortMin` | number | **55** | 0 | 100 | RSI zone bound for shorts. | — |

---

## 10. Risk & structure (frozen engine settings)

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

## 11. Fee model selector

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

## 12. Timeframe selector

Multi-select. Default: **15m, 30m, 1h, 4h**.

| Value | Selectable | Note |
|---|---|---|
| 1m, 5m | ⚠️ warn | Break-even cost is **negative** — unprofitable even at zero fees |
| 15m | ✅ | Only timeframe with n ≥ 100 in validation |
| 30m, 1h, 4h | ✅ | Default set |
| 1d | ⚠️ warn | Sample too thin (n = 8–45) |

**V3.0 overrides this selector:** the frozen candidate runs a fixed
`1h` execution / `4h` structure pair (`v30.ltfTimeframe` / `v30.htfTimeframe`).
Changing either is a different strategy and invalidates the freeze.

---

## 13. Symbol selector

Multi-select. Default: **all six**.

BTCUSDT · ETHUSDT · BNBUSDT · SOLUSDT · XRPUSDT · DOGEUSDT

**Warning to display (V2.x):** *"No per-symbol conclusion is statistically
supported — every validation symbol cell had n < 100."*

**V3.0 note:** on TRAIN every symbol cell cleared the `n < 100` rule for the first
time (n = 238–295, all six positive). That rule still applies to the VALIDATION
run, which is expected to produce roughly one third of the TRAIN sample.

---

## 14. Implementation requirements

1. ~~**Never write to `src/`.**~~ **SUPERSEDED (2026-09-16).** That rule scoped
   the research phase: `src/` stayed byte-identical to `4839074` while the
   candidate was being validated, so the artifact could not be tainted. The port
   task changed the goal — V3.0 now has to RUN in the site — so `src/` is where
   the work happens. What replaces the rule, in order of strength:
   `research/v30_htf_trap.ts` itself stays untouched (sha256 pinned by
   `tests/v30-validation.test.ts`), the strategy logic is proven equivalent by
   `scripts/real-data/v30-parity.ts` (TRAIN-only, every trade compared) and by
   `tests/v30-port-parity.test.ts`, and `git diff 4839074 -- src/strategy/`
   now shows the port rather than a frozen tree.
2. **Persist a parameter snapshot** (hash + values) with every run, as this
   repository does via `settings.sha256`.
3. **Expose read-only result fields:** n, win rate, gross R/trade, profit factor,
   max drawdown, **gross excluding top 1 %**, fee drag, net R/trade.
4. **Always show `ex-top-1 %` beside gross.** Several strategies here looked
   profitable until trimmed; this field is the single best fragility indicator.
5. **Show `n` on every table row** and grey out any subgroup with n < 100.
6. **Pin the V3.0 candidate by hash.** The research module — sha256
   `a821757ff0319a100a8a9087da1bdd137abb1df0785493d644ad4d87f05dc4cd` — must
   stay unchanged; a mismatch aborts `tests/v30-validation.test.ts`. The site
   runs the ported module rather than that file, so the pin alone is not enough:
   `V30_RESEARCH_SHA256` and the parity status are shown in the admin panel, and
   the parity run is the check that the port still deserves the V3.0 label.
7. **Never run V3.0 on the TEST window.** Before loading a candle the driver must
   assert `validToMs < testFromMs`; the 2026-H1 window is unspent and must not be
   downloaded.

8. **Forward test is the only remaining evidence.** Both research windows are
   spent (TRAIN and VALIDATION were each read once) and the 2026 TEST window has
   never been read and must stay unread. Forward testing on live data is
   `FORWARD_TEST`/`DRY_RUN` only.
9. **Never present a drifted configuration as validated.** If any `v30.*`
   parameter differs from the frozen value, the admin panel must say so by key
   and the TRAIN/VALIDATION numbers must not be attached to that run.
10. **Keep the outcome record honest.** The `outcomes.r_multiple` a V3.0 trade
    writes is **net of per-leg fees** (maker entry, taker on each of the two
    exits); the gross R, the fee R and the leg count are stored beside it in
    `signals.breakdown.v30.lastOutcome`. A net figure must never be silently
    replaced by a gross one.
11. **Never present V3.3 as validated, live or selectable.** It has no settings
    category, no route and no engine wiring. The selector must label it research-
    only, §2b must be shown as a proposal, and any port must first fix its own
    forward-test pre-registration — because the pre-registered verdict it earned
    is `V3_3_TRAIN_ONLY`, and TRAIN is burned data.

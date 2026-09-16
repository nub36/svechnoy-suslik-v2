# V2.3 — SNIPER REVERSAL ENGINE — PRE-REGISTRATION

**Written and committed BEFORE any V2.3 research is run.** No V2.3 performance
number exists. Every rule, threshold and metric below is fixed now and may not
be revised after results are seen.

Frozen V2 (`4839074`) is not modified. V2.3 is a separate research path.

| pinned | value |
|---|---|
| frozen strategy | `4839074` (unchanged) |
| prior stage | V2.2 TRAIN, `5ce58db` (`V2_2_REJECTED_ON_TRAIN`) |
| dataset | `c3c1dce` |
| development slice | **TRAIN only** |
| VALIDATION | once, after candidate freeze |
| TEST (2022–2025) | **USED — excluded** |
| future window (2026-H1) | not downloaded |

---

## 0. HONEST STATEMENT OF CIRCULARITY — read first

Both defining choices of V2.3 were taken from observations made on **TRAIN,
after the V2.2 run had already been scored**:

1. **Reversals-only** comes from the V2.2 finding that the new sweep gates
   selected reversals with **+0.0785** gross expectancy versus **−0.0270** for
   the frozen rule — on **n=421**.
2. **Restoring R-multiple targets** comes from the V2.2 finding that
   `R_MULTIPLE` was the only profitable TP1 basis (**+0.0449**, n=5,130) while
   `INTERNAL_LIQUIDITY` was **−0.0058** (n=22,194).

This means V2.3 is **not an independent test**. It is a hypothesis fitted on
TRAIN and then re-measured on the same TRAIN data, which inflates any result. A
positive TRAIN outcome here is therefore **weak evidence**, not confirmation,
and the only thing that could confirm it is the untouched VALIDATION split —
and after that, a genuinely unseen period.

Recorded now so it cannot be quietly forgotten if the numbers look good.

### Statistical power, stated up front

V2.2 arm R produced **421** closed reversals across 15m–4h; with the corridor
and filters, arm FULL produced **136**. V2.3 disables continuation entirely, so
the expected closed-trade count is of order **400–600**. Spread across 4
timeframes × 6 symbols × 2 directions, most subgroup cells will be **under 100**
and some under 20. Per the standing rule, **no subgroup with n < 100 may support
a conclusion**, and the headline itself must be read as underpowered.

---

## 1. Scope

| item | value |
|---|---|
| setups | **REVERSAL only — CONTINUATION is disabled** |
| timeframes | 15m, 30m, 1h, 4h |
| HTF context | frozen `HTF_MAP`, closed bars only |
| symbols | the 6 frozen symbols |
| slice | TRAIN |

## 2. Reversal filter (fixed)

All conditions read from the frozen `SweepEvent` on the setup at **CLOSED N**:

| # | condition | field | requirement |
|---|---|---|---|
| 1 | swept a real extreme | pool `kind` | `SWING`, `EQUAL` or `CLUSTER` |
| 2 | directional | `sweep.direction` | `== setup.direction` |
| 3 | causal reclaim | `sweep.reclaimed` | `=== true` |
| 4 | prompt reclaim | `sweep.reclaimBars` | `<= 3` |
| 5 | genuine penetration | `sweep.penetrationAtr` | `>= 0.10` (frozen) |
| 6 | rejection wick | `sweep.wickRatio` | `>= 0.25` (frozen) |
| 7 | **body reclaim** | `sweep.bodyRatio` | **`>= 0.35`** |
| 8 | **volume surge** | `sweep.rvol` | **`> 1.2`** |

Conditions 7–8 are the V2.2 "sniper" gates, carried over **unchanged**. No
threshold is swept. The separate `Displacement` object is **not** required —
that requirement was measured to be the binding blocker.

Pool kind is recorded for reporting. **Condition 1 is a gate** (an extreme must
have been swept) but the *specific* kind is never used to filter, since V2.1
measured EQH/EQL to be the worst kind.

## 3. Target ladder — R-multiple restored (fixed)

```
TP1 = entry ± 1.5R
TP2 = min(2.5R, nearest opposing structural liquidity beyond TP1)
TP3 = nearest opposing structural liquidity beyond TP2, if any
```

where `R = |entry − structuralStop|`, direction-aware.

Rationale: V2.2 measured the removal of R-multiple targets to be a mistake.
TP1 at **1.5R** is fixed now and not swept; it is above the frozen
`risk.min_rr = 1`, so a 1.5R TP1 **always clears the rr1 gate by construction**,
which is the mechanism intended to fix V2.2's 60–71 % rr1 rejection.

TP2 prefers structure when structure is nearer than 2.5R, otherwise uses 2.5R.
TP3 is structural only; if none exists the ladder is 2 rungs.

**Exit model unchanged: final rung only.** H1 was tested and NOT validated — no
partial, no breakeven, no trailing. `risk.min_rr` stays at the frozen value.

## 4. Execution — corridor entry (fixed)

```
centre    = close(N)
halfWidth = clamp(0.10 × ATR(N), 1 tick, 0.15 % × close(N))
corridor  = [quantize(centre − halfWidth), quantize(centre + halfWidth)]
```

- Fill only from **N+1 onward**, never on the setup bar.
- Conservative fill price: LONG `min(open, corridorHigh)`, SHORT
  `max(open, corridorLow)` — never better than the corridor's worse edge.
- Expiry **3 bars** → `EXPIRED`. Structural SL breached before fill →
  `CANCELLED`. Frozen TP1 reached before fill → `MISSED` (never chased).
- One candle that both fills and breaches the SL → `CANCELLED` (unfavourable
  reading), consistent with frozen `sl_priority_on_ambiguous_bar = true`.
- Post-fill, risk and every target R are **recomputed from the actual fill**;
  invalid geometry → the trade is not taken.

**Fee model (maker fill):** entry **2 bps maker**, exit **5 bps taker**, charged
per leg on that leg's own notional:

```
feeR = (2bps × entryPrice + 5bps × exitPrice) / riskPerUnit
```

The exit is taker because SL and TIMEOUT exits are market events. **No maker
rebate (negative fee) is assumed.** For comparability the same four environments
as Amendment 1 are reported: GROSS (0), SPOT (10 bps), FUT_7 (2/5 — the headline
model for this design), FUT_4 (2/2, best case).

## 5. Fee Drag Guard and confluence

The **Fee Drag Guard is RETAINED**: `stop >= 0.35 % of price AND >= 0.5 ATR`,
never widening the stop. Rationale: V2.1 measured it to reject setups whose
baseline gross was ~5× better, so it is **ablated separately** (arm `S-noguard`)
rather than assumed helpful.

The **confluence filter is DROPPED** for V2.3. Conditions 7–8 already encode
volume; re-applying RVOL inside a 3-of-4 vote would double-count it, and V2.2
measured confluence to remove ~95 % of setups. It is therefore **not** part of
the design, and is not reintroduced later.

## 6. Ablation (fixed in advance)

| arm | description |
|---|---|
| **A** | frozen baseline, all setups, OPEN N+1 — fidelity anchor |
| **S-base** | reversals only, frozen targets, OPEN N+1 |
| **S-tgt** | reversals only, **R-multiple ladder**, OPEN N+1 |
| **S-cor** | S-tgt + corridor entry |
| **S-full** | S-cor + Fee Drag Guard |
| **S-noguard** | S-cor without the guard (isolates the guard's effect) |

`S-tgt vs S-base` isolates the ladder; `S-cor vs S-tgt` isolates entry;
`S-full vs S-noguard` isolates the guard.

## 7. Success criteria (fixed, and deliberately strict)

**Primary:** positive **net expectancy per FILLED trade** *and* positive **net
expectancy per ORIGINAL ACTIONABLE SETUP**, under **both** FUT_4 and FUT_7.

Both denominators must be positive in both environments. Per-trade alone is not
sufficient — that is exactly how V2.1's model B looked good while being worst
overall.

**Secondary, reported but not decisive:** rr1 rejection should be ≈0 by
construction (TP1 = 1.5R > min_rr = 1); if it is not, the ladder is misbuilt.

**Failure is the expected outcome and must be reported plainly.** Every study so
far has measured V2's gross edge at ~0.03 R/trade with no entry, target or
filter rearrangement creating alpha. If the criteria are not met, the status is
`V2_3_REJECTED_ON_TRAIN`.

## 8. Metrics and mandatory anti-bias checks

Per arm: actionable setups, every rejection bucket, PENDING, FILLED, fill rate,
MISSED, EXPIRED, CANCELLED, closed, TP/SL/TIMEOUT, gross expectancy per filled
and per setup, median R, PF, total R, max drawdown, positiveRRate, stop %
quantiles, stop ATR, fill latency, and **net expectancy in all four fee
environments on both denominators**.

Gross is reconstructed exactly as `grossR = storedR + (0.1/100) × entry / risk`,
because `trackOutcome` returns an R already net of the frozen lump fee.

Breakdowns, always with n: **LONG vs SHORT**, **per timeframe**, **per symbol**,
HTF alignment, pool kind, and TP1 basis.

Mandatory:
1. **MISSED analysis** — baseline outcome of declined setups.
2. **Selection bias** — baseline outcomes for FILLED vs NOT-FILLED.
3. **Fee-guard decomposition** — baseline outcome of setups the guard rejects vs
   admits (repeating the V2.1 check that exposed edge-removal).
4. **Outlier dependence** — expectancy excluding the best 1 trade, best 5, and
   top 1 %. With n≈500 a single outlier can carry the result, so this is
   decisive here.
5. **Sample-size honesty** — n on every row; no subgroup with n<100 may support
   a conclusion.

## 9. Required tests before results are reported

Model A fidelity gate; reversal filter accept/reject for each of the 8
conditions including the `bodyRatio >= 0.35` and `rvol > 1.2` boundaries;
continuation is genuinely disabled (a CONTINUATION setup is always rejected);
R-multiple ladder geometry for LONG and SHORT including the TP2 structural
substitution; corridor quantisation, max-width cap and all terminal states;
same-bar ambiguity → CANCELLED; **no look-ahead** (fill index strictly > setup
index); per-leg fee arithmetic.

## 10. Selection protocol and permitted statuses

TRAIN only. At most **one** arm may be carried forward, chosen on net expectancy
per actionable setup, outlier robustness and sample adequacy — **not** on
highest per-trade expectancy. The choice and reason are committed **before**
VALIDATION runs. VALIDATION runs **once**.

Permitted statuses: `V2_3_REJECTED_ON_TRAIN`, `V2_3_NOT_VALIDATED`,
`V2_3_VALIDATED_FOR_RESEARCH`. **`PRODUCTION_READY` is forbidden.**

**v2.enabled = false. LIVE_TRADING_ENABLED = false. Research only.**

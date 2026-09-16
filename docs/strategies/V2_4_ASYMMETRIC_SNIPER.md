# V2.4 — ASYMMETRIC SNIPER ENGINE

**Status: ❌ `V2_4_NOT_VALIDATED`** — passed TRAIN, failed validation comprehensively
· docs: `V2_4_TRAIN_RESULTS.md`, `V2_4_VALIDATION_RESULTS.md`
· code: `scripts/real-data/v24-engine.ts`

> **This is the cautionary tale of the programme.** It met every TRAIN criterion,
> then inverted on unseen data. Read §Results before reusing any part of it.

## What it does

Sniper reversal entry plus a **one-sided HTF filter**: LONGs must show HTF-bullish
confluence, SHORTs are unrestricted. The asymmetry was added because V2.3 measured
LONGs (+0.0325) underperforming SHORTs (+0.1392).

## Entry logic

1. The 8-condition sniper filter (see V2.8 §2).
2. **LONG only** — additionally requires **≥ 1 of 3** HTF-bullish legs:
   - `close(N) > EMA200` on the causally-bounded primary HTF series, **or**
   - any available `HtfContext.bias === 'BULLISH'`, **or**
   - `rsi.bullishDivergence === true`.
3. SHORTs bypass this gate entirely.

Entry at OPEN of N+1, then corridor execution (`close(N) ± 0.10 ATR`).

## Exit logic

Structural SMC targets only — nearest opposing liquidity → equilibrium → skip.
No R-multiple fallback.

## Stop loss

Structural behind the sweep wick + **0.25 ATR**.

## Key parameters

| Parameter | Value | Type | Controls | Impact if changed |
|---|---|---|---|---|
| sniper filter | as V2.3 | — | Base entry | — |
| LONG legs required | ≥ 1 of 3 | integer | HTF confluence for longs | Requiring 2+ nearly eliminates longs |
| `HTF_EMA_MIN_BARS` | 200 | integer | Min closed HTF bars for EMA200 | Below this the leg is **false**, never true-by-default |
| primary HTF | first entry of `HTF_MAP[tf]` | enum | Which series feeds EMA200 | 15m/30m→1h, 1h→4h, 4h→1d |
| SHORT gate | **none** | — | Asymmetry | Adding one changes the design |
| corridor | 0.10 ATR, 3-bar expiry | number | Execution | — |

## Results — TRAIN passed, VALIDATION failed

| Metric | TRAIN | VALIDATION |
|---|---|---|
| n | 689 | 234 |
| Gross R/trade | **+0.2023** | **−0.1098** |
| Profit factor | 1.2989 | **0.8559** |
| Net @2/5 bps | +0.0624 | **−0.2350** |
| Gross ex-top-1 % | +0.1069 | −0.2540 |

**Every component inverted:**

| Component | TRAIN | VALIDATION |
|---|---|---|
| LONG | +0.0743 | −0.2668 |
| SHORT | +0.2937 | +0.0033 |
| HTF_EMA200 leg | +0.2422 | −0.1985 |
| HTF_STRUCTURE leg | −0.1919 | −0.2953 |
| RSI_DIVERGENCE leg | +0.2201 | −0.7812 |

**The selection filter became anti-selective.** On TRAIN it picked setups with
baseline gross +0.3316 and rejected LONGs at −0.2339. On VALIDATION it picked
−0.1863 while declining +0.0508, and the LONGs it threw away were the **best in
the sample (+0.5259)**.

## Why it failed — the lesson

**Circularity.** The LONG gate was designed *because* LONGs underperformed on the
same TRAIN data used to score it. That gain was fitting, not signal.

One leg (`HTF_STRUCTURE`) was **known negative on TRAIN** (−0.1919, n=110) and was
deliberately **not patched** before validation — patching it would have been
further TRAIN-fitting. That restraint was vindicated: `HTF_EMA200`, the leg that
carried TRAIN, also reversed, so removing the bad leg would not have saved it.

## When to use

**Never.** Overfitted. Do not reintroduce the LONG asymmetry into any successor —
V2.8 deliberately excludes it.

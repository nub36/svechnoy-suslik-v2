# V2.3 — SNIPER REVERSAL ENGINE

**Status: ❌ `V2_3_REJECTED_ON_TRAIN`** · doc: `V2_3_TRAIN_RESULTS.md`
· code: `scripts/real-data/v23-engine.ts`

## What it does

First strategy to trade **reversals exclusively** through a strict sweep filter,
paired with fixed R-multiple targets. This is where the **sniper filter** — the
most valuable component found in the whole programme — was introduced.

## Entry logic

The 8-condition sniper filter (see V2.8 §2), all required, continuation disabled.
Entry at OPEN of N+1.

## Exit logic

```
TP1 = entry ± 1.5R
TP2 = min(2.5R, nearest opposing liquidity beyond TP1)
TP3 = nearest structural level beyond TP2, if any
```
TP1 at 1.5R clears `risk.min_rr = 1` by construction, eliminating `rr1` rejection.

## Stop loss

Structural behind the sweep wick + **0.25 ATR**.

## Key parameters

| Parameter | Value | Type | Controls | Impact if changed |
|---|---|---|---|---|
| `MIN_BODY_RATIO` | 0.35 | number | Sweep body reclaim | Core filter |
| `MIN_RVOL` | 1.2 | number | Volume surge, strict `>` | Core filter |
| `RECLAIM_MAX_BARS` | 3 | integer | Reclaim promptness | — |
| `MIN_PENETRATION_ATR` | 0.10 | number | Sweep depth | — |
| `MIN_WICK_RATIO` | 0.25 | number | Rejection wick | — |
| `TP1_R` | 1.5 | number | First target | Clears min_rr by construction |
| `TP2_R` | 2.5 | number | Second target cap | Structure substitutes if nearer |
| Continuation | disabled | boolean | Scope | Defining choice |

## Results — why it was rejected

Criteria: net > 0 per filled trade **and** per setup, under **both** FUT_4 and FUT_7.

| Arm | n | Gross | FUT_4 /fill | FUT_7 /fill | Pass |
|---|---|---|---|---|---|
| A | 30,888 | −0.0015 | −0.0725 | −0.1257 | ❌ |
| S-base | 836 | +0.0585 | −0.0309 | −0.0980 | ❌ |
| S-tgt | 1,589 | +0.0112 | −0.0623 | −0.1173 | ❌ |
| **S-cor** | 1,497 | **+0.0844** | **+0.0164** | −0.0345 | ❌ |

**Ablation:**
- Sniper filter: −0.0015 → **+0.0585**, max drawdown −505.8R → −33.6R. Works.
- R-multiple ladder: +0.0585 → **+0.0112**. *Hurt* reversals.
- Corridor: +0.0112 → **+0.0844**. Largest single gain.

**Fatal flaw — outlier fragility:** removing 15 of 1,497 trades cut gross from
+0.0844 to **+0.0196** — **77 % of the edge sat in 1 % of trades.**

**The standout positive:** the filter selected setups with baseline gross
**+0.2663** vs **−0.0036** for those declined — proof it identifies real quality.

## When to use

**Never as a whole strategy.** But its entry filter is the core of V2.8 and
should be ported. Its R-multiple ladder should not.

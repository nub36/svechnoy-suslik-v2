# V2.2 — HTF-FOCUSED SPOT ENGINE

**Status: ❌ `V2_2_REJECTED_ON_TRAIN`** — both success criteria failed
· doc: `V2_2_TRAIN_RESULTS.md` · code: `scripts/real-data/v22-engine.ts`

## What it does

Restricts trading to timeframes where Binance Spot fees are survivable, and
attempts to unblock two measured funnel losses: an excessive `rr1` rejection rate
and a near-dead reversal path.

## Entry logic

**Reversal:** sweep + reclaim (≤3 bars) + **body reclaim `bodyRatio ≥ 0.35`** +
**`rvol > 1.2`**. The separate `Displacement` object requirement — which had been
the binding blocker — is removed.

**Continuation:** body close beyond the level (`closeBeyondAtr ≥ 0.25`,
`bodyRatio ≥ 0.50`) with the `holdBars ≥ 1` requirement relaxed to
`immediateReclaim === false`.

Entry at OPEN of N+1.

## Exit logic

**Structural targets only** — nearest opposing liquidity (`INTERNAL_LIQUIDITY` or
`RANGE_EDGE`) → `EQUILIBRIUM` → otherwise **skip the setup**. The 1R/2R/3R
fallback ladder is removed.

## Stop loss

Structural behind the sweep wick + **0.25 ATR**.

## Key parameters

| Parameter | Value | Type | Controls | Impact if changed |
|---|---|---|---|---|
| `REV_MIN_BODY_RATIO` | 0.35 | number | Reversal body reclaim | Core gate |
| `REV_MIN_RVOL` | 1.2 | number | Reversal participation | Strict `>` |
| `REV_RECLAIM_MAX_BARS` | 3 | integer | Reclaim promptness | — |
| `CONT_MIN_CLOSE_ATR` | 0.25 | number | Continuation close beyond level | — |
| `CONT_MIN_BODY_RATIO` | 0.50 | number | Continuation body vs wick | — |
| hold requirement | `immediateReclaim === false` | boolean | Replaces `holdBars ≥ 1` | Relaxation was the point |
| R-multiple fallback | **removed** | — | Target source | Measured to be a mistake |
| Timeframes | 15m, 30m, 1h, 4h | enum | Scope (amended from 1h/4h) | — |

## Results — why it was rejected

Success criteria were `rr1` rejection < 40 % and reversal share ≥ 10 %.

| Arm | rr1 rejection | < 40 %? | Reversal share | ≥ 10 %? |
|---|---|---|---|---|
| A (baseline) | 71.12 % | ❌ | 19.89 % | ✅ |
| T (targets) | 60.71 % | ❌ | 23.95 % | ✅ |
| R (confirm) | 57.18 % | ❌ | **1.64 %** | ❌ |
| FULL | 10.02 % | ✅ | **2.55 %** | ❌ |

**Both changes backfired:**

1. **The reversal "unblock" was a net tightening** — share fell 19.89 % → 1.64 %.
   The new gates rejected 13,897 `weak_body_reclaim` + 3,848 `low_rvol` setups,
   more than the displacement rule they replaced. The `no_displacement` premise
   came from the 1m-dominated corpus and did not hold at 15m–4h.
2. **The removed R-multiple fallback was the only profitable TP1 basis**
   (+0.0449 vs INTERNAL_LIQUIDITY −0.0058). Removing it dropped gross per filled
   trade from −0.0015 to −0.0358.

FULL only met the `rr1` criterion because other gates had already removed ~95 %
of setups before `rr1` could be evaluated.

## When to use

**Never.** Both mechanisms are disproven. The body-reclaim + RVOL pair survived
into V2.3/V2.8 as the sniper filter — that part was worth keeping.

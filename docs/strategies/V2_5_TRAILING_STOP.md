# V2.5 — DYNAMIC TRAILING STOP + BREAKEVEN

**Status: ⚠️ `V2_5_PROMISING_PENDING_VALIDATION`** — beat the baseline, still net-negative
· doc: `V2_5_TRAIN_RESULTS.md` · code: `scripts/real-data/v25-trailing.ts`

> **This is an EXIT MODULE, not a standalone strategy.** Its exit logic is reused
> verbatim by V2.6 and by the final V2.8.

## What it does

Keeps **all** baseline V2 entries unchanged and replaces the fixed target ladder
with a breakeven + trailing stop. A clean exit-only ablation: same entries, same
initial stops, different exit.

## Entry logic

**Unchanged** — every frozen V2 setup (reversal *and* continuation), entry at the
OPEN of N+1. **No sniper filter.**

## Exit logic

| Stage | Rule |
|---|---|
| Initial | Structural stop `S₀` |
| Breakeven | `MFE ≥ 1.0R` → stop to entry |
| Trailing | Stop = `peakMFE − 1.0R` |
| Step gate | Updates only on `≥ 0.25R` MFE advance |
| Targets | **None** |
| Timeout | `MFE < 1.0R` by bar 10 → close at market |

Intrabar rules R1–R5 as documented in V2.8 §3 — all conservative.

## Key parameters

| Parameter | Value | Type | Range | Controls | Impact if changed |
|---|---|---|---|---|---|
| `BREAKEVEN_R` | 1.0 | number | 0.5–3 | MFE to move stop to entry | ↓ protects sooner, more breakeven stop-outs |
| `TRAIL_DISTANCE_R` | 1.0 | number | 0.25–3 | Trail distance below peak | ↓ tighter, exits earlier |
| `TRAIL_STEP_R` | 0.25 | number | 0.05–1 | MFE advance to move stop | ↓ more updates |
| `TIMEOUT_BARS` | 10 | integer | 5–100 | Bars to reach +1R | ↑ holds stalled trades |

## Results

| Metric | Baseline A | V2.5 |
|---|---|---|
| Trades | 30,888 | 30,867 |
| **Gross R/trade** | −0.0015 | **+0.0457** |
| Net @2/5 bps | −0.1257 | **−0.0786** |
| Win rate | 28.11 % | **47.88 %** |
| Avg win | +2.3634 | +0.9261 |
| Avg loss | −0.9261 | −0.7630 |
| Profit factor | 0.9978 | **1.1150** |
| **Max drawdown** | **−505.82 R** | **−79.26 R** |

**Improved every single cell** — both directions, all four timeframes, all six
symbols, each with n in the thousands. The most broadly consistent result in the
programme, and not derived from a TRAIN observation.

**Still fails on economics:** gross +0.0457 against fee drag 0.1243 R/trade.
Removing the top 1 % flips gross to −0.0189. And **63.61 %** of trades never reach
+1R, so the mechanism cannot touch two thirds of the book.

## When to use

**As the exit module of V2.8.** Do not deploy standalone — without the sniper
entry filter the gross edge is too thin. Note that V2.6 later measured trailing
to add **nothing** on top of the sniper filter at real fees (−0.0028); it is
retained in V2.8 for its superior *shape* (higher win rate, smaller drawdown) at
zero fees.

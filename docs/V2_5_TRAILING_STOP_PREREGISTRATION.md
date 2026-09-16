# V2.5 — DYNAMIC TRAILING STOP + BREAKEVEN EXIT ENGINE — PRE-REGISTRATION

**Written and committed BEFORE any V2.5 research is run.** No V2.5 performance
number exists. Every rule and threshold below is fixed now and may not be
revised after results are seen.

| pinned | value |
|---|---|
| frozen V2 strategy | `4839074` (unchanged) |
| prior stage | V2.4 VALIDATION, `c52fda7` (`V2_4_NOT_VALIDATED`) |
| dataset | `c3c1dce` |
| development slice | **TRAIN only** |
| TEST (2022–2025) | **USED — excluded** |
| future window (2026-H1) | not downloaded |

---

## 0. TWO THINGS RECORDED BEFORE ANY CODE IS WRITTEN

### 0.1 A deviation from the task instruction, and why

The task says *"modify the outcome tracker to simulate bar-by-bar trailing
stop"* — i.e. `src/outcome/tracker.ts`. **That file is part of the frozen
surface.** Every stage since `4839074` has enforced the gate
`git diff 4839074 -- src/outcome/tracker.ts` must be **empty**, and
`trackOutcome` *is* the frozen exit model.

**Resolution, fixed now:** the trailing simulator is implemented in **research
code** (`scripts/real-data/v25-trailing.ts`). The frozen tracker is not touched.
This is not a workaround — it is required for the comparison to mean anything:
baseline **A** must keep calling the unmodified `trackOutcome`, otherwise
"V2.5 vs A" would compare two modified engines. The frozen-diff gate is reported
with the results.

### 0.2 The H1 prior — this mechanism has already been tested once

H1 (commit `1629c06`) tested exit management directly: full exit at TP1, 50 %
partial, and **breakeven-after-TP1**. Result: **`H1_NOT_VALIDATED`**. The
measured reason was structural, not parametric:

> **223,205 of 328,872 TRAIN trades (67.9 %) never reach TP1 at all**, averaging
> **−0.7611 R**, and their outcome is *identical under every exit model*.

V2.5's breakeven triggers at **+1R MFE**. The H1 path analysis measured the
never-TP1 group's mean MFE at **0.6112 R** — *below* the +1R trigger. Those
trades will therefore be untouched by the breakeven and trailing logic too, and
will resolve at the original SL or the new 10-bar timeout.

**Prior expectation, registered:** V2.5 changes outcomes only for the ~32 % of
trades that reach +1R, and H1 measured that truncating winners costs more than
protecting stalls saves (reached-final group: 3.7698 → 1.8363 under full TP1
exit). **Failure is the expected outcome.** This is a prior, not a result, and
it does not excuse the run — the mechanism differs from H1 (trailing lets
winners run rather than capping them), which is precisely why it is worth one
clean test.

---

## 1. Scope

| item | value |
|---|---|
| signal logic | **UNCHANGED** — same SMC setup as baseline A |
| entries | **UNCHANGED** — OPEN of N+1, frozen `resolveEntry` |
| initial SL | **UNCHANGED** — structural, from the frozen engine |
| timeframes | 15m, 30m, 1h, 4h |
| symbols | the 6 frozen symbols |
| slice | TRAIN |

Only the **exit** differs. Same entries, same stops, different exit rule — this
is a clean exit-only ablation.

## 2. The V2.5 exit mechanic (fixed)

Let `E` = entry, `S0` = initial structural stop, `R = |E − S0|`, direction-aware.
`MFE` is peak favourable excursion in R since entry.

| stage | rule |
|---|---|
| **initial** | stop at `S0` |
| **breakeven** | when `MFE >= 1.0R`, move stop to `E` |
| **trailing** | after breakeven, stop = `peakMFE − 1.0R`, in R terms |
| **trail step** | stop is only updated when `MFE` increases by **≥ 0.25R** since the last update |
| **targets** | **none** — no TP1/TP2/TP3. Exit is trailing stop, original SL, or timeout |
| **timeout** | if `MFE < 1.0R` within **10 bars**, close at the CLOSE of bar 10 |

Exit reasons recorded: `TRAIL`, `SL`, `TIMEOUT`, plus `BE` when the stop was at
exactly breakeven.

### Intrabar rules — fixed in advance, conservative

OHLC cannot order events within a bar, so:

- **R1.** If a bar's adverse extreme hits the current stop, the stop fires —
  checked **before** any favourable update from the same bar. A bar that both
  makes a new MFE high and breaches the trailing stop is booked as a **stop
  exit**, never as a trail-up-then-exit-higher. This is the unfavourable reading
  and mirrors the frozen `sl_priority_on_ambiguous_bar = true`.
- **R2.** The stop is raised using the MFE of *completed* bars only. Within the
  bar that sets a new MFE, the stop in force is the one computed from prior
  bars. A new high cannot retroactively protect itself.
- **R3.** The breakeven/trailing stop is never moved backwards.
- **R4.** On the entry bar itself the stop is `S0`; breakeven cannot arm on the
  entry bar.
- **R5.** Timeout is evaluated at bar index 10 counting the entry bar as 1,
  consistent with the frozen tracker's `i + 1 >= timeoutBars` convention.

## 3. Fee model

Per leg, no maker rebate:

| label | maker bps | taker bps | role |
|---|---|---|---|
| `GROSS` | 0 | 0 | edge before costs |
| **`FUT_4`** | 2 | 5 | **headline** (2 maker entry / 5 taker exit) |
| `SPOT` | 5 | 5 | stress |

> Naming note: the task calls the headline "FUT_4 (Maker 2 bps entry, Taker
> 5 bps exit)". That arithmetic (2+5) is what is used. The label is kept as the
> task specifies it; earlier reports called the identical 2/5 model `FUT_7`.
> Both names denote **2 bps maker entry + 5 bps taker exit** here.

Exits are charged **taker** because trailing-stop and timeout exits are market
events.

## 4. Arms

| arm | exits |
|---|---|
| **A** | frozen baseline — frozen `trackOutcome`, TP ladder + SL + 48-bar timeout |
| **V25** | trailing/breakeven engine, no targets, 10-bar +1R timeout |

Identical entries and identical initial stops in both arms, so any difference is
attributable to the exit rule alone.

## 5. Success criteria (fixed)

**Primary:** V2.5 **net expectancy per trade > baseline A** under the headline
2/5 model, on the same entry set.

**Reported alongside, diagnostics only:** net per actionable setup, stress (5/5),
winrate, average win vs average loss, max drawdown R, exit-reason mix, MFE at
exit, and outlier sensitivity (ex-top-1, ex-top-5, ex-top-1 %).

**Anything else is FAIL.** No criterion may be relaxed or substituted after the
numbers are seen. Permitted statuses: `V2_5_REJECTED_ON_TRAIN`,
`V2_5_PROMISING_PENDING_VALIDATION`. `PRODUCTION_READY` is forbidden, and a
TRAIN win would license only a VALIDATION run, nothing more.

## 6. Required tests

Frozen-diff gate (`src/` byte-identical to `4839074`); breakeven arms exactly at
+1R and not before; trailing distance is exactly 1R below peak MFE; the 0.25R
step gating actually suppresses smaller updates; stop never moves backwards;
same-bar stop-hit beats same-bar new-MFE (R1); new MFE cannot protect itself
within its own bar (R2); 10-bar timeout fires only when +1R was never reached;
LONG and SHORT symmetry; no look-ahead (no bar before entry is read).

## 7. Anti-bias checks

1. **Same-entry invariant** — A and V25 must operate on an identical entry set;
   any divergence in trade count is a bug and aborts the comparison.
2. **Untouched-trade share** — report the fraction of trades that never reach
   +1R, whose outcome the mechanism cannot change. H1 measured this at 67.9 %;
   if it is similar here, the ceiling on any improvement is correspondingly low.
3. **Outlier sensitivity** — with trailing exits the tail is the whole thesis, so
   ex-top-1 % is decisive.
4. **Sample honesty** — n on every row; no subgroup with n < 100 may decide.

**v2.enabled = false. LIVE_TRADING_ENABLED = false. Research only.**

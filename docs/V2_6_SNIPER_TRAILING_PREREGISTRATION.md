# V2.6 — SNIPER ENTRY + TRAILING EXIT — PRE-REGISTRATION

**Written and committed BEFORE any V2.6 research is run.** No V2.6 performance
number exists. Every rule below is fixed now and may not be revised after
results are seen.

| pinned | value |
|---|---|
| frozen V2 strategy | `4839074` (unchanged, including `src/outcome/tracker.ts`) |
| prior stages | V2.3 `2ee06d1`, V2.5 `07dabbb` |
| dataset | `c3c1dce` |
| development slice | **TRAIN only** |
| TEST (2022–2025) | **USED — excluded** |
| future window (2026-H1) | not downloaded |

---

## 0. ARITHMETIC PRIOR — registered before the run

V2.6 combines two components that have **already been measured separately on
TRAIN**, so the expected outcome can be stated in advance rather than
discovered:

| component | measured gross delta | sample |
|---|---|---|
| baseline A gross | −0.0015 | n = 30,888 |
| **+ trailing exit** (V2.5, same 15m–4h scope) | **+0.0472** | n = 30,867 |
| **+ sniper entry** (V2.3 S-base) | **+0.0600** | n = 836 |
| naive additive gross | **+0.1057** | — |
| − fee drag @ 2/5 bps | 0.1243 | measured |
| **naive additive NET** | **−0.0186** | — |

**Even assuming the two deltas add perfectly, the projected net is −0.0186 —
below the success threshold of 0.** Passing requires near-full additivity *and*
the sniper delta holding on a sample ~40× smaller than the one that produced it.

**They are unlikely to be additive.** Trailing helps most where MFE ≥ 1R is
reached; the sniper filter already selects setups with better excursion (V2.3
measured its picks at baseline gross +0.2663 vs −0.0036 for those declined). So
part of the trailing gain is plausibly *already captured* by the entry filter —
the deltas likely **overlap rather than stack**.

**Expected outcome: FAIL.** This is a prior, not a result. The run is still
worth making because the overlap hypothesis is itself measurable, and because
combining the two best-performing components is the obvious next question.

### Sample-size forecast

V2.3 `S-base` produced **836** closed trades under the same filter and scope.
V2.6 should land in the same order, **~800–900**. Most subgroup cells will fall
below 100. **No subgroup with n < 100 may support a conclusion.**

---

## 1. Entry — sniper filter (reversals only)

Unchanged from V2.3/V2.4, read from the frozen `SweepEvent` at **CLOSED N**:

| # | condition | requirement |
|---|---|---|
| 1 | swept a real extreme | pool kind ∈ {SWING, EQUAL, CLUSTER} |
| 2 | directional | `sweep.direction == setup.direction` |
| 3 | causal reclaim | `sweep.reclaimed === true` |
| 4 | prompt | `sweep.reclaimBars <= 3` |
| 5 | penetration | `sweep.penetrationAtr >= 0.10` (frozen) |
| 6 | rejection wick | `sweep.wickRatio >= 0.25` (frozen) |
| 7 | **body reclaim** | `sweep.bodyRatio >= 0.35` |
| 8 | **volume surge** | `sweep.rvol > 1.2` |

**CONTINUATION is disabled.** No LONG asymmetry — that rule failed VALIDATION in
V2.4 (`V2_4_NOT_VALIDATED`) and is **not** reintroduced.

**Entry execution: OPEN of N+1**, the frozen `resolveEntry`. No corridor —
adding it would confound the entry-filter and exit-rule effects this study is
meant to isolate.

## 2. Exit — V2.5 trailing (verbatim)

| stage | rule |
|---|---|
| initial | structural stop `S0` from the frozen engine |
| breakeven | `MFE >= 1.0R` → stop to entry |
| trailing | after breakeven, stop = `peakMFE − 1.0R` |
| trail step | update only when MFE advances ≥ **0.25R** |
| targets | **none** |
| timeout | `MFE < 1.0R` within **10 bars** → close at that bar's CLOSE |

Intrabar rules R1–R5 carried over unchanged from `aad5be5`: stop checked before
the same bar's favourable extreme; stop raised from completed bars only; never
moves backwards; breakeven cannot arm on the entry bar; timeout counts the entry
bar as 1.

**The frozen `trackOutcome` is NOT modified.** The trailing simulator remains in
research code (`scripts/real-data/v25-trailing.ts`, reused as-is), so baseline A
keeps calling the unmodified frozen tracker and the comparison stays honest.

## 3. Fee model

Per leg, no maker rebate. Exits charged **taker** (trailing/timeout exits are
market events).

| label | maker bps | taker bps | role |
|---|---|---|---|
| `GROSS` | 0 | 0 | edge before costs |
| **`FUT_4`** | 2 | 5 | **headline** |
| `SPOT` | 5 | 5 | stress |

`FUT_4` denotes **2 bps maker entry + 5 bps taker exit**, as the task specifies.

## 4. Scope and arms

15m, 30m, 1h, 4h · 6 symbols · TRAIN only.

| arm | entry | exit |
|---|---|---|
| **A** | all setups, OPEN N+1 | frozen `trackOutcome` (TP ladder + SL + 48-bar timeout) |
| **V25** | all setups, OPEN N+1 | trailing |
| **V26** | **sniper only**, OPEN N+1 | trailing |
| **V26-frozen-exit** | sniper only, OPEN N+1 | frozen `trackOutcome` |

`V26` vs `V25` isolates the entry filter; `V26` vs `V26-frozen-exit` isolates the
exit rule; together they test the additivity hypothesis in §0 directly.

All four arms are resolved from **one** chronological walk on an identical entry
universe, so differences are attributable to the gates alone.

## 5. Success criterion (fixed)

**V2.6 net expectancy per trade > 0 under the headline 2/5 model.**

Absolute profitability, not "better than baseline" — a stricter bar than V2.5's.

Reported alongside as diagnostics only: net per actionable setup, 5/5 stress,
win rate, avg win vs avg loss, payoff ratio, max drawdown, exit-reason mix,
share never reaching +1R, outlier sensitivity, and LONG/SHORT, timeframe and
symbol breakdowns.

**Anything else is FAIL.** No criterion may be relaxed or substituted after the
numbers are seen. Permitted statuses: `V2_6_REJECTED_ON_TRAIN`,
`V2_6_PROMISING_PENDING_VALIDATION`. `PRODUCTION_READY` is forbidden; a TRAIN
pass licenses only a VALIDATION run.

## 6. Mandatory anti-bias checks

1. **Additivity test** — compare the measured V2.6 gross against the §0 naive
   additive projection (+0.1057). Report the shortfall explicitly; a large
   shortfall confirms the overlap hypothesis.
2. **Same-universe invariant** — all arms must derive from one entry universe;
   any unexplained divergence aborts the comparison.
3. **Outlier sensitivity** — ex-top-1, ex-top-5, ex-top-1 %. At n≈850 a handful
   of trades can carry the result, so this is decisive.
4. **Untouched-trade share** — fraction never reaching +1R, which the exit
   mechanism cannot affect (V2.5 measured 63.61 %).
5. **Sample honesty** — n on every row; no n<100 subgroup may decide.

## 7. Required tests

Frozen-diff gate (`src/` byte-identical to `4839074`); sniper filter accept/
reject on all 8 conditions with boundaries; continuation proven disabled;
trailing mechanics already covered by the 20 tests at `07dabbb` and reused
unchanged; no look-ahead (no bar before entry read); LONG/SHORT symmetry.

**v2.enabled = false. LIVE_TRADING_ENABLED = false. Research only.**

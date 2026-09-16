# V2.4 CANDIDATE FREEZE — S-asym

**Committed BEFORE the VALIDATION replay is run.** No VALIDATION number exists
at the time of this commit. Nothing below may change afterwards.

| pinned | value |
|---|---|
| frozen V2 strategy | `4839074` (unchanged) |
| V2.4 pre-registration | `072490e` |
| V2.4 TRAIN results | `8e07352` |
| dataset | `c3c1dce` |
| candidate | **V2.4 `S-asym`** |
| VALIDATION | to be run **once**, immediately after this commit |
| TEST (2022–2025) | **USED — must not be run or inspected** |
| future window (2026-H1) | not downloaded |

---

## a) The fixed candidate

**V2.4 `S-asym`** = reversal sniper + corridor entry + structural targets +
LONG HTF asymmetry.

Gate vector, verbatim from `scripts/real-data/v24-replay.ts`:

```ts
'S-asym': { sniper: true, structTargets: true, corridor: true, asymmetry: true }
```

Pipeline at each CLOSED bar N:

1. Frozen `evaluateV2` produces the signal, structural stop and target plans.
2. **Base sniper filter** (reversals only; continuation OFF) — 8 conditions.
3. **LONG asymmetry** — a LONG needs ≥1 of three HTF-bullish legs; SHORT passes
   unconditionally.
4. **Structural targets only** — nearest opposing liquidity → equilibrium →
   else SKIP. No R-multiple rung is ever emitted.
5. **Corridor entry** at `close(N) ± 0.10·ATR`, filled from N+1 at the worse
   edge.
6. Frozen `trackOutcome` resolves the outcome; exit model is final-rung-only.

## b) Frozen parameters — exact values, no post-hoc adjustment

| constant | value | source file |
|---|---|---|
| `RECLAIM_MAX_BARS` | 3 | `v24-engine.ts` |
| `MIN_PENETRATION_ATR` | 0.10 | `v24-engine.ts` |
| `MIN_WICK_RATIO` | 0.25 | `v24-engine.ts` |
| `MIN_BODY_RATIO` | **0.35** | `v24-engine.ts` |
| `MIN_RVOL` | **1.2** (strict `>`) | `v24-engine.ts` |
| `HTF_EMA_MIN_BARS` | 200 | `v24-engine.ts` |
| `CORRIDOR_ATR_FRAC` | 0.10 | `corridor-entry.ts` |
| `CORRIDOR_MAX_PCT` | 0.0015 (0.15 %) | `corridor-entry.ts` |
| `EXPIRY_BARS` | 3 | `corridor-entry.ts` |
| `risk.min_rr` | 1 (frozen registry) | unchanged |
| `outcome.timeout_bars` | 48 (frozen registry) | unchanged |
| exit model | final rung only | unchanged |

LONG asymmetry legs (OR):
`close(N) > HTF EMA200` on the causally-bounded primary HTF **OR** any available
`HtfContext.bias === 'BULLISH'` **OR** `rsi.bullishDivergence === true`.

Fee environments (per leg, no maker rebate):

| label | maker bps | taker bps | role |
|---|---|---|---|
| `GROSS` | 0 | 0 | edge before costs |
| `FUT_7` | 2 | 5 | **headline (2/5)** |
| `SPOT` | 5 | 5 | **stress (5/5)** |
| `FUT_4` | 2 | 2 | best case |

### Implementation hashes (SHA-256, first 16 hex)

| file | hash |
|---|---|
| `scripts/real-data/v24-engine.ts` | `6f930e48998bdfbd…` |
| `scripts/real-data/v24-replay.ts` | `b65258352e75718d…` |
| `scripts/real-data/corridor-entry.ts` | `c2eebef8af2dea3c…` |
| `scripts/real-data/v22-engine.ts` | `e6eba37044a079fa…` |

### The negative leg is frozen AS-IS

TRAIN measured the `HTF_STRUCTURE` leg at **−0.1919 gross on n=110** — it admits
losing LONGs, and the gate passes overall only because `HTF_EMA200` (+0.2422,
n=157) outweighs it.

**This leg is NOT removed, NOT reweighted, NOT patched.** Deleting it now would
be fitting to TRAIN, which is precisely what the pre-registration forbids. It
goes into VALIDATION exactly as tested.

## c) The four recorded caveats

1. **Circularity.** The LONG asymmetry was designed *because* V2.3 LONGs
   underperformed on the same TRAIN data (S-cor LONG +0.0325 vs SHORT +0.1392).
   Part of the +0.0604 asymmetry gain is fitting, and TRAIN cannot say how much.
   Project base rate: **2 of 3** prior TRAIN-derived leads failed to reproduce.
2. **Small sample.** TRAIN produced **n = 689** closed trades. VALIDATION is a
   shorter window (~20 % of history vs 60 %), so expect roughly **n ≈ 150–250**.
   Most subgroup cells will fall below 100.
3. **Thin stress margin.** TRAIN stress (5/5) was **+0.0025** per filled trade —
   essentially breakeven. A small adverse shift erases it.
4. **Post-only optimism.** A real post-only order is rejected if it would cross;
   OHLC cannot detect that, so fills are modelled whenever price trades into the
   corridor. The bias is **optimistic** and its direction is stated in advance.

## d) Pre-registered VALIDATION success criteria

**PASS requires BOTH, under the headline FUT (2 bps maker entry / 5 bps taker
exit):**

1. Net expectancy **per FILLED trade > 0**
2. Net expectancy **per ORIGINAL ACTIONABLE SETUP > 0**

Reported alongside, but **not** part of the pass/fail test (diagnostics only):
stress (5/5) net, outlier robustness after removing the top 1 %, and the
LONG/SHORT, timeframe and symbol breakdowns.

**Anything else is FAIL.** No criterion may be relaxed, re-weighted or
substituted after the numbers are seen. There is exactly **one** VALIDATION run;
no re-runs, no variants, no parameter changes.

Outcome mapping:
- both criteria met → `V2_4_VALIDATED_FOR_RESEARCH`
- otherwise → `V2_4_NOT_VALIDATED`

`PRODUCTION_READY` remains forbidden, and validation here would mean only that
the design survived one unseen split — **not** that it is deployable.

## Protocol constraints for the run

- VALIDATION window only, per-series boundaries from the frozen `splits.json`
  (`validFromMs` … `validToMs`).
- All 6 symbols × 15m, 30m, 1h, 4h.
- **TEST must not be read.** The driver will be restricted to the validation
  window by construction.
- `v2.enabled = false`, `LIVE_TRADING_ENABLED = false`, frozen strategy
  untouched.

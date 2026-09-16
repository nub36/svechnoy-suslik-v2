# V2.8 ZERO-FEE SNIPER + TRAILING — VALIDATION RESULTS

## Status: `V2_8_VALIDATED_FOR_RESEARCH` — PASS, with serious reservations

Both pre-registered criteria are met. **The margin is thin enough that a single
trade decides it**, and that is stated plainly below rather than buried.

One validation run, as frozen. TEST untouched. `git diff 852167c` is empty for
the candidate files — nothing was adjusted after seeing results.

| pinned | value |
|---|---|
| frozen V2 strategy | `4839074` — `src/` byte-identical |
| candidate freeze | `852167c` (committed **before** the run) |
| TRAIN results | `54243a7` |
| dataset | `c3c1dce` |
| slice | VALIDATION only · 15m/30m/1h/4h · 6 symbols · fees = 0 |
| TEST | **not run, not inspected** |

---

## 1. PASS / FAIL

| criterion | required | actual | result |
|---|---|---|---|
| gross R/trade | > 0 | **+0.0488** | ✅ |
| profit factor | > 1.0 | **1.1087** | ✅ |

# ==> PASS

**Same-entry invariant: OK** — SMC and Trail resolved an identical 98-entry set.

## 2. Headline table

| metric | n | Win Rate % | Gross R/trade | Profit Factor | Max Drawdown R |
|---|---|---|---|---|---|
| **Trail (candidate)** | 98 | 44.90 | **+0.0488** | **1.1087** | **−8.11** |
| SMC (anchor only) | 98 | 15.31 | −0.1821 | 0.7590 | −25.26 |

The SMC anchor is included for context and was **not** the candidate. It is worth
noting it collapsed hard out of sample (TRAIN +0.1490 → VALIDATION −0.1821),
exactly as its 19.6 % outlier-retention on TRAIN warned. Choosing Trail over
SMC — on robustness rather than raw gross — was the right call and is the one
clear methodological win here.

## 3. TRAIN → VALIDATION

| metric | TRAIN | VALIDATION | change |
|---|---|---|---|
| n | 317 | 98 | as forecast (100–160) |
| win rate | 50.79 % | 44.90 % | −5.9 pts |
| **gross R/trade** | **+0.1462** | **+0.0488** | **−67 %** |
| profit factor | 1.3508 | 1.1087 | −0.24 |
| max drawdown R | −16.16 | −8.11 | better |
| **median R** | **+0.0364** | **−0.1270** | **sign flip** |
| avg win | +1.1088 | +1.1100 | stable |
| avg loss | −0.8471 | −0.8158 | stable |

The **direction** of the edge survived; its **size** did not. Gross retained
roughly one third of its TRAIN value, and the median trade turned negative —
meaning the typical trade now loses and the average is carried by the upper tail.

Encouragingly, the two mechanical properties of the trailing exit held almost
exactly: average win (+1.109 → +1.110) and average loss (−0.847 → −0.816). The
exit behaves as designed; there is simply less edge for it to work on.

## 4. The reservation that matters most

**Outlier sensitivity:**

| | gross | after removing top 1 % |
|---|---|---|
| TRAIN | +0.1462 | +0.0536 |
| **VALIDATION** | **+0.0488** | **−0.0143** |

At n=98 the top 1 % is **one trade**. Removing it flips the result negative.

So the honest reading is: the candidate passes its pre-registered test, but the
pass **does not survive the removal of a single trade**. Under the project's own
standing rule — that outlier robustness is decisive at small n — this is a PASS
on the letter of the criteria and a very weak result in substance.

I did not add an outlier criterion after the fact; it was registered as a
diagnostic, not a gate. Reporting it prominently is the correct handling.

## 5. Subgroups — nothing is decisive

**Every single cell is below n=100**, so per the standing rule none may support
a conclusion. They are reported for completeness, and the instability is itself
informative:

| dimension | VALIDATION | TRAIN (same cell) |
|---|---|---|
| LONG | +0.2673 (n=47) | +0.1097 (n=188) |
| SHORT | **−0.1525** (n=51) | **+0.1995** (n=129) |
| 15m | +0.5030 (n=46) | +0.1338 (n=179) |
| 30m | −0.4795 (n=34) | +0.2558 (n=97) |

**The SHORT leg inverted** (+0.1995 → −0.1525), and SHORT was the stronger side
in every prior study (V2.3, V2.4, V2.6, V2.8-TRAIN). LONG carried this
validation instead. On n≈50 per leg that is as likely to be noise as a real
regime change, but it means the one consistent directional finding of the whole
project did not reproduce.

Symbols range from −0.4005 (BTC, n=14) to +0.5572 (BNB, n=12) — pure noise at
those counts.

Exits: TRAIL 38 / SL 38 / TIMEOUT 22.

## 6. What this does and does not establish

**Does:** the sniper + trailing combination produced a positive gross edge on an
unseen split at zero fees, with a sane trade shape and a drawdown half that of
TRAIN. It is the first candidate in this project to clear a pre-registered
validation test.

**Does not:**

1. **It is not profitable at real fees.** TRAIN measured 0.1555 R/trade of drag
   at 2/5 bps against a VALIDATION gross of 0.0488 — a deficit of ~0.107 R.
   This candidate requires a genuinely zero-fee or full-rebate venue; at Binance
   futures rates it loses roughly 0.11 R per trade.
2. **It is not robust.** One trade removal flips it negative.
3. **It is not a validated edge profile.** Median R is negative, the SHORT leg
   inverted, and no subgroup is above n=100.
4. **It has not seen TEST.** TEST and the 2026-H1 window remain unspent.

## 7. Protocol compliance

- Candidate frozen and pushed at `852167c` **before** the validation driver was
  written; `git diff 852167c` empty for candidate files.
- **Exactly one** validation run. No re-runs, variants or parameter changes.
- No criterion relaxed, re-weighted or substituted after seeing results.
- Hard **TEST-safety guard** in the driver aborts if any series' `validToMs` is
  not strictly below its `testFromMs`; all 24 series verified in advance, guard
  never fired, **TEST never read**.
- Gates: typecheck ✅ · **1090 tests** ✅ · build ✅ ·
  `git diff 4839074 -- src/` empty · `v2.enabled=false` ·
  `LIVE_TRADING_ENABLED=false`.

## 8. Verdict

# `V2_8_VALIDATED_FOR_RESEARCH`

Passed both frozen criteria on unseen data. This is a real, if modest, result —
and the first positive validation the project has produced.

**Recommended reading: treat it as a weak positive, not a green light.** The edge
is +0.0488 R/trade gross, one trade from zero, and only exists at 0 % fees. The
responsible next step is more data (the untouched 2026-H1 window) to establish
whether the edge is real at a usable sample size — **not** a move toward
deployment.

**TEST untouched. `v2.enabled=false`, `LIVE_TRADING_ENABLED=false`.
`PRODUCTION_READY` forbidden.**

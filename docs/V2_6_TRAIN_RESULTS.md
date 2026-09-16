# V2.6 SNIPER ENTRY + TRAILING EXIT — TRAIN RESULTS

## Status: `V2_6_REJECTED_ON_TRAIN`

**FAIL** — net **−0.0092 R/trade** under the headline 2/5 model, against a
required **> 0**. Narrow, but a fail.

TRAIN only. VALIDATION and TEST untouched. No rule changed after seeing results.
`src/` byte-identical to `4839074`, including `src/outcome/tracker.ts`.

| pinned | value |
|---|---|
| frozen V2 strategy | `4839074` |
| pre-registration | `3e164ef` |
| dataset | `c3c1dce` |
| scope | 15m/30m/1h/4h · 6 symbols · 24 series · TRAIN |

---

## 1. The criterion

**Rule:** V2.6 net expectancy per trade **> 0**, headline 2 bps maker / 5 bps taker.

| measure | value |
|---|---|
| gross expectancy | **+0.1462** |
| mean fee drag @2/5 | 0.1555 |
| **net expectancy** | **−0.0092** |

# ==> FAIL

V2.6 produces the **highest gross expectancy of any arm ever tested** in this
project — and still loses money, because its fee drag (0.1555 R) is higher than
its gross edge. The sniper filter selects tighter-stop setups, and fee-in-R
scales inversely with stop distance, so the filter partly pays for itself.

**Same-universe invariant: OK.** All four arms derive from one chronological
walk; A/V25 differ by exactly the 21 boundary-unresolved trailing trades, and
V26/V26-frozen-exit share an identical 317-entry set.

## 2. The 2×2 ablation — the real finding

| arm | entry | exit | n | gross | net 2/5 | PF | win % | max DD |
|---|---|---|---|---|---|---|---|---|
| A | all | frozen | 30,888 | −0.0015 | −0.1257 | 0.998 | 28.11 | −505.8 |
| V25 | all | trailing | 30,867 | +0.0457 | −0.0786 | 1.115 | 47.88 | −79.3 |
| **V26-frozen-exit** | **sniper** | frozen | 317 | **+0.1490** | **−0.0064** | 1.211 | 28.39 | −22.0 |
| **V26** | **sniper** | trailing | 317 | +0.1462 | −0.0092 | **1.351** | 50.79 | **−16.2** |

**Decomposition of the gross delta vs baseline A:**

| component | delta |
|---|---|
| entry filter alone (A → V26-frozen-exit) | **+0.1505** |
| exit rule alone (A → V25) | +0.0472 |
| both together (A → V26) | +0.1477 |
| **exit rule on top of the sniper (V26-frozen-exit → V26)** | **−0.0028** |

**The trailing exit contributes nothing once the sniper filter is applied.** In
isolation it was worth +0.0472; stacked on the entry filter it is −0.0028.

## 3. The overlap hypothesis is CONFIRMED

The pre-registration (§0) predicted the two deltas would overlap rather than
stack, reasoning that trailing helps most where MFE ≥ 1R is reached and the
sniper filter already selects setups with better excursion.

That is exactly what happened. Supporting evidence: the share of trades never
reaching +1R falls from **63.61 %** (V2.5, all entries) to **58.36 %** (V2.6,
sniper entries) — the filter pre-selects better-excursion trades, so the exit
rule has less left to harvest.

The naive additive projection was +0.1057; measured gross is **+0.1462**, i.e.
**+0.0405 above** projection. That sounds like super-additivity but is not: the
sniper delta was measured on V2.3's 836-trade sample and came in stronger here
(+0.1505 vs +0.0600), while the *trailing* delta collapsed to zero. The
components did not stack — one simply outperformed its own prior.

## 4. Why it fails despite the best gross

| arm | gross | fee drag | net |
|---|---|---|---|
| V26 | +0.1462 | 0.1555 | −0.0092 |
| V26-frozen-exit | +0.1490 | 0.1555 | −0.0064 |

Fee drag is **0.1555 R/trade** versus **0.1243 R** for the all-entry arms. The
sniper filter selects setups with tighter stops, and since
`feeR = fee% × price / stopDistance`, tighter stops cost proportionally more.
The filter's gross gain is real but it drags its own cost up with it.

**Both sniper arms miss by under 0.01 R** — the closest this project has come —
but both miss.

## 5. Robustness — the result does not survive scrutiny

**Outlier sensitivity at n=317 (decisive):**

| arm | gross | ex-top-1 | ex-top-5 | ex-top-1 % |
|---|---|---|---|---|
| V26 | +0.1462 | +0.1172 | **+0.0394** | +0.0536 |
| V26-frozen-exit | +0.1490 | +0.1049 | **+0.0060** | +0.0292 |

Removing **five trades out of 317** cuts V2.6's gross by 73 % (+0.1462 →
+0.0394) and all but erases V26-frozen-exit's (+0.1490 → +0.0060). Even the
gross edge — the one genuinely strong number here — rests on a handful of trades.

**Stress (5/5):** V26 −0.0759, V26-frozen-exit −0.0731. Both clearly negative.

**Subgroups — nearly everything is below the n<100 threshold:**

- **Direction:** LONG +0.1097 (n=188), SHORT +0.1995 (n=129). Both usable.
- **Timeframe:** 15m +0.1338 (179) is the only cell with n ≥ 100. 30m +0.2558
  (97), 1h −0.0617 (33), 4h −0.0456 (8) are **not decisive**.
- **Symbol:** every cell n < 100 (42–64). Spread runs −0.0998 (SOL) to +0.4311
  (BTC). **No symbol conclusion is supportable.**

Per the standing rule, no n<100 cell may support a conclusion, which here rules
out every timeframe except 15m and every symbol.

## 6. Trade profile

Win rate **50.79 %**, avg win **+1.1088 R**, avg loss **−0.8471 R**, payoff
**1.3089**, median hold **6 bars**, max drawdown **−16.16 R** (vs −505.8 for
baseline A). Exits: TRAIL 130 / SL 119 / TIMEOUT 68.

This is the most attractive *shape* any arm has produced — balanced win rate,
positive payoff ratio, 31× smaller drawdown than baseline. It is still not
profitable after costs.

## 7. Protocol compliance

- `src/outcome/tracker.ts` **byte-identical** to `4839074`; the trailing
  simulator remains in research code, so baseline A calls the unmodified frozen
  tracker.
- Criterion fixed before the run, not relaxed. The result missed by 0.0092 and
  is reported as a **fail**, not rounded into a pass.
- No LONG asymmetry reintroduced (failed VALIDATION in V2.4). No corridor added,
  to avoid confounding entry and exit effects.
- Gates: typecheck ✅ · **1074 tests** ✅ · build ✅ · `git diff 4839074 -- src/`
  empty · `v2.enabled=false` · `LIVE_TRADING_ENABLED=false`.

## 8. Verdict

# `V2_6_REJECTED_ON_TRAIN`

Three findings worth carrying forward:

1. **The sniper entry filter is the single most valuable component found**
   (+0.1505 gross vs baseline, the largest effect measured in this project).
2. **The trailing exit is redundant once that filter is applied** (−0.0028). The
   two mechanisms harvest the same excursion; they do not compose. The overlap
   hypothesis registered in advance was correct.
3. **The filter raises its own fee drag** (0.1243 → 0.1555 R) by selecting
   tighter stops, which is why the best gross edge in the project still nets
   negative.

The project-level conclusion is unchanged and now sharper: V2's gross edge can
be lifted to ~+0.15 R/trade by aggressive entry selection, but fees on that same
trade population run ~0.16 R. **The gap is structural, and combining the two
best components does not close it** — it merely arrives at the same wall from a
better starting point, on a 317-trade sample whose edge collapses when five
trades are removed.

**TEST untouched. `v2.enabled=false`, `LIVE_TRADING_ENABLED=false`.
`PRODUCTION_READY` forbidden.**

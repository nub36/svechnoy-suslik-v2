# Strategy evidence pass

Purpose of this document: record what was actually measured about the strategy,
what it showed, and — just as importantly — what could **not** be established
and why. It is deliberately written so that a reader can tell the difference
between a proven claim and an unproven one.

---

## 0. The headline limitation — read this first

**No number in this document was produced from real market history.**

All crypto-market egress is blocked from the environment this analysis ran in.
Verified unreachable (curl exit code 000): `api.binance.com`,
`data-api.binance.vision`, `data.binance.vision`, `api.bybit.com`,
`api.kraken.com`, `api.coingecko.com`, `api.coinbase.com`,
`min-api.cryptocompare.com` — while `registry.npmjs.org`, `github.com` and
`pypi.org` all return 200. The block is domain-specific, not general network
failure.

The `fixtures/` corpus (80 files, 45 200 candles) is **synthetic**, produced by
`scripts/make-fixtures.mjs` from a seeded mulberry32 PRNG. Its statistical
properties are *plausible* — BTCUSDT 1h has sd 0.00314, kurtosis 9.61,
ACF|r| 0.338; DOGEUSDT 15m has sd 0.00425, kurtosis 7.80, ACF|r| 0.485, all in
the range real crypto occupies — but **plausible is not real**.

Therefore:

- Every metric below measures **the interaction between the strategy and a
  random-number generator**. It does not measure an edge in the market.
- Nothing here justifies calling the strategy profitable, and nothing here was
  used to change production trading parameters.
- What the numbers *are* good for: proving the harness works, exposing
  structural properties of the scoring model that hold regardless of data
  source, and giving the operator a ready-to-run procedure.

To obtain a real baseline, run the harness where Binance is reachable:

```bash
npm run fixtures:real     # fetch real Binance Spot klines
npm run lab               # full baseline metric set
npm run lab:optimize      # TRAIN / VALIDATION / TEST candidate comparison
```

Until that has been done on real candles, **the strategy's quality is unknown.**

---

## 1. Source of truth for runtime parameters

`src/core/settings.ts` → `SETTINGS_REGISTRY` (54 definitions) is the sole home
of every tunable. Nothing in the strategy hard-codes a weight or a threshold.

Shipped defaults:

| group | values |
|---|---|
| weights | BOS 25 · ORDER_BLOCK 20 · FVG 15 · LIQUIDITY_SWEEP 15 · RANGE_POSITION 10 · INTERNAL_STRUCTURE 8 · OB_FVG_CONFLUENCE 7 |
| gating | `engine.score_threshold` 55 · `engine.min_components` 2 |
| risk | `risk.tp1_r` 1 · `risk.tp2_r` 2 · `risk.tp3_r` 3 · `risk.sl_atr_mult` · `risk.atr_period` · `risk.sl_policy` · `risk.signal_expiry_bars` · `risk.min_rr` · `risk.max_concurrent` |
| outcome | `outcome.timeout_bars` 48 · `outcome.sl_priority_on_ambiguous_bar` **true** · `outcome.fee_pct` 0.1 |

### The 18/12 vs 20/15 discrepancy — resolved, not a bug

`loadSettings()` layers rows from the `settings` table over registry defaults.
An operator had saved `ORDER_BLOCK=18` and `FVG=12`; the registry still ships
20/15. The observed production score reproduces exactly from the DB values:

```
0.92026055x18 + 0.62746934x25 + 1x8 + 0.56591727x12 + 0.47606082x7 = 50.374856
```

README documented the defaults; runtime read the DB. Both were right at their
own layer. **The weights were not changed to match the README** — the README
was corrected to explain the layering.

### Single trading path — nothing to de-duplicate

Replay (`src/replay/runner.ts`) and live (`src/strategy/engine-runner.ts`) call
the *same* `evaluate()`, `step()`, `resolveEntry()`, `buildRiskPlan()`,
`trackOutcome()`. `evaluate()` has exactly three callers: replay, engine-runner,
and `src/web/overlays.ts` (display only). `trackOutcome()` has two: replay and
`src/workers/outcome.worker.ts`. There is no second strategy implementation to
remove. Pinned by `tests/strategy-audit.test.ts`.

### Look-ahead guards

- `evaluate()` takes `atIndex`, defaulting to `closed.length - 1`; replay pins
  it to the bar being replayed, so later candles are unreachable.
- Both paths filter to closed candles (`closedOnly: true` / `c.isClosed`).
- Replay sorts by `openTime` ascending before walking.
- `resolveEntry()` returns the **open of N+1**; `WAITING_ENTRY` carries
  `entry_price = NULL` until that candle exists.

### Ambiguous TP/SL bars

`outcome.sl_priority_on_ambiguous_bar` defaults to **true**, and both
`trackOutcome()` and `trackMilestones()` honour it: when a single bar's range
touches both the stop and a take-profit, the **stop** wins. The conservative
policy already existed; this pass added the missing test coverage rather than
changing behaviour. The favourable outcome is never silently chosen.

---

## 2. Measurement harness

`scripts/strategy-lab.ts` — walk-forward metrics. It calls `replaySeries()` and
aggregates; it defines **no** trading rule of its own (enforced by
`tests/strategy-lab.test.ts`, which fails if the lab grows an entry, stop, TP or
scoring function).

`scripts/strategy-optimize.ts` — candidate comparison over a chronological
TRAIN 60% / VALIDATION 20% / TEST 20% split.

### Why the split is per-series

A single global time boundary is wrong for this corpus: every timeframe has 600
candles but a wildly different span (600x `1w` ≈ 11 years, 600x `1m` ≈ 10
hours). A global cut put nearly all intraday trades in one slice — the first
version produced TRAIN n=81 vs TEST n=1570. Each `(symbol, timeframe)` series is
now cut at its own 60%/80% marks, so the split stays strictly chronological
*within* every series while all three slices get a comparable mix. This is a
real methodological bug that was found and fixed during the pass.

---

## 3. Baseline (SYNTHETIC DATA — not a market baseline)

6 symbols, all 8 timeframes, 1737 finished trades.

| metric | value |
|---|---|
| signals (finished) | 1737 |
| LONG / SHORT | 885 / 852 |
| win rate | 25.56% |
| stop rate | 69.78% |
| expired rate | 4.66% |
| average R | +0.0187 |
| **median R** | **-1.0824** |
| total R | +32.51 |
| profit factor | 1.024 |
| max drawdown | -56.65 R |
| expectancy | +0.0187 R |
| avg holding | 11.99 bars |
| TP1 / TP2 / TP3 reached | 27.81% / 26.19% / 0% |

Read this honestly: profit factor 1.02 on 1737 trades is **noise, not an edge**,
and the median trade is a full stop-out. The distribution is carried by a small
number of large winners.

**TP3 was reached 0 times.** Worth the operator's attention — either the 3R rung
is effectively unreachable under the current stop distance, or the timeout at 48
bars closes trades first.

### LONG vs SHORT

| | n | win | avg R | total R | PF | maxDD |
|---|---|---|---|---|---|---|
| LONG | 885 | 23.16% | -0.0716 | -63.35 | 0.910 | -83.18 |
| SHORT | 852 | 28.05% | +0.1125 | +95.85 | 1.151 | -48.95 |

The two sides disagree in sign. On synthetic data this is most likely generator
drift, which is exactly why it must not be acted on.

### By symbol

| symbol | n | win | avg R | total R | PF |
|---|---|---|---|---|---|
| BTCUSDT | 296 | 26.69% | +0.0650 | +19.25 | 1.086 |
| ETHUSDT | 272 | 25.00% | +0.0210 | +5.70 | 1.028 |
| BNBUSDT | 270 | 25.56% | +0.0306 | +8.28 | 1.040 |
| SOLUSDT | 306 | 20.59% | -0.2277 | -69.66 | 0.731 |
| XRPUSDT | 299 | 28.09% | +0.1193 | +35.67 | 1.160 |
| DOGEUSDT | 294 | 27.55% | +0.1132 | +33.27 | 1.153 |

### By timeframe

| tf | n | win | avg R | total R | PF |
|---|---|---|---|---|---|
| 1m | 247 | 28.74% | +0.1647 | +40.69 | 1.230 |
| 5m | 225 | 28.89% | +0.1669 | +37.55 | 1.228 |
| 15m | 215 | 22.33% | -0.1000 | -21.51 | 0.874 |
| 30m | 232 | 25.00% | -0.0562 | -13.04 | 0.930 |
| 1h | 233 | 22.32% | -0.0808 | -18.82 | 0.898 |
| 4h | 228 | 27.63% | +0.0970 | +22.11 | 1.130 |
| 1d | 232 | 22.41% | -0.0997 | -23.13 | 0.876 |
| 1w | 125 | 28.00% | +0.0692 | +8.65 | 1.091 |

No coherent pattern across the timeframe axis — consistent with noise.

---

## 4. Factor quality

### Score monotonicity — **ABSENT, AND INVERTED**

This is the most important structural finding of the pass, and it does not
depend on the data being synthetic.

| score bucket | n | win | avg R | total R | PF |
|---|---|---|---|---|---|
| 55-60 | 86 | 53.49% | **+1.1345** | +97.56 | 3.429 |
| 60-70 | 306 | 45.10% | +0.7730 | +236.54 | 2.354 |
| 70-80 | 399 | 28.32% | +0.1077 | +42.98 | 1.143 |
| 80-90 | 502 | 16.93% | -0.2955 | -148.33 | 0.650 |
| 90-100 | 280 | 13.93% | -0.4343 | -121.60 | 0.512 |
| **100** | 164 | **14.02%** | **-0.4552** | -74.66 | 0.491 |

Score is **inversely** related to outcome, monotonically, across the whole
range. score=100 is the *worst* bucket; score 55-60 is the best.

**Root cause — it is arithmetic, not market behaviour.** `score = 100 x
Σcontribution / Σweight` sums the denominator over *counted factors only*. A
setup where one factor fires at full strength therefore scores 100. Score
measures **average conviction per factor**, not **amount of evidence**.
Measured: `corr(score, confirmations) = -0.36`.

Holding confirmations fixed at 2, the inversion persists:

| score (at exactly 2 confirmations) | n | avg R |
|---|---|---|
| 55-60 | 22 | +1.744 |
| 60-70 | 98 | +0.445 |
| 70-80 | 206 | -0.284 |
| 80-90 | 351 | -0.595 |
| 90-100 | 232 | -0.743 |
| 100 | 162 | -0.490 |

So the effect is not purely a confirmation-count proxy.

**Consequence for operators: raising `engine.score_threshold` does not make the
strategy more selective in the way the name implies.** It selects for *fewer,
more one-sided* setups.

### Confirmation count — the real quality axis

| confirmations | n | win | avg R | total R | PF |
|---|---|---|---|---|---|
| 2 | 1050 | 15.05% | **-0.4102** | -430.69 | 0.538 |
| 3 | 394 | 39.85% | +0.5647 | +222.47 | 1.905 |
| 4 | 203 | 45.32% | +0.8760 | +177.83 | 2.668 |
| 5 | 77 | 42.86% | +0.7489 | +57.67 | 2.383 |
| 6 | 12 | 33.33% | +0.5239 | +6.29 | 1.844 |
| 7 | 1 | 0% | -1.067 | -1.07 | 0 |

Extra confirmations **do** raise expectancy, sharply, and the entire negative
contribution of the baseline sits in the 2-confirmation bucket
(`engine.min_components = 2`, the current default). The benefit saturates
around 4.

### Marginal factor contribution

| factor | present | avg R with | avg R without | marginal |
|---|---|---|---|---|
| ORDER_BLOCK | 767 | +0.8604 | -0.6468 | **+1.5072** |
| FVG | 482 | +1.0802 | -0.3890 | +1.4692 |
| INTERNAL_STRUCTURE | 485 | +0.8365 | -0.2981 | +1.1346 |
| BOS | 310 | +0.9489 | -0.1834 | +1.1323 |
| OB_FVG_CONFLUENCE | 159 | +0.8159 | -0.0616 | +0.8775 |
| LIQUIDITY_SWEEP | 1230 | -0.4043 | +1.0448 | **-1.4491** |
| RANGE_POSITION | 1125 | -0.6017 | +1.1593 | **-1.7610** |

Caveat against over-reading: `LIQUIDITY_SWEEP` and `RANGE_POSITION` are the two
highest-frequency factors (1230 and 1125 of 1737). They dominate the
2-confirmation bucket, so their negative marginals partly restate "thin setups
lose" rather than "these factors are bad". Disentangling frequency from quality
requires real data.

---

## 5. Optimization — TRAIN / VALIDATION / TEST

Candidate set is small and hypothesis-driven (no grid search):

| candidate | hypothesis |
|---|---|
| `baseline` | shipped config; the bar to clear |
| `min_components=3` | 2-confirmation signals carry all the loss; raise the evidence floor |
| `min_components=4` | is more better, or does the sample collapse? |
| `threshold=65` | the naive "raise the score bar" move — included as a **falsification test**, predicted to fail |
| `min_components=3 + threshold=55` | evidence-driven filter at the original score bar |

### TRAIN (selection allowed)

| candidate | n | win | expectancy | total R | PF | maxDD |
|---|---|---|---|---|---|---|
| baseline | 998 | 25.05% | +0.0098 | +9.75 | 1.013 | -48.12 |
| min_components=3 | 599 | 37.23% | +0.5267 | +315.51 | 1.844 | -11.17 |
| min_components=4 | 388 | 35.31% | +0.4897 | +189.99 | 1.793 | -12.38 |
| threshold=65 | 966 | 22.46% | -0.0938 | -90.63 | 0.882 | -126.68 |
| mc=3 + thr=55 | 599 | 37.23% | +0.5267 | +315.51 | 1.844 | -11.17 |

### VALIDATION (selection allowed)

| candidate | n | win | expectancy | total R | PF | maxDD |
|---|---|---|---|---|---|---|
| baseline | 323 | 28.79% | +0.1186 | +38.30 | 1.159 | -22.52 |
| min_components=3 | 211 | 39.81% | +0.5805 | +122.49 | 1.945 | -17.99 |
| min_components=4 | 120 | 40.00% | +0.6131 | +73.58 | 2.001 | -8.84 |
| threshold=65 | 317 | 23.34% | -0.1065 | -33.75 | 0.869 | -56.39 |
| mc=3 + thr=55 | 211 | 39.81% | +0.5805 | +122.49 | 1.945 | -17.99 |

**The falsification test fired as predicted:** `threshold=65` is *worse* than
baseline on both slices, confirming the inversion in section 4 is real and not
a bucketing artifact.

### TEST — held out, scored once

| candidate | n | win | expectancy | total R | PF | maxDD |
|---|---|---|---|---|---|---|
| baseline | 351 | 23.65% | **-0.1007** | -35.34 | 0.876 | -57.02 |
| min_components=3 | 206 | 39.81% | +0.5489 | +113.07 | 1.867 | -14.33 |
| min_components=4 | 131 | 42.75% | **+0.6940** | +90.92 | 2.174 | -9.83 |

`min_components=4` holds up on unseen TEST: better expectancy, better profit
factor, and a drawdown roughly 6x smaller, on an adequate sample.

### Why this was NOT shipped

The result is consistent, survives held-out data, and passes the falsification
control — and it is still **not sufficient grounds to change production**,
because every slice comes from a seeded PRNG. A filter that improves results
against a random generator has demonstrated only that the generator's
multi-factor setups behave differently from its single-factor ones.

`engine.min_components` therefore remains at its shipped default of **2**. The
finding is recorded as a **hypothesis to re-test on real candles**, with the
exact procedure in section 0 and a verdict rule already coded into
`scripts/strategy-optimize.ts`.

---

## 6. One-signal-per-symbol constraint

### What the DB index actually does

`signals_edge_unique` = `(symbol, timeframe, setup_candle_time, source,
COALESCE(replay_run_id, -1))`.

It prevents duplicate rows for one setup candle. It does **not** implement the
one-signal-per-symbol policy, and it has **no strategy discriminator** — two
strategy variants writing `LIVE_ENGINE` rows for the same setup candle would
collide on this index, so in-database A/B comparison is impossible without a
schema change.

### The policy, and its defect

Enforcement lives in application code, `src/strategy/engine-runner.ts` (~line
216): `busySymbols.has(s.symbol)` → `suppressedBySymbolPolicy` →
`settleEdge(next)`.

The scan is `for (const symbol) { for (const timeframe) }` over a canonically
ordered timeframe list. **The earliest timeframe wins the symbol lock, and no
score comparison guards the suppression branch.** A 1m edge scoring 58
suppresses a 4h edge scoring 92 on the same symbol, purely because of loop
order. Results depend on processing order rather than signal quality.

Correct behaviour that must be preserved: suppressed edges `settleEdge()` into
**HOLD**, not NEUTRAL, so a persistent condition cannot later re-fire as a fake
new edge.

### Proposed fix — NOT implemented in this pass

Two-phase scan: collect all candidate edges for a symbol across timeframes
first, then commit the highest-scoring one and settle the rest to HOLD. This
keeps the one-per-symbol invariant, removes the order dependency, and needs no
schema change.

It is written up rather than implemented because the ranking rule it introduces
(score? score x timeframe weight? confirmations?) should be chosen from real
measurements — and per section 0, those do not exist yet. Changing it now would
mean picking a tie-break rule with no evidence behind it. Nothing was weakened.

---

## 7. What changed, and what deliberately did not

Changed:

- Documentation corrected to describe the registry/DB layering and the true
  meaning of score (README).
- Measurement harness added (`scripts/strategy-lab.ts`,
  `scripts/strategy-optimize.ts`) plus `npm run lab` / `npm run lab:optimize`.
- Regression tests added (`tests/strategy-audit.test.ts`,
  `tests/strategy-lab.test.ts`).
- `/admin` layout fix for the «Таймфреймы стратегии» row.

Deliberately unchanged:

- **All strategy parameters**, including `engine.min_components`, despite a
  candidate that beat baseline on held-out synthetic data.
- Factor weights — not touched to match the README; the README was fixed.
- The ambiguous-bar policy — already conservative; only test coverage added.
- The symbol-lock behaviour — defect proven, fix proposed, nothing weakened.
- DB schema.

---

## 8. Still to be checked

1. **Everything in sections 3-5, on real Binance Spot candles.** Until then the
   strategy's real-world quality is unknown.
2. Whether the score inversion survives on real data. If it does, the scoring
   formula's denominator should be reconsidered — score currently cannot serve
   as a quality ranking, which also blocks the symbol-lock fix in section 6.
3. Why TP3 was never reached, and whether `outcome.timeout_bars = 48` truncates
   winners before the final rung.
4. Whether the LONG/SHORT asymmetry is a generator artifact or a real skew.
5. Whether `LIQUIDITY_SWEEP` / `RANGE_POSITION` are genuinely negative or merely
   over-represented in thin setups.
6. Browser verification of the `/admin` layout fix at 1280px, tablet and mobile
   — not possible in this sandbox (Playwright downloads are blocked).

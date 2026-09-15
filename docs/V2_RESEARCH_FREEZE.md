# SMC V2 — RESEARCH FREEZE MANIFEST

**Purpose.** This document pins the exact V2 configuration that existed
**BEFORE any real Binance history was loaded or inspected**. After real data
arrives we must be able to prove which parameters predate the real TEST slice,
so that any later claim of an edge cannot be contaminated by hindsight.

Everything below was fixed while the only available data was
`fixtures/` — a **synthetic, seeded-PRNG generator**, not the market.

> **SYNTHETIC RESULTS ARE NOT EVIDENCE OF PROFITABILITY.**
> No number in this repository measured against `fixtures/` says anything about
> real-market expectancy, win rate, or edge. The fixtures measure the engine
> against a random-number generator.

---

## 1. Identity

| item | value |
|---|---|
| freeze commit | the commit that added this file (see note below) |
| parent commit (audited read-only) | `60aac85` |
| branch | `arena/01a09fa1-svechnoy-suslik-v2` |
| date frozen (Europe/Moscow) | 2026-09-14 |
| real Binance history loaded at freeze time | **NO — none, ever** |

> A commit cannot contain its own hash, so the freeze commit is identified by
> its **parent**, `60aac85`, which is fixed. Resolve the exact hash with:
>
> ```
> git log --oneline --diff-filter=A -- docs/V2_RESEARCH_FREEZE.md
> ```
>
> The freeze is the unique child of `60aac85` on branch
> `arena/01a09fa1-svechnoy-suslik-v2` that adds this file.
| V2 enabled | **NO** (`v2.enabled = false`) |
| LIVE trading | **BLOCKED** (`LIVE_TRADING_ENABLED = false`, compile-time `as const`) |

**Data provenance at freeze time.** Crypto-market egress is blocked in the
development sandbox; `api.binance.com`, `data.binance.vision`, Bybit, Kraken,
Coinbase, CoinGecko and CryptoCompare are all unreachable. No real candle has
ever entered this repository. Every measurement quoted anywhere in the docs
comes from `scripts/make-fixtures.mjs` (mulberry32 PRNG).

---

## 2. CRITICAL — runtime settings may differ from these defaults

The values in this manifest are the **registry defaults** declared in
`src/core/settings.ts` (`SETTINGS_REGISTRY`, 74 keys total).

**They are not necessarily the values a running instance uses.** At runtime,
`loadSettings()` reads the `settings` table:

```ts
export async function loadSettings(db = getDb()): Promise<Settings> {
  const rows = await db.selectFrom('settings').select(['key', 'value']).execute();
  return Settings.fromEntries(rows.map((r) => [r.key, r.value] as const));
}
```

`src/db/seed.ts` seeds that table from the registry, but any row can afterwards
be edited through the admin settings API (`app/api/admin/settings/route.ts`).
A DB value therefore **overrides** the default shown here.

**Requirement for statistical replay.** Any real-data replay run MUST persist a
snapshot of the settings actually used, alongside its results. Comparing a
replay against this manifest alone is not sufficient — the manifest proves what
the *defaults* were, not what a given run *used*.

---

## 3. Frozen parameters

### 3.1 V2 and shared registry keys

| key | default | type | category |
|---|---|---|---|
| `engine.lookback_candles` | `300` | number | engine |
| `engine.swing_lookback` | `3` | number | detectors |
| `outcome.fee_pct` | `0.1` | number | outcome |
| `outcome.sl_priority_on_ambiguous_bar` | `true` | boolean | outcome |
| `outcome.timeout_bars` | `48` | number | outcome |
| `risk.atr_period` | `14` | number | risk |
| `risk.min_rr` | `1` | number | risk |
| `v2.adx_period` | `14` | number | detectors |
| `v2.breakout_hold_window` | `3` | number | detectors |
| `v2.breakout_min_body_atr` | `0.5` | number | detectors |
| `v2.breakout_min_close_atr` | `0.25` | number | detectors |
| `v2.displacement_min_body_atr` | `0.6` | number | detectors |
| `v2.enabled` | `false` | boolean | engine |
| `v2.fvg_min_size_atr` | `0.15` | number | detectors |
| `v2.liquidity_tol_atr` | `0.25` | number | detectors |
| `v2.min_evidence` | `0.45` | number | engine |
| `v2.min_net_evidence` | `0.12` | number | engine |
| `v2.min_range_confidence` | `0.25` | number | engine |
| `v2.min_room_r` | `1.5` | number | risk |
| `v2.range_edge_pct` | `0.25` | number | engine |
| `v2.rsi_period` | `14` | number | detectors |
| `v2.stop_buffer_atr` | `0.25` | number | risk |
| `v2.structure_min_penetration_atr` | `0.05` | number | detectors |
| `v2.sweep_min_penetration_atr` | `0.1` | number | detectors |
| `v2.sweep_min_wick_ratio` | `0.25` | number | detectors |
| `v2.sweep_reclaim_window` | `3` | number | detectors |
| `v2.volume_period` | `20` | number | detectors |

**`v2.min_first_target_r` does not exist.** It was introduced by `60aac85` and
**removed** by this freeze commit as redundant double-filtering — see §4.3.

### 3.2 Risk / execution

| item | value | source |
|---|---|---|
| **`risk.min_rr`** | **`1`** | registry; **the single executable minimum-RR gate** |
| RR formula | `rr1 = \|firstExecutableTarget − entryFill\| / \|entryFill − SLfill\|` | `executableLadder()` |
| applied in | `src/replay/v2-runner.ts`, `src/replay/runner.ts`, `src/strategy/engine-runner.ts` | |
| SL buffer | `v2.stop_buffer_atr = 0.25` ATR | |
| SL anchors | `SWEEP_EXTREME` (reversal) / `BREAKOUT_LEVEL` (continuation) | `engine.ts` |
| entry model | **N+1 OPEN** — signal on closed bar N, fill at the open of N+1 | `resolveEntry()` |
| position sizing | not modelled; all results are in R | |

`risk.min_rr` was **not** re-tuned by this commit. Its value is unchanged.

### 3.3 Outcome / exit model

| item | value |
|---|---|
| `outcome.timeout_bars` | `48` |
| timeout semantics | exit at the **close** of the Nth permitted bar; entry bar counts as the 1st, so `barsHeld === N` and the exit bar index is `N − 1`. Verified for N ∈ {1,2,3,5,48}, no off-by-one |
| TP semantics | only the **final** rung closes the trade; TP1/TP2 are milestones (no partial exits in this build) |
| ambiguous-bar policy | `outcome.sl_priority_on_ambiguous_bar = true` |
| dataset boundary | yields **OPEN**, never TIMEOUT |
| OPEN in metrics | excluded from every CLOSED-scoped metric; reported as `openCount` |
| TIMEOUT in metrics | **included** in main CLOSED metrics; `expectancyExTimeout` exists only as a diagnostic |

### 3.4 Indicators

| indicator | parameters |
|---|---|
| ATR | Wilder, period `risk.atr_period = 14` |
| RSI | Wilder, period `v2.rsi_period = 14` |
| ADX | Wilder, period `v2.adx_period = 14` |
| MACD | `12 / 26 / 9` (hard-coded in `indicators.ts`) |
| EMA | `20`, `50`, `200` (hard-coded); slope measured on EMA20 in ATR units |
| RVOL | average over `v2.volume_period = 20`; `rvolScore = clamp01((rvol − 0.8) / 1.2)` |
| minimum bars to evaluate | `max(60, swing_lookback * 6 + 30)` = **60** at defaults |

### 3.5 HTF mapping

```json
{"1m":["5m","15m"],"5m":["15m","1h"],"15m":["1h","4h"],"30m":["1h","4h"],
 "1h":["4h","1d"],"4h":["1d"],"1d":["1w"],"1w":[]}
```

HTF candles are filtered by `closedHtfCandles()` on a **time** basis
(`htfCloseTime <= ltfCloseTime`), not on the `is_closed` flag — verified to
exclude a not-yet-closed HTF bar even when its DB flag is wrongly `true`.
Missing HTF data yields `available: false` → `UNKNOWN` bias, never a fabricated one.

### 3.6 Evidence model — UNCHANGED from `b8825d1`

`COMPONENT_WEIGHTS` (`src/strategy/v2/engine.ts`):

```json
{"structure":1.4,"liquidity":1.4,"displacement":1.1,"obFvg":0.9,"volume":0.8,
 "htf":1,"trend":0.8,"momentum":0.8,"volatility":0.5,"roomToTarget":1.1}
```

| gate | value |
|---|---|
| `v2.min_evidence` | `0.45` |
| `v2.min_net_evidence` | `0.12` |

Aggregation: `evidence = Σ(clamp01(component) × weight) / Σ(weight)`.
Decision: `mine >= min_evidence` **and** `mine − other >= min_net_evidence`.

These were verified **byte-identical** to `b8825d1` by the read-only audit and
were **not touched** by this freeze commit either.

### 3.7 Structure / swings

| item | value |
|---|---|
| swing strength | `engine.swing_lookback = 3` bars each side |
| confirmation | a swing is invisible until `confirmedIndex` (`knownSwings(swings, atIndex)` filters `confirmedIndex <= atIndex`) |
| lookback window | `engine.lookback_candles = 300` |
| BOS/CHoCH penetration | `v2.structure_min_penetration_atr = 0.05` ATR; a **wick is not a break** |
| range edge zone | `v2.range_edge_pct = 0.25` |
| range confidence floor | `v2.min_range_confidence = 0.25` |
| range invalidation | close beyond a boundary by `> 0.10 × range.size`; wicks never invalidate |
| range reclaim | **no un-break path** — documented limitation, deliberately unchanged (§5) |

### 3.8 Liquidity

| item | value |
|---|---|
| cluster tolerance | `v2.liquidity_tol_atr = 0.25` ATR |
| pool price | `max(cluster)` buy-side, `min(cluster)` sell-side |
| strength | `0.6 × min(1, touches/3) + 0.4 × min(1, age/20)` |
| kind | 1 touch `SWING`, 2 `EQUAL`, 3+ `CLUSTER` |
| cluster identity | `clusterId = SIDE#earliestMemberIndex` |
| **lifecycle** | `FRESH` / `TOUCHED` / `SWEPT` / `CONSUMED`; `resting = FRESH ∨ TOUCHED` |
| SWEPT threshold | wick penetration `>= v2.sweep_min_penetration_atr` (0.1 ATR), no acceptance |
| CONSUMED threshold | close beyond `>= v2.breakout_min_close_atr` (0.25 ATR) |
| lifecycle causality | scanned over `(knownAtIndex .. evalIndex]` only |

The lifecycle reuses existing detector thresholds; **no new tunable was
introduced**, so nothing here could have been fitted to results.

### 3.9 Sweep / breakout / displacement

| item | value |
|---|---|
| sweep min penetration | `v2.sweep_min_penetration_atr = 0.1` ATR |
| sweep min wick ratio | `v2.sweep_min_wick_ratio = 0.25` |
| sweep reclaim window | `v2.sweep_reclaim_window = 3` bars (backwards only, never future) |
| breakout min close beyond | `v2.breakout_min_close_atr = 0.25` ATR |
| breakout min body | `v2.breakout_min_body_atr = 0.5` ATR |
| breakout hold window | `v2.breakout_hold_window = 3` bars |
| displacement min body | `v2.displacement_min_body_atr = 0.6` ATR |
| FVG min size | `v2.fvg_min_size_atr = 0.15` ATR |

### 3.10 Target construction rules

Order of operations in `buildTargets()`:

1. Collect candidates ahead of entry: same-side liquidity pools, range mid, opposite range edge.
2. **Lifecycle filter** — skip pools with `resting === false`.
3. Direction filter — `ahead(p)`; nothing behind or level with entry.
4. Range-invalidation filter — drop `RANGE_EDGE` when `range.brokenSide !== null` (both sides, both directions).
5. Sort by distance from entry; keep the nearest three.
6. **Area de-duplication** — collapse when the `clusterId` matches **or** the gap is `<= v2.liquidity_tol_atr` ATR (the same tolerance used to build pools).
7. `R_MULTIPLE` fallback `[1, 2, 3]` only where structure supplies nothing, never behind or inside an existing rung.
8. Guarantee: strictly positive, strictly increasing R, at most 3 rungs.

`basis ∈ {INTERNAL_LIQUIDITY, EQUILIBRIUM, RANGE_EDGE, R_MULTIPLE}`.
`EXTERNAL_LIQUIDITY` was removed — it was never emitted.

Room: `finalR = R(last rung)`, `firstR = R(first rung)`,
`nextStructuralR = R(second rung, else last)`, and
**`adequate = finalR >= v2.min_room_r`** — one gate, on `finalR` only.

### 3.11 WAIT rules

A setup returns WAIT when any of the following hold (10 `waitReasons.push`
sites in `engine.ts`):

| rule | condition |
|---|---|
| no range / weak range | no range, or `confidence < v2.min_range_confidence` |
| at edge, no liquidity event | price at a boundary with neither confirmed sweep nor breakout |
| mid-range, no watch point | price mid-range with no actionable structure |
| no valid reversal / continuation | no candidate direction derivable |
| insufficient evidence | `mine < v2.min_evidence` |
| insufficient net evidence | `mine − other < v2.min_net_evidence` |
| no structural stop | stop underivable, or on the wrong side of entry |
| insufficient room | `finalR < v2.min_room_r` |
| no target derivable | ladder empty |

Downstream, the runner additionally refuses any setup whose
`executableLadder(...).rr1 < risk.min_rr`.

---

## 4. Changes made by this freeze commit

Three correctness fixes from the read-only audit of `60aac85`. **No parameter
was tuned, and no change was made to improve a synthetic metric.**

### 4.1 Liquidity lifecycle (correctness)

Pools price had already swept or accepted through were still being offered as
future take-profits. Pools now carry `FRESH`/`TOUCHED`/`SWEPT`/`CONSUMED` and
only resting pools can become targets — and therefore only resting pools can
contribute to room-to-target. Thresholds are the existing sweep/breakout ones.

### 4.2 Target area de-duplication (correctness)

Pools clustered at 0.25 ATR while the ladder de-duplicated at a hard-coded
0.15 ATR, so two levels the pool builder called one area could occupy two TP
slots. De-duplication now inherits `v2.liquidity_tol_atr` and also collapses on
shared `clusterId`. **The tolerance is inherited, not chosen** — nothing was
fitted.

### 4.3 Removal of `v2.min_first_target_r` (de-duplication of a gate)

The audit measured `room.firstR === executableLadder(...).rr1` in **748/748**
TEST setups — the same quantity — and showed the engine floor (0.5) was
strictly dominated by `risk.min_rr` (1.0). Toggling it 0 ↔ 0.5 produced a
**byte-identical trade set** (136 vs 136 trades) and only relabelled WAIT
reasons. It was deleted. `risk.min_rr` is unchanged at `1`.

### 4.4 Deliberately NOT changed

* **Range breakout + immediate reclaim** keeps the range invalidated until a new
  confirmed swing re-anchors it. Conservative, not permissive; a design question
  for after real-data replay. Documented in `docs/STRATEGY.md` §3.4.
* Evidence weights, `min_evidence`, `min_net_evidence` — untouched.
* `risk.min_rr`, `outcome.timeout_bars` — untouched.

---

## 5. Verification recorded at freeze time

| check | result |
|---|---|
| `npm run typecheck` | **pass** (exit 0) |
| `npx vitest run` | **pass** — 33 files, 922 tests, 31 skipped |
| `npm run build` | **pass** |
| `v2.enabled` runtime value | `false` |
| V2 referenced from `src/workers/` | **none** |
| V1 signal path changed | **no** |
| `LIVE_TRADING_ENABLED` | `false` |
| FORWARD_TEST history | untouched; no `DELETE`/`DROP`/`TRUNCATE`, no migrations |
| anti-look-ahead | `evaluateV2` output identical with and without future bars (>100 sampled evaluations) |
| single RR gate | 152 TEST trades, min `rr1 = 1.0000`, 0 violations |

---

## 6. What must happen next

1. Load real Binance history.
2. Persist a **settings snapshot** with every replay run (§2).
3. Re-run the V1/V2 comparison on real data with the chronological
   TRAIN/VALIDATION/TEST split.
4. Judge V2 **only** on the unseen real TEST slice.
5. Do not tune parameters against that TEST slice. If tuning becomes necessary,
   it happens on TRAIN/VALIDATION and the freeze is re-issued with a new commit
   hash.

Activation remains governed by §24–§28 of the V2 specification. Nothing in this
document authorises enabling V2 or unlocking LIVE.

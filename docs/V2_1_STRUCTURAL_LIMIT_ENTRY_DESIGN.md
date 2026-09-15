# V2.1 STRUCTURAL LIMIT ENTRY — READ-ONLY DESIGN AUDIT

**Nothing was implemented. No strategy code changed. No replay run. TEST not
used. No parameter tuned or compared.**

This is a design audit against the frozen code (`4839074`) and the existing
TRAIN artifacts, answering whether a structural limit-entry range is
architecturally supportable and what "a point" technically means.

| pinned | value |
|---|---|
| frozen V2 strategy | `4839074` — `git diff 4839074 -- src/` empty |
| dataset | `c3c1dce` |
| TRAIN closed trades examined | 328,872 |
| TEST | USED — **not touched here** |

---

## 3. Structural entry candidates that already exist in frozen V2

Audited in `src/strategy/v2/types.ts`, `structure.ts` and `engine.ts`.

| candidate | type / fields | A. fully known at CLOSED N? | B. look-ahead free? | C. in artifacts? | D. usable without changing direction logic? |
|---|---|---|---|---|---|
| **Order Block** | `OrderBlock {high, low, state, knownAtIndex}` | **Yes** — `knownAtIndex = displacement.index` | **Yes** | **No** — only `hasOb: bool` | Yes (price levels exist in-engine) |
| **FVG** | `FairValueGap {top, bottom, state, filledFraction, knownAtIndex}` | **Yes** — `knownAtIndex = index + 1`, the 3-bar pattern completes before N | **Yes** | **No** — only `hasFvg: bool` | Yes |
| **OB + FVG overlap** | intersection of the two | Yes, when both exist | Yes | **No** — booleans only | Yes |
| **50 % displacement** | `Displacement {strength, index}` | Yes | Yes | **No** — no boundaries | Midpoint is derivable in-engine, not from artifacts |
| **Swept liquidity / reclaim** | `SweepEvent` → `SWEEP_EXTREME` | **Yes** — already anchors the SL | **Yes** | **Indirectly** — `stopAnchor` label only | **Yes — strongest support** |
| **Broken level / retest** | `BreakoutEvent.level` → `BREAKOUT_LEVEL` | **Yes** — already anchors the SL | **Yes** | **Indirectly** — `stopAnchor` label only | **Yes — strongest support** |

### Causality verdict

All six are **causally clean**. Both `knownAtIndex` assignments prove the level
is established at or before the evaluated bar:

- OB: `knownAtIndex = displacement.index` — the displacement that creates the OB
  has already printed.
- FVG: `knownAtIndex = index + 1` — the middle bar of the 3-bar pattern is at
  `index`, so the gap is confirmed one bar later, still ≤ N.

Since a limit order is *published at N and filled later*, there is no look-ahead
risk in the fill itself either: the zone is fixed before any future bar exists.

### The blocking architectural finding

**Frozen V2 never uses OB/FVG as price levels.** In `engine.ts` they contribute
only a scalar to evidence:

```ts
let obFvg = 0;
if (orderBlock && orderBlock.direction === dir && orderBlock.state !== 'INVALIDATED') obFvg += 0.6;
if (fvg && fvg.direction === dir && fvg.state !== 'FILLED') obFvg += 0.4;
prof.obFvg = clamp01(obFvg);
```

The boundaries `orderBlock.high/low` and `fvg.top/bottom` are computed, attached
to the decision, and then **never consulted for pricing**. Critically, **nothing
checks which side of current price they sit on** — an OB can be above price on a
LONG and still add 0.6 evidence. Entry is unconditionally `bar.close` → filled at
OPEN N+1.

So the raw material exists, but the side-of-price test demanded by §7 is **not
implemented anywhere** and would have to be built.

---

## 4. Priority hierarchy — what the frozen code actually supports

The proposed hierarchy is **not** adopted as given. Ranked by what is genuinely
available and already trusted by the engine:

| rank | anchor | justification | TRAIN availability |
|---|---|---|---|
| **1** | `BREAKOUT_LEVEL` (retest) | Already the causal SL anchor for CONTINUATION; a single unambiguous price | **85.19 %** |
| **2** | `SWEEP_EXTREME` (reclaim) | Already the causal SL anchor for REVERSAL | **14.81 %** |
| **3** | OB ∩ FVG overlap | Both present, narrow by construction | 35.06 % |
| **4** | Fresh OB | `state !== 'INVALIDATED'`, has high/low | 49.94 % |
| **5** | FVG | `state !== 'FILLED'`, has top/bottom | 72.81 % |
| **6** | 50 % displacement | Derivable, weakest structural claim | n/a |

**A structural anchor is available on 100 % of TRAIN setups** (85.19 % +
14.81 %). The recommended anchor is therefore **the existing stop anchor**, not
OB/FVG — because the engine already commits to it as the level that invalidates
the idea, which makes it the most defensible causal reference. OB/FVG are better
used as an optional *refinement* of the zone when they overlap the anchor.

---

## 5. What is a "point"? — empirical tick sizes

`tickSize` is not stored in the research dataset (it exists only as
`tick_size` in `src/db/repo.ts` for the production UI). It was therefore
**measured empirically** from the real Binance klines by price-decimal
inspection, not invented.

| symbol | tickSize | ref price | 5 ticks | 10 ticks | 5 ticks (%) | 10 ticks (%) |
|---|---|---|---|---|---|---|
| BTCUSDT | 0.01 | 87,648.22 | $0.05 | $0.10 | 0.00006 % | 0.00011 % |
| ETHUSDT | 0.01 | 2,971.64 | $0.05 | $0.10 | 0.00168 % | 0.00337 % |
| BNBUSDT | 0.01 | 864.30 | $0.05 | $0.10 | 0.00579 % | 0.01157 % |
| SOLUSDT | 0.01 | 124.65 | $0.05 | $0.10 | 0.04011 % | 0.08022 % |
| XRPUSDT | 0.0001 | 1.8423 | $0.0005 | $0.001 | 0.02714 % | 0.05428 % |
| DOGEUSDT | 0.00001 | 0.11747 | $0.00005 | $0.0001 | 0.04256 % | 0.08513 % |

**"5–10 points" ≠ "$5–10".** On BTC, 5 ticks is **5 cents**, not $5.

### E. Is that zone too small? — yes, catastrophically, and non-uniformly

Measured against median ATR(14):

| symbol | ATR 1m | 5 ticks / ATR 1m | ATR 1h | 5 ticks / ATR 1h |
|---|---|---|---|---|
| BTCUSDT | 46.25 | **0.0011** | 483.22 | **0.00010** |
| ETHUSDT | 3.07 | 0.0163 | 25.88 | 0.00193 |
| BNBUSDT | 0.651 | 0.0768 | 4.28 | 0.01168 |
| SOLUSDT | 0.196 | 0.2545 | 1.88 | 0.02657 |
| XRPUSDT | 0.00221 | 0.2258 | 0.01205 | 0.04149 |
| DOGEUSDT | 0.000215 | 0.2326 | 0.00202 | 0.02481 |

A 5-tick zone spans **0.0011 ATR on BTC 1m** but **0.2545 ATR on SOL 1m** — a
**231× difference in market meaning** for the same nominal "5 points". On BTC 1h
it is 0.0001 ATR, i.e. effectively a single price, which would almost never fill.

Inverted, a *meaningful* 0.10 ATR zone requires:

| symbol | 0.10 ATR on 1m | 0.10 ATR on 1h |
|---|---|---|
| BTCUSDT | **463 ticks** | **4,832 ticks** |
| ETHUSDT | 31 ticks | 259 ticks |
| BNBUSDT | 7 ticks | 43 ticks |
| SOLUSDT | 2 ticks | 19 ticks |
| XRPUSDT | 2 ticks | 12 ticks |
| DOGEUSDT | 2 ticks | 20 ticks |

**Conclusion: a fixed tick count cannot be the unit.** It ranges from 2 to 4,832
ticks for identical market meaning. The zone must be defined in **ATR fractions**
(or % of price), with `tickSize` used **only** to round the final boundaries to a
valid exchange price. Ticks are a *quantisation* concern, not a *sizing* concern.

---

## 6. Structural area vs entry range

Two distinct objects, as requested:

- **STRUCTURAL AREA** — the real SMC region, e.g. `[orderBlock.low, orderBlock.high]`
  or `[fvg.bottom, fvg.top]`, or a band around `breakout.level` / sweep extreme.
- **ENTRY RANGE** — a small executable band **strictly inside** it.

Invariant: `entryRange ⊆ structuralArea`, enforced by clamping, never by
widening the structural area.

Three deterministic placements are identified. **None is selected** — selecting
one requires a backtest, which is out of scope:

1. **Proximal edge** — the boundary price reaches first. Highest fill
   probability, worst average price, smallest distance to SL.
2. **Midpoint** — balanced; the natural default if one must be picked without
   evidence.
3. **OB ∩ FVG overlap** — the narrowest and most confluent, available on 35.06 %
   of TRAIN setups; needs a documented fallback for the other 64.94 %.

Width should be expressed as `max(minTicks × tickSize, k × ATR)` — the ATR term
governs on BTC/ETH, the tick floor only prevents a sub-tick zone on DOGE/XRP.
`k` is **deliberately left unspecified**; fixing it is parameter selection.

---

## 7. LONG / SHORT semantics

| | LONG | SHORT |
|---|---|---|
| confirmation | bullish on CLOSED N | bearish on CLOSED N |
| structural area | **below** current price | **above** current price |
| order | BUY LIMIT | SELL LIMIT |
| fill test | `candle.low <= entryHigh` | `candle.high >= entryRange.low` |
| wrong side | **do not create the setup** | **do not create the setup** |

The wrong-side rule is the key discipline: if the structural area is not on the
retracement side, the setup is simply skipped. It must **never** degrade into a
market order — that is exactly the chasing behaviour this design removes.

**This test does not exist in frozen V2** and is new work.

---

## 8. State machine

```
SETUP_CONFIRMED   direction proven on CLOSED N
      │
      ▼
PENDING_ENTRY     limit range published; price has not traded into it
      │
      ├─► FILLED      price traded within [entryLow, entryHigh]
      ├─► MISSED      price reached a material objective (e.g. TP1) without returning
      ├─► EXPIRED     waiting horizon elapsed
      └─► CANCELLED   structural invalidation (SL level breached) before fill
```

Rules that must hold:

- **No retroactive fills.** Only candles with `openTime > setupCandleTime` can
  fill; the setup candle itself can never fill its own order.
- `MISSED` and `CANCELLED` are distinct: one is opportunity cost, the other is a
  thesis failure. Collapsing them would hide which mode dominates.
- If a single candle both enters the zone and breaches the SL, intrabar order is
  unknown → must be recorded **AMBIGUOUS** and resolved conservatively
  (`CANCELLED`), consistent with the frozen
  `outcome.sl_priority_on_ambiguous_bar = true`.
- `EXPIRED` needs an explicit horizon; none exists in frozen V2 today.

---

## 9. Signal format (design only)

```
LONG — REVERSAL                 SETUP CONFIRMED
ENTRY TYPE     : LIMIT
STRUCTURAL AREA: 77 430 – 77 560      (OB ∩ FVG)
ENTRY RANGE    : 77 495 – 77 505      (inside area, tick-rounded)
ENTRY STATUS   : WAITING
SL             : 77 310
TP1 / TP2      : 77 850 / 78 100
EXPIRY         : N + k bars
```

On fill: `ENTRY STATUS: FILLED @ 77 502`. Otherwise `MISSED`, `EXPIRED`, or
`CANCELLED`. Displayed prices must be rounded to that symbol's `tickSize`, which
is why tick size still matters even though it cannot size the zone.

---

## 10. Feasibility from existing artifacts

# FULL REPLAY REQUIRED

The descriptive feasibility analysis in §10 **cannot** be performed on the saved
artifacts. Three independent blockers:

1. **No structural boundaries are stored.** `v2-trades.jsonl` contains only
   `hasOb: bool` and `hasFvg: bool`. `obHigh`, `obLow`, `fvgTop`, `fvgBottom`,
   displacement boundaries and any structural-area field are all **absent**. The
   zone cannot be reconstructed, so "did price return into the area" is not
   computable.
2. **Only filled trades were recorded.** Every saved row has an entry taken at
   OPEN N+1; results are only `TP`/`SL`/`TIMEOUT`/`OPEN`. There is no population
   of `MISSED`/`CANCELLED` observations, which is precisely the quantity of
   interest.
3. **The trade set is not the signal set.** TRAIN had 1,271,409 directional
   decisions but only 328,872 trades (~26 %); the rest were suppressed by the
   one-position-at-a-time rule. Changing fills changes which trades occupy the
   slot, so the sequence cannot be re-derived by accounting.

What *is* already established without any new run: a causal structural anchor
exists on **100 %** of TRAIN setups (BREAKOUT_LEVEL 85.19 %, SWEEP_EXTREME
14.81 %), and OB ∩ FVG confluence on 35.06 %. The raw material is sufficient; the
*recorded* material is not.

A future replay would need to persist, per setup: structural area bounds, the
chosen entry range, side-of-price validity, and the terminal state
(FILLED/MISSED/EXPIRED/CANCELLED/AMBIGUOUS) — **including setups that never
fill**, which the current harness discards.

---

## 12. ANSWERS

**A. Best structural anchor for current V2 architecture.**
The **existing stop anchor** — `BREAKOUT_LEVEL` for CONTINUATION,
`SWEEP_EXTREME` for REVERSAL. The engine already computes it causally and already
stakes the trade's invalidation on it, and it covers 100 % of setups. OB/FVG
should refine the zone when they overlap, not replace the anchor.

**B. Which anchors are causally known at CLOSED N.**
All of them: OB (`knownAtIndex = displacement.index`), FVG
(`knownAtIndex = index + 1`), OB∩FVG, displacement, sweep extreme and breakout
level. None requires a future bar. Verified in code, not assumed.

**C. What is one point.**
One `tickSize` — the exchange's minimum price increment: 0.01 for
BTC/ETH/BNB/SOL, 0.0001 for XRP, 0.00001 for DOGE (measured empirically from the
klines; not stored in the research dataset).

**D. What 5 and 10 points mean per coin.**
BTC/ETH/BNB/SOL: $0.05 / $0.10. XRP: $0.0005 / $0.001. DOGE: $0.00005 / $0.0001.
As a share of price this spans 0.00006 % (BTC) to 0.085 % (DOGE) — a ~750× range.

**E. Is the zone too small vs ATR/spread.**
**Yes, and unusably non-uniform.** 5 ticks = 0.0011 ATR on BTC 1m and 0.0001 ATR
on BTC 1h (effectively a single price that would never fill), versus 0.2545 ATR
on SOL 1m — a 231× difference in meaning on 1m alone. Conversely a uniform
0.10 ATR zone needs 2 ticks on SOL/XRP/DOGE 1m but **4,832 ticks on BTC 1h**.
A fixed tick count therefore cannot define the zone. Size in **ATR fractions**;
use `tickSize` only to round boundaries to valid prices.

**F. How the entry range sits inside OB/FVG.**
`entryRange ⊆ structuralArea`, always clamped, never widened. Three
deterministic placements are documented — proximal edge, midpoint, OB∩FVG
overlap — and **none is chosen**, because choosing requires a backtest.

**G. LONG limit.** Structural area below price after bullish confirmation; BUY
LIMIT; fills when `candle.low <= entryHigh`; skip the setup entirely if the area
is above price.

**H. SHORT limit.** Structural area above price after bearish confirmation; SELL
LIMIT; fills when `candle.high >= entryLow`; skip if the area is below price.

**I. Required statuses.** `SETUP_CONFIRMED`, `PENDING_ENTRY`, `FILLED`, `MISSED`,
`EXPIRED`, `CANCELLED`, plus an `AMBIGUOUS` marker when one candle both fills and
invalidates — resolved conservatively as `CANCELLED`, never counted favourably.

**J. Backtest from existing artifacts?**
**No — FULL REPLAY REQUIRED.** Structural boundaries are not stored (booleans
only), only filled trades were recorded, and the one-position rule means the
trade set is not the signal set. The frozen engine has the data in memory; the
harness simply never persisted it.

---

**No implementation. No tuning. No TEST use. `v2.enabled=false`,
`LIVE_TRADING_ENABLED=false`, frozen strategy unchanged.**

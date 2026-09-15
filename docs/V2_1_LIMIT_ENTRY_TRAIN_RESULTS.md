# V2.1 STRUCTURAL LIMIT ENTRY — TRAIN RESULTS

**TRAIN ONLY. No candidate selected. VALIDATION and TEST not run.**

Models implemented exactly as fixed in `docs/V2_1_LIMIT_ENTRY_PREREGISTRATION.md`
(commit `e3750fc`). No preregistered rule was changed. Frozen V2 (`4839074`) is
untouched — `git diff 4839074 -- src/` is empty.

| pinned | value |
|---|---|
| frozen strategy | `4839074` (unchanged) |
| preregistration | `e3750fc` |
| dataset | `c3c1dce` (re-cloned, verified bit-identical) |
| slice | TRAIN only, per-series boundaries from frozen `splits.json` |

---

## 0. Environment recovery (before any result)

The sandbox was re-cloned between stages, destroying everything gitignored: the
dataset, the 891 MB candle cache, `node_modules`, and the baseline trade files.
All were rebuilt and **verified before use**:

- Dataset re-cloned at `c3c1dce`; manifest totals identical to the frozen run
  (2016 zips, 16,681,073 candles, 0 duplicates / out-of-order / invalid OHLC /
  invalid volume, 31 gaps, 625 missing candles, 30 badCloseTime).
- All 42 series reproduce the frozen split boundaries exactly.
- `npm ci` failed on pre-existing lockfile drift (lock pinned esbuild 0.25.12,
  tree resolves 0.28.2); `npm install` was used. `package.json` untouched.

## 1. Model A fidelity gate — **PASS**

| metric | Model A (rebuilt) | frozen baseline | match |
|---|---|---|---|
| closed | 328,872 | 328,872 | ✅ |
| open | 22 | 22 | ✅ |
| TP | 43,277 | 43,277 | ✅ |
| SL | 204,660 | 204,660 | ✅ |
| TIMEOUT | 80,935 | 80,935 | ✅ |
| total R | −239,721.2471 | −239,721.2471 | ✅ |
| expectancy | −0.7289 | −0.7289 | ✅ |
| profit factor | 0.4160 | 0.4160 | ✅ |

B/C/D results are therefore trustworthy.

## 2. A note on GROSS vs the stored R

`trackOutcome` returns an R that is **already net** of the frozen 0.1 % one-lump
fee, and that fee in R units is `0.1% × entry / riskPerUnit`. Because limit
fills move the entry *toward* the stop, they **shrink riskPerUnit** and therefore
**inflate fee-in-R**. Reading the stored R directly would conflate entry quality
with a fee artifact, so gross is reconstructed exactly:
`grossR = storedR + (0.1/100) × entry / riskPerUnit`.

Both economies are reported below. This distinction is the single most important
thing in this report.

## 3. Funnel

| model | actionable setups | PENDING | FILLED | fill rate | MISSED | EXPIRED | CANCELLED | REJECTED_GEOMETRY | AMBIGUOUS |
|---|---|---|---|---|---|---|---|---|---|
| A | 328,894 | 328,894 | 328,894 | 100.00 % | 0 | 0 | 0 | 0 | 0 |
| B | 1,219,225 | 934,314 | 121,304 | **12.98 %** | 369,350 | 320,978 | 122,035 | 626 | 122,035 |
| C | 1,489,734 | 656,270 | 167,293 | **25.49 %** | 221,248 | 88,840 | 70,358 | 108,519 | 46,327 |
| D | 1,770,071 | 604,501 | 129,278 | **21.39 %** | 220,498 | 112,031 | 79,822 | 62,855 | 45,322 |

"Actionable setups" is larger than A's trade count because A occupies its single
position slot far longer: a market fill always takes the slot, whereas a pending
order that expires or is cancelled releases it, so the limit models evaluate
more bars. This is a real consequence of the one-position rule, not an error.

## 4. Performance — GROSS (fee removed)

| model | closed | gross exp / FILLED | gross exp / ACTIONABLE SETUP | median R | gross PF | gross total R | max DD R | pos % |
|---|---|---|---|---|---|---|---|---|
| A | 328,872 | +0.0350 | **+0.0350** | −1.0000 | 1.0539 | +11,505 | −1,144 | 29.07 |
| B | 121,300 | **+3.5281** | +0.3510 | −1.0000 | 5.0680 | +427,963 | −92 | 13.21 |
| C | 167,280 | +0.6941 | +0.0779 | −1.0000 | 2.0384 | +116,115 | −330 | 26.95 |
| D | 129,271 | +0.4325 | +0.0335 | −1.0000 | 1.6344 | +55,910 | −169 | 25.68 |

## 5. Performance — NET at the frozen 0.1 % fee

| model | net exp / FILLED | median fee in R |
|---|---|---|
| A | −0.7289 | 0.4619 |
| B | **−5.3159** | **1.9376** |
| C | −3.5594 | 0.5208 |
| D | −0.9386 | 0.5724 |

**The gross and net rankings are exactly inverted.** B is the best model gross
(+3.53 R) and by far the worst net (−5.32 R).

## 6. Cost geometry — the explanation

| model | risk % p25 | median | p75 | median risk ATR | <0.10 % | <0.20 % | <0.50 % |
|---|---|---|---|---|---|---|---|
| A | 0.1379 | 0.2951 | 0.7174 | 1.6063 | 22.34 % | 47.13 % | 74.97 % |
| B | 0.0337 | **0.0657** | 0.1325 | 0.3948 | **74.28 %** | 89.83 % | 98.23 % |
| C | 0.1090 | 0.2346 | 0.5726 | 1.4184 | 27.69 % | 51.46 % | 76.90 % |
| D | 0.0926 | 0.2025 | 0.5012 | 1.2661 | 31.45 % | 54.44 % | 78.16 % |

Model B fills so close to its stop that the median risk distance is **0.0657 %
of price** — a 10 bps round trip is then ~1.5 R of cost before the market moves.
74 % of B's trades sit under 0.10 %. B does not have a better edge; it has a
smaller denominator.

### Analytic net expectancy per FILLED trade

| model | 2 bps | 5 bps | 10 bps | 20 bps |
|---|---|---|---|---|
| A | −0.1178 | −0.3470 | −0.7289 | −1.4928 |
| B | **+1.7593** | −0.8939 | −5.3159 | −14.1600 |
| C | −0.1566 | −1.4327 | −3.5594 | −7.8130 |
| D | **+0.1583** | −0.2530 | −0.9386 | −2.3096 |

Only at an unrealistic 2 bps round trip do B and D turn positive. At Binance
Spot's actual ~0.1 % **per side**, every model is deeply negative.

## 7. Entry improvement — invariant holds

| model | filled | invariant violations | median improvement | LONG | SHORT | in ATR |
|---|---|---|---|---|---|---|
| B | 121,304 | **0** | 0.21763 % | 0.14101 % | 0.21416 % | 1.1718 |
| C | 167,293 | **0** | 0.13520 % | 0.12743 % | 0.12180 % | 0.9696 |
| D | 129,278 | **0** | 0.16105 % | 0.15398 % | 0.14412 % | 1.1372 |

Every filled limit price is at least as good as the OPEN N+1 reference, for both
directions, with zero violations across 417,875 fills. **Entry price genuinely
improves** — that part of the thesis is confirmed. It simply does not survive the
cost geometry it creates.

## 8. MISSED analysis (anti-bias check 1 — mandatory)

| model | MISSED | median bars to miss | baseline mean R of those setups | baseline median |
|---|---|---|---|---|
| B | 369,350 | 2.0 | **+0.7834** | +1.0536 |
| C | 221,248 | 2.0 | **+0.7846** | +0.9742 |
| D | 220,498 | 2.0 | **+0.7968** | +1.0286 |

**This is the decisive result.** The setups the limit models miss are precisely
the baseline's *winners* — mean **+0.78 R** each. Price ran to TP1 without
retracing, which is exactly what a winning trade looks like. Waiting for a
better entry systematically forfeits the trades that worked.

## 9. Selection bias (anti-bias check 2 — mandatory)

Baseline outcome of the same setups, split by what the limit model did:

| model | FILLED (baseline R) | MISSED (baseline R) | OTHER NON-FILL (baseline R) |
|---|---|---|---|
| B | −1.2080 (n=32,906) | **+0.7834** (n=28,385) | −0.7734 (n=97,575) |
| C | −0.7877 (n=42,243) | **+0.7846** (n=20,472) | −1.0431 (n=55,354) |
| D | −0.7848 (n=28,130) | **+0.7968** (n=20,081) | −0.8895 (n=61,173) |

Retracement is **not** a neutral filter. It mechanically selects trades that go
against the signal first — for model B the filled subset is markedly worse than
the baseline average (−1.21 vs −0.73). The apparent gross improvement comes from
the shrunken R denominator, not from picking better trades.

## 10. Breakdowns (gross)

**Direction**

| model | LONG | SHORT |
|---|---|---|
| A | +0.0117 (n=106,668) | +0.0462 (n=222,204) |
| B | +2.9056 (n=25,816) | +3.6965 (n=95,484) |
| C | +0.5741 (n=56,778) | +0.7558 (n=110,502) |
| D | +0.1397 (n=42,741) | +0.5771 (n=86,530) |

**Setup kind**

| model | REVERSAL | CONTINUATION |
|---|---|---|
| A | +0.0191 (n=48,722) | +0.0377 (n=280,150) |
| B | −0.0711 (**n=899**) | +3.5550 (n=120,401) |
| C | +0.3641 (n=14,882) | +0.7264 (n=152,398) |
| D | +0.3860 (n=12,724) | +0.4376 (n=116,547) |

Model B is effectively a CONTINUATION-only model: only 899 reversal fills, since
`breakout.level` barely exists for reversals (1.04 % availability in the
structural audit).

**Timeframe (gross expectancy, n)**

| model | 1m | 5m | 15m | 30m | 1h | 4h | 1d |
|---|---|---|---|---|---|---|---|
| A | +0.047 (246,692) | −0.001 (51,160) | −0.004 (17,016) | −0.008 (8,503) | +0.005 (4,344) | +0.078 (1,025) | +0.342 (132) |
| B | +4.262 (84,090) | +2.638 (22,913) | +0.606 (7,984) | +0.670 (3,889) | +0.663 (1,932) | +0.621 (436) | +2.538 (56) |
| C | +0.562 (126,629) | +1.617 (26,008) | +0.214 (8,142) | +0.195 (3,950) | +0.121 (1,985) | +0.184 (499) | +0.521 (67) |
| D | +0.496 (97,527) | +0.248 (20,270) | +0.149 (6,447) | +0.260 (3,085) | +0.390 (1,509) | +0.304 (363) | +0.194 (70) |

**Fill rate by timeframe** is remarkably stable (B 11.8–18.0 %, C 23.9–27.9 %,
D 19.6–24.8 %), so fill behaviour is not a timeframe artifact.

## 11. CANCELLED / EXPIRED / REJECTED census

| model | TP1 before retrace | expiry 12 bars | ambiguous same-bar | rr1 < min_rr | structural invalidation |
|---|---|---|---|---|---|
| B | 369,350 | 320,978 | 122,035 | 626 | 0 |
| C | 221,248 | 88,840 | 46,327 | 108,519 | 24,031 |
| D | 220,498 | 112,031 | 45,322 | 62,855 | 34,500 |

Model B records **zero** pure structural invalidations because its zone sits at
the breakout level itself — any move that would break the stop first trades
through the zone, landing in the conservative AMBIGUOUS→CANCELLED bucket
(122,035 cases). C and D lose a large share to `rr1 < min_rr`: filling closer to
the stop shrinks risk, but the frozen `risk.min_rr` gate then rejects the trade.

No CANCELLED/EXPIRED/MISSED record is ever later converted to FILLED — each
setup terminates exactly once and the pending slot is cleared on termination.

## 12. Anti-bias / causality checks

| check | result |
|---|---|
| fill only at N+1 or later | ✅ enforced structurally by the loop |
| no future OB/FVG/swing | ✅ zone built from the CLOSED-N `V2Setup` only |
| no ideal centre fill on an edge touch | ✅ fills at the FAR edge, only when traded through |
| same-bar ambiguity conservative | ✅ 213,684 cases resolved as CANCELLED |
| entry-improvement invariant | ✅ 0 violations / 417,875 fills |
| MISSED baseline outcomes reported | ✅ §8 |
| FILLED vs NOT-FILLED selection bias | ✅ §9 |

## 13. Interpretation (no candidate selected)

**Models that clearly failed on TRAIN:**

- **B (RETEST)** — fails decisively. Worst net expectancy of all four
  (−5.32 R), lowest fill rate (12.98 %), median risk distance 0.0657 % with
  74 % of trades under 0.10 %, 122,035 ambiguous cancellations, and essentially
  no reversal coverage (n=899). Its large gross number is a denominator
  artifact, not an edge.
- **C (FVG)** — fails on cost. Net −3.56 R, and 108,519 setups rejected by
  `rr1 < min_rr`. Gross +0.69 R does not survive any realistic fee.

**Model that remains arguable for a future VALIDATION:**

- **D (OB∩FVG → OB)** — the only model whose net expectancy is within reach of
  the baseline (−0.9386 vs A's −0.7289) while gross expectancy per actionable
  setup (+0.0335) is comparable to A (+0.0350). It has the most balanced
  profile: 21.4 % fill rate, the mildest risk-geometry distortion of the three
  limit models, positive gross on every timeframe, and reversal coverage that B
  lacks. It is **still worse than the baseline on net**, so this is not an
  endorsement.

**Honest summary:** all three limit models improve the entry price exactly as
intended and every one of them is worse than the frozen baseline once real
transaction costs are applied. The mechanism is now measured rather than
assumed: a better fill shortens the distance to the stop, and because fee-in-R
scales as `fee% × price / stopDistance`, the improvement is more than consumed
by the cost it creates. On top of that, waiting forfeits the baseline's winners
(+0.78 R per missed setup).

No model is selected, nothing is declared validated, and no rule was changed
after seeing these numbers.

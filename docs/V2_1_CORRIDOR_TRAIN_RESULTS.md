# V2.1 "CONFIRMED EXTREME CORRIDOR ENTRY" — TRAIN RESULTS

**TRAIN ONLY. No candidate selected. VALIDATION and TEST untouched.**

Implemented strictly per `docs/V2_1_CONFIRMED_EXTREME_CORRIDOR_PREREGISTRATION.md`
(commit `5ce3761`). No rule, threshold or constant was changed after seeing
results. Frozen V2 (`4839074`) untouched — `git diff 4839074 -- src/` is empty.

| pinned | value |
|---|---|
| frozen strategy | `4839074` |
| pre-registration | `5ce3761` |
| dataset | `c3c1dce` |
| slice | TRAIN only, per-series boundaries from frozen `splits.json` |
| series | 42 (6 symbols × 7 timeframes) |

---

## 1. Baseline fidelity gate — PASS

Arm **A** (all gates off, OPEN N+1) was checked trade-for-trade against the
frozen harness:

| series | frozen trades | arm A FILLED | identical entry/stop/result |
|---|---|---|---|
| BTCUSDT 4h | 169 | 169 | **169 / 169** |
| ETHUSDT 1h | 732 | 732 | **732 / 732** |

Arm A also reproduces the frozen TRAIN aggregate exactly: **328,873 closed**,
gross expectancy **+0.0350**, PF **1.0539**. The harness is therefore a faithful
superset of the frozen engine and the ablation is trustworthy.

## 2. Ablation arms

| arm | extreme | fee guard | confluence | corridor |
|---|---|---|---|---|
| A | – | – | – | – (OPEN N+1) |
| E | ✓ | – | – | – |
| F | – | ✓ | – | – |
| C | – | – | ✓ | – |
| EF | ✓ | ✓ | – | – |
| EFC | ✓ | ✓ | ✓ | – (OPEN N+1) |
| FULL | ✓ | ✓ | ✓ | ✓ |

**EFC vs FULL isolates the ENTRY effect from the FILTER effect** — the single
most important comparison in this report.

## 3. Funnel

| arm | actionable setups | FILLED | fill % of actionable | closed | rej EXTREME | rej FEE | rej CONFLUENCE | rej GEOMETRY |
|---|---|---|---|---|---|---|---|---|
| A | 1,271,418 | 328,899 | 25.87 % | 328,873 | 0 | 0 | 0 | 942,519 |
| E | 1,608,170 | 269,898 | 16.78 % | 269,878 | 532,292 | 0 | 0 | 805,980 |
| F | 2,537,776 | 131,863 | 5.20 % | 131,840 | 0 | 1,608,279 | 0 | 797,634 |
| C | 2,643,164 | 127,444 | 4.82 % | 127,436 | 0 | 0 | 2,226,013 | 289,707 |
| EF | 2,699,381 | 112,549 | 4.17 % | 112,531 | 813,868 | 1,121,176 | 0 | 651,788 |
| EFC | 3,266,559 | 60,135 | 1.84 % | 60,127 | 980,467 | 1,240,752 | 821,897 | 163,308 |
| **FULL** | 3,335,714 | **56,492** | **1.69 %** | 56,486 | 999,357 | 1,253,205 | 848,674 | 176,707 |

Actionable-setup counts grow as gates tighten because rejected setups release
the single position slot immediately, so more bars get evaluated. This is a real
consequence of the one-position rule, not double counting.

The stack is brutally selective: **56,492 fills from 3,335,714 setups (1.69 %)**
versus the baseline's 328,899.

## 4. Performance — GROSS (fee removed)

| arm | gross exp / FILLED | **gross exp / ACTIONABLE SETUP** | median R | PF | total R | max DD R | pos % | TP % |
|---|---|---|---|---|---|---|---|---|
| A | +0.0350 | **+0.0090** | −1.0000 | 1.0539 | +11,503 | −1,144 | 29.07 | 13.16 |
| E | +0.0350 | +0.0059 | −1.0000 | 1.0557 | +9,448 | −824 | 30.05 | 12.57 |
| F | −0.0057 | −0.0003 | −0.5689 | 0.9887 | −756 | −1,169 | 35.94 | 10.09 |
| C | +0.0220 | +0.0011 | −0.7337 | 1.0405 | +2,806 | −366 | 33.71 | 12.25 |
| EF | −0.0043 | −0.0002 | −0.3727 | 0.9910 | −483 | −796 | 37.10 | 9.26 |
| EFC | +0.0007 | +0.0000 | −0.1749 | 1.0017 | +40 | −407 | 39.43 | 7.02 |
| **FULL** | **+0.0076** | **+0.0001** | −0.1713 | 1.0195 | +427 | **−312** | **39.66** | 7.07 |

**No arm beats the baseline on gross expectancy per actionable setup.** A is
+0.0090; the best filtered arm is +0.0011 (C) and FULL is +0.0001 — an order of
magnitude worse. Every filter destroys more gross edge than it retains.

## 5. Performance — NET

**Per FILLED trade:**

| arm | 0 bps | 2 bps | 5 bps | 10 bps | 20 bps |
|---|---|---|---|---|---|
| A | +0.0350 | −0.1178 | −0.3470 | −0.7289 | −1.4928 |
| E | +0.0350 | −0.1155 | −0.3413 | −0.7175 | −1.4701 |
| F | −0.0057 | −0.0365 | −0.0827 | −0.1596 | −0.3135 |
| C | +0.0220 | −0.0795 | −0.2317 | −0.4854 | −0.9929 |
| EF | −0.0043 | −0.0341 | −0.0789 | −0.1535 | −0.3027 |
| EFC | +0.0007 | −0.0240 | −0.0610 | −0.1228 | −0.2462 |
| **FULL** | +0.0076 | **−0.0173** | −0.0546 | **−0.1167** | −0.2410 |

**Per ACTIONABLE SETUP (primary metric):**

| arm | 0 bps | 2 bps | 5 bps | 10 bps | 20 bps |
|---|---|---|---|---|---|
| A | +0.0090 | −0.0305 | −0.0898 | −0.1885 | −0.3861 |
| E | +0.0059 | −0.0194 | −0.0573 | −0.1204 | −0.2467 |
| **FULL** | +0.0001 | **−0.0003** | −0.0009 | **−0.0020** | −0.0041 |

The **Fee Drag Guard achieved its stated objective**: net loss per filled trade
at the frozen 0.1 % fee improves from **−0.7289 (A) to −0.1167 (FULL)**, a
**6.2× reduction** in fee bleed. Per actionable setup the loss shrinks from
−0.1885 to −0.0020, a **94 × reduction**.

**But that is cost avoidance, not edge creation.** FULL is close to zero mainly
because it barely trades (1.69 % fill rate). Its gross edge is +0.0001 per
setup — indistinguishable from nothing.

## 6. Cost geometry — the guard worked exactly as designed

| arm | risk % p25 | median | p75 | median risk ATR | <0.10 % | <0.20 % | <0.50 % |
|---|---|---|---|---|---|---|---|
| A | 0.1375 | 0.2960 | 0.7168 | 1.5984 | 22.34 % | 47.13 % | 74.97 % |
| F | 0.4492 | 0.6780 | 1.3069 | 2.5329 | **0.00 %** | **0.00 %** | 35.28 % |
| EFC | 0.5314 | 0.9243 | 1.9151 | 4.8966 | 0.00 % | 0.00 % | 22.20 % |
| **FULL** | 0.5284 | **0.9237** | 1.9190 | 4.8151 | **0.00 %** | **0.00 %** | 22.39 % |

Median stop distance rises from **0.2960 % → 0.9237 %** and the sub-0.20 %
population is eliminated entirely (47.13 % → 0 %). At a 0.1 % round trip that
caps fee drag near **0.11 R** instead of the baseline's ~0.34 R median.

## 7. Corridor fill rate and latency

| metric | FULL |
|---|---|
| corridors PUBLISHED (pending) | 234,478 |
| → rejected at fill on `rr1 < risk.min_rr` | 176,707 (75.36 %) |
| → reached a terminal state | 57,770 |
| FILLED | 56,492 |
| **fill rate of published corridors** | **24.09 %** |
| share of terminating corridors that filled | 97.79 % |
| MISSED | 277 |
| EXPIRED | 158 |
| CANCELLED | 843 (all ambiguous same-bar) |
| **median fill latency** | **1 bar** |
| p75 / p90 / max latency | 1 / 1 / 3 bars |

**Correction — two different denominators.** An earlier draft of this report
quoted 97.79 % as "the fill rate". That is the *conditional* rate among
corridors that reached a terminal state, and it overstates the design. The
honest headline is **24.09 %**: of 234,478 published corridors, **176,707
(75.36 %) were rejected at fill time because the recomputed `rr1` fell below
`risk.min_rr`**. Those setups never became trades. Both numbers are reported
here so the distinction cannot be lost:

- **24.09 %** — published corridor → actual trade. Comparable to the limit
  models' 12.98–25.49 %, i.e. **only modestly better, not transformative**.
- **97.79 %** — once a corridor survived the `rr1` gate and terminated, it
  almost always filled rather than being missed or expiring.

The genuine, defensible improvement over the rejected limit models is therefore
**latency and missed-winner behaviour, not raw fill rate**: median latency is
1 bar (max 3), and only **277** setups were MISSED versus 220k–369k for models
B/C/D. Because the corridor is centred on `close(N)` instead of waiting for a
retracement, it does not forfeit the winners — which was the specific defect
that killed B/C/D.

## 8. Anti-bias checks (all three mandatory checks executed)

Baseline **gross** outcome of the same setups, split by what FULL did:

| group | n | baseline gross mean | median |
|---|---|---|---|
| FILLED | 19,253 | **+0.0142** | −0.1534 |
| REJECTED_FEE_GUARD | 107,742 | **+0.0676** | −1.0000 |
| REJECTED_EXTREME | 142,629 | +0.0307 | −1.0000 |
| REJECTED_CONFLUENCE | 33,450 | −0.0069 | −1.0000 |
| MISSED | 7 | +1.0258 | +0.4172 |
| OTHER | 4,886 | −0.0340 | −0.1416 |

**This is the decisive finding, and it is negative.** The setups the Fee Drag
Guard rejects had a baseline gross expectancy of **+0.0676** — nearly **5×
better** than the +0.0142 of the setups it admits. The guard is not filtering
out bad trades; it is filtering out *tight-stop* trades, and those happened to
carry the better gross edge. It removes fee bleed and the edge together.

Only the confluence filter removes genuinely worse setups (−0.0069 baseline
gross), and it is the weakest contributor by volume.

The MISSED population is trivially small (7 matched setups), so unlike the
limit-entry study this design does **not** forfeit winners — confirming the
corridor fixed that specific defect.

## 9. Subgroup breakdowns (gross)

**Baseline A**

| dimension | values |
|---|---|
| setup | CONTINUATION +0.0377 (n=280,151) · REVERSAL +0.0191 (n=48,722) |
| direction | LONG +0.0117 (n=106,668) · SHORT +0.0462 (n=222,205) |
| timeframe | 1m +0.0468 (246,693) · 5m −0.0007 (51,160) · 15m −0.0045 (17,016) · 30m −0.0084 (8,503) · 1h +0.0051 (4,344) · 4h +0.0782 (1,025) · 1d +0.3422 (132) |
| symbol | ETH +0.0806 · BTC +0.0412 · DOGE +0.0359 · SOL +0.0195 · XRP +0.0185 · BNB +0.0106 |

**FULL**

| dimension | values |
|---|---|
| setup | CONTINUATION +0.0076 (n=56,041) · **REVERSAL +0.0039 (n=445)** |
| direction | LONG +0.0096 (n=26,082) · SHORT +0.0058 (n=30,404) |
| pool kind | CLUSTER +0.0218 (5,013) · **SWING +0.0094 (38,665)** · **EQUAL −0.0035 (12,808)** |
| timeframe | 1m +0.0026 (38,375) · 5m −0.0045 (10,699) · 15m +0.0421 (3,971) · 30m +0.0303 (2,104) · 1h +0.0801 (1,037) · 4h +0.1710 (255) · 1d +0.4350 (45) |
| symbol | BNB +0.0348 · SOL +0.0172 · ETH +0.0145 · DOGE +0.0076 · **BTC −0.0149** · **XRP −0.0205** |

Two observations worth recording, neither acted on:

- **The reversal path is effectively dead**: 445 closed trades out of 56,486
  (0.8 %). Requiring sweep + reclaim ≤3 bars + displacement ≥0.60 ATR
  simultaneously is far stricter than the structural audit implied.
- **EQH/EQL is the worst pool kind** (−0.0035) while CLUSTER is the best
  (+0.0218) — the opposite of the design's premise that equal highs/lows are the
  highest-quality extreme. Reported, not exploited.

## 10. Rejection census (FULL)

| reason | n |
|---|---|
| stop_below_floor (fee guard) | 1,253,205 |
| hold_too_short | 639,450 |
| votes_2 | 431,375 |
| votes_1 | 350,228 |
| no_displacement | 205,534 |
| rr1_below_min_rr | 176,707 |
| wick_not_body | 154,373 |
| votes_0 | 67,071 |
| ambiguous_same_bar_fill_and_sl | 843 |
| tp1_reached_before_fill | 277 |
| expiry_3_bars | 158 |

`hold_too_short` (639,450) is the single largest confirmation rejection —
`breakout.holdBars >= 1` is much more binding than anticipated.

## 11. Interpretation

**What worked.** The corridor entry is a real improvement over the rejected
limit models on *latency and missed winners*: 1-bar median fill latency and only
277 MISSED setups versus 220k-369k for B/C/D. Its true fill rate of published
corridors is **24.09 %**, only modestly better than B/C/D's 12.98-25.49 % -- the
often-quoted 97.79 % is the conditional rate among corridors that terminated and
excludes the 176,707 rejected on `rr1 < risk.min_rr`. The Fee Drag Guard also did exactly what it was designed to do,
eliminating the sub-0.20 % stop population and cutting net bleed 6.2× per trade.

**What failed.** Neither translated into edge. Ranked by the primary metric —
gross expectancy per actionable setup — **no filtered arm beats the unfiltered
baseline**: A +0.0090 vs FULL +0.0001. The anti-bias decomposition explains why:
the Fee Drag Guard rejects setups whose baseline gross (+0.0676) was ~5× better
than those it keeps (+0.0142). Tight-stop trades were carrying the edge, and
removing their fee problem removed them too.

The earlier fee-audit conclusion therefore still holds and is now confirmed from
a second direction: V2's gross edge is ~0.03 R per trade, and **no entry or
filter rearrangement tested so far creates edge — they only redistribute who
pays the fee.**

**Honest status.** FULL is "less bad per trade" while being ~6× more selective.
That is cost avoidance, not alpha. Per the pre-registration this is a
`CORRIDOR_ENTRY_REJECTED_ON_TRAIN` candidate, but **no selection decision is
made in this task** — that is the next step, to be committed before any
VALIDATION run.

**No candidate selected. VALIDATION not run. TEST untouched.**

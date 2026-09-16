# V2.5 DYNAMIC TRAILING STOP + BREAKEVEN — TRAIN RESULTS

## Status: criterion **PASSED** → `V2_5_PROMISING_PENDING_VALIDATION`

**But V2.5 is still net-negative after fees.** The criterion was "beat baseline
A", not "be profitable", and V2.5 clears the first while failing the second.

TRAIN only. VALIDATION and TEST untouched. No rule changed after seeing results.

| pinned | value |
|---|---|
| frozen V2 strategy | `4839074` — **`src/` byte-identical, including `outcome/tracker.ts`** |
| pre-registration | `aad5be5` |
| dataset | `c3c1dce` |
| scope | 15m/30m/1h/4h · 6 symbols · 24 series · TRAIN |

---

## 1. The pre-registered criterion

**Rule:** V2.5 net expectancy per trade > baseline A, headline 2 bps maker /
5 bps taker.

| arm | net per trade (2/5) |
|---|---|
| A (frozen exits) | −0.1257 |
| **V2.5 (trailing)** | **−0.0786** |

# ==> PASS (+0.0471 R improvement)

**Same-entry invariant (anti-bias check 1): OK.** A resolved 30,888 entries,
V2.5 resolved 30,867 — the 21-trade gap is exactly the count of V2.5 trades
still unresolved at the dataset boundary, so no entry-set divergence occurred.

## 2. The headline numbers

| metric | A | V2.5 |
|---|---|---|
| closed trades | 30,888 | 30,867 |
| **gross expectancy / trade** | **−0.0015** | **+0.0457** |
| gross median R | −1.0000 | −0.0486 |
| gross PF | 0.9978 | **1.1150** |
| **win rate** | 28.11 % | **47.88 %** |
| avg win | +2.3634 R | +0.9261 R |
| avg loss | −0.9261 R | −0.7630 R |
| payoff ratio | **2.5521** | 1.2138 |
| **max drawdown** | **−505.82 R** | **−79.26 R** |
| median bars held | 12 | 6 |

This is a textbook trailing-stop profile: **win rate up 20 points** (28 % → 48 %),
**average win cut by 61 %** (2.36 → 0.93 R), average loss reduced 18 %, and
**drawdown cut 6.4×**. The mechanism does exactly what trailing stops do — many
small wins instead of few large ones — and on this data the trade is favourable.

Exit mix: A = SL 19,913 / TIMEOUT 6,629 / TP 4,346. V2.5 = TRAIL 10,854 /
SL 10,736 / TIMEOUT 9,277.

## 3. Net by fee environment (per trade)

| env | A | V2.5 |
|---|---|---|
| GROSS | −0.0015 | **+0.0457** |
| **2/5 headline** | −0.1257 | **−0.0786** |
| 5/5 stress | −0.1790 | −0.1319 |

Mean fee drag is **0.1243 R/trade** in both arms — V2.5's gross gain of
+0.0472 R is not enough to cover it. **Gross positive, net negative.**

## 4. Consistency — V2.5 improves every single cell

**Direction**

| leg | A | V2.5 | delta |
|---|---|---|---|
| LONG | −0.0256 (10,316) | +0.0200 (10,299) | **+0.0456** |
| SHORT | +0.0106 (20,572) | +0.0586 (20,568) | **+0.0480** |

**Timeframe**

| TF | A | V2.5 | delta |
|---|---|---|---|
| 15m | −0.0045 (17,016) | +0.0438 (17,007) | +0.0483 |
| 30m | −0.0084 (8,503) | +0.0401 (8,493) | +0.0485 |
| 1h | +0.0051 (4,344) | +0.0530 (4,343) | +0.0479 |
| 4h | +0.0782 (1,025) | +0.0932 (1,024) | +0.0150 |

**Symbol** — all six improve, all n > 5,000:

| symbol | A | V2.5 | delta |
|---|---|---|---|
| XRPUSDT | −0.0654 | +0.0249 | **+0.0903** |
| BTCUSDT | +0.0078 | +0.0566 | +0.0488 |
| ETHUSDT | +0.0308 | +0.0768 | +0.0460 |
| SOLUSDT | +0.0076 | +0.0454 | +0.0378 |
| DOGEUSDT | +0.0065 | +0.0370 | +0.0305 |
| BNBUSDT | +0.0030 | +0.0323 | +0.0293 |

**Every cell improves, with n in the thousands.** This is far more robust than
anything V2.1–V2.4 produced, where gains concentrated in thin subgroups. It is
also the first result not derived from a TRAIN observation — the trailing
mechanic was specified from first principles, so the circularity that sank V2.4
does not apply here.

## 5. Where it still fails

**Outlier sensitivity — V2.5's gross edge does not survive the tail:**

| arm | gross | ex-top-1 | ex-top-5 | **ex-top-1 %** |
|---|---|---|---|---|
| A | −0.0015 | −0.0023 | −0.0045 | −0.0932 |
| V2.5 | **+0.0457** | +0.0449 | +0.0425 | **−0.0189** |

Removing 309 of 30,867 trades flips V2.5 gross negative. The edge is real but
thin and tail-dependent — though notably **less** tail-dependent than A, which
falls to −0.0932 on the same test.

**The H1 ceiling held, as predicted.** The pre-registration forecast that trades
never reaching +1R are untouchable. Measured: **63.61 %** of V2.5 trades never
reached +1R (A: 54.47 %). Roughly two thirds of the book is beyond the
mechanism's reach, which caps how much any exit rule can deliver — exactly the
structural limit H1 identified.

**Slot-sequencing caveat, as registered.** V2.5's 10-bar timeout would free the
position slot sooner than A's 48-bar timeout, so a live single-slot V2.5 engine
would take a *different* entry set. This study deliberately holds the entry set
fixed (governed by the frozen tracker) to isolate the exit rule. The +0.0471
improvement is therefore the **exit-only** effect, not a full-engine forecast.

## 6. Protocol compliance

- **`src/outcome/tracker.ts` is byte-identical to `4839074`.** The task asked to
  modify it; the pre-registration (`aad5be5`) recorded in advance why that was
  refused and put the simulator in research code instead. Baseline A calls the
  unmodified frozen tracker, so the comparison is honest.
- Criterion fixed before the run and not relaxed.
- Gates: typecheck ✅ · **1074 tests** ✅ · build ✅ · `git diff 4839074 -- src/`
  empty · `v2.enabled=false` · `LIVE_TRADING_ENABLED=false`.

## 7. Verdict

# `V2_5_PROMISING_PENDING_VALIDATION`

V2.5 is the **first V2.x variant to beat the baseline on a pre-registered
criterion with broad, high-n consistency** — every direction, timeframe and
symbol improved, on thousands of trades per cell, from a mechanic that was not
fitted to TRAIN.

It is **not** a working strategy:

- net **−0.0786 R/trade** after realistic fees — an improvement on −0.1257, but
  still losing;
- gross edge **+0.0457** does not survive removing the top 1 % (−0.0189);
- **63.61 %** of trades never reach +1R and are untouched by the mechanism;
- the exit-only framing means a live V2.5 engine would trade a different set.

**Honest reading:** trailing stops are a genuine improvement to exit management —
worth a VALIDATION run precisely because the gain is broad rather than
concentrated — but they do not close the fee gap. The project-level finding
stands: V2's gross edge is ~0.03–0.05 R/trade, and fees at ~0.12 R/trade exceed
it. No exit rule can fix an entry edge that small.

**TEST untouched. `v2.enabled=false`, `LIVE_TRADING_ENABLED=false`.
`PRODUCTION_READY` forbidden.**

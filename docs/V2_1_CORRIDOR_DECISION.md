# V2.1 CONFIRMED EXTREME CORRIDOR — TRAIN DECISION

## Status: `CORRIDOR_ENTRY_REJECTED_ON_TRAIN`

Recorded per §10 of `docs/V2_1_CONFIRMED_EXTREME_CORRIDOR_PREREGISTRATION.md`
(commit `5ce3761`). **VALIDATION is NOT run and is NOT burned.** TEST untouched.

### Decision

No variant is carried forward. The pre-registration required a candidate to be
chosen on *expectancy per original actionable setup*, and on that primary metric
**no filtered arm beats the unfiltered baseline**:

| arm | gross expectancy / actionable setup |
|---|---|
| **A (baseline)** | **+0.0090** |
| E (extreme) | +0.0059 |
| C (confluence) | +0.0011 |
| FULL | **+0.0001** |
| F (fee guard) | −0.0003 |
| EF | −0.0002 |
| EFC | +0.0000 |

### Why rejected

1. **The Fee Drag Guard removes the edge along with the fee.** Baseline gross of
   setups it *rejects* is **+0.0676** (n=107,742) versus **+0.0142** (n=19,253)
   for those it *admits* — the rejected population was ~5× better. It filters
   tight stops, not bad trades, and tight-stop trades were carrying the edge.
2. **Cost avoidance is not alpha.** FULL's net loss per filled trade improves
   6.2× (−0.7289 → −0.1167) but its gross edge per setup is +0.0001, which is
   indistinguishable from zero. It is "less bad" mainly by trading 1.69 % of
   setups instead of 25.87 %.
3. **The reversal path is effectively dead** — 445 closed trades of 56,486
   (0.8 %).
4. **A premise was contradicted**: EQH/EQL is the *worst* pool kind (−0.0035)
   while CLUSTER is the best (+0.0218).

### What is worth keeping

The corridor solved the defect that killed limit models B/C/D: median fill
latency 1 bar and only **277** MISSED setups (versus 220k–369k). Centring on
`close(N)` instead of waiting for a retracement does avoid forfeiting winners.
That mechanism is sound; it simply has no edge to preserve.

Its true fill rate of published corridors is **24.09 %**, not the 97.79 %
conditional figure — 176,707 of 234,478 corridors (75.36 %) were rejected at
fill on `rr1 < risk.min_rr`.

### Rules unchanged

No threshold, corridor width, expiry, fee floor, confluence rule or fill policy
was altered after seeing results. `v2.enabled=false`,
`LIVE_TRADING_ENABLED=false`, frozen strategy `4839074` untouched.

# V2.1 — LIMIT / CORRIDOR ENTRY

**Status: ❌ `CORRIDOR_ENTRY_REJECTED_ON_TRAIN`** · never validated
· docs: `V2_1_LIMIT_ENTRY_TRAIN_RESULTS.md`, `V2_1_CORRIDOR_DECISION.md`
· code: `scripts/real-data/limit-entry-replay.ts`, `scripts/real-data/corridor-replay.ts`

## What it does

Two attempts to replace the frozen market-at-OPEN-N+1 entry with a **resting
limit order**, on the theory that a better fill price improves expectancy.

- **V2.1a limit entry** — order rests at a structural level (retest / FVG / OB∩FVG),
  waiting for price to retrace to it.
- **V2.1b corridor entry** — order rests in a narrow band centred on `close(N)`,
  which does **not** wait for a retracement.

## Entry logic

**Corridor (V2.1b):**
```
centre    = close(N)
halfWidth = clamp(0.10 × ATR, 1 tick, 0.15% × close(N))
zone      = [centre − halfWidth, centre + halfWidth]   (tick-quantized)
```
Fills from N+1 onward at the **worse edge** of the zone (never the midpoint).
Expiry 3 bars. `MISSED` if TP1 is reached first; `CANCELLED` if the stop breaks
first or if one bar does both (ambiguous → unfavourable reading).

**Limit (V2.1a):** identical skeleton, but the zone sits at the anchor
(`breakout.level ± 0.25 ATR`, FVG bounds, or OB∩FVG), with a 12-bar expiry.

## Exit logic

Frozen SMC target ladder — nearest opposing liquidity → equilibrium → range edge,
with the frozen structural stop and 48-bar timeout. **Only the final rung closes
the position.**

## Stop loss

Structural, behind the sweep wick / broken level + **0.25 ATR** buffer
(`v2.stop_buffer_atr`).

## Additional gates (corridor variant)

- **Fee Drag Guard** — reject unless `stop ≥ 0.35 % of price` **AND** `≥ 0.5 ATR`.
  The stop is **never widened** to pass; failing setups are skipped.
- **Confluence ≥ 3 of 4** — RVOL > 1.2 · RSI divergence-or-zone (≤45 long / ≥55
  short) · MACD cross or histogram inflection · EMA alignment.

## Key parameters

| Parameter | Value | Type | Range | Controls | Impact if changed |
|---|---|---|---|---|---|
| `CORRIDOR_ATR_FRAC` | 0.10 | number | 0.01–1 | Zone half-width in ATR | ↑ wider zone, more fills, worse average price |
| `CORRIDOR_MAX_PCT` | 0.0015 | number | 0.0001–0.01 | Hard cap on half-width (0.15 % of price) | Prevents absurd zones in volatility spikes |
| `EXPIRY_BARS` | 3 | integer | 1–50 | Bars before an unfilled order expires | ↑ more fills, staler confirmation |
| `FEE_GUARD_PCT` | 0.0035 | number | 0–0.02 | Min stop distance as % of price | ↑ rejects far more setups |
| `FEE_GUARD_ATR` | 0.50 | number | 0–3 | Min stop distance in ATR | Second floor, volatility-relative |
| `CONFLUENCE_MIN` | 3 | integer | 0–4 | Votes required of 4 | ↑ 4 is far too rare; ↓ 2 barely filters |
| `RVOL_MIN` | 1.2 | number | 0.5–5 | Volume vote threshold | — |
| `RSI_LONG_MAX` / `RSI_SHORT_MIN` | 45 / 55 | number | 0–100 | RSI zone bounds | — |
| tick sizes | BTC/ETH/BNB/SOL 0.01, XRP 0.0001, DOGE 0.00001 | number | — | Price quantization | Measured empirically from klines |

## Results — why it was rejected

| Model | Fill rate | Gross R/trade | Net @0.1 % |
|---|---|---|---|
| A (baseline) | 100 % | +0.0350 | −0.7289 |
| B (retest) | 12.98 % | +3.5281 | **−5.3159** |
| C (FVG) | 25.49 % | +0.6941 | −3.5594 |
| D (OB∩FVG) | 21.39 % | +0.4325 | −0.9386 |
| Corridor FULL | **24.09 %** | +0.0076 | — |

Three independent failures:

1. **Limit fills sit closer to the stop**, shrinking `R`. Since
   `feeR = fee% × price / stopDistance`, model B's median stop fell to **0.0657 %**
   of price, making fees ~1.5 R per trade. Its huge gross is a shrunken-denominator
   artifact.
2. **Waiting forfeits the winners.** Missed setups had a baseline mean of
   **+0.78 R** — price ran to target without retracing.
3. **The Fee Drag Guard removed the edge with the cost.** Setups it rejected had
   baseline gross **+0.0676** vs **+0.0142** for those it admitted — it filtered
   tight stops, and tight-stop trades carried the edge.

The corridor fixed defect 2 (only 277 missed, 1-bar median latency) but not the
economics: gross per actionable setup **+0.0001**.

## When to use

**Never.** Superseded by V2.8. The corridor mechanic itself is sound and could be
revisited, but it adds nothing on top of the sniper entry filter.

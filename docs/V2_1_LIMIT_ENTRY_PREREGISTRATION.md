# STRUCTURAL LIMIT ENTRY — PRE-REGISTRATION OF CANDIDATE MODELS

**Written and committed BEFORE any comparative TRAIN performance was computed.**

Only the *structural audit* (anchor availability, side-of-price validity,
distances) was visible when this was written. No expectancy, PF, or fill-quality
number for any candidate existed yet. Nothing here may be revised after seeing
comparative results.

Frozen V2 (`4839074`) is not modified. The research replay lives in a separate
path and the baseline remains byte-identical.

---

## Baseline

**A — FROZEN OPEN N+1.** Exactly the current engine: setup confirmed on CLOSED
N, market fill at the OPEN of N+1. Reproduced by the existing harness and
validated against stored `rMultiple`.

---

## Candidate models (maximum three, fixed now)

All three share this skeleton and differ **only** in the anchor and zone
construction:

- **Anchor** must be causally known at CLOSED N (verified in code: OB
  `knownAtIndex = displacement.index`; FVG `knownAtIndex = index + 1`; sweep and
  breakout levels are the same ones the frozen engine already uses for the SL).
- **Side-of-price rule.** LONG requires the whole entry zone to sit *below* the
  baseline N+1 fill; SHORT requires it *above*. If the anchor is on the wrong
  side, **no pending order is created** — the setup is skipped entirely. It is
  never converted into a market order.
- **Zone width.** `halfWidth = clamp(0.05 * ATR, 1 tick, structuralArea/2)`,
  then both boundaries rounded to the symbol's `tickSize`. The ATR term governs
  sizing; the tick term only prevents a sub-tick zone. The zone is always
  clipped so `entryZone ⊆ structuralArea`. Width is **not** swept or tuned.
- **Expiry.** 12 bars after N. If unfilled by then → `EXPIRED`.
- **Invalidation.** If the structural SL level is breached before fill →
  `CANCELLED`.
- **Fill rule (conservative).** A fill is recorded only when the candle trades
  *through* the zone, and the fill price is the **far (worse) edge** of the
  zone, never the midpoint and never the touched edge:
  - LONG fills at `entryZone.low` when `candle.low <= entryZone.low`.
  - SHORT fills at `entryZone.high` when `candle.high >= entryZone.high`.
  A mere touch of the near edge does **not** fill. This deliberately
  under-states limit-entry quality rather than flattering it.
- **MISSED rule.** If price reaches the frozen TP1 before filling → `MISSED`.
  The setup is abandoned; the move is **not** chased.
- **Ambiguity.** If one candle both fills the zone and breaches the SL, intrabar
  order is unknown → resolved as `CANCELLED` (the unfavourable reading),
  consistent with the frozen `outcome.sl_priority_on_ambiguous_bar = true`.
  If one candle both fills and reaches TP1 → resolved as `FILLED` then the
  trade is tracked normally, because price must traverse the nearer zone first.
- **Post-fill.** SL stays structural (unchanged level from the frozen engine).
  Risk, ATR-risk, %-risk and every target R are **recomputed** from the actual
  fill. If the recomputed geometry is invalid — stop on the wrong side, no
  target ahead, or `rr1 < risk.min_rr` — the trade is **not taken**.
- **Exit model.** CURRENT (final rung only). No partial, no breakeven, no
  trailing, no ladder change. H1 was tested separately; this isolates ENTRY.
- **One position at a time** is preserved, which is exactly why a real replay is
  required rather than post-hoc re-accounting.

### B — RETEST (broken level)
Anchor: `breakout.level`, the level the frozen engine already uses for the
CONTINUATION stop. Structural area = `level ± 0.25 ATR`. Entry zone built at the
**proximal edge** of that band (the side price must retrace toward).
Rationale: acceptance-retest is the canonical continuation entry, and this
anchor has the widest availability.

### C — FVG (fair value gap)
Anchor: the fresh FVG (`state !== 'FILLED'`, direction matching). Structural
area = `[fvg.bottom, fvg.top]`. Entry zone at the **proximal edge**.
Rationale: an unfilled imbalance is the most common causal retracement
destination in SMC, and the audit shows it is usually on the correct side.

### D — OB ∩ FVG OVERLAP, falling back to fresh OB
Anchor: intersection of order block and FVG when it exists; otherwise the fresh
OB alone. Structural area = the overlap (or OB) bounds. Entry zone at the
**midpoint**, because the overlap is already narrow.
Rationale: highest-confluence area; the fallback is declared **now** so the
model is defined for setups without an overlap.

---

## Metrics fixed in advance

Per model: directional setups, PENDING, FILLED, fill rate, MISSED, EXPIRED,
CANCELLED, closed trades, **gross expectancy per FILLED trade**, **gross
expectancy per ORIGINAL actionable setup** (the honest denominator — it charges
a model for the setups it declines), gross PF, median R, positiveRRate, TP/SL/
TIMEOUT rates, max drawdown R, median stop % and stop ATR.

Costs: GROSS primary; analytic sensitivity at 2/5/10/20 bps round-trip. **No
maker discount is assumed** — limit orders are charged the same as market.

Mandatory anti-bias checks, registered now:
1. **MISSED analysis.** For every missed setup, the baseline OPEN N+1 outcome is
   reported, so a model cannot look good merely by declining hard trades.
2. **Selection-bias check.** Baseline outcomes are compared for setups the model
   FILLED vs did NOT fill, to expose whether retracement mechanically selects a
   special class of trade.

## Selection protocol

After TRAIN, at most **one** candidate is selected — on expectancy per original
setup, fill rate, cost geometry, drawdown, outlier dependence, structural
rationale and execution simplicity, **not** on highest expectancy alone. The
choice and its reason are written down **before** VALIDATION is computed. If no
model shows a convincing advantage → `LIMIT_ENTRY_REJECTED_ON_TRAIN`.

VALIDATION is run once; afterwards no anchor, width, expiry, fill policy or
invalidation rule may change. TEST (2022–2025) is USED and excluded. The 2026
window is not downloaded.

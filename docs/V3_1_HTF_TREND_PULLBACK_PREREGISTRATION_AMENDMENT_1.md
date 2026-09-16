# V3.1 — PRE-REGISTRATION AMENDMENT 1
# V3.1 — ПОПРАВКА 1 К ПРЕДРЕГИСТРАЦИИ

**Status / Статус: `V3_1_PRE_REGISTERED_A1`** — written **before** the reported
TRAIN run. It does not change a single constant, gate, exit rule or falsification
criterion of the original document; it fixes the **temporal window** of the
pullback condition, which the original text left implicit, and it discloses the
pre-amendment check that exposed the ambiguity.

**Статус: `V3_1_PRE_REGISTERED_A1`** — написано **до** отчётного прогона TRAIN.
Ни одна константа, ни одно правило входа/выхода и ни один критерий
фальсификации исходного документа не меняются; уточняется **временнóе окно**
условия отката, которое исходный текст оставлял неопределённым, и раскрывается
проверка, выявившая эту неопределённость.

---

## 1. What was ambiguous / Что было неоднозначно

The original §2.2 defines the pullback as a market **state**:

> "Price pulls back below 50 % Equilibrium of the current active 4H impulse leg
> (or touches fresh 4H FVG)."

while §2.3 defines bar **N** as the resumption trigger. The original §2.3(4)
resolved the ambiguity in the strictest possible way — "pullback condition
satisfied on the same bar N" — which is a **stronger** rule than the text
supports: it requires one candle that simultaneously (a) wicks into the value
zone, (b) closes with bodyRatio ≥ 0.35 and RVOL > 1.25 in the trend direction and
(c) breaks the previous 1H swing. Those are close to mutually exclusive: a bar
that closes strongly upward rarely still prints a new low below equilibrium.

**Disclosure.** Before writing this amendment a single-symbol smoke run of the
strict reading was executed as a bug-check (`BTCUSDT`, TRAIN, ~1 s):
`n = 13`, signals `14`, net `−0.1289 R`, TP1 hit `30.77 %`, F1 FAIL, F3
falsified. That run is reported for completeness and is **not** evidence for
anything: `n = 13` on one symbol is far below any usable threshold, and it is the
number that made the ambiguity visible.

## 2. The amendment / Поправка

The pullback condition is evaluated over the **current pullback leg**, anchored at
the same swing the resumption break uses:

- **Anchor.** For a LONG, the most recent confirmed 1H swing HIGH strictly before
  bar N — the same object `detectStructureBreak` reports as `levelIndex` and the
  same object the stop anchors on. Mirror for SHORT.
- **Window.** Bars `(anchor, N]` inclusive.
- **Condition.** At least one bar in the window traded into the leg's 50 %
  equilibrium (`low <= eq` for LONG, `high >= eq` for SHORT) or intersected a
  **fresh** 4H FVG in the trend direction, where freshness is judged as of that
  bar's own close time.

Two variants are therefore defined and **both are reported in full**:

| variant | pullback condition | status |
|---|---|---|
| **`leg`** | touch anywhere in `(anchor, N]` | **PRIMARY** (this amendment) |
| `same-bar` | touch on bar N itself (original §2.3(4)) | **SECONDARY**, reported for the record |

The primary variant is the one this amendment names, and it is named **before**
the six-symbol run. Everything else is unchanged: §2.1 trend gate, §2.2 zones and
the "leg not invalidated by the close" rule, §2.3 conditions 1–3, §2.4 execution
(corridor 0.10 ATR, fill from N+1 at the worse edge, 3-bar expiry, ambiguity rule,
geometry gate, 2/5 bps per leg), §2.5 exits (1H pullback extreme ∓ 0.15 ATR,
TP1 = the leg's terminal extreme, breakeven after TP1, TP2 = 1.5 Fibonacci
extension, 60-bar timeout), §2.6 intrabar rules R1–R5, §4 criteria F1/F2/F3,
§1 data scope and guards.

No constant is swept, no threshold is moved, and no result observed before this
amendment is used to choose anything.

## 3. Reporting consequence / Следствие для отчёта

The final report presents both variants side by side (n, TP1/TP2 hit rates, stop
distance, fee drag, gross/net R, PF, MaxDD, funnel, symbol/direction splits,
outlier dependence) against the V3.0 baseline, and evaluates F1/F2/F3 for the
**primary** variant while showing the secondary variant's values for the same
criteria. If the two variants disagree in sign, that disagreement is the finding
and will be stated as such — a rule that flips on a temporal-window definition is
not a robust edge.

Artifacts:
`artifacts/research/v31/v31-train-metrics.json` (primary, `--pullback=leg`) and
`artifacts/research/v31/v31-train-metrics-samebar.json` (secondary).

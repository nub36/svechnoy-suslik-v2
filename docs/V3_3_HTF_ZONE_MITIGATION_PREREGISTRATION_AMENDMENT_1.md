# V3.3 — PRE-REGISTRATION AMENDMENT 1
# V3.3 — ПОПРАВКА 1 К ПРЕДРЕГИСТРАЦИИ

**Status / Статус: `V3_3_PRE_REGISTERED_A1`** — written **before** the reported
TRAIN run. It changes **no** registered rule: §2.1 zones, §2.2 mitigation,
§2.3 trigger, §2.4 execution, §2.5 exits, §2.6 intrabar rules and §4 criteria
stand exactly as written. It (a) registers three decisions the original text left
open, (b) adds one sensitivity axis for the most consequential open ambiguity,
and (c) discloses the pre-amendment bug-check run.

**Статус: `V3_3_PRE_REGISTERED_A1`** — написано **до** отчётного прогона TRAIN.
Оно не меняет ни одного зарегистрированного правила: §2.1 зоны, §2.2 митигация,
§2.3 триггер, §2.4 исполнение, §2.5 выходы, §2.6 внутрибарные правила и §4
критерии остаются ровно такими, как написано. Оно (а) регистрирует три решения,
которые исходный текст оставлял открытыми, (б) добавляет одну ось
чувствительности для самой значимой открытой неоднозначности и (в) раскрывает
проверочный прогон, выполненный до поправки.

---

## 1. Disclosure: the pre-amendment bug-check run / Раскрытие: проверочный прогон

Before this amendment a single-symbol smoke run (`BTCUSDT`, TRAIN, `--
window=while --stop=protective`, ~1 s) was executed **purely as a bug check** —
to verify that the pipeline runs, that zones are produced and that the trade
manager resolves. It is reported here for completeness and **is not evidence**:
one symbol is not a sample, and no rule was changed in response to it. Its
numbers, verbatim: zones 1,688 / mitigated 1,347 / triggers in zone 2,698 /
filled 1,135 / rejected by geometry 1,417; net +0.0429 R/trade, fee drag 0.0644 R,
TP1 hit 65.90 %.

Two facts it exposed are the reason for §2 and §3 below: **multiple zones
qualified on the same bar 1,508 times out of 2,698 trigger bars**, and **1,368
triggers had TP1 at or behind the trigger close** under the original leg reading.

## 2. Registered decisions (no rule changed) / Зарегистрированные решения

1. **Tie-break when several zones qualify on one bar.** The pre-registration did
   not say which zone is taken when bar N sits inside two or more live zones and
   the exhaustion signature is satisfied. Registered now, and it **matters** —
   the bug-check fired it on more than half of the trigger bars:
   the **most recently created zone wins** (`knownAt4h` descending); if two zones
   share the revealing 4H bar, the **order block precedes the FVG** from the same
   displacement. Both are deterministic and are recorded in the artifact
   (`funnel.multiZoneBars` counts how often more than one zone qualified).
   Rationale: the freshest structure is the one the current displacement left
   behind, and the OB is its origin.
2. **Warm-up.** Zones revealed before bar `WARMUP_BARS = 60` cannot produce a
   trigger: the evaluation loop starts at bar 60 and only windows starting at or
   after it are ever active. The number of such windows is now recorded in the
   funnel (`zonesSkippedByWarmup`), so the exclusion is visible instead of
   silent. (In TRAIN this is a sliver of the first ~2.5 days, because the 4H ATR
   is `null` for the first 13 4H bars and `detectDisplacement` returns `null`
   there.)
3. **A null TP2 level skips the setup, silently and before counting.** The
   opposing confirmed 4H swing does not exist in the first days of the series;
   such bars produce no signal and are not counted as triggers.
   `funnel.triggersInZone` therefore means "trigger bars with a live, intersected
   zone and a full exhaustion signature".

## 3. Added sensitivity axis: the leg that defined TP1 / Ось чувствительности: нога для TP1

The pre-registration defines TP1 as *"the 50 % equilibrium of the 4H leg that
created the zone"* and measures that leg as `[originIndex, displacementIndex]`
for an OB and `[i−1, i+1]` for an FVG. The bug-check showed what that costs:
**1,368 of 2,698 triggers had TP1 at or behind the trigger close**, because an
order block's full-candle range can extend past the midpoint of the displacement
that created it. The phrase is genuinely ambiguous, so both readings ship and the
primary is named **now**, before the six-symbol run:

| `--leg` | definition | status |
|---|---|---|
| `displacement` | the move that created the zone: 4H `[originIndex, displacementIndex]` for an OB, `[i−1, i+1]` for an FVG; TP1 = its midpoint | **PRIMARY** (the request says "the leg that **created** the zone", and §2.1 defines zones as displacement-created) |
| `swing` | the confirmed 4H **swing-to-swing impulse leg in progress when the zone was revealed**: the last two confirmed 4H swings as of the zone's revealing bar, required to be ordered LOW→HIGH (bullish) or HIGH→LOW (bearish), frozen at creation; TP1 = its midpoint. This is the same definition V3.1 used for "the active 4H impulse leg". A zone whose two most recent swings are not ordered that way has **no** swing leg and produces no signal under this variant (`skippedNoSwingLeg` in the funnel). | sensitivity |

Both readings are causal: the displacement leg uses only bars up to the
displacement that created the zone, and the swing leg uses only swings confirmed
by the zone's revealing bar.

**Total grid:** 2 trigger windows × 2 stop definitions × 2 leg definitions =
**8 pre-registered runs**, of which
`while + protective + displacement` is **the** primary whose verdict is the
verdict. The other seven are ever reported as sensitivities and are **never
promoted** after the fact: with eight runs and three criteria, a single passing
cell is expected by chance, and choosing it would be exactly the selection this
programme forbids. Anything built on a non-primary cell would need its own
pre-registration.

## 4. Reporting consequence / Следствие для отчёта

The final report shows all eight runs (n, TP1/TP2 hit %, stop distance, fee drag,
gross/net R, PF, MaxDD, funnel, splits, outlier dependence) against V3.0 and
V3.2, evaluates F1/F2/F3 for **every** run for completeness, and states the
verdict from the primary alone. If the eight cells disagree in sign, that
disagreement is itself the finding and will be reported as such — a rule that
flips on a leg definition is not a robust edge.

Artifacts: `artifacts/research/v33/v33-train-metrics-<window>-<stop>-<leg>.json`
(the primary is `v33-train-metrics-while-protective-displacement.json`).

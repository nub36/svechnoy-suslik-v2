# V3.3 — HTF ZONE MITIGATION & LTF SQUEEZE — TRAIN RESULTS
# V3.3 — МИТИГАЦИЯ ЗОНЫ НА СТАРШЕМ ТАЙМФРЕЙМЕ — РЕЗУЛЬТАТЫ TRAIN

**Status / Статус: `V3_3_TRAIN_ONLY`** — the **pre-registered primary variant
passes all three registered criteria** on TRAIN: net **+0.0267 R/trade**
@2/5 bps, n = 6,957, TP1 hit **65.24 %**, fee drag **0.0511 R**. It is the first
hypothesis since V3.0 to clear F1 on its primary. **It is not validated and must
not be ported or forward-tested without an operator decision**: its edge lives in
the top 1 % of trades (excluding them turns the net negative), the strictest
reading of the same entry rule fails outright, and TRAIN is burned data.

**Статус: `V3_3_TRAIN_ONLY`** — **предрегистрированный основной вариант проходит
все три зарегистрированных критерия** на TRAIN: net **+0.0267 R/сделку** @2/5 bps,
n = 6 957, TP1 достигается в **65.24 %**, комиссия **0.0511 R**. Это первая
гипотеза после V3.0, прошедшая F1 в основном варианте. **Она не валидирована, и
её нельзя переносить в движок или отправлять на форвард-тест без решения
оператора**: преимущество живёт в лучшем 1 % сделок (без них результат
отрицательный), самое строгое прочтение того же правила входа проваливается, а
TRAIN — израсходованные данные.

| pinned / зафиксировано | value / значение |
|---|---|
| pre-registration / предрегистрация | `16728ef` — `docs/V3_3_HTF_ZONE_MITIGATION_PREREGISTRATION.md` |
| amendment 1 / поправка 1 | `01cbc28` — `docs/V3_3_HTF_ZONE_MITIGATION_PREREGISTRATION_AMENDMENT_1.md` |
| implementation / реализация | `research/v33_zone_mitigation.ts` (sha256 `3f5b1478a1b0c240a85b28a0280d61761246091ca0ed122fab2e03113fe2b1c6`) |
| artifacts / артефакты | `artifacts/research/v33/v33-train-metrics-<window>-<stop>-<leg>.json` (8 runs, primary = `while-protective-displacement`) |
| tests / тесты | `tests/v33-zone-mitigation.test.ts` (35 tests, incl. the module hash and every artifact figure) |
| slice / срез | TRAIN only — 1H `2022-01-01T00:00:00Z` … `2024-05-26T13:00:00Z`, 6 symbols, 4H context truncated at the same instant |
| engine surface / поверхность движка | unchanged / не изменялась (`srcModified: false`) |
| baselines / базы сравнения | V3.0 TRAIN net **+0.0994** (n = 1,585) · V3.1 TRAIN net −0.1097 (n = 158) · V3.2 TRAIN net −0.0620 (n = 307) |

---

## 1. Headline / Головные цифры

Primary variant (`while` trigger window + `protective` stop + `displacement` leg),
TRAIN, 6 symbols:

| metric / метрика | V3.3 (primary) | V3.0 (TRAIN) | V3.2 (TRAIN) |
|---|---|---|---|
| trades / сделок (n) | **6,957** | 1,585 | 307 |
| TP1 hit % | **65.24** | 48.26 | 60.59 |
| TP2 hit % | **12.43** | 17.35 | 15.64 |
| positive-R % | **66.16** | 50.73 | 60.91 |
| natural stop distance, % of price (p25 / median / p75) | **1.091 / 1.695 / 2.637** | 0.785 / 1.252 / 1.987 | 0.989 / 1.585 / 2.452 |
| fee drag, R @2/5 bps | **0.0511** | 0.0732 | 0.0538 |
| gross R/trade | **+0.0778** | +0.1726 | −0.0082 |
| **net R/trade @2/5 bps** | **+0.0267** | **+0.0994** | −0.0620 |
| profit factor | **1.2341** | 1.3538 | 0.9791 |
| max drawdown, R | **−43.67** | −37.18 | −19.97 |
| average win / average loss, R | **+0.6200 / −0.9823** | +1.3022 / −0.9901 | +0.6283 / −1.0000 |
| median bars held | **6** | 7 | 5 |
| median TP1 / TP2 distance, R | **0.5824 / 2.9164** | n/a | 0.7058 / 2.3689 |

Criteria, evaluated once, as registered:

| criterion / критерий | rule | V3.3 primary | verdict |
|---|---|---|---|
| **F1** primary | net R/trade > 0 @2/5 | **+0.0267** | **PASS** |
| **F2** cost | fee drag < 0.10 R | **0.0511** | holds |
| **F3** premise | TP1 hit ≥ 50 % | **65.24 %** | holds |

### All eight pre-registered runs / Все восемь предрегистрированных прогонов

| window | stop | leg | n | TP1 % | TP2 % | stop % (med) | fee R | gross R | net R @2/5 | PF | MaxDD | F1 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **while** | **protective** | **displacement** | **6,957** | 65.24 | 12.43 | 1.695 | 0.0511 | **+0.0778** | **+0.0267** | 1.2341 | −43.67 | ✅ |
| while | protective | swing | 2,087 | 56.54 | 16.53 | 2.071 | 0.0435 | +0.0668 | +0.0233 | 1.1844 | −36.86 | ✅ |
| while | climax | displacement | 6,263 | 60.96 | 12.09 | 1.051 | 0.0816 | +0.1874 | +0.1058 | 1.4902 | −22.48 | ✅ |
| while | climax | swing | 1,856 | 49.78 | 13.74 | 1.047 | 0.0834 | +0.1755 | +0.0920 | 1.3689 | −26.25 | ✅ |
| first | protective | displacement | 600 | 69.67 | 11.83 | 2.077 | 0.0419 | +0.0166 | **−0.0253** | 1.0586 | −15.27 | ❌ |
| first | protective | swing | 111 | 63.96 | 16.22 | 2.257 | 0.0391 | +0.0047 | **−0.0343** | 1.0142 | −9.68 | ❌ |
| first | climax | displacement | 542 | 66.97 | 11.62 | 1.276 | 0.0653 | +0.1265 | +0.0612 | 1.4018 | −13.92 | ✅ |
| first | climax | swing | 97 ⚠️ | 58.76 | 15.46 | 1.157 | 0.0756 | +0.2212 | +0.1456 | 1.5646 | −8.28 | ✅ |

⚠️ `first-climax-swing` is **underpowered** (n = 97). Six of the eight cells pass
F1; the two that fail are exactly the two `first` + `protective` combinations.
F2 holds in all eight (0.0391 – 0.0834 R). **Only the primary's verdict is the
verdict** (Amendment 1 §3) — the other cells are reported, never promoted.

**EN summary.** The confluence hypothesis is the first one in this programme that
works on TRAIN in the form it was registered. Mitigating a fresh, displacement-
created 4H zone and taking a 1H exhaustion trigger there recovers the equilibrium
of the leg that built the zone in **65 %** of trades, and the fee drag (0.0511 R)
is low enough to leave **+0.0267 R/trade** after Binance futures fees. The result
is broad rather than concentrated — **all six symbols are positive gross**
(+0.038 … +0.107) and both directions are positive — but it is **thin and tail-
dependent**: dropping the best 1 % of trades (70 of 6,957) leaves a gross of
+0.0264 R, i.e. *below* the 0.0511 R fee, so the strategy is net-negative without
its tail. And 51 % of triggers (8,140 of 15,957) never fill because the corridor
sits at or beyond TP1.

**RU кратко.** Гипотеза совпадения таймфреймов — первая в программе, которая
работает на TRAIN в том виде, в котором была зарегистрирована. Митигация свежей
4H-зоны, созданной смещением, с триггером истощения на 1H возвращает равновесие
ноги, построившей зону, в **65 %** сделок, а комиссия (0.0511 R) достаточно мала,
чтобы после комиссий Binance Futures осталось **+0.0267 R/сделку**. Результат
широкий, а не сконцентрированный — **все шесть символов положительны по
валовому** (+0.038 … +0.107) и оба направления положительны, — но он **тонкий и
зависит от хвоста**: удаление лучшего 1 % сделок (70 из 6 957) оставляет валовый
результат +0.0264 R, то есть *меньше* комиссии 0.0511 R, и без хвоста стратегия
убыточна. Кроме того, 51 % триггеров (8 140 из 15 957) вообще не исполняются,
потому что коридор стоит на TP1 или за ним.

---

## 2. What the run establishes, and what it does not / Что установлено и что нет

**EN.**

1. **The premise holds.** TP1 — the 50 % equilibrium of the leg that created the
   zone, measured from the *displacement* leg — is reached in 65.24 % of trades,
   well above V3.0's 48.26 %. The confluence of an HTF zone and an LTF exhaustion
   signature is a real entry condition, not noise.
2. **The cost claim holds.** The stop behind the further of the exhaustion wick
   and the zone's invalidation edge is wide (median 1.695 % of price, wider than
   V3.0's 1.252 %), giving 0.0511 R of fee drag — second-lowest recorded, and far
   below the 0.10 R line.
3. **But the first target is close and the losses are full.** Median TP1 sits
   0.5824 R away while a loss costs −0.9823 R on average. Winning 66 % of trades
   at +0.62 R against −0.98 R is what produces the thin +0.0778 R gross.
4. **The tail carries it.** ex-top-1 % gross = **+0.0264 R**, below the 0.0511 R
   fee: without the best 70 trades the strategy loses. ex-top-5 leaves +0.0710 R,
   so the dependence is on the far tail rather than on a handful of prints.
5. **The entry window is the load-bearing choice.** Narrowing "in the zone while
   it is alive" to "the bar that mitigates the zone" (`first`) cuts n from 6,957
   to 600 and **fails F1** (−0.0253) under the protective stop. The rule that was
   registered first — the state reading — is the one that works; that is a
   genuine sensitivity and it is reported, not hidden.
6. **Half the triggers never trade.** 8,140 of 15,957 triggers were rejected by
   the geometry gate: the corridor `close ± 0.10 ATR` sits at or beyond the TP1
   level for them, and under the `protective` stop a further share is rejected
   because the fill is already behind the stop. This is a structural property of
   the rule, not a bug, and it is why n is an order of magnitude below the
   trigger count.
7. **Zone supply is dominated by order blocks.** 10,665 zones (7,425 OB / 3,240
   FVG) produced 8,627 mitigations; the triggers actually taken were 14,512 OB
   vs 1,445 FVG (the tie-break takes the newest zone, and OBs are more numerous
   and wider). The FVG branch is therefore a small part of the result.
8. **The absorption branch mix:** WICK 10,670 · RECLAIM 4,537 · both 750
   trigger-bar evaluations. Under the literal (registered) reading the wick
   branch imposes no close-direction requirement, and 6,000 of 12,127 wick
   triggers closed against the intended fade direction — they were kept, and the
   whole result is reported with them. `WICK+RECLAIM` counts every evaluation
   where both branches fired on the same bar, including bars whose zone was not
   selected.
9. **It is 4.4× the trade count of V3.0** (6,957 vs 1,585) with a 3.6× smaller
   per-trade edge and a larger absolute drawdown (−43.67 R). More exposure, less
   edge per trade — and, per point 4, fragile in the tail.

**RU.**

1. **Посылка подтверждается.** TP1 — 50 % равновесие ноги, создавшей зону, — при
   измерении по ноге *смещения* достигается в 65.24 % сделок, заметно выше
   48.26 % у V3.0. Совпадение HTF-зоны и сигнатуры истощения на LTF — это
   реальное условие входа, а не шум.
2. **Утверждение об издержках подтверждается.** Стоп за дальней из двух структур
   (тень истощения и край инвалидации зоны) широк — медиана 1.695 % цены, шире,
   чем 1.252 % у V3.0, — что даёт комиссию 0.0511 R: второй результат снизу в
   программе и далеко ниже порога 0.10 R.
3. **Но первая цель близка, а убытки полные.** Медианный TP1 стоит в 0.5824 R,
   тогда как убыток стоит в среднем −0.9823 R. Выигрыш в 66 % сделок по +0.62 R
   против −0.98 R и даёт тонкий валовый результат +0.0778 R.
4. **Результат держит хвост.** Валовый без лучшего 1 % = **+0.0264 R**, меньше
   комиссии 0.0511 R: без лучших 70 сделок стратегия убыточна. Без лучших пяти
   остаётся +0.0710 R, то есть зависимость именно от дальнего хвоста, а не от
   нескольких сделок.
5. **Окно входа — несущий выбор.** Сужение «в зоне, пока она жива» до «на баре,
   который митигирует зону» (`first`) срезает n с 6 957 до 600 и **проваливает
   F1** (−0.0253) при защитном стопе. Работает то правило, которое было
   зарегистрировано первым — чтение состояния; это честная чувствительность, и
   она публикуется, а не прячется.
6. **Половина триггеров не торгуется.** 8 140 из 15 957 триггеров отклонены
   геометрическим фильтром: коридор `закрытие ± 0.10 ATR` стоит на уровне TP1
   или за ним, а при защитном стопе часть отклоняется ещё и потому, что цена
   исполнения уже за стопом. Это структурное свойство правила, а не баг, и
   именно поэтому n на порядок меньше числа триггеров.
7. **Предложение зон определяют ордер-блоки.** 10 665 зон (7 425 OB / 3 240 FVG)
   дали 8 627 митигаций; во взятых триггерах 14 512 OB против 1 445 FVG (при
   равенстве выбирается самая свежая зона, а OB многочисленнее и шире). Ветка FVG
   в итоге составляет малую часть результата.
8. **Состав ветвей абсорбции:** WICK 10 670 · RECLAIM 4 537 · обе 750. При
   буквальном (зарегистрированном) чтении ветка тени не требует направления
   закрытия, и 6 000 из 12 127 триггеров по тени закрылись против направления
   фейда — они оставлены, и весь результат приводится вместе с ними. `WICK+RECLAIM`
   считает все оценки, где обе ветки сработали на одном баре, включая бары, зона
   которых не была выбрана.
9. **Сделок в 4.4 раза больше, чем у V3.0** (6 957 против 1 585), преимущество на
   сделку в 3.6 раза меньше, а абсолютная просадка больше (−43.67 R). Больше
   экспозиции, меньше преимущества на сделку — и, согласно п. 4, хрупкость в
   хвосте.

Breakdowns (primary) / Разбивки (основной вариант):

| split | value |
|---|---|
| funnel | 10,665 zones → 8,627 mitigated → **15,957 triggers** → 6,957 filled, 8,140 rejected (geometry), 849 cancelled, 9 unresolved, 0 expired |
| zone type | zones 7,425 OB / 3,240 FVG · triggers taken 14,512 OB / 1,445 FVG |
| tie-breaks | 8,756 of 15,957 trigger bars had more than one live zone in range (Amendment 1 §2) |
| absorption | WICK 10,670 · RECLAIM 4,537 · both 750 |
| exits | TP1_THEN_BE 3,295 · SL 2,298 · TP2 865 · TP1_THEN_TIMEOUT 379 · TIMEOUT 120 |
| direction | LONG n = 3,537, gross +0.0382 · SHORT n = 3,420, gross +0.1188 |
| symbols (gross) | BTC +0.1074 (1,135) · ETH +0.1003 (1,149) · BNB +0.0944 (1,092) · XRP +0.0893 (1,213) · SOL +0.0407 (1,154) · DOGE +0.0378 (1,214) |
| outlier dependence | gross +0.0778 · ex-top-1 +0.0758 · ex-top-5 +0.0710 · **ex-top-1 % +0.0264 (below the 0.0511 fee)** |
| target distances | TP1 R p25 0.2425 / median 0.5824 / p75 1.1911 · TP2 p25 1.8127 / median 2.9164 / p75 4.5831 |

---

## 3. Verdict / Вердикт

**EN.** `V3_3_TRAIN_ONLY`, exactly as the pre-registration's §5 provides: the
hypothesis cleared a fee-inclusive TRAIN run, and that is all it earned. It is
**not** validated, **not** deployable and **not** to be ported. Three reasons, in
order of severity:

1. **TRAIN is burned.** V3.0, V3.1 and V3.2 all used it; a pass here is a pass on
   data the programme has already learned from.
2. **The edge is in the tail.** Remove the best 1 % and the net is negative.
3. **The VALIDATION window is spent** (2026-09-16, read once) and the 2026-H1 TEST
   window must stay unread, so **nothing can be validated on existing data any
   more**. The only honest next step is a **paper forward test**, which is an
   operator decision — and if V3.3 is to be forward-tested, the pre-registration
   for it must fix in advance: the primary reading (`while` + `protective` +
   `displacement`), the drift monitoring, and the stopping rule, because a
   forward sample of a few hundred trades is what any later decision would need
   (V3.3 at ~2,800 trades/year across six symbols reaches that in weeks, not
   months).

**RU.** `V3_3_TRAIN_ONLY`, ровно как предусмотрено §5 предрегистрации: гипотеза
прошла прогон на TRAIN с учётом комиссий, и это всё, что она заслужила. Она
**не** валидирована, **не** готова к эксплуатации и **не** подлежит переносу. Три
причины по убыванию серьёзности:

1. **TRAIN израсходован.** V3.0, V3.1 и V3.2 уже его использовали; успех здесь —
   это успех на данных, из которых программа уже извлекала уроки.
2. **Преимущество в хвосте.** Уберите лучший 1 % — и результат отрицательный.
3. **Окно VALIDATION израсходовано** (16.09.2026, прочитано один раз), а окно
   TEST-2026 должно остаться непрочитанным, поэтому **валидация на существующих
   данных более невозможна**. Единственный честный следующий шаг — **бумажный
   форвард-тест**, и это решение оператора; если V3.3 на него отправлять, то в
   предрегистрации нужно заранее зафиксировать основное чтение
   (`while` + `protective` + `displacement`), контроль дрейфа и правило остановки,
   потому что для любого позднейшего решения понадобится форвардная выборка в
   несколько сотен сделок (V3.3 при ~2 800 сделках в год на шести символах
   набирает её за недели, а не месяцы).

`PRODUCTION_READY` remains forbidden for every strategy in this repository,
V3.0 included.

---

## 4. Method disclosures / Раскрытия по методу

**EN.** (a) All eight variants were named in the pre-registration (`16728ef`) and
Amendment 1 (`01cbc28`) **before** the reported runs; the primary is the cell the
pre-registration named. (b) Amendment 1 disclosed and registered the pre-amendment
single-symbol bug-check run, and pinned the tie-break for simultaneous zones and
the leg axis. (c) A regression check confirmed the amendment changed nothing in
the primary: re-running it after implementing the amendment reproduced every
trade metric of the bug-check run exactly (only the funnel gained counters).
(d) The research runners allow a new setup while an earlier filled trade is open —
the same convention as V3.0/V3.1/V3.2, kept for comparability; a production port
would trade less often. (e) The 1D series named in the request's "4H/1D context"
was never loaded: no rule references it, and `guards.htfSeriesLoaded` records
exactly the six 4H series that were read.

**RU.** (а) Все восемь вариантов названы в предрегистрации (`16728ef`) и Поправке 1
(`01cbc28`) **до** отчётных прогонов; основной — та ячейка, которую назвала
предрегистрация. (б) Поправка 1 раскрыла и зарегистрировала проверочный прогон по
одному символу, а также зафиксировала разрешение равенства зон и ось определения
ноги. (в) Регрессионная проверка подтвердила, что поправка ничего не изменила в
основном варианте: повторный прогон после реализации поправки воспроизвёл все
торговые метрики проверочного прогона в точности (новые счётчики появились только
в воронке). (г) Исследовательские прогоны допускают новый сетап, пока открыта
ранее исполненная сделка, — та же конвенция, что у V3.0/V3.1/V3.2, сохранена для
сопоставимости; прод-версия торговала бы реже. (д) Ряд 1D, упомянутый в запросе
как «4H/1D context», не загружался: ни одно правило на него не ссылается, и
`guards.htfSeriesLoaded` фиксирует ровно шесть прочитанных 4H-рядов.

---

## 5. Reproduce / Воспроизведение

```bash
S=artifacts/research/v2-real-20260915-080338/splits.json
for w in while first; do for st in protective climax; do for lg in displacement swing; do
  npx tsx research/v33_zone_mitigation.ts --cache=~/.cache/v30parity --splits=$S \
    --window=$w --stop=$st --leg=$lg \
    --out=artifacts/research/v33/v33-train-metrics-$w-$st-$lg.json
done; done; done

npx vitest run tests/v33-zone-mitigation.test.ts   # 35 tests, pins all eight artifacts
```

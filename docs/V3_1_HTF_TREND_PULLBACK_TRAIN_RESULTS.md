# V3.1 — HTF TREND PULLBACK & MITIGATION — TRAIN RESULTS
# V3.1 — ОТКАТ В ТРЕНДЕ НА СТАРШЕМ ТАЙМФРЕЙМЕ — РЕЗУЛЬТАТЫ TRAIN

**Status / Статус: `V3_1_FALSIFIED_ON_TRAIN`** — criterion **F1 is falsified**:
at realistic Binance futures fees (maker 2 bps entry / taker 5 bps exit, per leg)
the strategy loses money on every variant tested, and it loses **before fees**
too (gross R/trade is negative). The mechanism prediction F2 held — the wide
1H-pullback stop really does cut fee drag to a third of V3.0's — but it cannot
rescue a negative gross edge. **REJECTED for any forward use**, forward test
included.

**Статус: `V3_1_FALSIFIED_ON_TRAIN`** — критерий **F1 опровергнут**: при
реалистичных комиссиях Binance Futures (вход мейкером 2 bps, выход тейкером
5 bps, на каждую ногу) стратегия теряет деньги во всех проверенных вариантах,
причём теряет **до комиссий** (валовый R/сделку отрицателен). Предсказание
механизма F2 подтвердилось — широкий стоп за экстремумом 1H-отката
действительно снижает комиссию в R втрое против V3.0 — но это не спасает
отрицательное валовое преимущество. **Отклонена для любого применения**, включая
форвард-тест.

| pinned / зафиксировано | value / значение |
|---|---|
| pre-registration / предрегистрация | `760b15f` — `docs/V3_1_HTF_TREND_PULLBACK_PREREGISTRATION.md` |
| amendment 1 / поправка 1 | `docs/V3_1_HTF_TREND_PULLBACK_PREREGISTRATION_AMENDMENT_1.md` |
| implementation / реализация | `research/v31_trend_pullback.ts` (sha256 `1f18bb3ce45bbc94d79f48181fde7ad9550731e5c031ac0bd54662b6804a3bc7`) |
| artifacts / артефакты | `artifacts/research/v31/v31-train-metrics.json` (primary `leg`), `…-samebar.json` (secondary) |
| tests / тесты | `tests/v31-trend-pullback.test.ts` (30 tests, incl. the module hash pin) |
| slice / срез | TRAIN only — 1H `2022-01-01T00:00:00Z` … `2024-05-26T13:00:00Z`, 6 symbols |
| engine surface / поверхность движка | unchanged / не изменялась (`srcModified: false`) |
| baseline / база сравнения | V3.0 TRAIN: net **+0.0994 R/trade** @2/5 bps, n = 1,585 |

---

## 1. Headline / Головные цифры

Primary variant (`--pullback=leg`, Amendment 1), TRAIN, 6 symbols, 1H execution:

| metric / метрика | V3.1 | V3.0 (TRAIN) |
|---|---|---|
| trades / сделок (n) | **158** | 1,585 |
| TP1 hit % | **48.10** | 48.26 |
| TP2 hit % | **15.19** | 17.35 |
| positive-R % | **55.06** | 50.73 |
| natural stop distance, % of price (p25 / median / p75) | **2.046 / 3.456 / 5.279** | 0.785 / 1.252 / 1.987 |
| fee drag, R @2/5 bps | **0.0258** | 0.0732 |
| gross R/trade | **−0.0838** | +0.1726 |
| **net R/trade @2/5 bps** | **−0.1097** | **+0.0994** |
| profit factor | **0.7873** | 1.3538 |
| max drawdown, R | **−20.42** | −37.18 |
| average win / average loss, R | **+0.5637 / −0.8773** | +1.3022 / −0.9901 |
| median bars held | **19** | 7 |

Criteria, evaluated once, as registered:

| criterion / критерий | rule | V3.1 | verdict |
|---|---|---|---|
| **F1** primary | net R/trade > 0 @2/5 | **−0.1097** | **FALSIFIED** |
| **F2** mechanism | fee drag < 0.10 R | **0.0258** | holds (better than V3.0) |
| **F3** premise | TP1 hit ≥ 40 % | **48.10 %** | holds |

Secondary variant (`--pullback=same-bar`, the original §2.3(4) reading):
n = **82** (underpowered), TP1 **31.71 %**, TP2 **10.98 %**, fee drag 0.0279 R,
gross **−0.2540**, net **−0.2819**, PF 0.5264, MaxDD −23.07 R — F1 falsified and
F3 falsified. Both readings of the pullback condition lose; the disagreement in
magnitude does not change the sign, so this is not a definitional artefact.

**EN summary.** The strategy does what it was designed to do about *cost* and
fails completely on *payoff*. Its stop is 2.8× wider than V3.0's (median 3.46 %
of price), which cuts fee drag to 0.0258 R — the lowest the programme has
recorded. But the same geometry that widens the stop also shrinks the reward: the
entry sits at the close of a candle that already broke the previous 1H swing,
while TP1 is the 4H leg's terminal extreme, so the **median TP1 is only 0.64 R
away while the stop is 1 R**. Average win +0.564 R against average loss −0.877 R
cannot be paid for by a 48 % TP1 hit rate, let alone by a 55 % positive-R rate.
Gross expectancy is negative before any fee is charged, so no fee model, venue or
maker rebate could save it.

**RU кратко.** Стратегия делает то, ради чего задумывалась, в части *издержек*,
и полностью проваливается в части *выплаты*. Её стоп в 2.8 раза шире, чем у
V3.0 (медиана 3.46 % цены), что снижает комиссию до 0.0258 R — минимум за всю
программу. Но та же геометрия, что расширяет стоп, сжимает награду: вход стоит
на закрытии свечи, которая уже пробила предыдущий 1H-свинг, а TP1 — это
терминальный экстремум 4H-ноги, поэтому **медианный TP1 находится всего в
0.64 R, тогда как стоп — в 1 R**. Средний выигрыш +0.564 R против среднего
проигрыша −0.877 R не покрывается ни 48 % попаданий в TP1, ни 55 % доли
положительных сделок. Валовое матожидание отрицательно ещё до комиссий, поэтому
никакая модель комиссий или ребейт не могут это исправить.

---

## 2. Why it failed / Почему это провалилось

**EN.** 84 of 242 setups (35 %) were rejected by the geometry gate because the
corridor sat at or beyond TP1 — the strategy enters after the move it wants to
join. The survivors carry the same defect in weaker form: the median TP1 is
0.6381 R and the median TP2 is 1.6301 R from the fill, while a stop is −1 R and a
breakeven exit returns only +0.319 R (half of TP1). The exit mix reflects it
exactly — 57 full stops against only 24 TP2s, and 48 trades that reach TP1 and
then return to breakeven for +0.32 R.

The 4H trend filter did work and is not the problem: 209 of 242 triggers were 1H
**CHoCH** breaks (only 33 were BOS), i.e. the resumption signal is real, and TP1
was hit 48 % of the time — essentially identical to V3.0's 48.26 %. The premise
"pullbacks into value resume" is *not* falsified. What is falsified is that this
entry/exits pairing monetises it.

**RU.** 84 из 242 сетапов (35 %) отклонены геометрическим фильтром, потому что
коридор стоял на TP1 или за ним — стратегия входит уже после того движения, к
которому хочет присоединиться. У выживших тот же дефект в мягкой форме:
медианный TP1 — 0.6381 R, медианный TP2 — 1.6301 R от входа, тогда как стоп —
−1 R, а выход по безубытку возвращает лишь +0.319 R (половина TP1). Состав
выходов это подтверждает: 57 полных стопов против всего 24 TP2 и 48 сделок,
которые дошли до TP1 и вернулись в безубыток за +0.32 R.

Фильтр 4H-тренда сработал и проблемой не является: 209 из 242 триггеров — это
пробои **CHoCH** на 1H (BOS всего 33), то есть сигнал возобновления
существует, и TP1 достигался в 48 % случаев — практически столько же, сколько у
V3.0 (48.26 %). Посылка «откаты в зону стоимости возобновляются» **не**
опровергнута. Опровергнуто то, что данная пара «вход/выходы» умеет на ней
зарабатывать.

Breakdowns / Разбивки (primary):

| split | value |
|---|---|
| funnel | 242 signals → 158 filled, **84 rejected (geometry)**, 0 expired, 0 cancelled, 0 unresolved |
| exits | SL 57 · TP1_THEN_BE 48 · TIMEOUT 25 · TP2 24 · TP1_THEN_TIMEOUT 4 |
| direction | LONG n=58, gross −0.0165 · SHORT n=100, gross −0.1229 |
| symbols (gross) | BTC +0.1487 (26) · BNB +0.0978 (27) · SOL −0.0402 (31) · DOGE −0.0549 (33) · ETH −0.2010 (17) · XRP −0.5533 (24) |
| pullback source | EQ 187 · FVG 36 · both 19 |
| break type | CHoCH 209 · BOS 33 |
| outlier dependence | gross −0.0838 · ex-top-1 −0.1057 · ex-top-5 −0.1755 · ex-top-1 % −0.1272 |
| target distance | TP1 R-multiple p25 0.340 / median **0.638** / p75 1.067 · TP2 p25 1.141 / median 1.630 / p75 2.413 |

**EN.** Two of six symbols are positive and four are negative, the short side is
worse than the long side, and removing the best trades makes the result *worse*,
not better — this is a losing sample, not a fragile winner. The FVG branch of the
pullback condition contributes 55 of 242 signals (23 %) and none of the top
results depend on it.

**RU.** Два символа из шести положительны, четыре отрицательны, шорты хуже
лонгов, а удаление лучших сделок делает результат *хуже*, а не лучше — это
проигрышная выборка, а не хрупкий победитель. Ветка FVG в условии отката даёт
55 из 242 сигналов (23 %), и ни один из лучших результатов от неё не зависит.

---

## 3. Data discipline / Дисциплина данных

**EN.** TRAIN only. Both series were truncated at `trainToMs` immediately after
loading; the artifact records that **105,192 rows were dropped unread**,
`candlesBeyondTrainRead = 0` and `candles2026Read = 0`. No VALIDATION candle
(from 2024-05-26T14:00Z) and no TEST candle reached any computation. The 1D
series was never loaded — no rule in the specification references it.

**RU.** Только TRAIN. Оба ряда усекались по `trainToMs` сразу после загрузки;
артефакт фиксирует, что **105 192 строки отброшены непрочитанными**,
`candlesBeyondTrainRead = 0` и `candles2026Read = 0`. Ни одна свеча VALIDATION
(с 2024-05-26T14:00Z) и ни одна свеча TEST не дошли до вычислений. Ряд 1D не
загружался вовсе — ни одно правило спецификации на него не ссылается.

## 4. Correction disclosure / Раскрытие исправления

**EN.** The first artifact run contained a **double-booking bug**: on the
"TP2 reached on a bar after TP1" path the TP1 half was booked a second time,
inflating every TP2 trade by 0.5 × TP1-R. The unit tests written immediately
after that run caught it (`R1..R5` suite); the module was fixed, both artifacts
were regenerated, and the corrected figures are **worse**, not better
(primary net −0.0762 → **−0.1097** R/trade). The bug, the fix and both sets of
numbers are recorded here so the discrepancy cannot be discovered later and
mistaken for a revision.

**RU.** В первом прогоне артефакта был **баг двойного учёта**: на пути «TP2
достигнут на баре после TP1» половина TP1 учитывалась второй раз, завышая каждую
сделку TP2 на 0.5 × TP1-R. Юнит-тесты, написанные сразу после того прогона
(набор `R1..R5`), его поймали; модуль исправлен, оба артефакта перегенерированы,
и исправленные цифры **хуже**, а не лучше (primary net −0.0762 → **−0.1097**
R/сделку). Баг, исправление и оба набора чисел зафиксированы здесь, чтобы
расхождение нельзя было обнаружить позже и принять за ревизию.

## 5. What this does and does not mean / Что это значит и что нет

**EN.** *Does mean:* the V3.1 specification, implemented as pre-registered across
both readings of the pullback window, is a losing strategy on TRAIN at realistic
fees and must not be built, ported, or forward-tested. *Does not mean:* that trend
continuation does not work — the trigger and the TP1 rate were fine; the failure
is the payoff geometry of "enter on the resumption close, target the leg's
terminal extreme, risk the whole pullback".

Because the single VALIDATION window was spent on 2026-09-16 and may never be
re-read, **nothing can be validated on existing data** — but V3.1 does not even
get that far: it fails the weakest, most permissive gate (positive expectancy on
TRAIN, before fees). Its only legitimate successor would be a **new
pre-registration** with an ex-ante entry/exit geometry constraint (for instance:
require the corridor's TP1 R-multiple ≥ 1 before taking a setup, or place TP1 at
a nearer structural level). That is *not* done here, no filtered expectancy is
published, and the TRAIN window is by now partly burned — such a hypothesis would
start with reduced standing. `PRODUCTION_READY` remains forbidden for every
strategy in this repository, V3.0 included.

**RU.** *Значит:* спецификация V3.1, реализованная как предрегистрировано в обоих
прочтениях окна отката, — убыточная стратегия на TRAIN при реалистичных
комиссиях, и её нельзя ни строить, ни переносить в движок, ни отправлять на
форвард-тест. *Не значит:* что продолжение тренда не работает — триггер и доля
TP1 были в норме; провалилась геометрия выплаты «вход на закрытии свечи
возобновления, цель — терминальный экстремум ноги, риск — весь откат».

Единственное окно VALIDATION израсходовано 16.09.2026 и не может быть прочитано
повторно, поэтому **валидация на существующих данных невозможна** — но V3.1 до
неё даже не доходит: он проваливает самый слабый и мягкий критерий
(положительное матожидание на TRAIN, до комиссий). Единственный законный
преемник — **новая предрегистрация** с априорным ограничением геометрии
входа/выходов (например: требовать R-множитель TP1 от коридора ≥ 1 до входа,
или ставить TP1 на более близкий структурный уровень). Здесь это *не* сделано,
никакая отфильтрованная доходность не публикуется, и окно TRAIN к этому моменту
частично израсходовано — такая гипотеза стартовала бы с пониженным статусом.
`PRODUCTION_READY` остаётся запрещённым для любой стратегии репозитория, включая
V3.0.

## 6. Reproduce / Воспроизведение

```bash
npx tsx research/v31_trend_pullback.ts \
  --cache=/home/user/.cache/v30parity \
  --splits=artifacts/research/v2-real-20260915-080338/splits.json \
  --out=artifacts/research/v31/v31-train-metrics.json --pullback=leg

npx tsx research/v31_trend_pullback.ts \
  --cache=/home/user/.cache/v30parity \
  --splits=artifacts/research/v2-real-20260915-080338/splits.json \
  --out=artifacts/research/v31/v31-train-metrics-samebar.json --pullback=same-bar

npx vitest run tests/v31-trend-pullback.test.ts   # 30 tests, pins both artifacts
```

# V3.2 — HTF VOLUME CLIMAX & ABSORPTION — TRAIN RESULTS
# V3.2 — ОБЪЁМНЫЙ КЛИМАКС И АБСОРБЦИЯ — РЕЗУЛЬТАТЫ TRAIN

**Status / Статус: `V3_2_FALSIFIED_ON_TRAIN`** — the **pre-registered primary
variant fails F1**: net **−0.0620 R/trade** @2/5 bps. The fade premise itself is
the strongest the programme has ever measured (TP1 hit **60.59 %**) and the cost
claim held (fee drag **0.0538 R**), but the strategy's expectancy **before any
fee is charged is −0.0082 R/trade** — a coin flip that pays exchange fees. Two
pre-registered *sensitivity* variants (TP1 = 1H EMA50) do clear F1, but they
falsify the premise criterion F3 and are **not promoted**: they are recorded as
`V3_2_EMA50_VARIANT_UNPROMOTED` and require a new pre-registration before any use.

**Статус: `V3_2_FALSIFIED_ON_TRAIN`** — **предрегистрированный основной вариант
проваливает F1**: net **−0.0620 R/сделку** @2/5 bps. Сама посылка фейда — самая
сильная за всю программу (TP1 достигается в **60.59 %** случаев), а утверждение
о издержках подтвердилось (комиссия **0.0538 R**), но матожидание стратегии
**до начисления комиссий равно −0.0082 R/сделку** — это подбрасывание монеты,
которое платит биржевую комиссию. Два предрегистрированных *чувствительных*
варианта (TP1 = EMA50 на 1H) формально проходят F1, но опровергают критерий
посылки F3 и **не повышаются в статусе**: они записаны как
`V3_2_EMA50_VARIANT_UNPROMOTED` и требуют новой предрегистрации перед любым
использованием.

| pinned / зафиксировано | value / значение |
|---|---|
| pre-registration / предрегистрация | `b631fba` — `docs/V3_2_VOLUME_CLIMAX_PREREGISTRATION.md` |
| implementation / реализация | `research/v32_volume_climax.ts` (sha256 `c209b8d7ecf38940b910cc8de49608a0d8a849b75c9083f4492f691c08075bb6`) |
| artifacts / артефакты | `artifacts/research/v32/v32-train-metrics.json` (primary), `…-fast3.json`, `…-union-ema50.json`, `…-fast3-ema50.json` |
| tests / тесты | `tests/v32-volume-climax.test.ts` (30 tests, incl. the module hash pin) |
| slice / срез | TRAIN only — 1H `2022-01-01T00:00:00Z` … `2024-05-26T13:00:00Z`, 6 symbols |
| engine surface / поверхность движка | unchanged / не изменялась (`srcModified: false`) |
| baselines / базы сравнения | V3.0 TRAIN net **+0.0994** (n = 1,585) · V3.1 TRAIN net −0.1097 (n = 158) |

---

## 1. Headline / Головные цифры

Primary variant (union cascade window + TP1 = 50 % mean reversion), TRAIN:

| metric / метрика | V3.2 (primary) | V3.0 (TRAIN) |
|---|---|---|
| trades / сделок (n) | **307** | 1,585 |
| TP1 hit % | **60.59** | 48.26 |
| TP2 hit % | **15.64** | 17.35 |
| positive-R % | **60.91** | 50.73 |
| natural stop distance, % of price (p25 / median / p75) | **0.989 / 1.585 / 2.452** | 0.785 / 1.252 / 1.987 |
| fee drag, R @2/5 bps | **0.0538** | 0.0732 |
| gross R/trade | **−0.0082** | +0.1726 |
| **net R/trade @2/5 bps** | **−0.0620** | **+0.0994** |
| profit factor | **0.9791** | 1.3538 |
| max drawdown, R | **−19.97** | −37.18 |
| average win / average loss, R | **+0.6283 / −1.0000** | +1.3022 / −0.9901 |
| median bars held | **5** | 7 |
| median TP1 distance, R | **0.7058** | n/a (not recorded for V3.0) |
| median TP2 distance, R | **2.3689** | n/a |

Criteria, evaluated once, as registered:

| criterion / критерий | rule | V3.2 primary | verdict |
|---|---|---|---|
| **F1** primary | net R/trade > 0 @2/5 | **−0.0620** | **FALSIFIED** |
| **F2** cost | fee drag < 0.10 R | **0.0538** | holds (second-lowest on record) |
| **F3** premise | TP1 hit ≥ 50 % | **60.59 %** | holds (highest on record) |

### All four pre-registered variants / Все четыре варианта

| # | cascade window | TP1 | n | TP1 % | TP2 % | stop % (med) | fee R | gross R | net R @2/5 | PF | MaxDD | F1 | F2 | F3 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **A** | union (3–6) | 50 % mrev | **307** | 60.59 | 15.64 | 1.585 | 0.0538 | **−0.0082** | **−0.0620** | 0.9791 | −19.97 | ❌ | ✅ | ✅ |
| B | fast3 | 50 % mrev | 158 | 58.86 | 15.19 | 1.543 | 0.0532 | −0.0594 | −0.1126 | 0.8533 | −18.69 | ❌ | ✅ | ✅ |
| C | union (3–6) | 1H EMA50 | 213 | 42.72 | 29.11 | 1.440 | 0.0573 | +0.1104 | **+0.0530** | 1.2061 | −18.10 | ✅ | ✅ | ❌ |
| D | fast3 | 1H EMA50 | 97 ⚠️ | 42.27 | 27.84 | 1.463 | 0.0571 | +0.0679 | +0.0108 | 1.1291 | −8.91 | ✅ | ✅ | ❌ |

⚠️ D is **underpowered** (n = 97 < 100) and its gross turns negative once the best
five trades are removed (−0.0842) — no conclusion may be drawn from it.

**EN summary.** The Volume Climax fade is the highest-hit-rate strategy this
programme has produced, and it still cannot pay for itself. The reason is
arithmetic, not luck: the median TP1 sits **0.71 R** from the entry, so a winner
earns +0.63 R on average while a loser pays the full −1 R. With a 60.91 %
positive-R rate the expectancy is `0.609 × 0.628 − 0.391 × 1 ≈ −0.008` — which is
exactly the measured gross of **−0.0082 R**. The pre-cost edge is zero to within
2 % of a single R, so the entire result is the fee: **the strategy loses money
even at zero fees**, and the fee drag (±0.0538 R) is what remains.

**RU кратко.** Фейд объёмного климакса — стратегия с самой высокой долей
успешных сделок за всю программу, и она всё равно не окупается. Причина
арифметическая, а не в невезении: медианный TP1 находится в **0.71 R** от входа,
поэтому выигрыш даёт в среднем +0.63 R, а проигрыш — полный −1 R. При доле
положительных сделок 60.91 % матожидание равно
`0.609 × 0.628 − 0.391 × 1 ≈ −0.008`, что в точности совпадает с измеренным
валовым результатом **−0.0082 R**. Преимущество до издержек равно нулю с
точностью до 2 % от одного R, поэтому весь результат — это комиссия:
**стратегия убыточна даже при нулевых комиссиях**, а комиссионная нагрузка
(0.0538 R) — это то, что остаётся.

---

## 2. What the run actually established / Что именно установил прогон

**EN.**

1. **The mechanism that was supposed to work, worked.** Absorption after a volume
   climax does mean-revert: 60.59 % of fades reached half of the cascade's range,
   the highest TP1 rate in the programme, and better than V3.0's 48.26 %. F3 was
   registered to falsify exactly this premise and it held.
2. **The cost claim held too.** The stop behind the climax wick is wide
   (median 1.585 % of price, wider than V3.0's 1.252 %), so fee drag is 0.0538 R —
   lower than V3.0's 0.0732 R and far below the 0.10 R falsification line.
3. **But the reward is at the wrong distance.** Because TP1 is the *50 %
   retracement of the cascade* and the entry is already at the climax candle's
   close, the first target sits a median of 0.71 R away while the stop is 1 R
   away. The strategy wins often and small, and loses rarely and fully: 134 of
   307 trades reached TP1 and then returned to breakeven for +0.32 R on the
   book — the single largest exit bucket.
4. **Therefore the result is a fee artefact, not an edge.** At zero fees the
   primary is still −0.0082 R/trade. This is the first strategy in the programme
   whose failure needs no fee discussion at all.
5. **Selectivity comes from absorption, not volume.** 5,357 cascades had RVOL
   ≥ 2.2 but failed the absorption signature; only 354 of 5,711 (6.2 %) passed
   both. The `WICK` branch supplied 340 of the entered 354; the `ENGULF` branch
   only 14. Entries are genuinely extreme events: median cascade size 2.78 ATR
   and median RVOL 2.86 on the trades taken.
6. **The EMA50 variant changes the trade, not just the target.** With TP1 at the
   1H EMA50 the profile flips to "ride the reversal": TP2 hit rate rises from
   15.6 % to 29.1 %, average win from +0.63 R to +1.40 R, and both variants clear
   F1 — but TP1 hit rate falls below 50 %, so F3 is falsified and the
   mean-reversion story no longer describes what is being traded. The union
   variant C is not fragile to outliers (ex-top-1 +0.0903, ex-top-5 +0.0286) but
   it *is* concentrated by symbol (BTC +0.497 and XRP +0.384 against
   SOL −0.334), and it only clears F1 by 0.053 R over a 0.0573 R fee — half its
   gross is fee.

**RU.**

1. **Механизм, на который делалась ставка, сработал.** Абсорбция после
   объёмного климакса действительно возвращает цену: 60.59 % фейдов достигли
   половины диапазона каскада — лучший показатель TP1 в программе и выше, чем
   48.26 % у V3.0. Критерий F3 был зарегистрирован именно для проверки этой
   посылки, и она выдержала.
2. **Утверждение об издержках тоже подтвердилось.** Стоп за свечой-климаксом
   широк (медиана 1.585 % цены, шире, чем 1.252 % у V3.0), поэтому комиссия
   составляет 0.0538 R — меньше, чем 0.0732 R у V3.0, и далеко ниже порога
   фальсификации 0.10 R.
3. **Но награда стоит не на том расстоянии.** Так как TP1 — это *50 % откат
   каскада*, а вход уже находится на закрытии свечи-климакса, первая цель
   расположена в медиане 0.71 R, тогда как стоп — в 1 R. Стратегия выигрывает
   часто и мало, а проигрывает редко и полностью: 134 из 307 сделок дошли до
   TP1 и вернулись в безубыток с результатом +0.32 R — это самая крупная
   группа выходов.
4. **Следовательно, результат — артефакт комиссии, а не преимущество.** При
   нулевых комиссиях основной вариант всё равно даёт −0.0082 R/сделку. Это
   первая стратегия программы, чей провал вообще не требует разговора о
   комиссиях.
5. **Селективность даёт абсорбция, а не объём.** 5 357 каскадов имели
   RVOL ≥ 2.2, но не прошли сигнатуру абсорбции; из 5 711 прошли обе проверки
   лишь 354 (6.2 %). Ветка `WICK` дала 340 из 354 входов, ветка `ENGULF` — лишь
   14. Входы действительно экстремальные события: медиана размера каскада
   2.78 ATR и медиана RVOL 2.86 по взятым сделкам.
6. **Вариант с EMA50 меняет саму сделку, а не только цель.** С TP1 на EMA50
   профиль переворачивается в «ведение разворота»: доля TP2 растёт с 15.6 % до
   29.1 %, средний выигрыш — с +0.63 R до +1.40 R, и оба варианта проходят F1 —
   но доля TP1 падает ниже 50 %, F3 опровергнут, и история про возврат к
   среднему больше не описывает то, чем торгует стратегия. Вариант C устойчив к
   выбросам (ex-top-1 +0.0903, ex-top-5 +0.0286), но сконцентрирован по
   символам (BTC +0.497 и XRP +0.384 против SOL −0.334), и проходит F1 всего на
   0.053 R при комиссии 0.0573 R — половину валового результата съедает
   комиссия.

Breakdowns (primary) / Разбивки (основной вариант):

| split | value |
|---|---|
| funnel | 5,711 cascades with RVOL ≥ 2.2 → **5,357 failed absorption** → 354 signals → 307 filled, 39 cancelled, 8 rejected (geometry), 0 expired, 0 unresolved |
| absorption branch | WICK 340 · ENGULF 11 · WICK+ENGULF 3 |
| cascade window used | k = 6 → 317 · k = 5 → 20 · k = 4 → 14 · k = 3 → 3 |
| exits | TP1_THEN_BE 134 · SL 120 · TP2 48 · TP1_THEN_TIMEOUT 4 · TIMEOUT 1 |
| direction | LONG n = 156, gross +0.0073 · SHORT n = 151, gross −0.0241 |
| symbols (gross) | XRP +0.2843 · BTC +0.0797 · ETH +0.0033 · BNB −0.0737 · DOGE −0.0960 · SOL −0.1647 |
| outlier dependence | gross −0.0082 · ex-top-1 −0.0183 · ex-top-5 −0.0505 · ex-top-1 % −0.0427 |
| cascade size | p25 2.33 · median 2.78 · p75 3.46 ATR |
| RVOL on entries | p25 2.46 · median 2.86 · p75 3.44 |

---

## 3. Verdict and what must not be done next / Вердикт и чего нельзя делать

**EN.** V3.2 **must not be ported** into the engine and **must not be
forward-tested**. The pre-registered primary variant fails the primary criterion,
and its failure does not depend on fees, venues or execution quality — the
pre-cost edge is zero.

The two EMA50 variants are a genuinely interesting *new* observation (a fade whose
target is the mean rather than half the cascade behaves like a reversal-riding
trade and clears fees on TRAIN), but promoting them now would be exactly the
selection-after-failure the programme forbids: the primary was named before the
run, and choosing the winner of four after seeing all four is not evidence. If
anyone wants that strategy, it needs a **new pre-registration** written as if
from scratch, with its own falsification criteria — and it must be stated up front
that **no unspent validation window remains**: TRAIN is burned, VALIDATION was
spent once on 2026-09-16 and may never be re-read, and TEST-2026 has no data and
must stay unread. A fresh pre-registration could therefore only ever be tested by
paper forward testing, which is an operator decision and is not implied by
anything in this document.

**RU.** V3.2 **нельзя переносить** в движок и **нельзя** отправлять на
форвард-тест. Предрегистрированный основной вариант не проходит главный
критерий, и его провал не зависит от комиссий, площадки или качества
исполнения — преимущества до издержек нет вовсе.

Два варианта с EMA50 — действительно интересное *новое* наблюдение (фейд, у
которого цель стоит на средней, а не на половине каскада, ведёт себя как сделка
на развороте и на TRAIN покрывает комиссии), но повышать их в статусе сейчас —
это ровно тот отбор после провала, который программа запрещает: основной вариант
был назван до прогона, а выбор победителя из четырёх после того, как увидены все
четыре, доказательством не является. Если такая стратегия кому-то нужна, под неё
требуется **новая предрегистрация**, написанная заново, со своими критериями
фальсификации — и сразу следует сказать, что **неизрасходованного окна
валидации не осталось**: TRAIN израсходован, VALIDATION потрачено единожды
16.09.2026 и не может быть прочитано повторно, у TEST-2026 нет данных, и его
нельзя читать. Поэтому новая предрегистрация в принципе может быть проверена
только бумажным форвард-тестом — это решение оператора, и оно не следует ни из
чего в этом документе.

`PRODUCTION_READY` remains forbidden for every strategy in this repository,
V3.0 included.

---

## 4. Environment integrity and disclosures / Целостность среды и раскрытия

**EN.** The sandbox that produced this run was **re-provisioned** between V3.1
and V3.2: its `.git` directory, `node_modules`, `fixtures/` and both candle caches
were gone (these paths are excluded from workspace snapshots). Recovery and the
evidence that the environment is equivalent:

1. The branch was re-attached to the remote tip `292050c` after proving the
   working tree was byte-identical to it (a full staged snapshot compared against
   the fetched commit — empty diff). No work was lost or rewritten.
2. The dataset was re-cloned from its own repository,
   `github.com/nub36/svechnoy-suslik-binance-data`, **at the pinned commit
   `c3c1dce`**, sparse-checked out to the six symbols × {1h, 4h} (576 archives,
   the same originals).
3. The binary cache rebuilt to **262,974 candles / 12 series**, and every 1H
   series reports the identical integrity profile recorded before (35,063
   candles, 1 gap, 1 missing candle, 1 non-canonical close time).
4. **Reproduction proof:** the V3.1 simulator was re-run from scratch and its
   artifact is **byte-identical** to the committed one — the same code, the same
   data, the same numbers as before the re-provisioning.

**Performance disclosure.** The first two configurations were run with
`buildAtrContext(h1, i, p)` called on every bar, which recomputes the whole ATR
from bar 0 and makes the replay O(n²) (≈400 s per run). It was replaced by the
equivalent precomputed `atrSeriesV2` series (same Wilder recurrence over the same
prefix) and the artifacts were re-generated; the primary artifact is
**byte-identical** to the one produced by the slow path, and a run now takes
1.1 s. Nothing about the strategy changed.

**RU.** Песочница, в которой получен этот результат, была **пересоздана** между
V3.1 и V3.2: пропали `.git`, `node_modules`, `fixtures/` и оба кэша свечей (эти
пути исключены из снапшотов рабочего пространства). Восстановление и
доказательства эквивалентности среды:

1. Ветка заново привязана к удалённой вершине `292050c` после доказательства,
   что рабочее дерево **побайтово** совпадает с ней (полный staged-снапшот против
   полученного коммита — пустой diff). Ничего не потеряно и не переписано.
2. Датасет заново склонирован из своего репозитория
   `github.com/nub36/svechnoy-suslik-binance-data` **на закреплённом коммите
   `c3c1dce`**, с частичной выгрузкой шести символов × {1h, 4h} (576 архивов,
   те же оригиналы).
3. Бинарный кэш собран заново: **262 974 свечи / 12 серий**, и каждая 1H-серия
   даёт тот же профиль целостности, что зафиксирован ранее (35 063 свечи,
   1 разрыв, 1 пропущенная свеча, 1 неканоническое время закрытия).
4. **Доказательство воспроизводимости:** симулятор V3.1 запущен заново, и его
   артефакт **побайтово идентичен** закоммиченному — тот же код, те же данные,
   те же числа, что и до пересоздания среды.

**Раскрытие по производительности.** Первые две конфигурации считались с вызовом
`buildAtrContext(h1, i, p)` на каждом баре, что пересчитывает весь ATR с нулевого
бара и делает прогон O(n²) (≈400 с на запуск). Вызов заменён эквивалентным
предвычисленным рядом `atrSeriesV2` (та же рекурсия Уайлдера по тому же префиксу),
артефакты перегенерированы; основной артефакт **побайтово идентичен** полученному
медленным путём, а прогон теперь занимает 1.1 с. В стратегии не изменилось
ничего.

---

## 5. Reproduce / Воспроизведение

```bash
# dataset once (only the 6 symbols x {1h,4h}):
git clone --filter=blob:none --no-checkout \
  https://github.com/nub36/svechnoy-suslik-binance-data.git ~/.cache/binance-data
cd ~/.cache/binance-data && git sparse-checkout init --no-cone \
  && git sparse-checkout set '/*/1h/*' '/*/4h/*' && git checkout
cd - && npx tsx scripts/real-data/v30-parity-ingest.ts \
  --dataset=~/.cache/binance-data --cache=~/.cache/v30parity

# the four pre-registered configurations:
S=artifacts/research/v2-real-20260915-080338/splits.json
npx tsx research/v32_volume_climax.ts --cache=~/.cache/v30parity --splits=$S \
  --cascade=union --tp1=cascade --out=artifacts/research/v32/v32-train-metrics.json
npx tsx research/v32_volume_climax.ts --cache=~/.cache/v30parity --splits=$S \
  --cascade=fast3 --tp1=cascade --out=artifacts/research/v32/v32-train-metrics-fast3.json
npx tsx research/v32_volume_climax.ts --cache=~/.cache/v30parity --splits=$S \
  --cascade=union --tp1=ema50 --out=artifacts/research/v32/v32-train-metrics-union-ema50.json
npx tsx research/v32_volume_climax.ts --cache=~/.cache/v30parity --splits=$S \
  --cascade=fast3 --tp1=ema50 --out=artifacts/research/v32/v32-train-metrics-fast3-ema50.json

npx vitest run tests/v32-volume-climax.test.ts   # 30 tests, pins all four artifacts
```

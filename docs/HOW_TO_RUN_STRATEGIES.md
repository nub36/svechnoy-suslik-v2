# HOW TO RUN THE STRATEGIES / КАК ЗАПУСКАТЬ СТРАТЕГИИ

**Short answer / короткий ответ: да, код рабочий — он воспроизводит опубликованные
цифры на реальных данных Binance сегодня.** Одна команда запускает всё и печатает
таблицу:

```bash
npx tsx scripts/run-strategies.ts \
  --cache=/home/user/.cache/v30parity \
  --cache28=/home/user/.cache/v28parity \
  --splits=artifacts/research/v2-real-20260915-080338/splits.json
```

Но «работает» не значит «зарабатывает». Ниже — что именно доказано для каждой
стратегии, а что нет. Цифры взяты из артефактов в `artifacts/research/`, не из
памяти, и сам запуск проверяет, что свежий прогон совпал с опубликованным
(`✓ no drift`), а также сверяет sha256 модулей с зафиксированными тестами.

---

## 1. Итог по трём стратегиям из вашей таблицы / verdict on the three

| | **V3.0** Капкан ликвидаций | **V3.3** Митигация 4H-зон | **V2.8** Zero-Fee Sniper + Trailing |
|---|---|---|---|
| Статус | **`V3_0_VALIDATED_FOR_RESEARCH`** | `V3_3_TRAIN_ONLY` | `V2_8_VALIDATED_FOR_RESEARCH` (**только при нулевых комиссиях**) |
| Работает? | **Да** — проверена на данных, которых не видела | **Не доказано** — прошла только TRAIN | **Только на счёте с 0 % мейкером / кэшбэком** |
| TRAIN | n 1 585 · net **+0.0994** · PF 1.3538 | n 6 957 · net **+0.0267** · PF 1.2341 | n 317 · gross +0.1462 (без комиссий) |
| Вне выборки | **VALIDATION n 536 · net +0.0600** · PF 1.2484 | **нет, и уже невозможно** | **VALIDATION n 98 · gross +0.0488** (без комиссий) |
| Комиссии Binance futures 2/5 bps | **остаётся в плюсе** | остаётся в плюсе, но на грани | **уходит в минус** |
| Слабое место | 3 символа из 6 отрицательны; без 5 лучших сделок минус | **без лучшего 1 % сделок минус** (ex-top-1 % +0.0264 < комиссия 0.0511); прочтение `first` проваливает F1 | на нулевых комиссиях VALIDATION тоже **хвостовая**: ex-top-1 % = **−0.0143** |
| В движке сайта | **да**, `src/strategy/v30/`, бумажный форвард-тест | нет, только research | нет |

### Три поправки к вашей сводной таблице / three corrections

1. **V3.3 — не «тренд / импульс от зоны».** Это **сделка разворота**: вход *против*
   движения, которое входит в зону, и в направлении, которым зона была создана.
   Бычья зона → **LONG**. Название «Zone Continuation» описывает не то, что делает
   код. (Исправлено в спеке: `docs/strategies/V3_3_HTF_ZONE_MITIGATION.md`, §A1.)
2. **«ПРОВЕРЕНА НА TRAIN» — это не «чистый плюс».** +0.0267 R — да, но он держится
   на хвосте: уберите 70 лучших сделок из 6 957 — и результат хуже комиссии.
   Валидации нет и **быть не может**: TRAIN израсходован, окно VALIDATION потрачено
   16.09.2026 на V3.0, а окно TEST-2026 читать нельзя.
3. **V2.8 «валидирована» — только по нулевым комиссиям.** В таблице стоит
   «+0.0488 R» и отдельно «−0.107 R с комиссиями». Точнее так: +0.0488 — это
   *валовый* результат при **отключённых комиссиях**, и даже он целиком создан
   хвостом: без лучшего 1 % сделок валидация даёт **−0.0143**. То есть V2.8 не
   «требует нулевых комиссий» — она требует нулевых комиссий **и** удачи в хвосте.

---

## 2. Что делать прямо сейчас / what to do right now

**Хотите работающую вещь — берёте V3.0.** Это единственная стратегия, прошедшая
предрегистрированную проверку на невиданных данных, и она уже подключена к движку:

```bash
# 1) воспроизвести порт движка на TRAIN и убедиться, что он совпадает с research-модулем
npx tsx scripts/real-data/v30-parity-ingest.ts --dataset=/home/user/.cache/binance-data --cache=/home/user/.cache/v30parity
npx tsx scripts/real-data/v30-parity.ts \
  --cache=/home/user/.cache/v30parity --dataset=/home/user/.cache/binance-data \
  --splits=artifacts/research/v2-real-20260915-080338/splits.json \
  --out=artifacts/research/v30/v30-port-parity.json
# → PARITY: PASS · research trades 1585 · port trades 1585 · net/trade 0.0994

# 2) весь портфель одной командой
npx tsx scripts/run-strategies.ts --cache=/home/user/.cache/v30parity --cache28=/home/user/.cache/v28parity

# 3) сайт с V3.0 по умолчанию (бумажная торговля, LIVE заблокирован)
npm run dev            # http://localhost:3000  ·  админка /admin
```

**Хотите попробовать V3.3** — можно, но только как исследование: запускать
`research/v33_zone_mitigation.ts`, торговать по ней живыми деньгами основания нет.

**Не запускайте V3.1 и V3.2** — они фальсифицированы на TRAIN (отрицательны ещё до
комиссий). Они лежат в реестре, чтобы фальсификацию можно было воспроизвести.

---

## 3. Где лежит код / where the code lives

| Стратегия | Рабочий код | Артефакт с цифрами |
|---|---|---|
| **V3.0** (продакшн-порт) | `src/strategy/v30/` — `trap.ts`, `levels.ts`, `execution.ts`, `outcome.ts`, `params.ts`, `runner.ts` | `artifacts/research/v30/v30-train-metrics.json`, `v30-validation-metrics.json`, `v30-port-parity.json` |
| **V3.0** (research-эталон) | `research/v30_htf_trap.ts` (sha `a821757f…`, заморожен) | там же |
| **V3.3** | `research/v33_zone_mitigation.ts` (sha `3f5b1478…`) | `artifacts/research/v33/*.json` (8 прогонов) |
| **V2.8** | `research/v28_gross_only.ts` (эталон), `research/v28_validate.ts` | `artifacts/research/v28/*.json` |
| **V3.1 / V3.2** | `research/v31_trend_pullback.ts`, `research/v32_volume_climax.ts` | `artifacts/research/v31|v32/*.json` |
| **Единый запуск** | `scripts/run-strategies.ts` | `artifacts/research/portfolio-comparison.json` |

Документация: `docs/strategies/V3_0_HTF_LIQUIDATION_TRAP.md`,
`docs/strategies/V3_3_HTF_ZONE_MITIGATION.md`,
`docs/V3_3_HTF_ZONE_MITIGATION_TRAIN_RESULTS.md`, `docs/STRATEGY_ARCHIVE.md`.

---

## 4. Как читать вывод `run-strategies.ts` / reading the output

```
strategy  n       TP1 %   stop %   fee R   gross R  net@2/5 R  PF      MaxDD R   ex-top-1 %
v30       1585    48.26   1.2520   0.0732  +0.1726  +0.0994    1.3538  -37.18    +0.0983
v33       6957    65.24   1.6953   0.0511  +0.0778  +0.0267    1.2341  -43.67    +0.0264
v28       317     50.79   —        ZERO*   +0.1462  n/a*       1.3508  -16.16    +0.0536
```

- **`gross R`** — средний результат сделки до комиссий, в единицах риска (R).
- **`fee R`** — сколько комиссии съедает одна сделка (в тех же R): 2 bps мейкер на
  входе + 5 bps тейкер на каждом выходе, комиссия берётся с каждой ноги отдельно.
- **`net@2/5`** — то, что остаётся. **Это единственное число, по которому стоит
  судить.**
- **`ex-top-1 %`** — валовый результат, если удалить лучший 1 % сделок. Если это
  число **меньше** колонки `fee R`, стратегия убыточна без своего хвоста. Это
  правило сразу отсекает V3.3 (0.0264 < 0.0511) и V2.8 на валидации (−0.0143).
- **`ZERO*`** — прогон с отключёнными комиссиями (так валидировалась V2.8).

Скрипт печатает `✓ every run reproduced its published artifact exactly (no drift)`,
когда свежий запуск совпал с опубликованным файлом. Если появится `⚠ DRIFT` или
`⚠ PROBLEMS` — цифрам в таблице доверять нельзя до разбирательства.

---

## 5. Что нельзя делать / what must not happen

- Не перечитывать окно **VALIDATION** (израсходовано 16.09.2026) и не читать окно
  **TEST-2026** (последний неизрасходованный срез).
- Не торговать живыми деньгами ни по одной из этих стратегий:
  `LIVE_TRADING_ENABLED = false`, `assertAllowedMode` отклоняет `LIVE`,
  `PRODUCTION_READY` запрещён для всех.
- Не выбирать «лучшую» ячейку из восьми прогонов V3.3 задним числом — засчитывается
  только предрегистрированный основной вариант.
- Не менять параметры после заморозки — тогда цифры из артефактов перестают
  описывать то, что запускается.

---

## 6. Одна команда / English summary

`npx tsx scripts/run-strategies.ts` runs every strategy that has a research module,
through that exact module, on real cached Binance klines, and prints one table with
`gross`, `fee drag`, `net @2/5 bps`, `PF`, `MaxDD` and the tail test. It never
re-implements a strategy and never trades. Each run is checked against the published
artifact and against the case-sensitive sha256 pin, so a stale or edited module
fails loudly instead of quietly printing different numbers.

Reproduced on real data as of this commit: **V3.0 n = 1 585 net +0.0994**,
**V3.3 n = 6 957 net +0.0267**, **V2.8 n = 317 gross +0.1462 (zero fees)**,
**V3.1 n = 158 net −0.1097 (falsified)**, **V3.2 n = 307 net −0.0620 (falsified)** —
all identical to their committed artifacts.

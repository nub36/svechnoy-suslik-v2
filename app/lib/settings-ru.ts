/**
 * Russian labels and descriptions for Admin settings.
 *
 * Keyed by the SETTINGS_REGISTRY key, which is part of the API/DB contract and
 * must not change. Translation happens purely at render time; an unmapped key
 * gracefully falls back to the English text from the backend so a newly added
 * setting is never invisible.
 *
 * Factor identifiers (BOS, FVG, OB, ATR, R, TP1...) are intentionally kept in
 * their standard trading form — translating them would make the UI worse and
 * would break the link to the engine's own diagnostic output.
 */

export interface SettingText {
  label: string;
  description: string;
}

export const SETTING_RU: Record<string, SettingText> = {
  /* ---------------- engine ---------------- */
  'engine.trading_mode': {
    label: 'Режим торговли',
    description: 'DRY_RUN или FORWARD_TEST. Режим LIVE заблокирован и будет отклонён.',
  },
  'engine.enabled': {
    label: 'Движок включён',
    description: 'Главный выключатель. Если выключен, воркер стратегии ничего не рассчитывает.',
  },
  'engine.score_threshold': {
    label: 'Порог оценки для сигнала',
    description: 'Минимальная нормализованная оценка (0-100), необходимая для создания сигнала.',
  },
  'engine.min_components': {
    label: 'Минимум подтверждений',
    description: 'Минимальное количество различных учтённых факторов (подтверждений).',
  },
  'engine.timeframes': {
    label: 'Таймфреймы стратегии',
    description:
      'Какие таймфреймы стратегия сканирует прямо сейчас. Это единственная настройка таймфреймов: она же определяет, какие таймфреймы загружает воркер рынка, поэтому график по отключённому таймфрейму со временем перестанет пополняться новыми свечами (уже загруженная история сохраняется, ничего не удаляется и не выдумывается). Должен быть выбран хотя бы один таймфрейм.',
  },
  'engine.max_catchup_candles': {
    label: 'Максимум свечей для догона',
    description:
      'После простоя воркера или повторного включения таймфрейма движок последовательно обрабатывает пропущенные ЗАКРЫТЫЕ свечи. Если пропуск больше этого значения, слот просто получает новую базовую точку — ложный сигнал в этом случае невозможен.',
  },
  'engine.lookback_candles': {
    label: 'Глубина анализа (свечей)',
    description: 'Сколько закрытых свечей анализируют детекторы факторов.',
  },
  'engine.swing_lookback': {
    label: 'Сила основного пивота',
    description: 'Сколько баров с каждой стороны нужно для подтверждения основного экстремума.',
  },

  /* ---------------- factors: enable + weight ---------------- */
  'detectors.BOS.enabled': {
    label: 'BOS включён',
    description: 'Break of Structure — закрытие за подтверждённым экстремумом.',
  },
  'detectors.BOS.weight': { label: 'Вес BOS', description: 'Вес фактора BOS в расчёте оценки.' },
  'detectors.ORDER_BLOCK.enabled': {
    label: 'Order Block включён',
    description: 'Последняя противоположная свеча перед импульсным движением.',
  },
  'detectors.ORDER_BLOCK.weight': {
    label: 'Вес Order Block',
    description: 'Вес фактора Order Block в расчёте оценки.',
  },
  'detectors.FVG.enabled': {
    label: 'FVG включён',
    description: 'Fair Value Gap — ценовой дисбаланс на трёх свечах.',
  },
  'detectors.FVG.weight': { label: 'Вес FVG', description: 'Вес фактора FVG в расчёте оценки.' },
  'detectors.LIQUIDITY_SWEEP.enabled': {
    label: 'Liquidity Sweep включён',
    description: 'Тень снимает ликвидность за экстремумом, а закрытие возвращается внутрь.',
  },
  'detectors.LIQUIDITY_SWEEP.weight': {
    label: 'Вес Liquidity Sweep',
    description: 'Вес фактора Liquidity Sweep в расчёте оценки.',
  },
  'detectors.RANGE_POSITION.enabled': {
    label: 'Range Position включён',
    description: 'Положение цены внутри торгового диапазона (учитываются только крайние зоны).',
  },
  'detectors.RANGE_POSITION.weight': {
    label: 'Вес Range Position',
    description: 'Вес фактора Range Position в расчёте оценки.',
  },
  'detectors.INTERNAL_STRUCTURE.enabled': {
    label: 'Internal Structure включён',
    description:
      'КОНТЕКСТНЫЙ фактор: внутренняя (второстепенная) бычья или медвежья структура.',
  },
  'detectors.INTERNAL_STRUCTURE.weight': {
    label: 'Вес Internal Structure',
    description: 'Вес контекстного фактора Internal Structure в расчёте оценки.',
  },
  'detectors.OB_FVG_CONFLUENCE.enabled': {
    label: 'Конфлюэнция OB + FVG включена',
    description:
      'ПРОИЗВОДНЫЙ фактор: Order Block, перекрывающийся с FVG. Даёт только собственный бонус.',
  },
  'detectors.OB_FVG_CONFLUENCE.weight': {
    label: 'Вес конфлюэнции OB + FVG',
    description:
      'Собственный небольшой вес бонуса. Веса OB и FVG при этом повторно НЕ начисляются.',
  },

  /* ---------------- factor parameters ---------------- */
  'detectors.event_ttl_bars': {
    label: 'Актуальность события (свечей)',
    description: 'События факторов старше указанного числа свечей не учитываются.',
  },
  'detectors.bos_min_break_pct': {
    label: 'Мин. пробой для BOS, %',
    description: 'Закрытие должно превысить пробитый экстремум минимум на этот процент.',
  },
  'detectors.ob_min_displacement': {
    label: 'Мин. импульс для Order Block',
    description:
      'Тело импульсной свечи должно быть не меньше этого множителя от среднего тела за 20 баров.',
  },
  'detectors.ob_lookback_bars': {
    label: 'Глубина поиска Order Block',
    description: 'На сколько баров назад искать противоположную свечу, образующую ордер-блок.',
  },
  'detectors.fvg_min_pct': {
    label: 'Мин. размер FVG, %',
    description: 'Минимальный размер разрыва в процентах от цены, чтобы он считался FVG.',
  },
  'detectors.sweep_min_wick_ratio': {
    label: 'Мин. доля тени для Sweep',
    description: 'Тень отбоя должна составлять минимум эту долю от всего диапазона свечи (0-1).',
  },
  'detectors.range_edge_band': {
    label: 'Крайняя зона диапазона',
    description:
      'Какая доля диапазона по краям считается направленной зоной (например, 0.35 — нижние/верхние 35%).',
  },
  'detectors.internal_structure_strength': {
    label: 'Сила внутреннего пивота',
    description:
      'Сила пивота для второстепенных движений. Держите её ниже силы основного пивота, чтобы фактор не дублировал BOS.',
  },
  'detectors.internal_structure_legs': {
    label: 'Число внутренних движений',
    description:
      'Сколько последних второстепенных максимумов/минимумов сравнивается для оценки внутренней структуры.',
  },
  'detectors.confluence_min_overlap_pct': {
    label: 'Мин. перекрытие OB и FVG, %',
    description:
      'Минимальное перекрытие (в % от меньшей зоны), при котором ордер-блок и FVG считаются конфлюэнцией.',
  },

  /* ---------------- risk ---------------- */
  'risk.atr_period': {
    label: 'Период ATR',
    description: 'Глубина расчёта ATR. ATR используется ТОЛЬКО для риска, никогда для подтверждения.',
  },
  'risk.sl_atr_mult': {
    label: 'Множитель ATR для стоп-лосса',
    description: 'Расстояние до стопа = ATR × этот множитель.',
  },
  'risk.sl_policy': {
    label: 'Политика стоп-лосса',
    description:
      'ATR — стоп на расстоянии ATR × множитель. STRUCTURE — стоп за структурным уровнем инвалидации. ATR_OR_STRUCTURE — тот, который дальше (самый безопасный вариант).',
  },
  'risk.tp1_r': {
    label: 'TP1 (в R)',
    description: 'Первый тейк-профит, выраженный в кратности начального риска.',
  },
  'risk.tp2_r': {
    label: 'TP2 (в R)',
    description: 'Второй тейк-профит в кратности начального риска. 0 — уровень отключён.',
  },
  'risk.tp3_r': {
    label: 'TP3 (в R)',
    description: 'Третий тейк-профит в кратности начального риска. 0 — уровень отключён.',
  },
  'risk.signal_expiry_bars': {
    label: 'Истечение сигнала (свечей)',
    description:
      'Сигнал в состоянии «Ожидание входа» отменяется, если свеча N+1 так и не появилась за указанное число свечей. 0 — никогда не истекает.',
  },
  'risk.account_quote': {
    label: 'Размер виртуального счёта (USDT)',
    description: 'Виртуальный капитал, используемый для расчёта размера позиции.',
  },
  'risk.risk_pct': {
    label: 'Риск на сделку, %',
    description: 'Процент виртуального счёта, которым рискуем в одном сигнале.',
  },
  'risk.max_concurrent': {
    label: 'Макс. одновременных позиций',
    description: 'Максимум сигналов в состоянии «Открыт» или «Ожидание входа» одновременно.',
  },
  'risk.min_rr': {
    label: 'Минимальный R:R до TP1',
    description: 'Сигналы, у которых R:R до TP1 ниже этого значения, отклоняются.',
  },

  /* ---------------- market ---------------- */
  'market.top_n': {
    label: 'Размер ТОП-N',
    description: 'Сколько пар Binance Spot USDT отслеживается по объёму торгов за 24 часа.',
  },
  'market.quote_asset': {
    label: 'Котируемая валюта',
    description: 'Фильтр котируемой валюты. Архитектурно зафиксирован на USDT.',
  },
  'market.exclude_symbols': {
    label: 'Исключённые пары',
    description:
      'Пары, которые никогда не попадают в ТОП-N (стейблкоины и фиатоподобные). Это настраиваемый фильтр исключений, а НЕ жёстко заданный список ТОП-10.',
  },
  'market.enabled_symbols': {
    label: 'Разрешённые пары',
    description:
      'Ограничить движок этими парами (они всё равно должны быть в ТОП-N). Пусто — торгуется весь ТОП-N. Это фильтр, а не жёстко заданный список.',
  },
  'market.candle_limit': {
    label: 'Свечей за один запрос',
    description: 'Сколько свечей запрашивается у Binance на пару/таймфрейм.',
  },
  'market.refresh_top_minutes': {
    label: 'Обновление ТОП-N (минуты)',
    description: 'Как часто пересчитывается список ТОП-N.',
  },

  /* ---------------- outcome ---------------- */
  'outcome.timeout_bars': {
    label: 'Таймаут (свечей)',
    description: 'Закрыть открытый сигнал по таймауту через указанное число свечей.',
  },
  'outcome.sl_priority_on_ambiguous_bar': {
    label: 'При спорной свече побеждает SL',
    description:
      'Если одна свеча задела и SL, и TP, считать худший вариант (SL). Консервативно и исключает завышение результатов.',
  },
  'outcome.fee_pct': {
    label: 'Комиссия за круг, %',
    description: 'Моделируемая комиссия тейкера, применяемая к результату (вход + выход).',
  },

  /* ---------------- system ---------------- */
  'system.log_retention_rows': {
    label: 'Хранение журнала (строк)',
    description: 'Журнал движка обрезается до указанного количества строк.',
  },
  'system.candle_retention_per_series': {
    label: 'Хранение свечей на серию',
    description: 'Максимум свечей, хранимых для каждой пары и таймфрейма.',
  },
};

/** Russian label for a setting key, falling back to the backend label. */
export function settingLabel(key: string, fallback: string): string {
  return SETTING_RU[key]?.label ?? fallback;
}

/** Russian description for a setting key, falling back to the backend text. */
export function settingDescription(key: string, fallback: string): string {
  return SETTING_RU[key]?.description ?? fallback;
}

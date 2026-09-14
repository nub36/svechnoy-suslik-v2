/**
 * PRESENTATION-ONLY localisation helpers.
 *
 * Hard rule for this module: nothing here may ever be fed back into the API,
 * the database or the engine. Internal identifiers (BTCUSDT, WAITING_ENTRY,
 * FORWARD_TEST, BOS, ...) stay exactly as they are on the wire; these helpers
 * only decide how they are DISPLAYED.
 */

/** Quote assets we know how to split off for a friendly pair name. */
const QUOTES = ['USDT', 'FDUSD', 'USDC', 'BUSD', 'TUSD', 'BTC', 'ETH', 'BNB'];

/**
 * BTCUSDT -> BTC/USDT. Display only — never send this back to the API.
 * Unknown shapes are returned untouched rather than mangled.
 */
export function pairName(symbol: string): string {
  if (!symbol) return '';
  if (symbol.includes('/')) return symbol;
  for (const q of QUOTES) {
    if (symbol.length > q.length && symbol.endsWith(q)) {
      return `${symbol.slice(0, -q.length)}/${q}`;
    }
  }
  return symbol;
}

/** The base asset of a pair, e.g. BTCUSDT -> BTC. */
export function baseOf(symbol: string): string {
  const p = pairName(symbol);
  const i = p.indexOf('/');
  return i === -1 ? p : p.slice(0, i);
}

/**
 * Decimal places that keep a price readable without destroying precision.
 * A coin like REZ at 0.0000123 must NOT round to zero.
 */
export function priceDecimals(v: number): number {
  const a = Math.abs(v);
  if (!Number.isFinite(a) || a === 0) return 2;
  if (a >= 1000) return 2;
  if (a >= 1) return 4;
  if (a >= 0.01) return 5;
  if (a >= 0.0001) return 6;
  return 8;
}

/** Russian price formatting: 77 685,58 — space groups, comma decimal. */
export function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString('ru-RU', {
    minimumFractionDigits: priceDecimals(v),
    maximumFractionDigits: priceDecimals(v),
  });
}

/** Price with a leading $, for the market table. */
export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `$${fmtPrice(v)}`;
}

/** Signed percent, Russian style: +1,07% / -2,31%. */
export function fmtPct(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = v.toLocaleString('ru-RU', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
  return `${v > 0 ? '+' : ''}${s}%`;
}

/** Compact Russian volume: $820,8 млн / $41,9 млн / $1,25 млрд. */
export function fmtVolume(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const one = (n: number, suffix: string): string =>
    `$${n.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${suffix}`;
  if (abs >= 1e12) return one(v / 1e12, 'трлн');
  if (abs >= 1e9) return one(v / 1e9, 'млрд');
  if (abs >= 1e6) return one(v / 1e6, 'млн');
  if (abs >= 1e3) return one(v / 1e3, 'тыс.');
  return `$${v.toLocaleString('ru-RU', { maximumFractionDigits: 0 })}`;
}

/** A plain number in Russian formatting. */
export function fmtNum(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString('ru-RU', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/**
 * Timestamps are epoch milliseconds everywhere (Binance and our DB agree on
 * that). We only change how they are RENDERED — never the stored value.
 */
export function fmtDateTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Short form for dense tables: 14.09 13:45 */
export function fmtShortTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** ISO-ish strings coming from the API (engine log, monitoring). */
export function fmtIsoDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : fmtDateTime(d.getTime());
}

/** "12 с назад" / "3 мин назад" — for heartbeat freshness. */
export function fmtAge(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  if (sec < 60) return `${Math.round(sec)} с назад`;
  if (sec < 3600) return `${Math.round(sec / 60)} мин назад`;
  return `${Math.round(sec / 3600)} ч назад`;
}

/* ------------------------------------------------------------------ *
 * Identifier -> Russian label maps.
 * The KEYS are the internal values and must never change.
 * ------------------------------------------------------------------ */

/** Signal state machine values as stored in the DB. */
export const SIGNAL_STATE_RU: Record<string, string> = {
  WAITING_ENTRY: 'Ожидание входа',
  ACTIVE: 'Открыт',
  OPEN: 'Открыт',
  TP1_HIT: 'TP1 достигнут',
  TP2_HIT: 'TP2 достигнут',
  TP3_HIT: 'TP3 достигнут',
  STOPPED: 'Стоп',
  EXPIRED: 'Истёк',
  CANCELLED: 'Отменён',
  CLOSED_TP: 'Закрыт по TP',
  CLOSED_SL: 'Закрыт по SL',
  CLOSED_TIMEOUT: 'Закрыт по таймауту',
};

/** Outcome result values. */
export const OUTCOME_RU: Record<string, string> = {
  TP: 'TP',
  SL: 'SL',
  TIMEOUT: 'Таймаут',
};

/** Worker health values. */
export const HEALTH_RU: Record<string, string> = {
  OK: 'ОК',
  HEALTHY: 'Работает',
  STALE: 'Устарел',
  DOWN: 'Недоступен',
  MISSING: 'Нет данных',
  DEGRADED: 'Частично',
  UNKNOWN: 'Неизвестно',
  ERROR: 'Ошибка',
  up: 'ОК',
  down: 'Недоступен',
};

/** Worker names. */
export const WORKER_RU: Record<string, string> = {
  market: 'Рыночные данные',
  strategy: 'Стратегия',
  outcome: 'Итоги сделок',
  web: 'Веб-интерфейс',
};

/** Admin settings categories. */
export const CATEGORY_RU: Record<string, string> = {
  engine: 'Движок',
  detectors: 'Smart Money',
  risk: 'Риск',
  market: 'Рынок',
  outcome: 'Итоги',
  system: 'Система',
};

/**
 * Translate a known identifier, falling back to the raw value. The fallback
 * matters: an unmapped state must still be visible for debugging rather than
 * silently rendering as blank.
 */
export function ru(map: Record<string, string>, key: string | null | undefined): string {
  if (!key) return '—';
  return map[key] ?? key;
}

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
 * PRICE PRECISION — ONE RULE FOR THE WHOLE UI
 * ===========================================
 * Every price shown anywhere (market table, chart axis, crosshair, ENTRY/SL/TP
 * labels, /signals, monitoring, replay) goes through this module. There are
 * deliberately no per-page rounding rules: a price must not read 78 590,70 on
 * the chart and 78 590,7 in the table.
 *
 * The authority is Binance PRICE_FILTER `tickSize`, already persisted per
 * symbol in `symbols.tick_size`. tickSize is the smallest increment the
 * exchange itself quotes, so it is exactly the number of decimals worth
 * showing — no more (fake precision), no fewer (lost information).
 *
 *   BTCUSDT  tick 0.01     -> 2 dp -> 78 590,70
 *   XRPUSDT  tick 0.0001   -> 4 dp -> 0,5423
 *   DOGEUSDT tick 0.00001  -> 5 dp -> 0,08440
 *
 * Nothing is hard-coded per symbol. When tickSize is unknown (a symbol not in
 * the current TOP-10, or metadata not loaded yet) we fall back to a
 * magnitude-based heuristic that still refuses to collapse a small price to
 * 0,00.
 */

/** Decimals implied by a Binance tickSize, e.g. 0.00001 -> 5. */
export function decimalsFromTickSize(tickSize: number | null | undefined): number | null {
  if (tickSize === null || tickSize === undefined) return null;
  if (!Number.isFinite(tickSize) || tickSize <= 0) return null;
  // toFixed(12) avoids float artefacts such as 0.00001 -> "1e-5".
  const s = tickSize.toFixed(12).replace(/0+$/, '');
  const dot = s.indexOf('.');
  if (dot === -1) return 0;
  const decimals = s.length - dot - 1;
  // Binance never quotes finer than 8 dp on spot.
  return Math.min(Math.max(decimals, 0), 8);
}

/**
 * Fallback when tickSize is unavailable. Magnitude-based, and deliberately
 * generous for small numbers so a micro-cap never renders as 0,00.
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

/**
 * Decimals to use for a price: tickSize when known, magnitude otherwise.
 * This is the single decision point the rest of the UI relies on.
 */
export function resolvePriceDecimals(
  v: number,
  tickSize?: number | null,
): number {
  const fromTick = decimalsFromTickSize(tickSize);
  if (fromTick !== null) {
    // A very small price under a coarse tick would still collapse to 0,00
    // (e.g. tick 0.01 on a 0.0004 price); widen just enough to stay readable.
    if (v !== 0 && Math.abs(v) < Math.pow(10, -fromTick)) {
      return Math.max(fromTick, priceDecimals(v));
    }
    return fromTick;
  }
  return priceDecimals(v);
}

/**
 * Russian price formatting: 78 590,70 — space groups, comma decimal.
 * Pass the symbol's tickSize whenever it is available.
 */
export function fmtPrice(
  v: number | null | undefined,
  tickSize?: number | null,
): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const dp = resolvePriceDecimals(v, tickSize);
  return v.toLocaleString('ru-RU', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/** Price with a leading $, for the market table. */
export function fmtUsd(
  v: number | null | undefined,
  tickSize?: number | null,
): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `$${fmtPrice(v, tickSize)}`;
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
  v30: 'V3.0 HTF Trap',
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

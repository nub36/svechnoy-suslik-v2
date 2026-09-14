/**
 * Russian presentation helpers.
 *
 * The load-bearing requirement here is that localisation is PRESENTATION ONLY:
 * internal identifiers, API values and timestamps must survive untouched.
 */

import { describe, expect, it } from 'vitest';
import {
  CATEGORY_RU,
  HEALTH_RU,
  OUTCOME_RU,
  SIGNAL_STATE_RU,
  baseOf,
  fmtAge,
  fmtDateTime,
  fmtNum,
  fmtPct,
  fmtPrice,
  fmtShortTime,
  fmtUsd,
  fmtVolume,
  pairName,
  priceDecimals,
  ru,
} from '../app/lib/format';

/** Normalise the non-breaking/narrow spaces that Intl emits. */
const norm = (s: string): string => s.replace(/[\u00a0\u202f]/g, ' ');

describe('pair names', () => {
  it.each([
    ['BTCUSDT', 'BTC/USDT'],
    ['ETHUSDT', 'ETH/USDT'],
    ['SOLUSDT', 'SOL/USDT'],
    ['USD1USDT', 'USD1/USDT'],
    ['ETHBTC', 'ETH/BTC'],
  ])('%s renders as %s', (input, expected) => {
    expect(pairName(input)).toBe(expected);
  });

  it('extracts the base asset', () => {
    expect(baseOf('BTCUSDT')).toBe('BTC');
    expect(baseOf('USD1USDT')).toBe('USD1');
  });

  it('leaves an unrecognised symbol alone rather than mangling it', () => {
    expect(pairName('WEIRD')).toBe('WEIRD');
    expect(pairName('')).toBe('');
  });

  it('is idempotent', () => {
    expect(pairName(pairName('BTCUSDT'))).toBe('BTC/USDT');
  });
});

describe('price precision', () => {
  it('never rounds a cheap coin to zero', () => {
    // The REZ case from the brief.
    expect(fmtPrice(0.0000123)).not.toMatch(/^0,0+$/);
    expect(fmtPrice(0.0000123)).toContain('0,0000123');
    expect(fmtPrice(0.00000456)).toContain('456');
  });

  it('uses more decimals as the price gets smaller', () => {
    expect(priceDecimals(77685)).toBe(2);
    expect(priceDecimals(12.5)).toBe(4);
    expect(priceDecimals(0.05)).toBe(5);
    expect(priceDecimals(0.0005)).toBe(6);
    expect(priceDecimals(0.0000005)).toBe(8);
  });

  it('formats a large price with Russian group separators and a comma', () => {
    const s = norm(fmtPrice(77685.58));
    expect(s).toBe('77 685,58');
  });

  it('prefixes USD prices with $', () => {
    expect(norm(fmtUsd(77685.58))).toBe('$77 685,58');
  });

  it('renders null/NaN as an em dash instead of NaN', () => {
    expect(fmtPrice(null)).toBe('—');
    expect(fmtPrice(Number.NaN)).toBe('—');
    expect(fmtUsd(undefined)).toBe('—');
  });
});

describe('percent', () => {
  it('uses a comma decimal and an explicit plus sign', () => {
    expect(fmtPct(1.07)).toBe('+1,07%');
    expect(fmtPct(-2.31)).toBe('-2,31%');
  });

  it('does not sign zero', () => {
    expect(fmtPct(0)).toBe('0,00%');
  });

  it('handles missing values', () => {
    expect(fmtPct(null)).toBe('—');
  });
});

describe('volume', () => {
  it('renders millions and billions in Russian', () => {
    expect(norm(fmtVolume(820_800_000))).toBe('$820,8 млн');
    expect(norm(fmtVolume(41_900_000))).toBe('$41,9 млн');
    expect(norm(fmtVolume(1_250_000_000))).toBe('$1,3 млрд');
  });

  it('falls back to thousands and plain numbers', () => {
    expect(norm(fmtVolume(41_900))).toBe('$41,9 тыс.');
    expect(norm(fmtVolume(500))).toBe('$500');
  });

  it('handles missing values', () => {
    expect(fmtVolume(null)).toBe('—');
  });
});

describe('numbers', () => {
  it('uses a comma decimal separator', () => {
    expect(fmtNum(1.5)).toBe('1,50');
    expect(fmtNum(-0.125, 3)).toBe('-0,125');
  });
});

describe('dates', () => {
  const ms = Date.UTC(2026, 8, 14, 10, 30); // 14 Sep 2026 10:30 UTC

  it('formats a timestamp in Russian day-first order', () => {
    expect(fmtDateTime(ms)).toMatch(/^\d{2}\.\d{2}\.\d{4}/);
  });

  it('short form omits the year', () => {
    expect(fmtShortTime(ms)).toMatch(/^\d{2}\.\d{2},? \d{2}:\d{2}$/);
  });

  it('does NOT mutate the underlying timestamp', () => {
    const before = ms;
    fmtDateTime(ms);
    fmtShortTime(ms);
    expect(ms).toBe(before);
    // The epoch value is still exactly what Binance/the DB would store.
    expect(new Date(ms).getTime()).toBe(before);
  });

  it('handles missing values', () => {
    expect(fmtDateTime(null)).toBe('—');
    expect(fmtShortTime(undefined)).toBe('—');
  });

  it('formats worker heartbeat ages', () => {
    expect(fmtAge(12)).toBe('12 с назад');
    expect(fmtAge(180)).toBe('3 мин назад');
    expect(fmtAge(7200)).toBe('2 ч назад');
    expect(fmtAge(null)).toBe('—');
  });
});

describe('identifier maps are display-only', () => {
  it.each([
    ['WAITING_ENTRY', 'Ожидание входа'],
    ['OPEN', 'Открыт'],
    ['TP1_HIT', 'TP1 достигнут'],
    ['TP2_HIT', 'TP2 достигнут'],
    ['TP3_HIT', 'TP3 достигнут'],
    ['STOPPED', 'Стоп'],
    ['EXPIRED', 'Истёк'],
  ])('%s displays as %s', (key, label) => {
    expect(ru(SIGNAL_STATE_RU, key)).toBe(label);
  });

  it('the MAP KEYS remain the exact internal identifiers', () => {
    // If a key were ever translated the API contract would break.
    for (const k of Object.keys(SIGNAL_STATE_RU)) {
      expect(k).toMatch(/^[A-Z0-9_]+$/);
    }
    for (const k of Object.keys(OUTCOME_RU)) expect(k).toMatch(/^[A-Z0-9_]+$/);
    for (const k of Object.keys(CATEGORY_RU)) expect(k).toMatch(/^[a-z_]+$/);
  });

  it('falls back to the raw identifier when unmapped', () => {
    // Never render a blank cell: an unknown state must stay debuggable.
    expect(ru(SIGNAL_STATE_RU, 'SOME_NEW_STATE')).toBe('SOME_NEW_STATE');
    expect(ru(HEALTH_RU, 'WEIRD')).toBe('WEIRD');
  });

  it('handles null', () => {
    expect(ru(SIGNAL_STATE_RU, null)).toBe('—');
  });

  it('internal-only machine states are NOT mapped for display', () => {
    // NEUTRAL/EDGE/HOLD/REARM must not leak onto /signals as friendly text.
    for (const internal of ['NEUTRAL', 'EDGE', 'HOLD', 'REARM']) {
      expect(SIGNAL_STATE_RU[internal]).toBeUndefined();
    }
  });
});

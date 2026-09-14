/**
 * LIVE trading must remain locked. These tests are the executable proof.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertAllowedMode,
  assertNoRealExecution,
  canPlaceRealOrders,
  isTradingMode,
  LIVE_TRADING_ENABLED,
  LiveTradingLockedError,
  isPaperTracked,
} from '../src/core/mode';
import { Settings, coerceSettingValue, SETTINGS_BY_KEY } from '../src/core/settings';

describe('LIVE is locked', () => {
  it('the compile-time flag is false', () => {
    expect(LIVE_TRADING_ENABLED).toBe(false);
  });

  it('canPlaceRealOrders() always returns false', () => {
    expect(canPlaceRealOrders()).toBe(false);
  });

  it('assertAllowedMode rejects LIVE', () => {
    expect(() => assertAllowedMode('LIVE')).toThrow(LiveTradingLockedError);
    expect(() => assertAllowedMode('live')).toThrow(LiveTradingLockedError);
  });

  it('assertAllowedMode rejects unknown modes', () => {
    expect(() => assertAllowedMode('PRODUCTION')).toThrow();
    expect(() => assertAllowedMode('')).toThrow();
    expect(() => assertAllowedMode(undefined)).toThrow();
    expect(() => assertAllowedMode(42)).toThrow();
  });

  it('accepts exactly DRY_RUN and FORWARD_TEST', () => {
    expect(assertAllowedMode('DRY_RUN')).toBe('DRY_RUN');
    expect(assertAllowedMode('FORWARD_TEST')).toBe('FORWARD_TEST');
    expect(isTradingMode('DRY_RUN')).toBe(true);
    expect(isTradingMode('FORWARD_TEST')).toBe(true);
    expect(isTradingMode('LIVE')).toBe(false);
  });

  it('assertNoRealExecution always throws', () => {
    expect(() => assertNoRealExecution('test')).toThrow(LiveTradingLockedError);
  });

  it('the settings boundary also rejects LIVE', () => {
    const def = SETTINGS_BY_KEY.get('engine.trading_mode')!;
    expect(() => coerceSettingValue(def, 'LIVE')).toThrow(LiveTradingLockedError);
    expect(coerceSettingValue(def, 'FORWARD_TEST')).toBe('FORWARD_TEST');
  });

  it('a corrupted DB value degrades to DRY_RUN instead of arming LIVE', () => {
    const s = Settings.fromEntries([['engine.trading_mode', 'LIVE']]);
    expect(s.tradingMode()).toBe('DRY_RUN');
  });

  it('FORWARD_TEST is the paper-tracked mode; DRY_RUN is not', () => {
    expect(isPaperTracked('FORWARD_TEST')).toBe(true);
    expect(isPaperTracked('DRY_RUN')).toBe(false);
  });
});

describe('no order-placement code exists', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(p)) out.push(p);
    }
    return out;
  }

  it('no source file calls a Binance trading endpoint', () => {
    const files = [...walk('src'), ...walk('app')];
    const forbidden = [
      '/api/v3/order',
      '/api/v3/openOrders',
      '/sapi/v1/margin/order',
      'newOrderRespType',
      'X-MBX-APIKEY',
    ];
    const hits: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const pat of forbidden) {
        if (src.includes(pat)) hits.push(`${f}: ${pat}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('no API secret is read from the environment', () => {
    const files = [...walk('src'), ...walk('app')];
    const hits: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (/BINANCE_API_SECRET|BINANCE_SECRET_KEY/.test(src)) hits.push(f);
    }
    expect(hits).toEqual([]);
  });
});

describe('forbidden architecture patterns are absent', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(p)) out.push(p);
    }
    return out;
  }

  const files = [...walk('src'), ...walk('app')];

  /**
   * Strip comments and string literals: the architecture docs in this repo
   * legitimately mention the banned concepts in order to state that they are
   * NOT used. We only care about real code.
   */
  function codeOnly(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  }

  it.each([
    ['minExchanges', /minExchanges/],
    ['quorum', /\bquorum\b/i],
    ['exchange voting', /exchangeVot|voteCount|exchangeVote/i],
    ['TradingView tv.js widget', /tv\.js|TradingViewWidget|new\s+TradingView\.widget/],
    ['Smart Money V1/V2 split', /smartMoneyV[12]|SmartMoneyV[12]|smart-money-v[12]/],
  ])('no %s', (_label, re) => {
    const hits = files.filter((f) => re.test(codeOnly(readFileSync(f, 'utf8'))));
    expect(hits).toEqual([]);
  });

  it('uses lightweight-charts, not the TradingView widget', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.dependencies['lightweight-charts']).toBeTruthy();
    expect(Object.keys(pkg.dependencies)).not.toContain('tradingview-widget');
  });
});

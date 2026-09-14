/**
 * Homepage structure, the chart toolbar and Russian localisation.
 *
 * These are source-level assertions rather than a browser render: the sandbox
 * has no Chromium, and the properties we care about (ORDER of the sections,
 * presence of controls, absence of English labels) are statically decidable.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const home = readFileSync('app/page.tsx', 'utf8');
const layout = readFileSync('app/layout.tsx', 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

/** Page components the user actually sees (excludes API routes). */
const PAGES = [
  'app/page.tsx',
  'app/signals/page.tsx',
  'app/monitoring/page.tsx',
  'app/replay/page.tsx',
  'app/admin/page.tsx',
];

describe('homepage order — chart before TOP-10', () => {
  it('the chart panel appears BEFORE the market table in the markup', () => {
    const chart = home.indexOf('data-testid="chart-panel"');
    const table = home.indexOf('data-testid="top-symbols"');
    expect(chart).toBeGreaterThan(-1);
    expect(table).toBeGreaterThan(-1);
    expect(chart).toBeLessThan(table);
  });

  it('the Smart Money evaluation sits between the chart and the table', () => {
    const chart = home.indexOf('data-testid="chart-panel"');
    const evaluation = home.indexOf('Анализ Smart Money');
    const table = home.indexOf('data-testid="top-symbols"');
    expect(chart).toBeLessThan(evaluation);
    expect(evaluation).toBeLessThan(table);
  });

  it('the TOP-10 table is not the hero heading', () => {
    // The old layout opened with an <h1> for the market table.
    expect(home).not.toMatch(/<h1>\s*Markets/);
    expect(home).not.toMatch(/<h1>\s*Рынок/);
  });
});

describe('chart toolbar', () => {
  it('renders the symbol picker inside the toolbar', () => {
    const toolbar = home.indexOf('chart-toolbar');
    const picker = home.indexOf('<SymbolPicker');
    expect(toolbar).toBeGreaterThan(-1);
    expect(picker).toBeGreaterThan(toolbar);
  });

  it('offers all eight timeframe controls', () => {
    const m = home.match(/const TIMEFRAMES = \[(.*?)\] as const/s);
    expect(m).toBeTruthy();
    const tfs = [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(tfs).toEqual(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']);
  });

  it('defaults to BTCUSDT and 15m', () => {
    expect(home).toMatch(/DEFAULT_SYMBOL\s*=\s*'BTCUSDT'/);
    expect(home).toMatch(/DEFAULT_TIMEFRAME:\s*Tf\s*=\s*'15m'/);
    // The defaults are still the fallback, now behind the ?symbol=/?timeframe=
    // deep link used by the «На график» button on /signals.
    expect(home).toMatch(/useState<string>\(initial\.current\.symbol \?\? DEFAULT_SYMBOL\)/);
    expect(home).toMatch(/useState<Tf>\(initial\.current\.timeframe \?\? DEFAULT_TIMEFRAME\)/);
  });

  it('shows the current price and the connection status', () => {
    expect(home).toContain('data-testid="current-price"');
    expect(home).toContain('data-testid="conn-status"');
    expect(home).toMatch(/Цена:/);
  });

  it('the timeframe row can scroll inside its own container on mobile', () => {
    expect(home).toContain('tf-scroll');
    const css = readFileSync('app/globals.css', 'utf8');
    expect(css).toMatch(/\.tf-scroll\s*\{[^}]*overflow-x:\s*auto/s);
  });
});

describe('symbol selector', () => {
  const picker = readFileSync('app/components/SymbolPicker.tsx', 'utf8');

  it('is driven by the backend TOP-10, not a hardcoded list', () => {
    // No literal coin list may appear in the component.
    expect(picker).not.toMatch(/'(BTC|ETH|SOL|XRP|BNB)USDT'/);
    expect(picker).toMatch(/symbols\.map/);
  });

  it('shows friendly pair names plus price and 24h change', () => {
    expect(picker).toContain('pairName(');
    expect(picker).toContain('fmtUsd(');
    expect(picker).toContain('fmtPct(');
  });

  it('selecting a symbol calls back to the page', () => {
    expect(picker).toMatch(/onSelect\(/);
    expect(home).toMatch(/onSelect=\{setSelected\}/);
  });

  it('the TOP-10 table rows also switch the chart', () => {
    expect(home).toMatch(/onClick=\{\(\) => setSelected\(s\.symbol\)\}/);
  });

  it('closes on Escape and on an outside click', () => {
    expect(picker).toMatch(/'Escape'/);
    expect(picker).toMatch(/mousedown/);
  });
});

describe('live data wiring', () => {
  it('the chart subscribes per symbol AND timeframe', () => {
    expect(home).toMatch(/useLiveCandle\(selected,\s*timeframe\)/);
  });

  it('the live candle is passed to the chart as display data', () => {
    expect(home).toMatch(/liveCandle=\{liveForChart\}/);
  });

  it('a stale tick from the previous symbol is discarded', () => {
    // The adapter refuses to emit when the loaded chart no longer matches.
    expect(home).toMatch(/chart\.symbol !== selected \|\| chart\.timeframe !== timeframe/);
  });

  it('the chart updates in place instead of rebuilding the series', () => {
    const chart = readFileSync('app/components/CandleChart.tsx', 'utf8');
    expect(chart).toMatch(/candleSeries\.update\(/);
    // The live effect must depend ONLY on liveCandle.
    expect(chart).toMatch(/\}, \[liveCandle\]\);/);
  });
});

describe('Russian navigation', () => {
  it('the html lang is ru', () => {
    expect(layout).toMatch(/<html lang="ru">/);
  });

  it.each([
    ['Рынок', '/'],
    ['Сигналы', '/signals'],
    ['Мониторинг', '/monitoring'],
    ['История', '/replay'],
    ['Админка', '/admin'],
  ])('navigation shows %s', (label, href) => {
    expect(layout).toContain(`href="${href}"`);
    expect(layout).toContain(label);
  });

  it('no English navigation labels remain', () => {
    for (const en of ['>Markets<', '>Signals<', '>Monitoring<', '>Replay<', '>Admin<']) {
      expect(layout).not.toContain(en);
    }
  });
});

describe('Russian page content', () => {
  it.each([
    ['app/page.tsx', ['Анализ Smart Money', 'Расчёт оценки', 'Изменение 24ч', 'Объём 24ч', 'Цена']],
    ['app/signals/page.tsx', ['Сигналы', 'Расчёт оценки', 'Состояние', 'Сигналов пока нет']],
    ['app/monitoring/page.tsx', ['Мониторинг', 'Воркеры', 'Журнал движка']],
    ['app/replay/page.tsx', ['История / Replay', 'Пары', 'Таймфреймы', 'Запустить Replay']],
    ['app/admin/page.tsx', ['Вход в админку', 'Логин', 'Пароль', 'Войти', 'Админка']],
  ])('%s is localised', (file, needles) => {
    const src = readFileSync(file, 'utf8');
    for (const n of needles) expect(src).toContain(n);
  });

  it('every user-facing page contains Cyrillic text', () => {
    for (const p of PAGES) {
      expect(readFileSync(p, 'utf8')).toMatch(/[А-Яа-яЁё]/);
    }
  });

  it('no leftover English UI strings in the primary pages', () => {
    const banned = [
      'Loading chart',
      'Loading markets',
      'Loading…',
      'No signals yet.',
      'Last price',
      '24h quote volume',
      'Score breakdown',
      'Live Smart Money evaluation',
      'Admin login',
      'Sign in',
      'Sign out',
      'Refresh',
      'Historical replay',
      'Saved runs',
    ];
    for (const p of PAGES) {
      const src = readFileSync(p, 'utf8');
      for (const b of banned) {
        expect(src, `${p} still contains "${b}"`).not.toContain(b);
      }
    }
  });

  it('keeps standard trading abbreviations untranslated', () => {
    const signals = readFileSync('app/signals/page.tsx', 'utf8');
    // Column headers and labels that must stay in their standard form.
    for (const keep of ['Entry', 'SL', 'TP1', 'ATR', 'R:R']) {
      expect(signals).toContain(keep);
    }
    // LONG/SHORT are rendered from the raw API value, never translated.
    expect(signals).toMatch(/s\.direction === 'LONG'/);
    expect(signals).not.toMatch(/Длинная|Короткая|Покупка|Продажа/);
  });

  it('direction and mode identifiers are printed verbatim, not mapped', () => {
    const signals = readFileSync('app/signals/page.tsx', 'utf8');
    expect(signals).toContain('{s.direction}');
    expect(signals).toContain('{s.mode}');
  });
});

describe('responsive layout', () => {
  const css = readFileSync('app/globals.css', 'utf8');

  it('the page can never scroll horizontally', () => {
    expect(css).toMatch(/overflow-x:\s*hidden/);
    expect(css).toMatch(/main\s*\{[^}]*overflow-x:\s*hidden/s);
  });

  it('has breakpoints for tablet and phone', () => {
    expect(css).toMatch(/@media \(max-width: 900px\)/);
    expect(css).toMatch(/@media \(max-width: 640px\)/);
  });

  it('wide tables scroll inside their own container', () => {
    expect(css).toMatch(/\.table-scroll\s*\{[^}]*overflow-x:\s*auto/s);
    expect(home).toContain('table-scroll');
  });

  it('the chart still uses a ResizeObserver', () => {
    expect(readFileSync('app/components/CandleChart.tsx', 'utf8')).toMatch(/new ResizeObserver/);
  });
});

describe('removed Smart Money factors stay out of the UI', () => {
  it.each([['CHOCH'], ['EQUAL_LEVELS'], ['VOLUME_IMBALANCE'], ['PREMIUM_DISCOUNT']])(
    '%s appears nowhere in app/',
    (name) => {
      const hits = walk('app').filter((f) => readFileSync(f, 'utf8').includes(name));
      expect(hits).toEqual([]);
    },
  );

  it('the legend fallback lists exactly the seven active factors', () => {
    const m = home.match(/const ACTIVE_FACTORS: LegendEntry\[\] = \[(.*?)\n\];/s);
    expect(m).toBeTruthy();
    const ids = [...m![1]!.matchAll(/detector: '([A-Z_]+)'/g)].map((x) => x[1]);
    expect(ids.sort()).toEqual(
      [
        'BOS',
        'FVG',
        'INTERNAL_STRUCTURE',
        'LIQUIDITY_SWEEP',
        'OB_FVG_CONFLUENCE',
        'ORDER_BLOCK',
        'RANGE_POSITION',
      ].sort(),
    );
  });
});

describe('LIVE stays locked in the UI', () => {
  it('the admin mode selector offers only DRY_RUN and FORWARD_TEST', () => {
    const admin = readFileSync('app/admin/page.tsx', 'utf8');
    expect(admin).toContain('<option value="DRY_RUN">');
    expect(admin).toContain('<option value="FORWARD_TEST">');
    expect(admin).not.toMatch(/<option value="LIVE">/);
  });

  it('the header advertises the lock', () => {
    expect(layout).toMatch(/LIVE ЗАБЛОКИРОВАН/);
  });
});

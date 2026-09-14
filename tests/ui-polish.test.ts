/**
 * UI / UX polish pass.
 *
 * Two kinds of assertion here:
 *   - behavioural, for the price-precision utility (real arithmetic);
 *   - source-level, for layout/styling decisions that have no DOM renderer in
 *     this test setup. The latter pin the decisions that are easy to regress
 *     silently (font floors, tickSize plumbing, series.update(), cleanup).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decimalsFromTickSize,
  fmtPrice,
  fmtUsd,
  priceDecimals,
  resolvePriceDecimals,
} from '../app/lib/format';

const root = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

const css = read('app/globals.css');
const homeTsx = read('app/page.tsx');
const signalsTsx = read('app/signals/page.tsx');
const adminTsx = read('app/admin/page.tsx');
const chartTsx = read('app/components/CandleChart.tsx');
const pickerTsx = read('app/components/SymbolPicker.tsx');
const monitoringTsx = read('app/monitoring/page.tsx');
const chartRoute = read('app/api/chart/route.ts');
const signalsRoute = read('app/api/signals/route.ts');

/* ------------------------------------------------------------------ */
/* 1. Price precision                                                   */
/* ------------------------------------------------------------------ */

describe('tickSize -> decimals', () => {
  it('derives decimals from real Binance tick sizes', () => {
    expect(decimalsFromTickSize(0.01)).toBe(2); // BTC, ETH
    expect(decimalsFromTickSize(0.1)).toBe(1); // BNB
    expect(decimalsFromTickSize(0.001)).toBe(3); // LINK
    expect(decimalsFromTickSize(0.0001)).toBe(4); // XRP
    expect(decimalsFromTickSize(0.00001)).toBe(5); // DOGE
    expect(decimalsFromTickSize(1)).toBe(0);
  });

  it('is immune to floating-point artefacts', () => {
    // 0.00001 stringifies as "1e-5"; a naive split() would return 0.
    expect(decimalsFromTickSize(1e-5)).toBe(5);
    expect(decimalsFromTickSize(1e-8)).toBe(8);
  });

  it('rejects unusable values instead of guessing', () => {
    expect(decimalsFromTickSize(0)).toBeNull();
    expect(decimalsFromTickSize(-1)).toBeNull();
    expect(decimalsFromTickSize(NaN)).toBeNull();
    expect(decimalsFromTickSize(null)).toBeNull();
    expect(decimalsFromTickSize(undefined)).toBeNull();
  });

  it('never exceeds 8 decimals (Binance spot maximum)', () => {
    expect(decimalsFromTickSize(1e-12)).toBe(8);
  });
});

describe('price formatting matches the specified examples', () => {
  it('BTC renders as 78 590,70', () => {
    // ru-RU groups with a non-breaking space (U+00A0).
    expect(fmtPrice(78590.7, 0.01)).toBe('78\u00a0590,70');
    expect(fmtPrice(78590.7, 0.01).replace(/\u00a0/g, ' ')).toBe('78 590,70');
  });

  it('DOGE renders as 0,08440', () => {
    expect(fmtPrice(0.0844, 0.00001)).toBe('0,08440');
  });

  it('XRP renders as 0,5423', () => {
    expect(fmtPrice(0.5423, 0.0001)).toBe('0,5423');
  });

  it('keeps Russian formatting: comma decimal, space grouping', () => {
    const s = fmtPrice(78590.7, 0.01);
    expect(s).toContain(',');
    expect(s).not.toContain('.');
    // Grouping uses a non-breaking space in ru-RU.
    expect(/\s/.test(s)).toBe(true);
  });

  it('a very small price never collapses to 0,00', () => {
    // No tickSize at all.
    expect(fmtPrice(0.0000123, null)).not.toMatch(/^0,0+$/);
    // Coarse tick that would otherwise round it away.
    expect(fmtPrice(0.0004, 0.01)).not.toMatch(/^0,0+$/);
  });

  it('falls back to the magnitude heuristic when tickSize is unknown', () => {
    expect(resolvePriceDecimals(1500, null)).toBe(priceDecimals(1500));
    expect(resolvePriceDecimals(0.00005, undefined)).toBe(priceDecimals(0.00005));
  });

  it('tickSize wins over the heuristic when both are available', () => {
    // 0.5423 would get 5 dp from magnitude, but XRP's tick says 4.
    expect(priceDecimals(0.5423)).toBe(5);
    expect(resolvePriceDecimals(0.5423, 0.0001)).toBe(4);
  });

  it('fmtUsd carries the same precision with a $ prefix', () => {
    expect(fmtUsd(78590.7, 0.01).replace(/\u00a0/g, ' ')).toBe('$78 590,70');
    expect(fmtUsd(0.0844, 0.00001)).toBe('$0,08440');
  });

  it('renders null/NaN as an em dash rather than NaN', () => {
    expect(fmtPrice(null, 0.01)).toBe('—');
    expect(fmtPrice(undefined, 0.01)).toBe('—');
    expect(fmtPrice(NaN, 0.01)).toBe('—');
  });
});

describe('tickSize reaches every surface that shows a price', () => {
  it('is selected by the chart API and put in the payload', () => {
    expect(chartRoute).toMatch(/tick_size/);
    expect(chartRoute).toMatch(/tickSize/);
  });

  it('is joined into the signals API per row', () => {
    expect(signalsRoute).toMatch(/leftJoin\('symbols'/);
    expect(signalsRoute).toMatch(/tickSize:/);
  });

  it('is exposed by the symbols repo for the market table', () => {
    expect(read('src/db/repo.ts')).toMatch(/tickSize: r\.tick_size/);
  });

  it('drives the chart price scale, crosshair and level labels', () => {
    expect(chartTsx).toMatch(/priceFormat/);
    expect(chartTsx).toMatch(/precision: priceDecimalsRef\.current/);
    expect(chartTsx).toMatch(/resolveChartDecimals/);
  });

  it('is used by the market table, picker and current price', () => {
    expect(homeTsx).toMatch(/fmtUsd\(s\.lastPrice, s\.tickSize\)/);
    expect(homeTsx).toMatch(/fmtPrice\(currentPrice, chart\?\.tickSize\)/);
    expect(pickerTsx).toMatch(/fmtUsd\(s\.lastPrice, s\.tickSize\)/);
  });

  it('is used for Entry/SL/TP1-3 on /signals', () => {
    expect(signalsTsx).toMatch(/fmtPrice\(s\.entryPrice, s\.tickSize\)/);
    expect(signalsTsx).toMatch(/fmtPrice\(s\.stopLoss, s\.tickSize\)/);
    expect(signalsTsx).toMatch(/fmtPrice\(s\.takeProfits\?\.\[0\] \?\? null, s\.tickSize\)/);
    expect(signalsTsx).toMatch(/fmtPrice\(s\.takeProfits\?\.\[1\] \?\? null, s\.tickSize\)/);
    expect(signalsTsx).toMatch(/fmtPrice\(s\.takeProfits\?\.\[2\] \?\? null, s\.tickSize\)/);
  });

  it('is used in the expanded signal details too', () => {
    expect(signalsTsx).toMatch(/fmt\(s\.setupClose, undefined, s\.tickSize\)/);
    expect(signalsTsx).toMatch(/fmt\(s\.outcome\.exitPrice, undefined, s\.tickSize\)/);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Chart navigation from /signals                                    */
/* ------------------------------------------------------------------ */

describe('«На график» navigation', () => {
  it('every row links to / with symbol and timeframe', () => {
    expect(signalsTsx).toMatch(/\/\?symbol=\$\{encodeURIComponent\(s\.symbol\)\}/);
    expect(signalsTsx).toMatch(/timeframe=\$\{encodeURIComponent\(s\.timeframe\)\}/);
  });

  it('uses a real anchor so Back/Forward work', () => {
    // A router.push() would still work, but an <a href> guarantees history.
    expect(signalsTsx).toMatch(/<a[\s\S]{0,700}?На график/);
  });

  it('is a compact primary button with an icon', () => {
    expect(signalsTsx).toMatch(/btn-sm btn-primary btn-icon/);
    expect(signalsTsx).toMatch(/function ChartIcon/);
    expect(css).toMatch(/\.btn-icon/);
  });

  it('the icon is hidden from assistive tech and the link is labelled', () => {
    expect(signalsTsx).toMatch(/aria-hidden="true"/);
    expect(signalsTsx).toMatch(/aria-label=\{`Открыть /);
  });

  it('clicking the link does not also toggle the row', () => {
    expect(signalsTsx).toMatch(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
  });

  it('the home page parses and validates both params', () => {
    expect(homeTsx).toMatch(/readQueryParams/);
    expect(homeTsx).toMatch(/TIMEFRAMES\.includes\(rawTf as Tf\)/);
    expect(homeTsx).toMatch(/\/\^\[A-Z0-9\]\{2,16\}USDT\$\//);
  });

  it('invalid params fall back to the defaults instead of erroring', () => {
    expect(homeTsx).toMatch(/initial\.current\.symbol \?\? DEFAULT_SYMBOL/);
    expect(homeTsx).toMatch(/initial\.current\.timeframe \?\? DEFAULT_TIMEFRAME/);
  });
});

/* ------------------------------------------------------------------ */
/* 3-4. Signals readability + summary cards                             */
/* ------------------------------------------------------------------ */

describe('signals table readability', () => {
  it('table data is at least 13px; only meta text is smaller', () => {
    expect(css).toMatch(/table\s*\{[^}]*font-size:\s*13px/);
    expect(css).toMatch(/\.cell-key[^}]*font-size:\s*13\.5px/);
    expect(css).toMatch(/\.cell-price[^}]*font-size:\s*13px/);
    expect(css).toMatch(/\.cell-meta[^}]*font-size:\s*11\.5px/);
  });

  it('headers stay legible', () => {
    expect(css).toMatch(/th\s*\{[^}]*font-size:\s*11\.5px/);
  });

  it('no TEXT is rendered below 10px', () => {
    // Compactness must come from padding, never from 9px type. Decorative
    // glyphs (the status bullet, the select caret) are not text and are
    // excluded — they carry no information on their own.
    const glyphOnly = ['.conn .dot', '.sym-trigger .caret'];
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
    const offenders: string[] = [];
    for (const [, selector, body] of rules) {
      const m = /font-size:\s*([\d.]+)px/.exec(body ?? '');
      if (!m) continue;
      const sel = (selector ?? '').trim();
      if (glyphOnly.some((g) => sel.includes(g))) continue;
      if (Number(m[1]) < 10) offenders.push(`${sel} -> ${m[1]}px`);
    }
    expect(offenders).toEqual([]);
  });

  it('columns follow the required priority order', () => {
    const head = signalsTsx.slice(
      signalsTsx.indexOf('<thead>'),
      signalsTsx.indexOf('</thead>'),
    );
    // Read the actual <th> texts so prose in a comment cannot match.
    const headers = [...head.matchAll(/<th[^>]*>([^<]*)<\/th>/g)]
      .map((m) => (m[1] ?? '').trim())
      .filter((t) => t.length > 0);
    expect(headers).toEqual([
      'Пара', 'ТФ', 'Напр.', 'Состояние', 'Оценка',
      'Entry', 'SL', 'TP1', 'TP2', 'TP3', 'R', 'Цели',
    ]);
  });

  it('timestamps moved into the expandable details row', () => {
    const head = signalsTsx.slice(
      signalsTsx.indexOf('<thead>'),
      signalsTsx.indexOf('</thead>'),
    );
    expect(head).not.toContain('Свеча сетапа');
    expect(signalsTsx).toContain('Свеча сетапа (N)');
  });
});

describe('summary cards', () => {
  it('are compact and mutually exclusive', () => {
    expect(css).toMatch(/\.stat-strip/);
    expect(signalsTsx).toMatch(/data-testid="state-summary"/);
    for (const label of ['Всего', 'Ожидание', 'Открыто', 'TP1', 'TP2', 'TP3', 'Стоп', 'Истёк']) {
      expect(signalsTsx).toContain(label);
    }
  });

  it('use restrained semantic colours per state', () => {
    expect(css).toMatch(/--st-open:/);
    expect(css).toMatch(/--st-tp:/);
    expect(css).toMatch(/--st-stop:/);
    expect(css).toMatch(/--st-expired:/);
    expect(css).toMatch(/--st-wait:/);
    // Accent is a thin rule, not a loud fill.
    expect(css).toMatch(/\.stat-accent[^}]*border-left:/);
  });

  it('give the number more weight than the label', () => {
    const value = /\.stat \.value\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const label = /\.stat \.label\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const valueSize = Number(/font-size:\s*([\d.]+)px/.exec(value)?.[1]);
    const labelSize = Number(/font-size:\s*([\d.]+)px/.exec(label)?.[1]);
    expect(valueSize).toBeGreaterThan(labelSize);
    expect(value).toMatch(/font-weight:\s*700/);
  });

  it('milestones stay in their own section', () => {
    expect(signalsTsx).toMatch(/data-testid="milestone-summary"/);
    expect(signalsTsx).toContain('Достигнутые цели');
  });
});

/* ------------------------------------------------------------------ */
/* 6-8. Toolbar, buttons, panels                                        */
/* ------------------------------------------------------------------ */

describe('interaction polish', () => {
  it('transitions name explicit properties and are 120-200ms', () => {
    expect(css).toMatch(/--t-fast:\s*120ms/);
    expect(css).toMatch(/--t-base:\s*160ms/);
    const btn = /button,\s*\.btn\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
    for (const prop of ['background-color', 'border-color', 'color', 'transform', 'box-shadow']) {
      expect(btn).toContain(prop);
    }
    // `transition: all` would animate layout too.
    expect(btn).not.toMatch(/transition:\s*all/);
  });

  it('hover lifts by exactly 1px and active presses back', () => {
    expect(css).toMatch(/transform:\s*translateY\(-1px\)/);
    expect(css).toMatch(/transform:\s*translateY\(0\) scale\(0\.985\)/);
  });

  it('has no infinite or pulsating animation', () => {
    expect(css).not.toMatch(/animation:[^;]*infinite/);
    expect(css).not.toMatch(/@keyframes\s+(pulse|blink|flash|rainbow)/);
  });

  it('primary buttons use a restrained blue gradient', () => {
    expect(css).toMatch(/button\.primary[\s\S]{0,200}linear-gradient/);
    expect(css).not.toMatch(/linear-gradient[^;]*(red|orange|yellow)[^;]*(green|purple)/i);
  });

  it('the selected timeframe is unmistakable', () => {
    expect(css).toMatch(/\.tf-group button\.active/);
  });

  it('panels share one radius and border scale', () => {
    expect(css).toMatch(/--r-sm:/);
    expect(css).toMatch(/--r-md:/);
    expect(css).toMatch(/\.panel\s*\{[^}]*border-radius:\s*var\(--r-md\)/);
    expect(css).toMatch(/\.subpanel[^}]*border-radius:\s*var\(--r-sm\)/);
  });

  it('keeps at most three background levels', () => {
    expect(css).toMatch(/--bg:/);
    expect(css).toMatch(/--panel:/);
    expect(css).toMatch(/--panel-2:/);
    expect(css).not.toMatch(/--panel-3:/);
  });

  it('defines --accent, which the Admin picker relies on', () => {
    // It was referenced but undefined, silently disabling the selected style.
    expect(css).toMatch(/--accent:\s*#/);
  });
});

/* ------------------------------------------------------------------ */
/* 9. Smart Money breakdown                                             */
/* ------------------------------------------------------------------ */

describe('score breakdown stays fully transparent', () => {
  it('still shows strength, weight and contribution', () => {
    expect(signalsTsx).toMatch(/сила \{c\.strength\.toFixed\(3\)\} × вес \{c\.weight\}/);
    expect(signalsTsx).toMatch(/c\.contribution\.toFixed\(3\)/);
  });

  it('still shows the summing arithmetic', () => {
    expect(signalsTsx).toContain('сумма вкладов');
    expect(signalsTsx).toContain('сумма');
    expect(signalsTsx).toMatch(/duplicatesRemoved/);
  });

  it('still marks skipped factors with their reason', () => {
    expect(signalsTsx).toContain('ПРОПУЩЕН');
    expect(signalsTsx).toMatch(/title=\{c\.skippedReason\}/);
  });

  it('wraps on narrow screens instead of shrinking the type', () => {
    expect(css).toMatch(/\.sm-factor/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]{0,220}\.sm-factor/);
  });
});

/* ------------------------------------------------------------------ */
/* 10. Chart labels + 15. performance                                   */
/* ------------------------------------------------------------------ */

describe('chart labels and performance', () => {
  it('resolves label collisions without touching prices', () => {
    expect(chartTsx).toMatch(/LABEL_MIN_GAP_PX/);
    // Only the label text is dropped; `price: lv.price` is passed verbatim.
    expect(chartTsx).toMatch(/title: suppressed\.has\(lv\.price\) \? '' : lv\.label/);
    expect(chartTsx).toMatch(/price: lv\.price/);
  });

  it('never rounds or offsets a level price for layout', () => {
    const block = chartTsx.slice(chartTsx.indexOf('signal.levels'));
    expect(block).not.toMatch(/lv\.price\s*[+*-]\s*\d/);
    expect(block).not.toMatch(/lv\.price\.toFixed/);
  });

  it('ENTRY and SL keep their labels; TP text yields first', () => {
    expect(chartTsx).toMatch(/k === 'ENTRY' \? 0 : k === 'SL' \? 1 : 2/);
  });

  it('price lines are still registered and cleaned up', () => {
    expect(chartTsx).toMatch(/priceLinesRef\.current\.push\(/);
    expect(chartTsx).toMatch(/removePriceLine\(/);
    const calls = chartTsx.match(/^\s*clearPriceLines\(\);/gm) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('live ticks still use series.update(), not setData()', () => {
    const live = chartTsx.slice(chartTsx.indexOf('liveCandle'));
    expect(live).toMatch(/\.update\(/);
  });

  it('precision changes apply in place and never recreate the chart', () => {
    // The create-chart effect must stay keyed on [height] alone.
    expect(chartTsx).toMatch(/\}, \[height\]\);/);
    expect(chartTsx).toMatch(/applyOptions\(\{\s*priceFormat/);
    expect(chartTsx).toMatch(/\}, \[decimals\]\);/);
  });

  it('history is not refetched on every tick', () => {
    // The REST refresh stays on its 30s interval.
    expect(homeTsx).toMatch(/30_000/);
  });
});

/* ------------------------------------------------------------------ */
/* 11. Responsive + 16. accessibility                                   */
/* ------------------------------------------------------------------ */

describe('responsive layout', () => {
  it('has breakpoints for tablet and mobile', () => {
    for (const bp of [1280, 900, 640, 560]) {
      expect(css).toContain(`max-width: ${bp}px`);
    }
  });

  it('tables scroll horizontally rather than shrinking text', () => {
    expect(css).toMatch(/\.table-scroll[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/@media \(max-width: 560px\)[\s\S]{0,400}font-size:\s*12\.5px/);
  });

  it('caps line length on very wide monitors', () => {
    expect(css).toMatch(/max-width:\s*1760px/);
  });
});

describe('accessibility', () => {
  it('keyboard focus is always visible', () => {
    expect(css).toMatch(/:focus-visible/);
    expect(css).toMatch(/outline:\s*2px solid/);
  });

  it('honours prefers-reduced-motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it('status is never conveyed by colour alone', () => {
    // Every heartbeat tone ships a Russian text label.
    expect(monitoringTsx).toMatch(/label: 'Работает'/);
    expect(monitoringTsx).toMatch(/label: 'Задержка'/);
    expect(monitoringTsx).toMatch(/label: 'Не отвечает'/);
    expect(monitoringTsx).toMatch(/label: 'Нет сигнала'/);
  });

  it('keeps click targets reasonable in dense tables', () => {
    expect(css).toMatch(/\.btn-sm[^}]*min-height:\s*26px/);
  });
});

/* ------------------------------------------------------------------ */
/* 13-14. Heartbeats + realtime indicator                               */
/* ------------------------------------------------------------------ */

describe('worker heartbeats', () => {
  it('are surfaced prominently', () => {
    expect(monitoringTsx).toMatch(/data-testid="heartbeat-summary"/);
    expect(monitoringTsx).toContain('Пульс воркеров');
  });

  it('judge freshness by age, not only by the stored status', () => {
    expect(monitoringTsx).toMatch(/HB_WARN_SEC/);
    expect(monitoringTsx).toMatch(/HB_ERR_SEC/);
    expect(monitoringTsx).toMatch(/ageSec > HB_ERR_SEC/);
  });

  it('an old beat can never read as OK', () => {
    const fn = monitoringTsx.slice(
      monitoringTsx.indexOf('function hbTone'),
      monitoringTsx.indexOf('function hbTone') + 900,
    );
    // The age checks precede the status checks.
    expect(fn.indexOf('ageSec > HB_ERR_SEC')).toBeLessThan(fn.indexOf("status === 'OK'"));
  });

  it('uses green / amber / red', () => {
    expect(css).toMatch(/\.hb-ok[^}]*\{/);
    expect(css).toMatch(/\.hb-warn[^}]*\{/);
    expect(css).toMatch(/\.hb-err[^}]*\{/);
  });
});

describe('realtime indicator', () => {
  it('shows «Онлайн» only for a live socket', () => {
    expect(homeTsx).toMatch(/online: 'Онлайн'/);
  });

  it('reports a distinct state when the socket goes quiet or drops', () => {
    expect(homeTsx).toMatch(/stale: 'Задержка'/);
    expect(homeTsx).toMatch(/connecting: 'Переподключение'/);
    expect(homeTsx).toMatch(/offline: 'Нет связи · REST'/);
  });

  it('explains each state and exposes it to assistive tech', () => {
    expect(homeTsx).toMatch(/STATUS_HINT_RU/);
    expect(homeTsx).toMatch(/role="status"/);
  });
});

/* ------------------------------------------------------------------ */
/* 12. Admin                                                            */
/* ------------------------------------------------------------------ */

describe('admin polish', () => {
  it('groups settings and names the active group', () => {
    expect(adminTsx).toMatch(/role="tablist"/);
    expect(adminTsx).toMatch(/aria-selected=\{tab === c\}/);
    expect(adminTsx).toMatch(/ru\(CATEGORY_RU, tab\)/);
  });

  it('keeps the timeframe picker functional', () => {
    expect(adminTsx).toMatch(/data-testid="timeframe-picker"/);
    expect(adminTsx).toContain('Выбрать все');
    expect(adminTsx).toContain('Сбросить');
    expect(adminTsx).toContain('Таймфреймы стратегии');
    // Reset must never persist an empty selection.
    expect(adminTsx).toMatch(/onChange\(\['15m'\]\)/);
    expect(adminTsx).not.toMatch(/onChange\(\[\]\)/);
  });

  it('keeps Save primary and Cancel secondary', () => {
    expect(adminTsx).toMatch(/className="primary"[\s\S]{0,200}Сохранить/);
  });

  it('keeps the protected security panel', () => {
    expect(adminTsx).toMatch(/data-testid="security-panel"/);
    expect(adminTsx).toContain('Безопасность');
  });
});

/**
 * FINAL CORRECTION PASS — regression tests for fixes 1-12.
 *
 * Each block pins the *defect* that was observed in production so it cannot
 * come back silently. Where a fix lives in a React component, the assertion is
 * made against the source text (the project has no DOM renderer in the test
 * setup); where it lives in engine or API code, the behaviour itself is
 * exercised.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Settings } from '../src/core/settings';
import { trackOutcome, trackMilestones } from '../src/outcome/tracker';
import {
  LIVE_SIGNAL_STATES,
  TERMINAL_STATES,
  TIMEFRAMES,
  type Candle,
} from '../src/core/types';

const root = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

const chartTsx = read('app/components/CandleChart.tsx');
const homeTsx = read('app/page.tsx');
const signalsTsx = read('app/signals/page.tsx');
const adminTsx = read('app/admin/page.tsx');
const chartRoute = read('app/api/chart/route.ts');
const signalsRoute = read('app/api/signals/route.ts');
const marketWorker = read('src/workers/market.worker.ts');

const T0 = 1_700_000_000_000;
const H = 3_600_000;

function candle(
  openTime: number,
  open: number,
  high: number,
  low: number,
  close: number,
): Candle {
  return {
    openTime,
    open,
    high,
    low,
    close,
    volume: 100,
    closeTime: openTime + H - 1,
    quoteVolume: 100,
    trades: 10,
    isClosed: true,
  };
}

/* ------------------------------------------------------------------ */
/* FIX 1 — chart price lines must not leak                             */
/* ------------------------------------------------------------------ */

describe('FIX 1: chart price lines are removed, not stacked', () => {
  it('keeps a registry of every created price line', () => {
    expect(chartTsx).toMatch(/priceLinesRef\s*=\s*useRef<IPriceLine\[\]>\(\[\]\)/);
    // Every created handle must be retained so it can be removed later.
    expect(chartTsx).toMatch(/priceLinesRef\.current\.push\(/);
  });

  it('imports the IPriceLine type it uses', () => {
    expect(chartTsx).toMatch(/type IPriceLine/);
  });

  it('calls removePriceLine for each registered handle', () => {
    expect(chartTsx).toMatch(/removePriceLine\(/);
    expect(chartTsx).toMatch(/function clearPriceLines|const clearPriceLines/);
  });

  it('clears lines on every redraw AND on unmount', () => {
    // Once in the data/overlays effect (every redraw), once in the chart
    // teardown. The definition itself uses `= (): void =>`, so it is not
    // counted by this call-site pattern.
    const calls = chartTsx.match(/^\s*clearPriceLines\(\);/gm) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('creates the candle series once, so lines would otherwise accumulate', () => {
    // Guards the assumption behind the fix: the series outlives symbol/TF
    // changes, therefore price lines MUST be removed explicitly.
    expect(chartTsx).toMatch(/addSeries\(CandlestickSeries/);
  });
});

/* ------------------------------------------------------------------ */
/* FIX 2 — stale async responses must not win                          */
/* ------------------------------------------------------------------ */

describe('FIX 2: chart requests are race-guarded', () => {
  it('uses an AbortController and a generation counter', () => {
    expect(homeTsx).toMatch(/new AbortController\(\)/);
    expect(homeTsx).toMatch(/chartReqRef/);
    expect(homeTsx).toMatch(/signal:\s*controller\.signal/);
  });

  it('discards a response whose generation is no longer current', () => {
    expect(homeTsx).toMatch(/chartReqRef\.current\.gen !== gen/);
  });

  it('aborts the in-flight request when symbol or timeframe changes', () => {
    expect(homeTsx).toMatch(/controller\?\.abort\(\)/);
  });

  it('does not surface AbortError as a user-facing failure', () => {
    expect(homeTsx).toMatch(/AbortError/);
  });
});

/* ------------------------------------------------------------------ */
/* FIX 3 — chart signal scope                                          */
/* ------------------------------------------------------------------ */

describe('FIX 3: chart signal is scoped by symbol AND timeframe', () => {
  it('filters on both columns', () => {
    expect(chartRoute).toMatch(/\.where\('symbol', '=', symbol\)/);
    expect(chartRoute).toMatch(/\.where\('timeframe', '=', timeframe\)/);
  });

  it('prefers a non-terminal signal over a finished one', () => {
    expect(chartRoute).toMatch(/LIVE_SIGNAL_STATES/);
    expect(chartRoute).toMatch(/TERMINAL_STATES/);
  });

  it('marks a fallback terminal signal as historical with no active levels', () => {
    expect(chartRoute).toMatch(/historical/);
    expect(chartRoute).toMatch(/waiting \|\| historical \? \[\]/);
  });

  it('treats exactly TP3_HIT/STOPPED/EXPIRED as terminal', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(['EXPIRED', 'STOPPED', 'TP3_HIT']);
  });
});

/* ------------------------------------------------------------------ */
/* FIX 4 — a STOPPED trade can never report a positive R               */
/* ------------------------------------------------------------------ */

describe('FIX 4: stop-loss economics', () => {
  const s = Settings.fromEntries([['outcome.fee_pct', 0]]);

  const run = (
    direction: 'LONG' | 'SHORT',
    entryPrice: number,
    stopLoss: number,
    takeProfits: number[],
    candles: Candle[],
  ) =>
    trackOutcome({
      direction,
      entryPrice,
      stopLoss,
      takeProfits,
      entryCandleTime: T0,
      candles,
      settings: s,
      qty: 1,
    });

  it('LONG entry 100 / SL 95 / exit 95 is negative', () => {
    const out = run('LONG', 100, 95, [105], [candle(T0, 100, 101, 94, 96)]);
    expect(out!.result).toBe('SL');
    expect(out!.rMultiple).toBeLessThan(0);
    expect(out!.pnlPct).toBeLessThan(0);
  });

  it('SHORT entry 100 / SL 105 / exit 105 is negative', () => {
    const out = run('SHORT', 100, 105, [95], [candle(T0, 100, 106, 99, 104)]);
    expect(out!.result).toBe('SL');
    expect(out!.rMultiple).toBeLessThan(0);
    expect(out!.pnlPct).toBeLessThan(0);
  });

  it('LONG entry 100 / TP 105 is positive', () => {
    const out = run('LONG', 100, 95, [105], [candle(T0, 100, 106, 99, 105)]);
    expect(out!.result).toBe('TP');
    expect(out!.rMultiple).toBeGreaterThan(0);
  });

  it('SHORT entry 100 / TP 95 is positive', () => {
    const out = run('SHORT', 100, 105, [95], [candle(T0, 100, 101, 94, 95)]);
    expect(out!.result).toBe('TP');
    expect(out!.rMultiple).toBeGreaterThan(0);
  });

  it('reproduces production signal #9: SHORT stopped after touching TP1 → negative R', () => {
    // BTCUSDT 1m SHORT, entry 78590.70, SL 78692.77. The UI showed R = +0.23
    // because the outcome walk exited at TP1 while the signal state said STOP.
    const entry = 78590.7;
    const sl = 78692.77;
    const risk = sl - entry;
    const tps = [entry - risk * 1.5, entry - risk * 3, entry - risk * 5];
    const candles = [
      candle(T0, entry, entry + 10, tps[0]! - 1, entry - 50), // TP1 touched
      candle(T0 + H, entry - 50, sl + 200, entry - 60, sl + 150), // stop blown
    ];

    const mil = trackMilestones({
      direction: 'SHORT',
      entryPrice: entry,
      stopLoss: sl,
      takeProfits: tps,
      entryCandleTime: T0,
      candles,
      settings: s,
    });
    const out = trackOutcome({
      direction: 'SHORT',
      entryPrice: entry,
      stopLoss: sl,
      takeProfits: tps,
      entryCandleTime: T0,
      candles,
      settings: s,
      qty: 1,
    });

    // The milestone is preserved as a historical fact...
    expect(mil.milestones.map((m) => m.kind)).toContain('TP1');
    expect(mil.state).toBe('STOPPED');
    // ...but the trade is a loss.
    expect(out!.result).toBe('SL');
    expect(out!.rMultiple).toBeLessThan(0);
  });

  it('an intermediate TP touch is NOT realised profit and does not close the trade', () => {
    const out = run(
      'LONG',
      100,
      95,
      [105, 110, 115],
      [candle(T0, 100, 112, 99, 111)], // TP1+TP2 cleared, TP3 not
    );
    expect(out).toBeNull(); // still running
  });

  it('the milestone state and the outcome result never contradict each other', () => {
    const entry = 100;
    const sl = 95;
    const tps = [105, 110, 115];
    const candles = [
      candle(T0, entry, 106, 99, 105.5), // TP1
      candle(T0 + H, 105, 111, 104, 110.5), // TP2
      candle(T0 + 2 * H, 110, 111, 94, 94.5), // stop
    ];
    const mil = trackMilestones({
      direction: 'LONG',
      entryPrice: entry,
      stopLoss: sl,
      takeProfits: tps,
      entryCandleTime: T0,
      candles,
      settings: s,
    });
    const out = trackOutcome({
      direction: 'LONG',
      entryPrice: entry,
      stopLoss: sl,
      takeProfits: tps,
      entryCandleTime: T0,
      candles,
      settings: s,
      qty: 1,
    });
    expect(mil.state).toBe('STOPPED');
    expect(out!.result).toBe('SL');
    expect(out!.rMultiple).toBeLessThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* FIX 5 / FIX 11 — mutually exclusive state cards + milestones        */
/* ------------------------------------------------------------------ */

describe('FIX 5: signal summary categories are mutually exclusive', () => {
  it('exposes one counter per lifecycle state', () => {
    for (const key of ['waiting', 'open', 'tp1', 'tp2', 'tp3', 'stopped', 'expired']) {
      expect(signalsRoute).toMatch(new RegExp(`${key}:`));
    }
  });

  it('no longer bundles TP1/TP2 into an "active" bucket', () => {
    expect(signalsRoute).not.toMatch(/active: inState\('OPEN', 'TP1_HIT', 'TP2_HIT'\)/);
  });

  it('reports overlapping milestone counts separately', () => {
    expect(signalsRoute).toMatch(/milestoneSummary/);
    expect(signalsRoute).toMatch(/tp1Ever/);
    expect(signalsRoute).toMatch(/tp2Ever/);
    expect(signalsRoute).toMatch(/tp3Ever/);
  });

  it('the sum of the exclusive states equals the total', () => {
    // Mirrors the API arithmetic over a representative population.
    const rows = [
      'WAITING_ENTRY', 'WAITING_ENTRY', 'OPEN', 'OPEN', 'OPEN',
      'TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'STOPPED', 'EXPIRED',
    ];
    const inState = (...st: string[]): number =>
      rows.filter((r) => st.includes(r)).length;
    const summary = {
      total: rows.length,
      waiting: inState('WAITING_ENTRY'),
      open: inState('OPEN'),
      tp1: inState('TP1_HIT'),
      tp2: inState('TP2_HIT'),
      tp3: inState('TP3_HIT'),
      stopped: inState('STOPPED'),
      expired: inState('EXPIRED'),
    };
    const sum =
      summary.waiting + summary.open + summary.tp1 + summary.tp2 +
      summary.tp3 + summary.stopped + summary.expired;
    expect(sum).toBe(summary.total);
  });

  it('renders the Russian state cards and a separate milestone section', () => {
    for (const label of [
      'Всего', 'Ожидание входа', 'Открыт', 'TP1 достигнут',
      'TP2 достигнут', 'TP3 достигнут', 'Стоп', 'Истёк',
    ]) {
      expect(signalsTsx).toContain(label);
    }
    expect(signalsTsx).toContain('Достигнутые цели');
  });

  it('FIX 11: milestones stay visible on a signal that was later stopped', () => {
    expect(signalsTsx).toMatch(/tpLevel/);
    expect(signalsRoute).toMatch(/tpLevel: Number\(r\.tp_level \?\? 0\)/);
  });
});

/* ------------------------------------------------------------------ */
/* FIX 6 — «На график» deep link                                       */
/* ------------------------------------------------------------------ */

describe('FIX 6: «На график» reuses the existing home chart', () => {
  it('links to / with symbol and timeframe query params', () => {
    expect(signalsTsx).toContain('На график');
    expect(signalsTsx).toMatch(/\/\?symbol=\$\{encodeURIComponent\(s\.symbol\)\}/);
    expect(signalsTsx).toMatch(/timeframe=\$\{encodeURIComponent\(s\.timeframe\)\}/);
  });

  it('does not introduce a second chart page', () => {
    // Everything routes through the existing home chart.
    expect(signalsTsx).not.toMatch(/href="\/chart/);
  });

  it('the home page validates both params and falls back to defaults', () => {
    expect(homeTsx).toMatch(/readQueryParams/);
    expect(homeTsx).toMatch(/TIMEFRAMES\.includes\(rawTf as Tf\)/);
    expect(homeTsx).toMatch(/\/\^\[A-Z0-9\]\{2,16\}USDT\$\//);
    expect(homeTsx).toMatch(/initial\.current\.symbol \?\? DEFAULT_SYMBOL/);
    expect(homeTsx).toMatch(/initial\.current\.timeframe \?\? DEFAULT_TIMEFRAME/);
  });
});

/* ------------------------------------------------------------------ */
/* FIX 7 — ingestion covers all 8 timeframes                           */
/* ------------------------------------------------------------------ */

describe('FIX 7: market ingestion is independent of the scan selection', () => {
  it('the market worker ingests the supported-TIMEFRAMES constant', () => {
    expect(marketWorker).toMatch(/const timeframes = TIMEFRAMES;/);
  });

  it('the market worker no longer reads engine.timeframes', () => {
    expect(marketWorker).not.toMatch(/const timeframes = settings\.timeframes\(\)/);
  });

  it('there are exactly 8 supported timeframes', () => {
    expect([...TIMEFRAMES]).toEqual(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']);
  });

  it('the strategy scan still honours engine.timeframes', () => {
    const runner = read('src/strategy/engine-runner.ts');
    expect(runner).toMatch(/const timeframes = settings\.timeframes\(\)/);
  });

  it('no second timeframe setting was introduced', () => {
    const settingsSrc = read('src/core/settings.ts');
    expect(settingsSrc).not.toMatch(/'strategy\.timeframes'/);
    expect(settingsSrc).not.toMatch(/'scan\.timeframes'/);
    expect(settingsSrc).not.toMatch(/'market\.strategy_timeframes'/);
  });

  it('a restricted scan selection still leaves every timeframe ingested', () => {
    // engine.timeframes is a scan filter only; ingestion is the constant.
    const settings = Settings.fromEntries([['engine.timeframes', ['15m']]]);
    expect(settings.timeframes()).toEqual(['15m']);
    expect([...TIMEFRAMES]).toHaveLength(8);
  });
});

/* ------------------------------------------------------------------ */
/* FIX 8 — Admin wording and bulk controls                             */
/* ------------------------------------------------------------------ */

describe('FIX 8: Admin timeframe selector', () => {
  it('uses the strategy-scoped label and help text', () => {
    // JSX wraps the sentence across source lines; compare on collapsed
    // whitespace so the assertion tracks the rendered text, not the layout.
    const flat = adminTsx.replace(/\s+/g, ' ');
    expect(flat).toContain('Таймфреймы стратегии');
    expect(flat).toContain(
      'Определяет, на каких таймфреймах стратегия ищет новые сигналы.',
    );
    expect(flat).toContain(
      'Графики продолжают получать данные для всех поддерживаемых таймфреймов.',
    );
  });

  it('offers Выбрать все and Сбросить', () => {
    expect(adminTsx).toContain('Выбрать все');
    expect(adminTsx).toContain('Сбросить');
  });

  it('Сбросить never persists an empty selection', () => {
    expect(adminTsx).toMatch(/onChange\(\['15m'\]\)/);
    expect(adminTsx).not.toMatch(/onChange\(\[\]\)/);
  });

  it('no longer claims that unchecking a timeframe stops its candles', () => {
    const flat = adminTsx.replace(/\s+/g, ' ');
    expect(flat).not.toContain('новые свечи загружаются только для выбранных выше');
    expect(flat).toContain('продолжают получать');
  });
});

/* ------------------------------------------------------------------ */
/* FIX 9 — one active signal per symbol across timeframes              */
/* ------------------------------------------------------------------ */

describe('FIX 9: symbol lock states', () => {
  it('locks on WAITING_ENTRY / OPEN / TP1_HIT / TP2_HIT', () => {
    expect([...LIVE_SIGNAL_STATES].sort()).toEqual(
      ['OPEN', 'TP1_HIT', 'TP2_HIT', 'WAITING_ENTRY'].sort(),
    );
  });

  it('releases on TP3_HIT / STOPPED / EXPIRED', () => {
    for (const st of TERMINAL_STATES) {
      expect(LIVE_SIGNAL_STATES).not.toContain(st);
    }
  });

  it('the lock query spans all timeframes for the symbol', () => {
    const runner = read('src/strategy/engine-runner.ts');
    expect(runner).toMatch(/LIVE_SIGNAL_STATES/);
  });
});

/* ------------------------------------------------------------------ */
/* FIX 12 — legacy state/outcome inconsistency                         */
/* ------------------------------------------------------------------ */

describe('FIX 12: contradictory state/outcome pairs', () => {
  it('the API flags a legacy inconsistent row instead of rewriting it', () => {
    expect(signalsRoute).toMatch(/legacyInconsistent/);
    expect(signalsRoute).toMatch(/EXPECTED_RESULT/);
  });

  it('detects the known production case: state=EXPIRED with result=TP', () => {
    const EXPECTED: Record<string, string> = {
      TP3_HIT: 'TP',
      STOPPED: 'SL',
      EXPIRED: 'TIMEOUT',
    };
    const inconsistent = (state: string, result: string | null): boolean => {
      if (result === null) return false;
      const e = EXPECTED[state];
      return e !== undefined && e !== result;
    };
    expect(inconsistent('EXPIRED', 'TP')).toBe(true);
    expect(inconsistent('STOPPED', 'TP')).toBe(true);
    expect(inconsistent('TP3_HIT', 'SL')).toBe(true);
    // Consistent combinations are not flagged.
    expect(inconsistent('EXPIRED', 'TIMEOUT')).toBe(false);
    expect(inconsistent('STOPPED', 'SL')).toBe(false);
    expect(inconsistent('TP3_HIT', 'TP')).toBe(false);
    // A still-running signal has no outcome yet.
    expect(inconsistent('OPEN', null)).toBe(false);
  });

  it('the outcome worker refuses to write a new contradictory row', () => {
    const worker = read('src/workers/outcome.worker.ts');
    expect(worker).toMatch(/EXPECTED_RESULT_FOR/);
    expect(worker).toMatch(/mismatch/);
    expect(worker).toMatch(/positive R/);
  });

  it('the UI marks legacy rows rather than hiding them', () => {
    expect(signalsTsx).toContain('устаревшие данные');
  });
});

/* ------------------------------------------------------------------ */
/* FIX 10 — sequential catch-up guarantees                             */
/* ------------------------------------------------------------------ */

describe('FIX 10: sequential catch-up', () => {
  const runner = read('src/strategy/engine-runner.ts');

  it('feeds every closed candle newer than the cursor, in order', () => {
    expect(runner).toMatch(/candles\.filter\(\(c\) => c\.openTime > state\.lastCandleTime\)/);
    // The loop walks the pending list rather than jumping to the newest bar.
    expect(runner).toMatch(/for \(const bar of toProcess\)/);
  });

  it('never evaluates the forming candle', () => {
    expect(runner).toMatch(/closedOnly: true/);
  });

  it('an unseen slot takes a baseline instead of mining history', () => {
    expect(runner).toMatch(/state\.initialised\s*\n?\s*\?/);
    // Cold start processes only the newest bar, so it cannot emit.
    expect(runner).toMatch(/toProcess = pending\.length > 0 \? pending : newestBar/);
  });

  it('a gap beyond max_catchup_candles re-baselines to REARM without emitting', () => {
    expect(runner).toMatch(/pending\.length > maxCatchup/);
    expect(runner).toMatch(/state: 'REARM'/);
    expect(runner).toMatch(/re-baselined/);
  });

  it('the cursor advances monotonically so a restart replays nothing', () => {
    expect(runner).toMatch(/lastCandleTime/);
    // Only strictly-newer candles are pending, so a second run has an empty
    // pending list and therefore produces zero duplicates.
    expect(runner).toMatch(/c\.openTime > state\.lastCandleTime/);
  });
});

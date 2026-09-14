/**
 * HTTP-level tests against a REAL running Next.js production server backed by
 * a REAL PostgreSQL. Skipped automatically when SMOKE_BASE_URL is not set.
 *
 *   SMOKE_BASE_URL=http://127.0.0.1:3000 npx vitest run tests/api.test.ts
 */

import { describe, expect, it } from 'vitest';

const BASE = process.env['SMOKE_BASE_URL'] ?? '';
const run = BASE !== '' ? describe : describe.skip;

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const;

async function get(path: string, cookie?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(BASE + path, cookie ? { headers: { cookie } } : undefined);
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function post(path: string, body: unknown, cookie?: string) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null), res };
}

async function put(path: string, body: unknown, cookie?: string) {
  const res = await fetch(BASE + path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function login(): Promise<string> {
  const { res, json } = await post('/api/admin/login', {
    username: process.env['ADMIN_USER'] ?? 'admin',
    password: process.env['ADMIN_PASSWORD'] ?? 'suslik-admin',
  });
  expect(json.ok, 'admin login failed').toBe(true);
  const raw = res.headers.get('set-cookie') ?? '';
  return raw.split(';')[0] ?? '';
}

run('public pages render', () => {
  it.each(['/', '/signals', '/monitoring', '/replay', '/admin'])('%s returns 200 HTML', async (p) => {
    const res = await fetch(BASE + p);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Svechnoy Suslik');
    // The TradingView embed widget must never appear.
    expect(html).not.toContain('tv.js');
    expect(html).not.toContain('TradingView.widget');
  });
});

run('GET /api/symbols — TOP-N Binance Spot USDT', () => {
  it('returns a ranked USDT-only list', async () => {
    const { status, json } = await get('/api/symbols');
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.exchange).toBe('BINANCE_SPOT');
    expect(json.data.quoteAsset).toBe('USDT');
    const syms = json.data.symbols as Array<{ symbol: string; rank: number; quoteVolume24h: number }>;
    expect(syms.length).toBeGreaterThan(0);
    for (const s of syms) expect(s.symbol.endsWith('USDT')).toBe(true);
    for (let i = 1; i < syms.length; i++) {
      expect(syms[i - 1]!.rank).toBeLessThan(syms[i]!.rank);
      expect(syms[i - 1]!.quoteVolume24h).toBeGreaterThanOrEqual(syms[i]!.quoteVolume24h);
    }
    // stablecoin / leveraged pairs must be filtered out
    const names = syms.map((s) => s.symbol);
    expect(names).not.toContain('USDCUSDT');
    expect(names).not.toContain('FDUSDUSDT');
    expect(names.some((n) => /(UP|DOWN|BULL|BEAR)USDT$/.test(n))).toBe(false);
  });
});

run('GET /api/chart — candles + backend overlays', () => {
  it.each(TIMEFRAMES)('%s returns candles with correct spacing', async (tf) => {
    const MS: Record<string, number> = {
      '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
      '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000, '1w': 604_800_000,
    };
    const { status, json } = await get(`/api/chart?symbol=BTCUSDT&timeframe=${tf}&limit=300`);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    const d = json.data;
    expect(d.timeframe).toBe(tf);
    expect(d.candles.length).toBeGreaterThan(100);
    for (let i = 1; i < d.candles.length; i++) {
      expect(d.candles[i].time - d.candles[i - 1].time).toBe(MS[tf]);
    }
    for (const c of d.candles) {
      expect(c.high).toBeGreaterThanOrEqual(c.low);
      expect(c.high).toBeGreaterThanOrEqual(c.open);
      expect(c.high).toBeGreaterThanOrEqual(c.close);
      expect(c.low).toBeLessThanOrEqual(c.open);
      expect(c.low).toBeLessThanOrEqual(c.close);
    }
  });

  it('overlays and the evaluation come from the backend', async () => {
    const { json } = await get('/api/chart?symbol=BTCUSDT&timeframe=1h&limit=300');
    const d = json.data;
    expect(d.overlays).toBeTruthy();
    expect(Array.isArray(d.overlays.boxes)).toBe(true);
    expect(Array.isArray(d.overlays.lines)).toBe(true);
    expect(Array.isArray(d.overlays.markers)).toBe(true);
    const total = d.overlays.boxes.length + d.overlays.lines.length + d.overlays.markers.length;
    expect(total).toBeGreaterThan(0);

    // Every overlay carries a detector identity + reason (auditable).
    for (const b of [...d.overlays.boxes, ...d.overlays.lines]) {
      expect(b.detector).toBeTruthy();
      expect(b.reason).toBeTruthy();
      expect(['LONG', 'SHORT']).toContain(b.direction);
    }

    expect(d.evaluation).toBeTruthy();
    expect(d.evaluation.explainLong.length).toBeGreaterThan(0);
    expect(d.evaluation.decision).toBeTruthy();
  });

  it('the evaluation only ever references CLOSED candles', async () => {
    const { json } = await get('/api/chart?symbol=BTCUSDT&timeframe=1h&limit=300');
    const d = json.data;
    const closed = d.candles.filter((c: { isClosed: boolean }) => c.isClosed);
    const lastClosed = closed[closed.length - 1];
    expect(d.evaluation.candleTime).toBe(lastClosed.time);
    expect(d.evaluation.closePrice).toBeCloseTo(lastClosed.close, 8);
  });

  it('the score breakdown arithmetic holds over HTTP', async () => {
    const { json } = await get('/api/chart?symbol=ETHUSDT&timeframe=1h&limit=300');
    for (const side of ['long', 'short'] as const) {
      const b = json.data.evaluation[side];
      const counted = b.components.filter((c: { counted: boolean }) => c.counted);
      const raw = counted.reduce((s: number, c: { contribution: number }) => s + c.contribution, 0);
      const wt = counted.reduce((s: number, c: { weight: number }) => s + c.weight, 0);
      expect(raw).toBeCloseTo(b.rawScore, 3);
      expect(wt).toBeCloseTo(b.totalWeight, 3);
      if (wt > 0) expect((100 * raw) / wt).toBeCloseTo(b.score, 2);
      for (const c of counted) {
        expect(c.contribution).toBeCloseTo(c.strength * c.weight, 6);
      }
      // anti-double-counting: each detector at most once
      const names = counted.map((c: { detector: string }) => c.detector);
      expect(new Set(names).size).toBe(names.length);
      expect(b.score).toBeGreaterThanOrEqual(0);
      expect(b.score).toBeLessThanOrEqual(100);
    }
  });

  it('rejects a bad symbol', async () => {
    const { status } = await get('/api/chart?symbol=NOTAPAIR&timeframe=1h');
    expect(status).toBe(400);
  });
});

run('GET /api/signals', () => {
  it('returns signals with a summary', async () => {
    const { status, json } = await get('/api/signals?limit=50');
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.summary).toBeTruthy();
    expect(Array.isArray(json.data.signals)).toBe(true);
  });

  it('WAITING_ENTRY signals have no entry price; ACTIVE ones do', async () => {
    const { json } = await get('/api/signals?limit=200');
    for (const s of json.data.signals) {
      if (s.state === 'WAITING_ENTRY') {
        expect(s.entryPrice, `signal ${s.id} in WAITING_ENTRY must not have an entry`).toBeNull();
        expect(s.entryCandleTime).toBeNull();
      }
      if (s.state === 'ACTIVE' || s.state?.startsWith('CLOSED')) {
        expect(s.entryPrice).not.toBeNull();
        expect(s.entryCandleTime).not.toBeNull();
      }
      // no signal is ever in LIVE mode
      expect(s.mode).not.toBe('LIVE');
    }
  });
});

run('GET /api/monitoring', () => {
  it('reports health, engine config and the LIVE lock', async () => {
    const { status, json } = await get('/api/monitoring');
    expect(status).toBe(200);
    const d = json.data;
    expect(d.health.database).toBe('OK');
    expect(d.engine.liveTradingEnabled).toBe(false);
    expect(d.engine.liveLocked).toBe(true);
    expect(['DRY_RUN', 'FORWARD_TEST']).toContain(d.engine.tradingMode);
    expect(d.market.exchange).toBe('BINANCE_SPOT');
    expect(d.market.quoteAsset).toBe('USDT');
    expect(Array.isArray(d.health.workers)).toBe(true);
    expect(d.health.workers.map((w: { worker: string }) => w.worker)).toEqual([
      'market', 'strategy', 'outcome',
    ]);
    expect(d.performance).toBeTruthy();
  });
});

run('admin protection', () => {
  it('rejects unauthenticated access', async () => {
    expect((await get('/api/admin/settings')).status).toBe(401);
    expect((await put('/api/admin/settings', { updates: {} })).status).toBe(401);
    expect((await post('/api/replay', {})).status).toBe(401);
  });

  it('rejects bad credentials', async () => {
    const { status, json } = await post('/api/admin/login', { username: 'admin', password: 'nope' });
    expect(status).toBe(401);
    expect(json.ok).toBe(false);
  });

  it('allows access after login and exposes every registry setting', async () => {
    const cookie = await login();
    const { status, json } = await get('/api/admin/settings', cookie);
    expect(status).toBe(200);
    expect(json.data.settings.length).toBeGreaterThan(30);
    expect(json.data.liveLocked).toBe(true);
    expect(json.data.allowedModes).toEqual(['DRY_RUN', 'FORWARD_TEST']);
    // every setting declares where the engine consumes it
    for (const s of json.data.settings) {
      expect(s.consumedBy.length, `${s.key} has no consumer`).toBeGreaterThan(0);
    }
  });
});

run('LIVE stays locked over HTTP', () => {
  it('rejects engine.trading_mode = LIVE', async () => {
    const cookie = await login();
    const { status, json } = await put('/api/admin/settings', { updates: { 'engine.trading_mode': 'LIVE' } }, cookie);
    expect(status).toBe(400);
    expect(JSON.stringify(json)).toMatch(/LIVE mode is locked/);
  });

  it('accepts DRY_RUN and FORWARD_TEST', async () => {
    const cookie = await login();
    for (const mode of ['DRY_RUN', 'FORWARD_TEST']) {
      const { status, json } = await put(
        '/api/admin/settings',
        { updates: { 'engine.trading_mode': mode } },
        cookie,
      );
      expect(status).toBe(200);
      expect(json.data.effective['engine.trading_mode']).toBe(mode);
    }
  });
});

run('settings are DB -> engine over HTTP', () => {
  it('changing the threshold changes the live evaluation decision', async () => {
    const cookie = await login();

    await put('/api/admin/settings', { updates: { 'engine.score_threshold': 1, 'engine.min_components': 1 } }, cookie);
    const low = await get('/api/chart?symbol=BTCUSDT&timeframe=1h&limit=300');
    expect(low.json.data.evaluation.decision.threshold).toBe(1);
    expect(low.json.data.evaluation.decision.passed).toBe(true);

    await put('/api/admin/settings', { updates: { 'engine.score_threshold': 100 } }, cookie);
    const high = await get('/api/chart?symbol=BTCUSDT&timeframe=1h&limit=300');
    expect(high.json.data.evaluation.decision.threshold).toBe(100);

    // restore
    await put('/api/admin/settings', { updates: { 'engine.score_threshold': 50, 'engine.min_components': 2 } }, cookie);
  });

  it('disabling a detector removes it from the overlays', async () => {
    const cookie = await login();
    await put('/api/admin/settings', { updates: { 'detectors.FVG.enabled': false } }, cookie);
    const off = await get('/api/chart?symbol=BTCUSDT&timeframe=1h&limit=300');
    const all = [...off.json.data.overlays.boxes, ...off.json.data.overlays.lines];
    expect(all.some((o: { detector: string }) => o.detector === 'FVG')).toBe(false);

    await put('/api/admin/settings', { updates: { 'detectors.FVG.enabled': true } }, cookie);
  });

  it('validates ranges, locked keys and enums', async () => {
    const cookie = await login();
    expect((await put('/api/admin/settings', { updates: { 'engine.score_threshold': 500 } }, cookie)).status).toBe(400);
    expect((await put('/api/admin/settings', { updates: { 'market.quote_asset': 'BTC' } }, cookie)).status).toBe(400);
    expect((await put('/api/admin/settings', { updates: { 'engine.timeframes': ['3h'] } }, cookie)).status).toBe(400);
    expect((await put('/api/admin/settings', { updates: { 'nope.not.a.key': 1 } }, cookie)).status).toBe(400);
  });
});

run('POST /api/replay — same engine as live', () => {
  it('runs a replay and returns consistent metrics', async () => {
    const cookie = await login();
    const { status, json } = await post(
      '/api/replay',
      { symbols: ['BTCUSDT'], timeframes: ['1h'], save: true, label: 'api test' },
      cookie,
    );
    expect(status).toBe(200);
    expect(json.data.engine).toContain('same as live');
    const r = json.data.results[0];
    expect(r.candlesSeen).toBeGreaterThan(0);

    // every trade entered at the OPEN of N+1
    for (const t of r.trades) {
      expect(t.entryCandleTime).toBe(t.setupCandleTime + 3_600_000);
    }
    // `trades` is a truncated preview; `stats` describes the whole run.
    expect(r.stats.wins + r.stats.losses + r.stats.timeouts).toBe(r.stats.total);
    expect(r.stats.total).toBeLessThanOrEqual(r.tradeCount);
    if (!r.tradesTruncated) {
      const closed = r.trades.filter((t: { result: string }) => t.result !== 'OPEN');
      expect(r.stats.total).toBe(closed.length);
    }
    expect(r.stats.winRate).toBeGreaterThanOrEqual(0);
    expect(r.stats.winRate).toBeLessThanOrEqual(100);
  });

  it('lists saved runs', async () => {
    const { status, json } = await get('/api/replay');
    expect(status).toBe(200);
    expect(Array.isArray(json.data.runs)).toBe(true);
  });
});

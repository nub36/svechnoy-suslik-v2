import { getDb, ping } from '@/db';
import { sql } from 'kysely';
import { loadSettings } from '@/core/settings';
import { aggregate } from '@/outcome/tracker';
import { listStates } from '@/db/repo';
import { LIVE_TRADING_ENABLED } from '@/core/mode';
import { ok, fail, errorMessage } from '@/web/api-utils';

export const dynamic = 'force-dynamic';

/** System health: workers, DB, engine config, performance, recent logs. */
export async function GET(): Promise<Response> {
  try {
    const db = getDb();
    const dbOk = await ping(db);
    const settings = await loadSettings(db);

    const [heartbeats, states, symbolCount, candleStats, signalCounts, outcomeRows, logs] =
      await Promise.all([
        db.selectFrom('worker_heartbeats').selectAll().execute(),
        listStates(db),
        db
          .selectFrom('symbols')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('enabled', '=', true)
          .executeTakeFirst(),
        sql<{ timeframe: string; symbols: number; candles: number; closed: number; latest: number }>`
          SELECT timeframe,
                 COUNT(DISTINCT symbol)::int AS symbols,
                 COUNT(*)::int AS candles,
                 COUNT(*) FILTER (WHERE is_closed)::int AS closed,
                 COALESCE(MAX(open_time), 0)::bigint AS latest
          FROM candles GROUP BY timeframe ORDER BY timeframe
        `.execute(db),
        sql<{ state: string; n: number }>`
          SELECT state, COUNT(*)::int AS n FROM signals
          WHERE source = 'LIVE_ENGINE' GROUP BY state
        `.execute(db),
        db
          .selectFrom('outcomes')
          .innerJoin('signals', 'signals.id', 'outcomes.signal_id')
          .select(['outcomes.result as result', 'outcomes.r_multiple as r_multiple'])
          .where('signals.source', '=', 'LIVE_ENGINE')
          .execute(),
        db
          .selectFrom('engine_log')
          .selectAll()
          .orderBy('created_at', 'desc')
          .limit(50)
          .execute(),
      ]);

    const now = Date.now();
    const workers = ['market', 'strategy', 'outcome'].map((name) => {
      const hb = heartbeats.find((h) => h.worker === name);
      if (!hb) {
        return { worker: name, status: 'MISSING', detail: 'no heartbeat recorded', ageSec: null, loops: 0, errors: 0 };
      }
      const ageSec = Math.round((now - new Date(hb.last_beat).getTime()) / 1000);
      return {
        worker: name,
        // Considered stale after 3 minutes without a beat.
        status: ageSec > 180 ? 'STALE' : hb.status,
        detail: hb.detail,
        ageSec,
        loops: Number(hb.loops),
        errors: Number(hb.errors),
      };
    });

    const perf = aggregate(outcomeRows.map((r) => ({ result: r.result, r_multiple: r.r_multiple })));

    return ok({
      timestamp: new Date().toISOString(),
      health: {
        database: dbOk ? 'OK' : 'DOWN',
        workers,
        overall:
          dbOk && workers.every((w) => w.status === 'OK') ? 'HEALTHY' : 'DEGRADED',
      },
      engine: {
        enabled: settings.bool('engine.enabled'),
        tradingMode: settings.tradingMode(),
        liveTradingEnabled: LIVE_TRADING_ENABLED,
        liveLocked: true,
        threshold: settings.num('engine.score_threshold'),
        minComponents: settings.num('engine.min_components'),
        timeframes: settings.timeframes(),
        maxConcurrent: settings.num('risk.max_concurrent'),
      },
      market: {
        exchange: 'BINANCE_SPOT',
        quoteAsset: 'USDT',
        activeSymbols: Number(symbolCount?.n ?? 0),
        topN: settings.num('market.top_n'),
        candlesByTimeframe: candleStats.rows.map((r) => ({
          timeframe: r.timeframe,
          symbols: r.symbols,
          candles: r.candles,
          closed: r.closed,
          latest: Number(r.latest),
        })),
      },
      states: {
        machines: states.length,
        byState: states.reduce<Record<string, number>>((acc, s) => {
          acc[s.state] = (acc[s.state] ?? 0) + 1;
          return acc;
        }, {}),
        detail: states,
      },
      signals: signalCounts.rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.state] = r.n;
        return acc;
      }, {}),
      performance: perf,
      logs: logs.map((l) => ({
        id: Number(l.id),
        level: l.level,
        worker: l.worker,
        message: l.message,
        meta: l.meta,
        createdAt: l.created_at,
      })),
    });
  } catch (err) {
    return fail(errorMessage(err), 500);
  }
}

import { getDb } from '@/db';
import { loadSettings, Settings, SETTINGS_BY_KEY, coerceSettingValue } from '@/core/settings';
import { replayFromDb, saveReplayRun } from '@/replay/runner';
import { isTimeframe, type Timeframe } from '@/core/types';
import { requireAdmin, ok, fail, errorMessage } from '@/web/api-utils';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** List previous replay runs. */
export async function GET(): Promise<Response> {
  try {
    const db = getDb();
    const runs = await db
      .selectFrom('replay_runs')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();
    return ok({
      runs: runs.map((r) => ({
        id: Number(r.id),
        label: r.label,
        symbols: r.symbols,
        timeframes: r.timeframes,
        fromTime: Number(r.from_time),
        toTime: Number(r.to_time),
        status: r.status,
        candlesSeen: r.candles_seen,
        signals: r.signals_count,
        wins: r.wins,
        losses: r.losses,
        timeouts: r.timeouts,
        winRate: r.win_rate,
        avgR: r.avg_r,
        totalR: r.total_r,
        profitFactor: r.profit_factor,
        maxDrawdownR: r.max_drawdown_r,
        metrics: r.metrics,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    return fail(errorMessage(err), 500);
  }
}

/**
 * Run a historical replay using THE SAME Smart Money engine as live.
 * Protected: replays write rows and are CPU heavy.
 *
 * Body: { symbols?: string[], timeframes?: string[], from?: number, to?: number,
 *         label?: string, overrides?: Record<string, unknown>, save?: boolean }
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  try {
    const body = (await req.json().catch(() => ({}))) as {
      symbols?: string[];
      timeframes?: string[];
      from?: number;
      to?: number;
      label?: string;
      overrides?: Record<string, unknown>;
      save?: boolean;
    };

    const db = getDb();
    let settings = await loadSettings(db);

    // Optional per-run overrides (validated, never persisted).
    if (body.overrides && Object.keys(body.overrides).length > 0) {
      const entries: Array<[string, unknown]> = [];
      for (const [k, v] of Object.entries(body.overrides)) {
        const def = SETTINGS_BY_KEY.get(k);
        if (!def) return fail(`Unknown override: ${k}`, 400);
        entries.push([k, coerceSettingValue(def, v)]);
      }
      settings = Settings.fromEntries([...settings.raw().entries(), ...entries]);
    }

    const symbols =
      body.symbols && body.symbols.length > 0
        ? body.symbols.map((s) => s.toUpperCase())
        : (await db
            .selectFrom('symbols')
            .select('symbol')
            .where('enabled', '=', true)
            .orderBy('rank')
            .limit(5)
            .execute()).map((r) => r.symbol);

    if (symbols.length === 0) return fail('No symbols available to replay', 400);

    const timeframes: Timeframe[] = (
      body.timeframes && body.timeframes.length > 0 ? body.timeframes : settings.timeframes()
    ).filter((t): t is Timeframe => isTimeframe(t));

    if (timeframes.length === 0) return fail('No valid timeframes supplied', 400);

    const results = [];
    for (const symbol of symbols) {
      for (const tf of timeframes) {
        results.push(await replayFromDb(db, symbol, tf, settings, body.from, body.to));
      }
    }

    const allTrades = results.flatMap((r) => r.trades);
    const times = allTrades.map((t) => t.setupCandleTime).filter((t) => t > 0);
    const fromTime = body.from ?? (times.length > 0 ? Math.min(...times) : 0);
    const toTime = body.to ?? (times.length > 0 ? Math.max(...times) : 0);

    let runId: number | null = null;
    if (body.save !== false) {
      runId = await saveReplayRun(
        db,
        body.label ?? `replay ${new Date().toISOString()}`,
        results,
        settings,
        fromTime,
        toTime,
      );
    }

    return ok({
      runId,
      engine: 'SMART_MONEY (same as live)',
      symbols,
      timeframes,
      results: results.map((r) => ({
        symbol: r.symbol,
        timeframe: r.timeframe,
        candlesSeen: r.candlesSeen,
        evaluations: r.evaluations,
        tradeCount: r.trades.length,
        stats: r.stats,
        // `trades` is a TRUNCATED preview for the UI; `stats` and `tradeCount`
        // always describe the full run.
        tradesTruncated: r.trades.length > 50,
        trades: r.trades.slice(0, 50),
      })),
    });
  } catch (err) {
    return fail(errorMessage(err), 500);
  }
}

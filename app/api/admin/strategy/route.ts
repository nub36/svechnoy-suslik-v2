import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '@/db';
import { loadSettings } from '@/core/settings';
import { requireAdmin, ok, fail, errorMessage } from '@/web/api-utils';
import { LIVE_TRADING_ENABLED } from '@/core/mode';
import {
  V30_CAVEATS,
  V30_FROZEN,
  V30_FROZEN_SURFACE,
  V30_PARITY_ARTIFACT,
  V30_RESEARCH_SHA256,
  V30_VALIDATED_RESULTS,
  v30ConfigStatus,
} from '@/strategy/v30';
import { ACTIVE_STRATEGIES } from '@/strategy/v30/params';
import { LIVE_SIGNAL_STATES } from '@/core/types';

export const dynamic = 'force-dynamic';

/**
 * Strategy status for the admin panel (protected).
 *
 * Everything the operator needs to judge whether this build is doing what they
 * think it is: which strategy is active, whether the V3.0 configuration still
 * matches the validated one, what the validated numbers actually were (with the
 * caveats), and per-symbol data readiness.
 *
 * READ-ONLY. The strategy is changed through the normal settings API, and the
 * validated metrics are compiled in from the committed artifacts.
 */
export async function GET(): Promise<Response> {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  try {
    const db = getDb();
    const settings = await loadSettings(db);

    const status = v30ConfigStatus(settings);
    const params = status.params;

    // ---- data readiness: is each configured symbol actually tradeable? ----
    const readiness = await Promise.all(
      params.symbols.map(async (symbol) => {
        const ltf = await db
          .selectFrom('candles')
          .select(db.fn.countAll<number>().as('n'))
          .where('symbol', '=', symbol)
          .where('timeframe', '=', params.ltfTimeframe)
          .where('is_closed', '=', true)
          .executeTakeFirst();
        const htf = await db
          .selectFrom('candles')
          .select(db.fn.countAll<number>().as('n'))
          .where('symbol', '=', symbol)
          .where('timeframe', '=', params.htfTimeframe)
          .where('is_closed', '=', true)
          .executeTakeFirst();
        const executionBars = Number(ltf?.n ?? 0);
        const structureBars = Number(htf?.n ?? 0);
        const tradeable = executionBars >= 120 && structureBars >= 30;
        return {
          symbol,
          executionBars,
          structureBars,
          tradeable,
          note: tradeable
            ? 'ready'
            : `needs ≥ 120 closed ${params.ltfTimeframe} bars and ≥ 30 closed ${params.htfTimeframe} bars`,
        };
      }),
    );

    // ---- live signal counts, V3.0 only ----
    const live = await db
      .selectFrom('signals')
      .select(['state', db.fn.countAll<number>().as('n')])
      .where('source', '=', 'LIVE_ENGINE')
      .where('state', 'in', [...LIVE_SIGNAL_STATES])
      .groupBy('state')
      .execute();
    const counts: Record<string, number> = {};
    for (const row of live) counts[row.state] = Number(row.n);

    return ok({
      activeStrategy: settings.str('strategy.active'),
      engineEnabled: settings.bool('engine.enabled'),
      tradingMode: settings.tradingMode(),
      liveTradingEnabled: LIVE_TRADING_ENABLED,
      /** Strategies this BUILD can actually run. */
      selectable: [...ACTIVE_STRATEGIES],
      /**
       * The research V2.x candidates are NOT runnable here: their validated
       * results came from standalone harnesses (scripts/real-data, research/)
       * that were never ported into the pipeline. Listing them in the selector
       * would let an operator pick a strategy that emits nothing.
       */
      researchOnlyStrategies: ['V2_8', 'V2_7', 'V2_6', 'V2_5', 'V2_4', 'V2_3', 'V2_2', 'V2_1'],
      v30: {
        frozen: status.frozen,
        driftedKeys: status.driftedKeys,
        params,
        /** Shown read-only: these are part of the frozen tested configuration. */
        frozenConstants: {
          corridorExpiryBars: V30_FROZEN.corridorExpiryBars,
          slBufferAtr: V30_FROZEN.slBufferAtr,
          htfTimeframe: V30_FROZEN.htfTimeframe,
          ltfTimeframe: V30_FROZEN.ltfTimeframe,
          swingLookback: settings.num('engine.swing_lookback'),
          atrPeriod: settings.num('risk.atr_period'),
          volumePeriod: settings.num('v2.volume_period'),
          feeModel: V30_FROZEN_SURFACE.feeModel,
          intrabarRules: V30_FROZEN_SURFACE.intrabarRules,
        },
        results: V30_VALIDATED_RESULTS,
        caveats: V30_CAVEATS,
        provenance: {
          /** docs/ADMIN_PANEL_SPEC.md §14.6 — the pin the results attach to. */
          researchModule: 'research/v30_htf_trap.ts',
          sha256: V30_RESEARCH_SHA256,
          parityArtifact: V30_PARITY_ARTIFACT,
          parity: readParity(),
        },
        readiness,
        liveCounts: counts,
      },
    });
  } catch (err) {
    return fail(errorMessage(err), 500);
  }
}

/**
 * The parity evidence, read from the committed artifact. Never fatal: if the
 * artifact is missing the panel says so instead of claiming a verification that
 * did not happen.
 */
function readParity(): {
  status: 'PASS' | 'FAIL' | 'MISSING';
  window: string | null;
  generatedAt: string | null;
} {
  try {
    const raw = readFileSync(join(process.cwd(), V30_PARITY_ARTIFACT), 'utf8');
    const a = JSON.parse(raw) as { parity?: string; window?: string; generatedAt?: string };
    return {
      status: a.parity === 'PASS' ? 'PASS' : a.parity === 'FAIL' ? 'FAIL' : 'MISSING',
      window: a.window ?? null,
      generatedAt: a.generatedAt ?? null,
    };
  } catch {
    return { status: 'MISSING', window: null, generatedAt: null };
  }
}

/**
 * STRATEGY worker — the ONLY writer of `strategy_state` and of new `signals`.
 *
 * Runs THE Smart Money engine over closed candles and drives the persistent
 * state machine. LIVE execution is impossible here by construction: the worker
 * never calls any order API, and the mode gate rejects LIVE.
 */

import { getDb, closeDb, migrate } from '../db';
import { loadSettings } from '../core/settings';
import { createLogger, trimLogs } from '../core/logger';
import { runEngineOnce } from '../strategy/engine-runner';
import { runV30Once } from '../strategy/v30/runner';
import { heartbeat } from '../db/repo';
import { config } from '../core/config';
import { assertAllowedMode } from '../core/mode';

const WORKER = 'strategy';

async function tick(state: { loops: number; errors: number }): Promise<void> {
  const db = getDb();
  const log = createLogger(WORKER, db);
  const settings = await loadSettings(db);

  // STRATEGY SELECTOR. `strategy.active` picks which strategy runs this loop.
  // V3_0 is the validated lead candidate; V1_SMC is the original engine. Only
  // one of them runs per tick, and neither can open a parallel position on a
  // symbol the other already occupies: V3.0 skips a symbol whose live signal has
  // no V3.0 plan, and the V1 engine's own busy-symbol guard (which counts every
  // live signal) keeps it off a symbol that V3.0 holds. A switch therefore stops
  // NEW signals from the old strategy but never abandons an open position.
  const active = settings.str('strategy.active');

  if (active === 'V3_0') {
    const v30 = await runV30Once(db, settings, log);
    state.loops++;
    if (state.loops % 20 === 0) {
      await trimLogs(db, Math.floor(settings.num('system.log_retention_rows')));
    }
    await heartbeat(
      db,
      WORKER,
      state.errors > 0 ? 'DEGRADED' : 'OK',
      `V3.0 eval=${v30.evaluated} new=${v30.signalsCreated} filled=${v30.entriesFilled} ` +
        `expired=${v30.expired} cancelled=${v30.cancelled} held=${v30.skippedHeld} ` +
        `symbols=${v30.dataReady.filter((d) => d.tradeable).length}/${v30.dataReady.length} ` +
        `mode=${settings.tradingMode()}`,
      state.loops,
      state.errors,
    );
    return;
  }

  const res = await runEngineOnce(db, settings, log);
  state.loops++;

  if (state.loops % 20 === 0) {
    await trimLogs(db, Math.floor(settings.num('system.log_retention_rows')));
  }

  await heartbeat(
    db,
    WORKER,
    state.errors > 0 ? 'DEGRADED' : 'OK',
    `V1 eval=${res.evaluated} new=${res.signalsCreated} filled=${res.entriesFilled} mode=${settings.tradingMode()}`,
    state.loops,
    state.errors,
  );
}

async function main(): Promise<void> {
  const log = createLogger(WORKER);
  // Fails fast if someone sets TRADING_MODE=LIVE.
  const mode = assertAllowedMode(config.tradingMode);
  log.info('strategy worker starting', { mode, loopMs: config.strategyLoopMs });
  await migrate();

  const state = { loops: 0, errors: 0 };
  let running = true;
  const stop = async (): Promise<void> => {
    running = false;
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  while (running) {
    try {
      await tick(state);
    } catch (err) {
      state.errors++;
      log.error('strategy loop error', { error: err instanceof Error ? err.message : String(err) });
    }
    await new Promise((r) => setTimeout(r, config.strategyLoopMs));
  }
}

if (require.main === module) {
  void main();
}

export { tick as strategyTick };

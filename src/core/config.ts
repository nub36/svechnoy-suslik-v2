/**
 * Process-level config (env). Anything that is a *strategy* knob lives in the
 * DB settings table instead, so the Admin UI can change it (DB -> engine).
 */

import { assertAllowedMode } from './mode';
import type { TradingMode } from './types';
import { loadEnvFile } from './env';
import { resolveCookieSecure } from '../web/cookie-policy';

// Populate process.env from .env for plain-Node workers and CLI scripts.
loadEnvFile();

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Default mode is DRY_RUN. Setting TRADING_MODE=LIVE throws at startup by
 * design — LIVE is locked.
 */
function resolveMode(): TradingMode {
  return assertAllowedMode(env('TRADING_MODE', 'DRY_RUN'));
}

export const config = {
  databaseUrl: env(
    'DATABASE_URL',
    'postgresql://suslik:suslik@127.0.0.1:5432/svechnoy_suslik_v2',
  ),
  dbPoolMax: envInt('DB_POOL_MAX', 10),

  binanceBaseUrl: env('BINANCE_BASE_URL', 'https://api.binance.com'),
  binanceTimeoutMs: envInt('BINANCE_TIMEOUT_MS', 15_000),
  /** When true the Binance client refuses network calls and serves fixtures. */
  binanceOffline: env('BINANCE_OFFLINE', 'false') === 'true',
  fixturesDir: env('FIXTURES_DIR', ''),

  get tradingMode(): TradingMode {
    return resolveMode();
  },

  port: envInt('PORT', 3000),
  nodeEnv: env('NODE_ENV', 'development'),

  marketLoopMs: envInt('MARKET_LOOP_MS', 15_000),
  strategyLoopMs: envInt('STRATEGY_LOOP_MS', 20_000),
  outcomeLoopMs: envInt('OUTCOME_LOOP_MS', 20_000),

  /**
   * `Secure` attribute for the admin session cookie.
   *
   * This describes the TRANSPORT, not the build. A production build served
   * over plain HTTP must set COOKIE_SECURE=false, otherwise the browser will
   * not return the session cookie and the Admin UI logs itself out instantly.
   * Unset falls back to NODE_ENV==='production', keeping the default strict.
   * See src/web/cookie-policy.ts.
   */
  cookieSecure: resolveCookieSecure(process.env['COOKIE_SECURE'], env('NODE_ENV', 'development')),

  adminUser: env('ADMIN_USER', 'admin'),
  adminPassword: env('ADMIN_PASSWORD', 'suslik-admin'),
  sessionTtlHours: envInt('SESSION_TTL_HOURS', 12),
} as const;

export type Config = typeof config;

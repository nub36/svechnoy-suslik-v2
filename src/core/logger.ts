import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../db/types';
import { getDb } from '../db';
import { SETTINGS_BY_KEY } from './settings';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: LogLevel = (process.env['LOG_LEVEL'] as LogLevel) || 'info';

export class Logger {
  constructor(
    private readonly worker: string,
    private readonly db: Kysely<Database> | null = null,
  ) {}

  private get database(): Kysely<Database> | null {
    if (this.db) return this.db;
    try {
      return getDb();
    } catch {
      return null;
    }
  }

  private write(level: LogLevel, message: string, meta: Record<string, unknown> = {}): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
    const stamp = new Date().toISOString();
    const line = `[${stamp}] [${level.toUpperCase()}] [${this.worker}] ${message}`;
    if (level === 'error') console.error(line, Object.keys(meta).length ? meta : '');
    else if (level === 'warn') console.warn(line, Object.keys(meta).length ? meta : '');
    else console.log(line, Object.keys(meta).length ? meta : '');

    const db = this.database;
    if (!db) return;
    // Fire and forget — logging must never break the engine.
    void db
      .insertInto('engine_log')
      .values({
        level,
        worker: this.worker,
        message,
        meta: JSON.stringify(meta),
      })
      .execute()
      .catch(() => undefined);
  }

  debug(m: string, meta?: Record<string, unknown>): void {
    this.write('debug', m, meta);
  }
  info(m: string, meta?: Record<string, unknown>): void {
    this.write('info', m, meta);
  }
  warn(m: string, meta?: Record<string, unknown>): void {
    this.write('warn', m, meta);
  }
  error(m: string, meta?: Record<string, unknown>): void {
    this.write('error', m, meta);
  }
}

/** Trim engine_log to the configured retention (system.log_retention_rows). */
export async function trimLogs(
  db: Kysely<Database>,
  retentionRows?: number,
): Promise<number> {
  const keep =
    retentionRows ?? (SETTINGS_BY_KEY.get('system.log_retention_rows')?.default as number) ?? 5000;
  const res = await sql<{ id: number }>`
    DELETE FROM engine_log
    WHERE id <= (
      SELECT COALESCE(MAX(id), 0) - ${keep}::bigint FROM engine_log
    )
  `.execute(db);
  return Number(res.numAffectedRows ?? 0);
}

export function createLogger(worker: string, db?: Kysely<Database>): Logger {
  return new Logger(worker, db ?? null);
}

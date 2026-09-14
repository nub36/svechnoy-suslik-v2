import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool, types } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from './types';
import { config } from '../core/config';

// BIGINT (oid 20) and NUMERIC (1700) come back as strings by default -> parse to number.
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));
types.setTypeParser(701, (v) => Number(v));

let pool: Pool | null = null;
let dbInstance: Kysely<Database> | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.dbPoolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => {
      console.error('[db] idle client error', err.message);
    });
  }
  return pool;
}

export function getDb(): Kysely<Database> {
  if (!dbInstance) {
    dbInstance = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: getPool() }),
    });
  }
  return dbInstance;
}

/** Test seam: let tests inject a Kysely bound to their own pool. */
export function setDb(db: Kysely<Database>): void {
  dbInstance = db;
}

export async function closeDb(): Promise<void> {
  if (dbInstance) {
    await dbInstance.destroy();
    dbInstance = null;
    pool = null;
  }
}

export function schemaSql(): string {
  return readFileSync(join(__dirname, 'schema.sql'), 'utf8');
}

/** Apply schema.sql. Idempotent (all statements use IF NOT EXISTS). */
export async function migrate(db: Kysely<Database> = getDb()): Promise<void> {
  await sql.raw(schemaSql()).execute(db);
}

export async function ping(db: Kysely<Database> = getDb()): Promise<boolean> {
  try {
    await sql`SELECT 1`.execute(db);
    return true;
  } catch {
    return false;
  }
}

export { sql };
export type { Database };

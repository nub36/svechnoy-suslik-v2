/**
 * Test harness backed by a REAL PostgreSQL instance (not pg-mem), so the
 * schema, ON CONFLICT clauses, JSONB handling and constraints are genuinely
 * exercised.
 *
 * Uses @embedded-postgres/linux-x64 binaries, or an external server when
 * TEST_DATABASE_URL is provided.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool, types } from 'pg';
import type { Database } from '../src/db/types';
import { migrate, setDb } from '../src/db';

types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));
types.setTypeParser(701, (v) => Number(v));

const BIN = join(
  process.cwd(),
  'node_modules/@embedded-postgres/linux-x64/native/bin',
);

export interface TestPg {
  db: Kysely<Database>;
  url: string;
  stop: () => Promise<void>;
}

let shared: TestPg | null = null;
let dataDir: string | null = null;
let port = 0;

function pickPort(): number {
  return 5500 + Math.floor(Math.random() * 400);
}

/** Start (once) an embedded Postgres and return a migrated Kysely instance. */
export async function getTestPg(): Promise<TestPg> {
  if (shared) return shared;

  const external = process.env['TEST_DATABASE_URL'];
  if (external) {
    const pool = new Pool({ connectionString: external, max: 5 });
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    await migrate(db);
    setDb(db);
    shared = {
      db,
      url: external,
      stop: async () => {
        await db.destroy();
      },
    };
    return shared;
  }

  if (!existsSync(join(BIN, 'initdb'))) {
    throw new Error(
      'Embedded postgres binaries not found. Install @embedded-postgres/linux-x64 or set TEST_DATABASE_URL.',
    );
  }

  dataDir = mkdtempSync(join(tmpdir(), 'suslik-pg-'));
  port = pickPort();

  const init = spawnSync(
    join(BIN, 'initdb'),
    ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'],
    { encoding: 'utf8' },
  );
  if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr}`);

  const start = spawnSync(
    join(BIN, 'pg_ctl'),
    ['-D', dataDir, '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, '-l', join(dataDir, 'server.log'), '-w', 'start'],
    { encoding: 'utf8' },
  );
  if (start.status !== 0) throw new Error(`pg_ctl start failed: ${start.stderr}\n${start.stdout}`);

  const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  const pool = new Pool({ connectionString: url, max: 5 });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

  await migrate(db);
  setDb(db); // so production code paths (getDb()) hit the test database

  shared = {
    db,
    url,
    stop: async () => {
      await db.destroy();
      if (dataDir) {
        spawnSync(join(BIN, 'pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], {
          encoding: 'utf8',
        });
        rmSync(dataDir, { recursive: true, force: true });
      }
      shared = null;
    },
  };
  return shared;
}

/**
 * Truncate all domain tables between tests.
 *
 * NOTE: `settings` MUST be included. seedSettings() deliberately preserves
 * existing values (so a redeploy never clobbers admin changes), which means a
 * value written by one test would otherwise leak into the next one.
 */
export async function resetDb(db: Kysely<Database>): Promise<void> {
  await sql`
    TRUNCATE outcomes, signals, strategy_state, candles, symbols,
             worker_heartbeats, engine_log, replay_runs, admin_sessions,
             settings
    RESTART IDENTITY CASCADE
  `.execute(db);
}

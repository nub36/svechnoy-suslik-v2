/**
 * The production database already exists. Applying the corrected schema must be
 * ADDITIVE and IDEMPOTENT: it may add columns and backfill them, but it must
 * never drop data or fail on a second run.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { getTestPg, resetDb } from './pg';
import { migrate } from '../src/db';
import type { Database } from '../src/db/types';

let db: Kysely<Database>;

beforeAll(async () => {
  db = (await getTestPg()).db;
}, 120_000);

afterAll(async () => {
  await (await getTestPg()).stop();
});

beforeEach(async () => {
  await resetDb(db);
});

const NEW_COLS = ['long_score', 'short_score', 'confirmations'] as const;

async function columns(table: string): Promise<string[]> {
  const r = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns WHERE table_name = ${table}
  `.execute(db);
  return r.rows.map((x) => x.column_name);
}

/** Recreate the PRE-correction shape of the signals table. */
async function downgrade(): Promise<void> {
  for (const c of NEW_COLS) {
    await sql.raw(`ALTER TABLE signals DROP COLUMN IF EXISTS ${c}`).execute(db);
  }
}

async function insertLegacySignal(direction: string, score: number): Promise<void> {
  await sql`
    INSERT INTO signals (symbol, timeframe, direction, score, threshold,
                         setup_candle_time, setup_close)
    VALUES ('BTCUSDT', '1h', ${direction}, ${score}, 60, ${Date.now()}, 100)
  `.execute(db);
}

describe('additive schema migration for an existing production DB', () => {
  it('adds the new columns to a table that predates them', async () => {
    await downgrade();
    for (const c of NEW_COLS) expect(await columns('signals')).not.toContain(c);

    await migrate(db);
    for (const c of NEW_COLS) expect(await columns('signals')).toContain(c);
  });

  it('preserves existing rows and backfills them from the winning score', async () => {
    await downgrade();
    await insertLegacySignal('LONG', 77.5);
    await insertLegacySignal('SHORT', 64.25);

    await migrate(db);

    const rows = await sql<{
      direction: string; score: number; long_score: number;
      short_score: number; confirmations: number;
    }>`SELECT direction, score, long_score, short_score, confirmations
       FROM signals ORDER BY id`.execute(db);

    expect(rows.rows).toHaveLength(2); // nothing lost

    const long = rows.rows.find((r) => r.direction === 'LONG')!;
    expect(Number(long.long_score)).toBeCloseTo(77.5, 6);
    expect(Number(long.short_score)).toBe(0);

    const short = rows.rows.find((r) => r.direction === 'SHORT')!;
    expect(Number(short.short_score)).toBeCloseTo(64.25, 6);
    expect(Number(short.long_score)).toBe(0);

    // confirmations has no historical source, so it defaults rather than lying.
    for (const r of rows.rows) expect(Number(r.confirmations)).toBe(0);
  });

  it('is idempotent — running it repeatedly changes nothing', async () => {
    await downgrade();
    await insertLegacySignal('LONG', 77.5);

    await migrate(db);
    const snap = async (): Promise<string> => {
      const r = await sql<Record<string, unknown>>`
        SELECT direction, score, long_score, short_score, confirmations FROM signals ORDER BY id
      `.execute(db);
      return JSON.stringify(r.rows);
    };
    const first = await snap();

    for (let i = 0; i < 3; i++) {
      await expect(migrate(db)).resolves.not.toThrow();
      expect(await snap()).toBe(first);
    }
  });

  it('does not clobber a row that already has real scores', async () => {
    await migrate(db);
    await sql`
      INSERT INTO signals (symbol, timeframe, direction, score, threshold,
                           setup_candle_time, setup_close,
                           long_score, short_score, confirmations)
      VALUES ('ETHUSDT', '1h', 'LONG', 80, 60, ${Date.now()}, 100, 80, 42, 5)
    `.execute(db);

    await migrate(db);

    const r = await sql<{ long_score: number; short_score: number; confirmations: number }>`
      SELECT long_score, short_score, confirmations FROM signals WHERE symbol = 'ETHUSDT'
    `.execute(db);
    // The backfill must NOT overwrite a genuine short_score with 0.
    expect(Number(r.rows[0]!.short_score)).toBeCloseTo(42, 6);
    expect(Number(r.rows[0]!.confirmations)).toBe(5);
  });

  it('running migrate on a fresh database is safe and complete', async () => {
    await expect(migrate(db)).resolves.not.toThrow();
    const cols = await columns('signals');
    for (const c of [...NEW_COLS, 'score', 'threshold', 'breakdown', 'entry_price']) {
      expect(cols).toContain(c);
    }
  });
});

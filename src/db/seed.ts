/**
 * Seed: write every registry setting into the DB (without clobbering values the
 * admin already changed) and ensure an admin user exists.
 */

import type { Kysely } from 'kysely';
import bcrypt from 'bcryptjs';
import { closeDb, getDb, migrate } from './index';
import type { Database } from './types';
import { SETTINGS_REGISTRY } from '../core/settings';
import { config } from '../core/config';
import { createLogger } from '../core/logger';

export async function seedSettings(db: Kysely<Database>): Promise<number> {
  let written = 0;
  for (const def of SETTINGS_REGISTRY) {
    const res = await db
      .insertInto('settings')
      .values({
        key: def.key,
        value: JSON.stringify(def.default),
        type: def.type,
        category: def.category,
        label: def.label,
        description: def.description,
        min_value: def.min ?? null,
        max_value: def.max ?? null,
        editable: def.editable ?? true,
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        // Refresh metadata but PRESERVE the stored value.
        oc.column('key').doUpdateSet({
          type: def.type,
          category: def.category,
          label: def.label,
          description: def.description,
          min_value: def.min ?? null,
          max_value: def.max ?? null,
          editable: def.editable ?? true,
        }),
      )
      .execute();
    written += Number(res[0]?.numInsertedOrUpdatedRows ?? 0);
  }
  return written;
}

export async function seedAdmin(
  db: Kysely<Database>,
  username = config.adminUser,
  password = config.adminPassword,
): Promise<void> {
  const existing = await db
    .selectFrom('admin_users')
    .select('id')
    .where('username', '=', username)
    .executeTakeFirst();
  if (existing) return;
  const hash = await bcrypt.hash(password, 10);
  await db.insertInto('admin_users').values({ username, password_hash: hash }).execute();
}

async function main(): Promise<void> {
  const log = createLogger('seed');
  const db = getDb();
  await migrate(db);
  const n = await seedSettings(db);
  await seedAdmin(db);
  log.info(`seeded ${SETTINGS_REGISTRY.length} settings (${n} rows written), admin user ready`);
  await closeDb();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  });
}

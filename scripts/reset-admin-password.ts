/**
 * npm run admin:reset-password
 *
 * Sets the admin password in PostgreSQL from ADMIN_USER / ADMIN_PASSWORD.
 *
 * Editing .env alone does NOT change an existing account — `db:seed` only
 * creates the admin when it is absent, on purpose. This command is the
 * supported way to rotate the credential.
 *
 * It never prints the password, the bcrypt hash or any session token.
 */

import { closeDb, getDb } from '../src/db';
import { createLogger } from '../src/core/logger';
import {
  PasswordPolicyError,
  resetAdminPassword,
} from '../src/web/admin-password';

async function main(): Promise<void> {
  const log = createLogger('admin:reset-password');

  const username = process.env['ADMIN_USER'];
  const password = process.env['ADMIN_PASSWORD'];

  if (!username || !password) {
    console.error(
      '[admin:reset-password] ADMIN_USER and ADMIN_PASSWORD must both be set in the environment.\n' +
        '  Example:\n' +
        '    ADMIN_USER=admin ADMIN_PASSWORD=<strong-password> npm run admin:reset-password',
    );
    process.exit(1);
  }

  const db = getDb();
  try {
    const res = await resetAdminPassword(db, username, password);
    log.info(
      `password ${res.action} for admin user "${res.username}"; ` +
        `${res.sessionsRevoked} session(s) revoked`,
    );
    console.log(
      `\n  OK — admin "${res.username}" ${res.action === 'created' ? 'created' : 'password updated'}.\n` +
        `  ${res.sessionsRevoked} existing session(s) were invalidated; sign in again.\n`,
    );
  } catch (err) {
    if (err instanceof PasswordPolicyError) {
      console.error(`[admin:reset-password] rejected: ${err.message}`);
      process.exit(2);
    }
    throw err;
  } finally {
    await closeDb();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[admin:reset-password] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

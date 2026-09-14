/**
 * Admin password management.
 *
 * THE BUG THIS FIXES
 * ------------------
 * `db:seed` creates the admin account only if it does not already exist
 * (correctly — otherwise every deploy would silently reset the password and
 * clobber a rotated credential). The consequence is that editing
 * ADMIN_PASSWORD in .env has NO effect on an account that already exists in
 * PostgreSQL, which reads as "Invalid credentials" at the login form.
 *
 * PostgreSQL `admin_users` is, and stays, the single source of truth. To
 * change the password you must run an explicit command:
 *
 *     npm run admin:reset-password
 *
 * It is deliberately explicit rather than automatic: a web restart must never
 * rewrite credentials.
 */

import bcrypt from 'bcryptjs';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types';

/** Passwords we refuse to set, because they are defaults or trivially weak. */
export const INSECURE_PASSWORDS: readonly string[] = [
  'suslik-admin',
  'admin',
  'password',
  'changeme',
  '12345678',
  'admin123',
  'qwerty123',
];

export const MIN_PASSWORD_LENGTH = 12;

export class PasswordPolicyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'PasswordPolicyError';
  }
}

/**
 * Validate a candidate password. Throws PasswordPolicyError with a message
 * safe to print — it never echoes the password itself.
 */
export function assertPasswordAcceptable(password: unknown, username: unknown): void {
  if (typeof username !== 'string' || username.trim() === '') {
    throw new PasswordPolicyError('ADMIN_USER is missing or empty');
  }
  if (typeof password !== 'string' || password === '') {
    throw new PasswordPolicyError('ADMIN_PASSWORD is missing or empty');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(
      `ADMIN_PASSWORD is too short (minimum ${MIN_PASSWORD_LENGTH} characters)`,
    );
  }
  if (INSECURE_PASSWORDS.includes(password.toLowerCase())) {
    throw new PasswordPolicyError(
      'ADMIN_PASSWORD is a known default/insecure value — choose another one',
    );
  }
}

export interface ResetResult {
  username: string;
  /** 'created' when the account did not exist yet, otherwise 'updated'. */
  action: 'created' | 'updated';
  /** Sessions invalidated by the reset. */
  sessionsRevoked: number;
}

/**
 * Set the admin password, creating the account when necessary.
 *
 * Runs in a single transaction so an interrupted reset can never leave a new
 * hash with still-valid old sessions. Every existing session for the user is
 * revoked, because a password change must log out anyone holding a token.
 *
 * Returns metadata only — never the password, the hash or any token.
 */
export async function resetAdminPassword(
  db: Kysely<Database>,
  username: string,
  password: string,
  opts: { skipPolicy?: boolean } = {},
): Promise<ResetResult> {
  if (!opts.skipPolicy) assertPasswordAcceptable(password, username);

  const hash = await bcrypt.hash(password, 10);

  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('admin_users')
      .select(['id'])
      .where('username', '=', username)
      .executeTakeFirst();

    let userId: number;
    let action: 'created' | 'updated';

    if (existing) {
      userId = Number(existing.id);
      await trx
        .updateTable('admin_users')
        .set({ password_hash: hash })
        .where('id', '=', userId)
        .execute();
      action = 'updated';
    } else {
      const inserted = await trx
        .insertInto('admin_users')
        .values({ username, password_hash: hash })
        .returning('id')
        .executeTakeFirstOrThrow();
      userId = Number(inserted.id);
      action = 'created';
    }

    // A password change must invalidate every outstanding session.
    const del = await trx
      .deleteFrom('admin_sessions')
      .where('user_id', '=', userId)
      .executeTakeFirst();

    return {
      username,
      action,
      sessionsRevoked: Number(del?.numDeletedRows ?? 0),
    };
  });
}

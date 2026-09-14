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
  // Long enough to clear MIN_PASSWORD_LENGTH but still trivially guessable,
  // so the length check alone would let them through.
  'password1234',
  'qwerty123456',
  'administrator',
  'suslik-admin1',
  '123456789012',
  'adminadmin12',
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

/* ===================================================================
 * Authenticated self-service password change (Admin -> Безопасность)
 * =================================================================== */

/** Russian, user-facing reasons. Never include the password itself. */
export type ChangeFailure =
  | 'CURRENT_WRONG'
  | 'MISMATCH'
  | 'TOO_SHORT'
  | 'INSECURE'
  | 'SAME_AS_CURRENT'
  | 'RATE_LIMITED';

export const CHANGE_FAILURE_RU: Record<ChangeFailure, string> = {
  CURRENT_WRONG: 'Текущий пароль неверен',
  MISMATCH: 'Новый пароль и подтверждение не совпадают',
  TOO_SHORT: `Новый пароль слишком короткий (минимум ${MIN_PASSWORD_LENGTH} символов)`,
  INSECURE: 'Новый пароль слишком простой — выберите другой',
  SAME_AS_CURRENT: 'Новый пароль совпадает с текущим',
  RATE_LIMITED: 'Слишком много попыток. Попробуйте позже',
};

export class PasswordChangeError extends Error {
  readonly code: ChangeFailure;
  constructor(code: ChangeFailure) {
    super(code);
    this.name = 'PasswordChangeError';
    this.code = code;
  }
}

/* ---------------------- attempt rate limiting ---------------------- */

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

interface AttemptBucket {
  count: number;
  first: number;
}

const attempts = new Map<string, AttemptBucket>();

/**
 * Fixed-window limiter on FAILED attempts, keyed per admin user.
 *
 * In-process on purpose: the web app runs as a single PM2 fork instance, so a
 * shared map is sufficient and avoids inventing a table. It throttles online
 * guessing of the current password; it is not a defence against a distributed
 * attacker, and the real protection remains the bcrypt hash.
 */
export function checkRateLimit(key: string, now = Date.now()): void {
  const b = attempts.get(key);
  if (!b) return;
  if (now - b.first > ATTEMPT_WINDOW_MS) {
    attempts.delete(key);
    return;
  }
  if (b.count >= MAX_ATTEMPTS) throw new PasswordChangeError('RATE_LIMITED');
}

export function recordFailure(key: string, now = Date.now()): void {
  const b = attempts.get(key);
  if (!b || now - b.first > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { count: 1, first: now });
    return;
  }
  b.count++;
}

export function clearAttempts(key: string): void {
  attempts.delete(key);
}

/** Test-only: drop all limiter state. */
export function resetRateLimiter(): void {
  attempts.clear();
}

export interface ChangeResult {
  username: string;
  /** Other sessions killed by the change (the caller's own is preserved). */
  sessionsRevoked: number;
}

/**
 * Change the password of the CURRENTLY AUTHENTICATED admin.
 *
 * Differs from resetAdminPassword() in three ways:
 *  - it proves knowledge of the current password;
 *  - it only ever touches that one user, never creating an account;
 *  - it keeps the caller's own session alive and revokes every OTHER session,
 *    so changing your password does not log you out of the page you are on.
 *
 * Returns metadata only. The plaintext, the hash and the session token are
 * never returned, logged or included in an error.
 */
export async function changeOwnPassword(
  db: Kysely<Database>,
  args: {
    userId: number;
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
    /** Session token to preserve (the caller's own). */
    keepSessionToken?: string | null;
  },
): Promise<ChangeResult> {
  const { userId, currentPassword, newPassword, confirmPassword } = args;
  const key = `user:${userId}`;

  checkRateLimit(key);

  const user = await db
    .selectFrom('admin_users')
    .select(['id', 'username', 'password_hash'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) {
    recordFailure(key);
    throw new PasswordChangeError('CURRENT_WRONG');
  }

  const currentOk = await bcrypt.compare(currentPassword, user.password_hash);
  if (!currentOk) {
    recordFailure(key);
    throw new PasswordChangeError('CURRENT_WRONG');
  }

  if (newPassword !== confirmPassword) throw new PasswordChangeError('MISMATCH');
  if (newPassword.length < MIN_PASSWORD_LENGTH) throw new PasswordChangeError('TOO_SHORT');
  if (INSECURE_PASSWORDS.includes(newPassword.toLowerCase())) {
    throw new PasswordChangeError('INSECURE');
  }
  if (await bcrypt.compare(newPassword, user.password_hash)) {
    throw new PasswordChangeError('SAME_AS_CURRENT');
  }

  const hash = await bcrypt.hash(newPassword, 10);
  const keep = args.keepSessionToken ?? null;

  const revoked = await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('admin_users')
      .set({ password_hash: hash })
      .where('id', '=', userId)
      .execute();

    let q = trx.deleteFrom('admin_sessions').where('user_id', '=', userId);
    if (keep) q = q.where('token', '!=', keep);
    const del = await q.executeTakeFirst();
    return Number(del?.numDeletedRows ?? 0);
  });

  clearAttempts(key);
  return { username: user.username, sessionsRevoked: revoked };
}

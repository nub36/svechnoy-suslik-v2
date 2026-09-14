/**
 * The production bug: ADMIN_PASSWORD was changed in .env after db:seed, but
 * the login form still rejected the new password.
 *
 * These tests pin the intended behaviour end to end:
 *   - seeding creates the account from the environment ONCE;
 *   - changing the environment afterwards does NOT touch the stored password
 *     (that is correct, not a bug — otherwise every restart would clobber a
 *     rotated credential);
 *   - `npm run admin:reset-password` is the supported way to change it, and
 *     it revokes existing sessions.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { getTestPg, resetDb } from './pg';
import type { Database } from '../src/db/types';
import { seedAdmin } from '../src/db/seed';
import { createSession, resolveSession, verifyCredentials } from '../src/web/auth';
import {
  INSECURE_PASSWORDS,
  MIN_PASSWORD_LENGTH,
  PasswordPolicyError,
  assertPasswordAcceptable,
  resetAdminPassword,
} from '../src/web/admin-password';

let db: Kysely<Database>;

const USER = 'admin';
const FIRST = 'first-password-9911';
const SECOND = 'second-password-7722';

beforeAll(async () => {
  db = (await getTestPg()).db;
}, 120_000);

afterAll(async () => {
  await (await getTestPg()).stop();
});

beforeEach(async () => {
  await resetDb(db);
  // resetDb deliberately preserves admin_users (other suites rely on a
  // persistent admin). This suite is ABOUT that table, so clear it too —
  // otherwise seedAdmin becomes a no-op and the tests silently pollute
  // each other.
  await sql`DELETE FROM admin_users`.execute(db);
});

describe('the original bug', () => {
  it('the initially seeded password works', async () => {
    await seedAdmin(db, USER, FIRST);
    await expect(verifyCredentials(USER, FIRST, db)).resolves.toMatchObject({
      username: USER,
    });
  });

  it('a wrong password is rejected', async () => {
    await seedAdmin(db, USER, FIRST);
    await expect(verifyCredentials(USER, 'not-the-password', db)).resolves.toBeNull();
  });

  it('an unknown user is rejected', async () => {
    await seedAdmin(db, USER, FIRST);
    await expect(verifyCredentials('nobody', FIRST, db)).resolves.toBeNull();
  });

  it('REPRODUCES IT: re-seeding with a new env password does NOT change the stored one', async () => {
    await seedAdmin(db, USER, FIRST);
    // Operator edits .env and restarts / re-runs the seed.
    await seedAdmin(db, USER, SECOND);

    // This is exactly what production saw: the NEW password fails...
    await expect(verifyCredentials(USER, SECOND, db)).resolves.toBeNull();
    // ...while the ORIGINAL one still works.
    await expect(verifyCredentials(USER, FIRST, db)).resolves.toMatchObject({
      username: USER,
    });
  });
});

describe('admin:reset-password fixes it', () => {
  it('changes the password so the new one works and the old one does not', async () => {
    await seedAdmin(db, USER, FIRST);

    const res = await resetAdminPassword(db, USER, SECOND);
    expect(res.action).toBe('updated');
    expect(res.username).toBe(USER);

    await expect(verifyCredentials(USER, SECOND, db)).resolves.toMatchObject({
      username: USER,
    });
    await expect(verifyCredentials(USER, FIRST, db)).resolves.toBeNull();
  });

  it('creates the account when it does not exist yet', async () => {
    const res = await resetAdminPassword(db, 'brand-new', SECOND);
    expect(res.action).toBe('created');
    await expect(verifyCredentials('brand-new', SECOND, db)).resolves.toMatchObject({
      username: 'brand-new',
    });
  });

  it('invalidates every existing session for that user', async () => {
    await seedAdmin(db, USER, FIRST);
    const user = (await verifyCredentials(USER, FIRST, db))!;

    const a = await createSession(user.id, db);
    const b = await createSession(user.id, db);
    // Both tokens are valid before the reset.
    await expect(resolveSession(a.token, db)).resolves.toMatchObject({ username: USER });
    await expect(resolveSession(b.token, db)).resolves.toMatchObject({ username: USER });

    const res = await resetAdminPassword(db, USER, SECOND);
    expect(res.sessionsRevoked).toBe(2);

    // A password change must log everyone out.
    await expect(resolveSession(a.token, db)).resolves.toBeNull();
    await expect(resolveSession(b.token, db)).resolves.toBeNull();
  });

  it('does not touch OTHER users’ sessions', async () => {
    await seedAdmin(db, USER, FIRST);
    await seedAdmin(db, 'other', 'other-password-4413');
    const other = (await verifyCredentials('other', 'other-password-4413', db))!;
    const otherToken = (await createSession(other.id, db)).token;

    await resetAdminPassword(db, USER, SECOND);

    await expect(resolveSession(otherToken, db)).resolves.toMatchObject({
      username: 'other',
    });
  });

  it('is repeatable — rotating twice leaves only the newest password valid', async () => {
    await seedAdmin(db, USER, FIRST);
    await resetAdminPassword(db, USER, SECOND);
    const third = 'third-password-5566';
    await resetAdminPassword(db, USER, third);

    await expect(verifyCredentials(USER, third, db)).resolves.toMatchObject({ username: USER });
    await expect(verifyCredentials(USER, SECOND, db)).resolves.toBeNull();
    await expect(verifyCredentials(USER, FIRST, db)).resolves.toBeNull();
  });

  it('does not create a duplicate account row when updating', async () => {
    await seedAdmin(db, USER, FIRST);
    await resetAdminPassword(db, USER, SECOND);
    const rows = await db
      .selectFrom('admin_users')
      .select('id')
      .where('username', '=', USER)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('stores a bcrypt hash, never the plaintext', async () => {
    await resetAdminPassword(db, USER, SECOND);
    const row = await db
      .selectFrom('admin_users')
      .select('password_hash')
      .where('username', '=', USER)
      .executeTakeFirstOrThrow();
    expect(row.password_hash).not.toContain(SECOND);
    expect(row.password_hash).toMatch(/^\$2[aby]\$\d{2}\$/);
  });
});

describe('password policy', () => {
  it('rejects the shipped default password', () => {
    expect(() => assertPasswordAcceptable('suslik-admin', USER)).toThrow(PasswordPolicyError);
  });

  it('rejects every known insecure value', () => {
    for (const p of INSECURE_PASSWORDS) {
      expect(() => assertPasswordAcceptable(p, USER)).toThrow(PasswordPolicyError);
    }
  });

  it('rejects a short password', () => {
    expect(() => assertPasswordAcceptable('x'.repeat(MIN_PASSWORD_LENGTH - 1), USER)).toThrow(
      /too short/i,
    );
  });

  it('rejects a missing password or username', () => {
    expect(() => assertPasswordAcceptable('', USER)).toThrow(/missing or empty/i);
    expect(() => assertPasswordAcceptable(undefined, USER)).toThrow(/missing or empty/i);
    expect(() => assertPasswordAcceptable(SECOND, '')).toThrow(/ADMIN_USER/);
  });

  it('accepts a sufficiently strong password', () => {
    expect(() => assertPasswordAcceptable('a-perfectly-fine-password', USER)).not.toThrow();
  });

  it('never echoes the password in the error message', () => {
    const secret = 'short1';
    try {
      assertPasswordAcceptable(secret, USER);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });

  it('the policy is enforced by resetAdminPassword itself', async () => {
    await expect(resetAdminPassword(db, USER, 'admin')).rejects.toThrow(PasswordPolicyError);
    // ...and nothing was written.
    const rows = await db.selectFrom('admin_users').select('id').execute();
    expect(rows).toHaveLength(0);
  });
});

describe('the reset script and docs', () => {
  it('package.json exposes the admin:reset-password command', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts['admin:reset-password']).toBe('tsx scripts/reset-admin-password.ts');
  });

  it('the script never prints the password, hash or token', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('scripts/reset-admin-password.ts', 'utf8');
    // It may READ the env var and may say the WORD "password" in prose, but
    // it must never interpolate the VALUE (or a hash/token) into output.
    expect(src).not.toMatch(/\$\{\s*password\s*\}/);
    expect(src).not.toMatch(/\$\{[^}]*passwordHash[^}]*\}/i);
    expect(src).not.toMatch(/\$\{[^}]*\bhash\b[^}]*\}/i);
    expect(src).not.toMatch(/\$\{[^}]*\btoken\b[^}]*\}/i);
    expect(src).not.toMatch(/console\.(log|error)\(\s*password/i);
    // ADMIN_PASSWORD is read into a variable but never logged.
    expect(src).toMatch(/process\.env\['ADMIN_PASSWORD'\]/);
  });

  it('the login page no longer claims that editing .env changes the password', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/admin/page.tsx', 'utf8');
    expect(src).toContain('admin:reset-password');
    // The help text must state the .env caveat explicitly.
    expect(src).toMatch(/не меняет/);
  });
});

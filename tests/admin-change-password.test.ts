/**
 * Authenticated self-service password change (Admin -> Безопасность).
 *
 * Distinct from the CLI reset (`npm run admin:reset-password`, covered in
 * tests/admin-password.test.ts): this path requires a live session, proves
 * knowledge of the CURRENT password, and deliberately keeps the caller's own
 * session alive while revoking every other one.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { getTestPg, resetDb } from './pg';
import type { Database } from '../src/db/types';
import {
  CHANGE_FAILURE_RU,
  PasswordChangeError,
  changeOwnPassword,
  resetAdminPassword,
  resetRateLimiter,
  MIN_PASSWORD_LENGTH,
} from '../src/web/admin-password';
import { createSession, resolveSession, verifyCredentials } from '../src/web/auth';

let db: Kysely<Database>;

const USER = 'admin';
const START = 'start-password-123';
const NEXT = 'next-password-456';

beforeAll(async () => {
  db = (await getTestPg()).db;
});

afterAll(async () => {
  await (await getTestPg()).stop();
});

beforeEach(async () => {
  await resetDb(db);
  await db.deleteFrom('admin_users').execute();
  resetRateLimiter();
  await resetAdminPassword(db, USER, START);
});

async function userId(): Promise<number> {
  const row = await db
    .selectFrom('admin_users')
    .select(['id'])
    .where('username', '=', USER)
    .executeTakeFirstOrThrow();
  return Number(row.id);
}

describe('happy path', () => {
  it('changes the password when the current one is correct', async () => {
    const id = await userId();
    const res = await changeOwnPassword(db, {
      userId: id,
      currentPassword: START,
      newPassword: NEXT,
      confirmPassword: NEXT,
    });
    expect(res.username).toBe(USER);

    expect(await verifyCredentials(USER, NEXT, db)).not.toBeNull();
    expect(await verifyCredentials(USER, START, db)).toBeNull();
  });

  it('keeps the caller session and revokes the others', async () => {
    const id = await userId();
    const mine = await createSession(id, db);
    const other1 = await createSession(id, db);
    const other2 = await createSession(id, db);

    const res = await changeOwnPassword(db, {
      userId: id,
      currentPassword: START,
      newPassword: NEXT,
      confirmPassword: NEXT,
      keepSessionToken: mine.token,
    });

    expect(res.sessionsRevoked).toBe(2);
    // The caller stays signed in...
    expect(await resolveSession(mine.token, db)).not.toBeNull();
    // ...everyone else is out.
    expect(await resolveSession(other1.token, db)).toBeNull();
    expect(await resolveSession(other2.token, db)).toBeNull();
  });

  it('revokes ALL sessions when no token is preserved', async () => {
    const id = await userId();
    const a = await createSession(id, db);
    const b = await createSession(id, db);

    const res = await changeOwnPassword(db, {
      userId: id,
      currentPassword: START,
      newPassword: NEXT,
      confirmPassword: NEXT,
    });

    expect(res.sessionsRevoked).toBe(2);
    expect(await resolveSession(a.token, db)).toBeNull();
    expect(await resolveSession(b.token, db)).toBeNull();
  });
});

describe('validation', () => {
  it('rejects a wrong current password and does NOT change anything', async () => {
    const id = await userId();
    await expect(
      changeOwnPassword(db, {
        userId: id,
        currentPassword: 'not-the-password',
        newPassword: NEXT,
        confirmPassword: NEXT,
      }),
    ).rejects.toThrow(PasswordChangeError);

    expect(await verifyCredentials(USER, START, db)).not.toBeNull();
    expect(await verifyCredentials(USER, NEXT, db)).toBeNull();
  });

  it('rejects a confirmation mismatch', async () => {
    const id = await userId();
    await expect(
      changeOwnPassword(db, {
        userId: id,
        currentPassword: START,
        newPassword: NEXT,
        confirmPassword: `${NEXT}-typo`,
      }),
    ).rejects.toMatchObject({ code: 'MISMATCH' });
    expect(await verifyCredentials(USER, START, db)).not.toBeNull();
  });

  it(`rejects a new password shorter than ${MIN_PASSWORD_LENGTH} characters`, async () => {
    const id = await userId();
    const short = 'a'.repeat(MIN_PASSWORD_LENGTH - 1);
    await expect(
      changeOwnPassword(db, {
        userId: id,
        currentPassword: START,
        newPassword: short,
        confirmPassword: short,
      }),
    ).rejects.toMatchObject({ code: 'TOO_SHORT' });
  });

  it('rejects a known-insecure new password', async () => {
    const id = await userId();
    await expect(
      changeOwnPassword(db, {
        userId: id,
        currentPassword: START,
        newPassword: 'password',
        confirmPassword: 'password',
      }),
    ).rejects.toMatchObject({ code: 'TOO_SHORT' }); // short AND insecure; short wins

    await expect(
      changeOwnPassword(db, {
        userId: id,
        currentPassword: START,
        newPassword: 'qwerty123456',
        confirmPassword: 'qwerty123456',
      }),
    ).rejects.toThrow(PasswordChangeError);
  });

  it('rejects reusing the current password', async () => {
    const id = await userId();
    await expect(
      changeOwnPassword(db, {
        userId: id,
        currentPassword: START,
        newPassword: START,
        confirmPassword: START,
      }),
    ).rejects.toMatchObject({ code: 'SAME_AS_CURRENT' });
  });

  it('rejects an unknown user without revealing that it is unknown', async () => {
    await expect(
      changeOwnPassword(db, {
        userId: 999_999,
        currentPassword: START,
        newPassword: NEXT,
        confirmPassword: NEXT,
      }),
    ).rejects.toMatchObject({ code: 'CURRENT_WRONG' });
  });
});

describe('rate limiting', () => {
  it('locks out after repeated wrong current passwords', async () => {
    const id = await userId();
    for (let i = 0; i < 5; i++) {
      await expect(
        changeOwnPassword(db, {
          userId: id,
          currentPassword: `wrong-${i}`,
          newPassword: NEXT,
          confirmPassword: NEXT,
        }),
      ).rejects.toMatchObject({ code: 'CURRENT_WRONG' });
    }

    // The 6th attempt is refused before the password is even checked, and a
    // CORRECT password is refused too while the lockout holds.
    await expect(
      changeOwnPassword(db, {
        userId: id,
        currentPassword: START,
        newPassword: NEXT,
        confirmPassword: NEXT,
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('a successful change clears the failure counter', async () => {
    const id = await userId();
    for (let i = 0; i < 3; i++) {
      await expect(
        changeOwnPassword(db, {
          userId: id,
          currentPassword: 'nope',
          newPassword: NEXT,
          confirmPassword: NEXT,
        }),
      ).rejects.toMatchObject({ code: 'CURRENT_WRONG' });
    }

    await changeOwnPassword(db, {
      userId: id,
      currentPassword: START,
      newPassword: NEXT,
      confirmPassword: NEXT,
    });

    // Counter cleared: three more failures do not trip the limit.
    for (let i = 0; i < 3; i++) {
      await expect(
        changeOwnPassword(db, {
          userId: id,
          currentPassword: 'nope',
          newPassword: 'another-password-1',
          confirmPassword: 'another-password-1',
        }),
      ).rejects.toMatchObject({ code: 'CURRENT_WRONG' });
    }
  });
});

describe('secrecy', () => {
  it('never leaks the password or the hash in an error message', async () => {
    const id = await userId();
    try {
      await changeOwnPassword(db, {
        userId: id,
        currentPassword: 'wrong-current-secret',
        newPassword: 'brand-new-secret-value',
        confirmPassword: 'brand-new-secret-value',
      });
      throw new Error('should have thrown');
    } catch (err) {
      const text = `${String(err)}${err instanceof Error ? err.stack ?? '' : ''}`;
      expect(text).not.toContain('wrong-current-secret');
      expect(text).not.toContain('brand-new-secret-value');
      expect(text).not.toContain('$2a$');
      expect(text).not.toContain('$2b$');
    }
  });

  it('the success result contains no secret material', async () => {
    const id = await userId();
    const res = await changeOwnPassword(db, {
      userId: id,
      currentPassword: START,
      newPassword: NEXT,
      confirmPassword: NEXT,
    });
    const json = JSON.stringify(res);
    expect(json).not.toContain(START);
    expect(json).not.toContain(NEXT);
    expect(json).not.toContain('$2');
    expect(Object.keys(res).sort()).toEqual(['sessionsRevoked', 'username']);
  });

  it('all user-facing failure messages are Russian', () => {
    for (const [code, msg] of Object.entries(CHANGE_FAILURE_RU)) {
      expect(msg, code).toMatch(/[А-Яа-яЁё]/);
    }
  });

  it('the route never logs the request body', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/api/admin/password/route.ts', 'utf8');
    expect(src).not.toMatch(/console\.(log|info|warn|error)/);
    expect(src).not.toMatch(/\$\{\s*(currentPassword|newPassword|confirmPassword)\s*\}/);
  });
});

describe('the Admin UI exposes the section', () => {
  it('renders the Безопасность fields', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/admin/page.tsx', 'utf8');
    expect(src).toContain('Безопасность');
    expect(src).toContain('Текущий пароль');
    expect(src).toContain('Новый пароль');
    expect(src).toContain('Повторите новый пароль');
    expect(src).toContain('Изменить пароль');
    // Inputs must be masked.
    expect(src).toMatch(/id="cur-pwd"[\s\S]{0,120}type="password"/);
    expect(src).toMatch(/id="new-pwd"[\s\S]{0,120}type="password"/);
    expect(src).toMatch(/id="confirm-pwd"[\s\S]{0,120}type="password"/);
  });
});

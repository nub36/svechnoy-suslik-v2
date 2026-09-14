/**
 * Admin session cookie policy + end-to-end session lifecycle.
 *
 * Regression cover for the production defect where the Admin UI appeared for
 * about a second after a successful login and then bounced back to the login
 * form. Credentials, session creation and Postgres storage were all fine (7
 * rows, all valid) — the cookie was emitted with `Secure` because NODE_ENV was
 * 'production', while the VPS is reached over plain http://<ip>:3000. The
 * browser therefore never sent it back and GET /api/admin/session resolved
 * anonymous.
 *
 * The `Secure` attribute must follow the TRANSPORT (COOKIE_SECURE), never the
 * build type alone.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { getTestPg, resetDb } from './pg';
import type { Database } from '../src/db/types';
import {
  SESSION_COOKIE_BASE,
  resolveCookieSecure,
  sessionCookieOptions,
} from '../src/web/cookie-policy';
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  resolveSession,
  verifyCredentials,
} from '../src/web/auth';
import {
  changeOwnPassword,
  resetAdminPassword,
  resetRateLimiter,
} from '../src/web/admin-password';

let db: Kysely<Database>;

const USER = 'admin';
const PASSWORD = 'start-password-123';

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
  await resetAdminPassword(db, USER, PASSWORD);
});

async function userId(): Promise<number> {
  const row = await db
    .selectFrom('admin_users')
    .select(['id'])
    .where('username', '=', USER)
    .executeTakeFirstOrThrow();
  return Number(row.id);
}

/* ------------------------------------------------------------------ */
/* Secure flag resolution — the actual bug                             */
/* ------------------------------------------------------------------ */

describe('COOKIE_SECURE resolution', () => {
  it('production NODE_ENV + COOKIE_SECURE=false => cookie is NOT Secure', () => {
    // The exact production VPS configuration.
    expect(resolveCookieSecure('false', 'production')).toBe(false);
    expect(sessionCookieOptions(resolveCookieSecure('false', 'production')).secure).toBe(false);
  });

  it('production NODE_ENV + COOKIE_SECURE=true => cookie IS Secure', () => {
    expect(resolveCookieSecure('true', 'production')).toBe(true);
    expect(sessionCookieOptions(resolveCookieSecure('true', 'production')).secure).toBe(true);
  });

  it('an explicit setting overrides NODE_ENV in both directions', () => {
    expect(resolveCookieSecure('true', 'development')).toBe(true);
    expect(resolveCookieSecure('false', 'production')).toBe(false);
  });

  it('accepts 1/0 as aliases', () => {
    expect(resolveCookieSecure('1', 'development')).toBe(true);
    expect(resolveCookieSecure('0', 'production')).toBe(false);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(resolveCookieSecure(' FALSE ', 'production')).toBe(false);
    expect(resolveCookieSecure('True', 'development')).toBe(true);
  });

  it('defaults to secure when unset in production', () => {
    // Saying nothing must not silently weaken anything.
    expect(resolveCookieSecure(undefined, 'production')).toBe(true);
  });

  it('defaults to not-secure when unset in development (plain localhost)', () => {
    expect(resolveCookieSecure(undefined, 'development')).toBe(false);
  });

  it('an unrecognised value falls back to the SAFE default, not to false', () => {
    // A typo must never be interpreted as "disable security".
    expect(resolveCookieSecure('yes', 'production')).toBe(true);
    expect(resolveCookieSecure('', 'production')).toBe(true);
    expect(resolveCookieSecure('nope', 'production')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Invariant attributes — never configurable                           */
/* ------------------------------------------------------------------ */

describe('session cookie invariants', () => {
  it('httpOnly is always true, whatever the transport', () => {
    for (const secure of [true, false]) {
      expect(sessionCookieOptions(secure).httpOnly).toBe(true);
    }
    expect(SESSION_COOKIE_BASE.httpOnly).toBe(true);
  });

  it('sameSite is always lax', () => {
    for (const secure of [true, false]) {
      expect(sessionCookieOptions(secure).sameSite).toBe('lax');
    }
  });

  it('path is always /', () => {
    for (const secure of [true, false]) {
      expect(sessionCookieOptions(secure).path).toBe('/');
    }
  });

  it('carries the expiry when one is supplied', () => {
    const exp = new Date('2030-01-01T00:00:00Z');
    expect(sessionCookieOptions(false, exp).expires).toBe(exp);
  });

  it('only the Secure flag differs between the two transports', () => {
    const http = sessionCookieOptions(false);
    const https = sessionCookieOptions(true);
    const { secure: _a, ...restHttp } = http;
    const { secure: _b, ...restHttps } = https;
    expect(restHttp).toEqual(restHttps);
  });
});

/* ------------------------------------------------------------------ */
/* Login route wiring                                                  */
/* ------------------------------------------------------------------ */

describe('login route cookie wiring', () => {
  const route = readRoute();

  function readRoute(): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    return readFileSync(join(__dirname, '..', 'app/api/admin/login/route.ts'), 'utf8');
  }

  it('no longer derives Secure from NODE_ENV', () => {
    expect(route).not.toMatch(/secure:\s*config\.nodeEnv === 'production'/);
  });

  it('uses the shared cookie policy driven by config.cookieSecure', () => {
    expect(route).toMatch(/sessionCookieOptions\(config\.cookieSecure/);
  });

  it('does not consult X-Forwarded-Proto', () => {
    // No trusted-proxy model exists, so the header is attacker-controlled.
    expect(route.toLowerCase()).not.toContain('x-forwarded-proto');
  });

  it('never returns the session token in the response body', () => {
    expect(route).toMatch(/return ok\(\{ username: user\.username, expiresAt \}\)/);
  });
});

/* ------------------------------------------------------------------ */
/* Session lifecycle against the real database                         */
/* ------------------------------------------------------------------ */

describe('session lifecycle', () => {
  it('successful login creates a DB-backed session', async () => {
    const user = await verifyCredentials(USER, PASSWORD, db);
    expect(user).not.toBeNull();

    const { token } = await createSession(user!.id, db);
    expect(token).toBeTruthy();

    const rows = await db.selectFrom('admin_sessions').selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  it('the session endpoint authenticates when the cookie comes back', async () => {
    const user = await verifyCredentials(USER, PASSWORD, db);
    const { token } = await createSession(user!.id, db);

    // This is what the browser does when the cookie is actually sent.
    const resolved = await resolveSession(token, db);
    expect(resolved).not.toBeNull();
    expect(resolved!.username).toBe(USER);
  });

  it('reproduces the bug: a withheld cookie resolves anonymous despite a valid DB session', async () => {
    const user = await verifyCredentials(USER, PASSWORD, db);
    await createSession(user!.id, db);

    // The session row exists and is valid...
    const rows = await db.selectFrom('admin_sessions').selectAll().execute();
    expect(rows).toHaveLength(1);

    // ...but a browser that refuses to send a Secure cookie over HTTP sends
    // nothing, and the UI logs itself out. Exactly the production symptom.
    expect(await resolveSession(undefined, db)).toBeNull();
  });

  it('wrong credentials create no session', async () => {
    expect(await verifyCredentials(USER, 'wrong-password-999', db)).toBeNull();
    const rows = await db.selectFrom('admin_sessions').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('logout destroys the session', async () => {
    const user = await verifyCredentials(USER, PASSWORD, db);
    const { token } = await createSession(user!.id, db);
    expect(await resolveSession(token, db)).not.toBeNull();

    await destroySession(token, db);

    expect(await resolveSession(token, db)).toBeNull();
    const rows = await db.selectFrom('admin_sessions').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('changing the password still invalidates OTHER sessions only', async () => {
    const id = await userId();
    const mine = await createSession(id, db);
    const other = await createSession(id, db);
    const third = await createSession(id, db);

    const res = await changeOwnPassword(db, {
      userId: id,
      currentPassword: PASSWORD,
      newPassword: 'brand-new-password-789',
      confirmPassword: 'brand-new-password-789',
      keepSessionToken: mine.token,
    });

    expect(res.sessionsRevoked).toBe(2);
    // The caller keeps working; everyone else is logged out.
    expect(await resolveSession(mine.token, db)).not.toBeNull();
    expect(await resolveSession(other.token, db)).toBeNull();
    expect(await resolveSession(third.token, db)).toBeNull();
  });

  it('the new password works and the old one does not', async () => {
    const id = await userId();
    const mine = await createSession(id, db);
    await changeOwnPassword(db, {
      userId: id,
      currentPassword: PASSWORD,
      newPassword: 'brand-new-password-789',
      confirmPassword: 'brand-new-password-789',
      keepSessionToken: mine.token,
    });

    expect(await verifyCredentials(USER, 'brand-new-password-789', db)).not.toBeNull();
    expect(await verifyCredentials(USER, PASSWORD, db)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Secret hygiene                                                      */
/* ------------------------------------------------------------------ */

describe('no secret leaks', () => {
  it('the session cookie options contain no token material', () => {
    const opts = JSON.stringify(sessionCookieOptions(false, new Date()));
    expect(opts).not.toMatch(/token/i);
    expect(opts).not.toMatch(/password/i);
    expect(opts).not.toMatch(/hash/i);
  });

  it('resolveSession exposes only id and username, never the hash', async () => {
    const user = await verifyCredentials(USER, PASSWORD, db);
    const { token } = await createSession(user!.id, db);
    const resolved = await resolveSession(token, db);

    expect(Object.keys(resolved!).sort()).toEqual(['id', 'username']);
    expect(JSON.stringify(resolved)).not.toMatch(/hash|password|token/i);
  });

  it('verifyCredentials never returns the stored hash', async () => {
    const user = await verifyCredentials(USER, PASSWORD, db);
    expect(JSON.stringify(user)).not.toMatch(/hash|password/i);
  });

  it('the session token is not stored in client-readable storage anywhere', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('node:path') as typeof import('node:path');
    const adminPage = readFileSync(join(__dirname, '..', 'app/admin/page.tsx'), 'utf8');
    expect(adminPage).not.toMatch(/localStorage/);
    expect(adminPage).not.toMatch(/sessionStorage/);
    expect(adminPage).not.toContain(SESSION_COOKIE);
  });
});

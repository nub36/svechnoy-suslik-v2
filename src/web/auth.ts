/**
 * Admin authentication: bcrypt password check + opaque DB-backed session
 * tokens stored in an httpOnly cookie.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Kysely } from 'kysely';
import { getDb } from '../db';
import type { Database } from '../db/types';
import { config } from '../core/config';

export const SESSION_COOKIE = 'suslik_admin';

export interface SessionUser {
  id: number;
  username: string;
}

export async function verifyCredentials(
  username: string,
  password: string,
  db: Kysely<Database> = getDb(),
): Promise<SessionUser | null> {
  const user = await db
    .selectFrom('admin_users')
    .selectAll()
    .where('username', '=', username)
    .executeTakeFirst();
  if (!user) {
    // Constant-ish time: still run a hash comparison to avoid user enumeration.
    await bcrypt.compare(password, '$2a$10$invalidsaltinvalidsaltinvalidsaltinvalidsaltinvalidsa');
    return null;
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;
  return { id: Number(user.id), username: user.username };
}

export async function createSession(
  userId: number,
  db: Kysely<Database> = getDb(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);
  await db.insertInto('admin_sessions').values({ token, user_id: userId, expires_at: expiresAt }).execute();
  return { token, expiresAt };
}

export async function resolveSession(
  token: string | undefined,
  db: Kysely<Database> = getDb(),
): Promise<SessionUser | null> {
  if (!token) return null;
  const row = await db
    .selectFrom('admin_sessions')
    .innerJoin('admin_users', 'admin_users.id', 'admin_sessions.user_id')
    .select(['admin_users.id as id', 'admin_users.username as username', 'admin_sessions.expires_at as expires_at'])
    .where('admin_sessions.token', '=', token)
    .executeTakeFirst();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await destroySession(token, db);
    return null;
  }
  return { id: Number(row.id), username: row.username };
}

export async function destroySession(token: string, db: Kysely<Database> = getDb()): Promise<void> {
  await db.deleteFrom('admin_sessions').where('token', '=', token).execute();
}

export async function purgeExpiredSessions(db: Kysely<Database> = getDb()): Promise<void> {
  await db.deleteFrom('admin_sessions').where('expires_at', '<', new Date()).execute();
}

/** Constant-time string compare helper. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

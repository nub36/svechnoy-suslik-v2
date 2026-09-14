import { cookies } from 'next/headers';
import { getDb } from '@/db';
import { createSession, verifyCredentials, SESSION_COOKIE } from '@/web/auth';
import { ok, fail, errorMessage } from '@/web/api-utils';
import { config } from '@/core/config';
import { sessionCookieOptions } from '@/web/cookie-policy';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as { username?: string; password?: string };
    const username = String(body.username ?? '');
    const password = String(body.password ?? '');
    if (!username || !password) return fail('username and password are required', 400);

    const db = getDb();
    const user = await verifyCredentials(username, password, db);
    if (!user) return fail('Invalid credentials', 401);

    const { token, expiresAt } = await createSession(user.id, db);
    const store = await cookies();
    // `secure` reflects the actual deployment transport (COOKIE_SECURE), not
    // NODE_ENV: a production build served over plain HTTP must not emit a
    // Secure cookie, or the browser silently withholds it and the session is
    // unusable. httpOnly/sameSite/path are fixed. See src/web/cookie-policy.ts.
    store.set(SESSION_COOKIE, token, sessionCookieOptions(config.cookieSecure, expiresAt));
    // The response body deliberately carries no token, hash or secret.
    return ok({ username: user.username, expiresAt });
  } catch (err) {
    return fail(errorMessage(err), 500);
  }
}

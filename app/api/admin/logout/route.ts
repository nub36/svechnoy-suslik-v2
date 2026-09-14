import { cookies } from 'next/headers';
import { getDb } from '@/db';
import { destroySession, SESSION_COOKIE } from '@/web/auth';
import { ok, errorMessage, fail } from '@/web/api-utils';
import { SESSION_COOKIE_BASE } from '@/web/cookie-policy';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  try {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (token) await destroySession(token, getDb());
    // Cookie removal is matched on name + path, so the path must be stated
    // explicitly to match the cookie that login wrote.
    store.delete({ name: SESSION_COOKIE, path: SESSION_COOKIE_BASE.path });
    return ok({ loggedOut: true });
  } catch (err) {
    return fail(errorMessage(err), 500);
  }
}

import { cookies } from 'next/headers';
import { getDb } from '@/db';
import { destroySession, SESSION_COOKIE } from '@/web/auth';
import { ok, errorMessage, fail } from '@/web/api-utils';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  try {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (token) await destroySession(token, getDb());
    store.delete(SESSION_COOKIE);
    return ok({ loggedOut: true });
  } catch (err) {
    return fail(errorMessage(err), 500);
  }
}

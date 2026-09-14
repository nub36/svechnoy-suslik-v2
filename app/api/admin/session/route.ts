import { cookies } from 'next/headers';
import { resolveSession, SESSION_COOKIE } from '@/web/auth';
import { ok, errorMessage, fail } from '@/web/api-utils';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const store = await cookies();
    const user = await resolveSession(store.get(SESSION_COOKIE)?.value);
    return ok({ authenticated: user !== null, username: user?.username ?? null });
  } catch (err) {
    return fail(errorMessage(err), 500);
  }
}

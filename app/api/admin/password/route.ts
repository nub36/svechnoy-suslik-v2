import { cookies } from 'next/headers';
import { getDb } from '@/db';
import { resolveSession, SESSION_COOKIE } from '@/web/auth';
import {
  CHANGE_FAILURE_RU,
  PasswordChangeError,
  changeOwnPassword,
} from '@/web/admin-password';
import { ok, fail, errorMessage } from '@/web/api-utils';

export const dynamic = 'force-dynamic';

/**
 * Authenticated self-service password change.
 *
 * Requires a valid session; the caller's own session survives the change while
 * every other session for that admin is revoked. Nothing sensitive is ever
 * logged or returned — not the passwords, not the hash, not the token.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value ?? null;
    const user = await resolveSession(token ?? undefined);
    if (!user) return fail('Требуется вход в систему', 401);

    const body = (await req.json().catch(() => ({}))) as {
      currentPassword?: unknown;
      newPassword?: unknown;
      confirmPassword?: unknown;
    };

    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    const confirmPassword = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';

    if (!currentPassword || !newPassword || !confirmPassword) {
      return fail('Заполните все поля', 400);
    }

    const res = await changeOwnPassword(getDb(), {
      userId: user.id,
      currentPassword,
      newPassword,
      confirmPassword,
      keepSessionToken: token,
    });

    return ok({
      changed: true,
      username: res.username,
      sessionsRevoked: res.sessionsRevoked,
      message:
        res.sessionsRevoked > 0
          ? `Пароль изменён. Другие сеансы завершены: ${res.sessionsRevoked}`
          : 'Пароль изменён',
    });
  } catch (err) {
    if (err instanceof PasswordChangeError) {
      const status = err.code === 'RATE_LIMITED' ? 429 : 400;
      return fail(CHANGE_FAILURE_RU[err.code], status);
    }
    return fail(errorMessage(err), 500);
  }
}

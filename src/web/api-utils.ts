import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { resolveSession, SESSION_COOKIE, type SessionUser } from './auth';
import { isTimeframe, type Timeframe } from '../core/types';

export const dynamic = 'force-dynamic';

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, { status: 200, ...init });
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ ok: false, error: message, ...extra }, { status });
}

/** Require an authenticated admin. Returns the user or a 401 response. */
export async function requireAdmin(): Promise<
  { user: SessionUser } | { response: NextResponse }
> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const user = await resolveSession(token);
  if (!user) return { response: fail('Unauthorized', 401) };
  return { user };
}

export function parseTimeframe(v: string | null, fallback: Timeframe = '1h'): Timeframe {
  if (v && isTimeframe(v)) return v;
  return fallback;
}

export function parseIntParam(v: string | null, fallback: number, min: number, max: number): number {
  if (v === null) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

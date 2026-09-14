/**
 * Session cookie policy.
 *
 * WHY THIS EXISTS
 * ---------------
 * The `Secure` cookie attribute is a statement about the TRANSPORT, not about
 * the build. Deriving it from `NODE_ENV` alone conflates the two and breaks a
 * real deployment: the VPS runs with `NODE_ENV=production` but is reached over
 * plain `http://89.125.24.50:3000`. The browser was handed a `Secure` cookie
 * over HTTP, refused to send it back, and every `GET /api/admin/session` after
 * a successful login came through anonymous — so the Admin UI rendered for a
 * moment and then bounced straight back to the login form. The database was
 * never at fault; sessions were created correctly and were all valid.
 *
 * So the flag is now explicit and deployment-scoped: `COOKIE_SECURE`.
 *
 * WHAT IS DELIBERATELY NOT DONE
 * -----------------------------
 * `X-Forwarded-Proto` is NOT consulted. That header is attacker-controlled
 * unless a trusted reverse proxy is known to overwrite it, and this project has
 * no trusted-proxy model. Honouring it blindly would let a client dictate the
 * security attributes of its own session cookie. An explicit operator setting
 * is both safer and easier to reason about.
 *
 * Only `Secure` is configurable. `httpOnly`, `sameSite` and `path` are
 * constants — they are not transport-dependent and must never be relaxed.
 */

/** Cookie attributes that are fixed regardless of deployment. */
export const SESSION_COOKIE_BASE = {
  /** The token must never be readable from JavaScript. Not negotiable. */
  httpOnly: true,
  /** Survives top-level navigation to /admin while blocking cross-site POSTs. */
  sameSite: 'lax',
  /** The whole app shares one session. */
  path: '/',
} as const;

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: 'lax';
  path: '/';
  secure: boolean;
  expires?: Date;
}

/**
 * Decide the `Secure` attribute.
 *
 * Precedence:
 *   1. An explicit `COOKIE_SECURE` value always wins — this is the operator
 *      stating what the transport actually is.
 *   2. Otherwise fall back to `NODE_ENV === 'production'`, so the default stays
 *      security-conscious: a production build that says nothing still gets a
 *      Secure cookie, and only a deliberate opt-out relaxes it.
 *
 * Accepted values are strict. A typo such as `COOKIE_SECURE=yes` must not be
 * read as "insecure": anything unrecognised is ignored and the safe default
 * applies.
 *
 * @param raw      the raw `COOKIE_SECURE` value, if set
 * @param nodeEnv  the raw `NODE_ENV` value
 */
export function resolveCookieSecure(
  raw: string | undefined,
  nodeEnv: string,
): boolean {
  if (raw !== undefined) {
    const v = raw.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    // Unrecognised -> fall through to the secure-by-default rule.
  }
  return nodeEnv === 'production';
}

/**
 * Build the full attribute set for the admin session cookie.
 * `expires` is omitted for deletion-style writes.
 */
export function sessionCookieOptions(
  secure: boolean,
  expires?: Date,
): SessionCookieOptions {
  return {
    ...SESSION_COOKIE_BASE,
    secure,
    ...(expires === undefined ? {} : { expires }),
  };
}

/**
 * Cookie serialization with secure flags on by default.
 *
 * This application authenticates with a bearer token in `localStorage`, so it
 * has historically set no cookies at all. The broker OAuth flow introduces the
 * first one — a short-lived, opaque binding value — and the point of this helper
 * is that the flags are not a per-call decision:
 *
 *  · HttpOnly  — never readable from JavaScript. The value is only ever compared
 *                server-side, so script access has no legitimate use and would
 *                only widen XSS impact.
 *  · Secure    — HTTPS only, except on localhost, where a dev server has no
 *                certificate and the flag would silently drop the cookie.
 *  · SameSite  — `Lax`, not `Strict`. The cookie must survive the broker's
 *                top-level redirect back to us (a cross-site GET navigation),
 *                which `Strict` would strip. `Lax` still withholds it from
 *                cross-site subrequests and form POSTs, which is the CSRF-
 *                relevant case.
 *  · Path      — scoped to the broker routes so it is not attached to every
 *                request to this origin.
 *  · Max-Age   — always set. A session cookie that outlives the flow is a
 *                credential with no expiry.
 *
 * Anything added later that needs a cookie should come through here rather than
 * hand-building a Set-Cookie string.
 */

export interface SecureCookieOptions {
  name: string;
  value: string;
  /** Seconds. Required — see the Max-Age note above. */
  maxAgeSeconds: number;
  path?: string;
  /** Overrides the HTTPS detection below. Only set this in tests. */
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
}

/**
 * `Secure` is dropped only for local development.
 *
 * A cookie marked `Secure` is not sent over plain HTTP, so on `localhost` the
 * flag would make the binding silently fail — and a silently-absent binding is
 * worse than an explicitly relaxed one. Production is HTTPS behind Caddy, so
 * the flag is on wherever it can work.
 */
function shouldMarkSecure(): boolean {
  if (process.env.NODE_ENV === 'production') return true;
  const base = process.env.API_PUBLIC_URL || process.env.FRONTEND_URL || '';
  return base.startsWith('https://');
}

export function serializeSecureCookie(opts: SecureCookieOptions): string {
  const {
    name,
    value,
    maxAgeSeconds,
    path = '/',
    secure = shouldMarkSecure(),
    sameSite = 'Lax',
  } = opts;

  // Reject rather than escape: every value this is called with is generated
  // server-side, so a control character means a bug, and quietly encoding it
  // would hide a header-injection attempt instead of failing on it.
  if (/[;,\s]/.test(value)) {
    throw new Error('Cookie value contains a delimiter; refusing to serialize');
  }
  if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(name)) {
    throw new Error('Invalid cookie name');
  }

  const parts = [
    `${name}=${value}`,
    `Path=${path}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    'HttpOnly',
    `SameSite=${sameSite}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** An immediately-expiring version of the same cookie, for clearing it. */
export function clearSecureCookie(name: string, path = '/'): string {
  return serializeSecureCookie({ name, value: 'x', maxAgeSeconds: 0, path });
}

/**
 * Read one cookie out of a raw `Cookie` header.
 *
 * Hand-parsed rather than adding `cookie-parser`: one cookie, one read site.
 * Returns null for anything malformed instead of throwing, because the header is
 * attacker-controlled and a parse failure must read as "no binding present",
 * which the caller already handles.
 */
export function readCookie(header: string | undefined | null, name: string): string | null {
  if (!header || typeof header !== 'string') return null;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    const value = pair.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

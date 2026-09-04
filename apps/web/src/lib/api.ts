import {
  clearSession,
  getAccessToken,
  getRefreshTokenValue,
  writeSession,
} from './session-storage';

export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

/**
 * The token this TAB is signed in with.
 *
 * Reads through `session-storage.ts` rather than localStorage directly. That
 * indirection is the fix for "every tab shows whoever logged in last" — see
 * that file for the full reasoning. Nothing else in the app should touch the
 * storage keys; this module remains the single owner of the credential.
 */
export function getToken() {
  return getAccessToken();
}

export function getRefreshToken() {
  return getRefreshTokenValue();
}

/**
 * A NON-SECRET marker that a session exists, mirrored into a cookie.
 *
 * The credential itself stays in localStorage — that has not changed. But
 * Next middleware runs on the server and cannot read localStorage, so without
 * some server-visible signal the route gate would have to be a client-side
 * redirect, which means rendering the workspace and yanking it away a tick
 * later. This cookie exists purely so the gate can decide before paint.
 *
 * It is deliberately valueless. Forging `tw_auth=1` gets you a workspace shell
 * that 401s on the first API call, because every real authorization decision
 * is still made by the API against the bearer token. Do not put anything in
 * here that would be worth stealing, and do not start trusting it for
 * anything but routing.
 */
export const AUTH_HINT_COOKIE = 'tw_auth';

function setAuthHint(present: boolean) {
  if (typeof document === 'undefined') return;
  document.cookie = present
    ? // Mirrors REFRESH_TOKEN_DAYS (30d) — the window in which a session can
      // still be revived by a refresh, not the 15-minute access token.
      `${AUTH_HINT_COOKIE}=1; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Lax`
    : `${AUTH_HINT_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
}

export function setSession(accessToken: string, refreshToken?: string) {
  writeSession(accessToken, refreshToken);
  setAuthHint(true);
}

export function setToken(token: string) {
  writeSession(token);
  setAuthHint(true);
}

export function clearToken() {
  clearSession();
  setAuthHint(false);
}

/**
 * Re-assert the routing cookie for a tab that still holds a session.
 *
 * The cookie is device-wide and can be cleared by another tab signing out, or
 * dropped by the browser, while this tab's sessionStorage credential survives.
 * When that happens the middleware bounces an authenticated tab to `/` on its
 * next navigation. Calling this on load repairs the mismatch from the side
 * that actually knows the truth: possession of a token.
 */
export function syncAuthHint() {
  if (getToken()) setAuthHint(true);
}

/**
 * The single in-flight refresh, shared by every concurrent caller.
 *
 * ── THE RACE THIS PREVENTS ─────────────────────────────────────────────────
 *
 * `sessionStore.init()` fires `/auth/me` and `/entitlements/me` together in a
 * `Promise.all`. On a page load with an expired 15-minute access token, BOTH
 * come back 401 at essentially the same instant, and each used to call this
 * function independently — two POSTs to `/auth/refresh` carrying the SAME
 * refresh token.
 *
 * Refresh tokens are single-use and rotated: `auth.service.ts` revokes the row
 * the moment it is presented (`refreshToken.update({ revokedAt: new Date() })`)
 * before issuing the replacement. So the first request succeeds and the second
 * presents an already-revoked token, gets 401 "Invalid refresh token", returns
 * false — and `init()`'s catch calls `clearToken()`.
 *
 * The user is signed out at random, on a page load, having done nothing. It is
 * a race, so it is intermittent and looks like flakiness rather than a bug.
 *
 * Sharing one promise means the second caller awaits the first's result and
 * both proceed with the same new token. The slot is released in `finally` so a
 * later expiry can refresh again.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function performRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  const res = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  setSession(data.accessToken, data.refreshToken);
  return true;
}

function refreshAccessToken(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = performRefresh()
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

/**
 * An API call that reached the server and came back non-OK. Carries the HTTP
 * status so callers can tell "not signed in" (401) from "the service behind
 * this route is down" (5xx) — a distinction the UI must surface accurately
 * rather than collapsing every failure into one message. A thrown TypeError
 * (rather than this) means the API itself was unreachable.
 *
 * `retryAfterSeconds` is the server's own instruction for when to come back,
 * read off the `Retry-After` response header. `@nestjs/throttler` sets it on
 * every 429 with the exact number of seconds left in the bucket's window, so a
 * client that honours it stops guessing: retrying earlier can only produce
 * another 429 and burn the budget the retry is waiting for. Null when the
 * header is absent or unparseable — callers fall back to their own backoff.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  constructor(message: string, status: number, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * `Retry-After` in seconds, per RFC 9110 §10.2.3: either delta-seconds or an
 * HTTP-date. Returns null for anything else, and clamps out negatives so a
 * clock skew on a date-form header cannot produce an instant retry.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * The best human-readable sentence available for a non-OK response.
 *
 * The old fallback was the bare string "API request failed", which told a user
 * nothing and told a developer even less — it was equally the message for a
 * wrong password, a 404 from a mistyped API base URL, and an HTML error page
 * from a proxy in front of a dead server. Three different problems with three
 * different fixes, all wearing the same four words.
 *
 * So: use the server's own message when there is one, understanding that Nest
 * speaks in two shapes (`message` is a string for a thrown HttpException and
 * an ARRAY of failed constraints from `ValidationPipe`), and when the body
 * carries nothing usable, say what actually happened — the status, its reason
 * phrase, and the route — rather than inventing a generic failure.
 */
export function describeApiFailure(
  status: number,
  statusText: string,
  path: string,
  data: unknown,
): string {
  const body = (data ?? {}) as { message?: unknown; error?: unknown };
  const { message } = body;

  if (typeof message === 'string' && message.trim()) return message.trim();
  // ValidationPipe: every failed constraint, in the order it was declared.
  if (Array.isArray(message)) {
    const parts = message.filter((m): m is string => typeof m === 'string' && !!m.trim());
    if (parts.length) return parts.join('. ');
  }
  if (typeof body.error === 'string' && body.error.trim()) return body.error.trim();

  // Nothing usable in the body — a non-JSON response (a proxy's HTML error
  // page, an empty 502) or a shape this client does not know. Describe the
  // response itself; it is the only true thing we have.
  const reason = statusText?.trim() ? `${status} ${statusText.trim()}` : String(status);
  return `${path} failed with ${reason}`;
}

function apiError(res: Response, path: string, data: unknown): ApiError {
  return new ApiError(
    describeApiFailure(res.status, res.statusText, path, data),
    res.status,
    parseRetryAfter(res.headers?.get?.('Retry-After') ?? null),
  );
}

export async function api(path: string, options: RequestInit = {}) {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (res.status === 401 && await refreshAccessToken()) {
    const retryToken = getToken();
    const retry = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(retryToken ? { Authorization: `Bearer ${retryToken}` } : {}),
        ...(options.headers || {}),
      },
    });
    const retryData = await retry.json().catch(() => ({}));
    if (!retry.ok) throw apiError(retry, path, retryData);
    return retryData;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res, path, data);
  return data;
}

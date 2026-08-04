/**
 * apps/admin's session model.
 *
 * Authorization for the whole console is the SAME shared secret
 * `services/api` already trusts — `ADMIN_API_TOKEN`, checked by
 * `AdminTokenGuard` (`services/api/src/auth/admin-token.guard.ts`). This app
 * introduces no second admin concept; it is a browser front end for that
 * one operator credential.
 *
 * The raw token is never stored in the browser, not even in an httpOnly
 * cookie. At login the submitted token is checked against a real
 * `AdminTokenGuard`-gated endpoint on `services/api` (see
 * `app/api/session/route.ts` — a genuine integration check that catches
 * admin's `ADMIN_API_TOKEN` drifting from api's), and on success the cookie
 * stores a signed, expiring session marker: `expiresAtMs.hmac(secret,
 * expiresAtMs)`. Anyone who could forge that signature already knows the
 * token, so it proves the same thing a copy of the token would, without ever
 * putting the secret itself in front of client-side JavaScript.
 *
 * Route Handlers that call `services/api` do not read the token from the
 * cookie either — they read `process.env.ADMIN_API_TOKEN` directly (see
 * `lib/adminApi.ts`). The cookie's only job is "is this browser currently an
 * authenticated session," never carrying the secret itself.
 *
 * Uses Web Crypto (`crypto.subtle`) rather than Node's `crypto` module
 * deliberately: this file is imported from `middleware.ts`, which runs in
 * Next's Edge runtime and cannot load Node built-ins. `crypto.subtle` is
 * available in both the Edge runtime and modern Node, so one implementation
 * serves both call sites instead of maintaining two.
 */

const SESSION_COOKIE = 'tradew_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h — an operator shift, not a lingering credential

function adminToken(): string | null {
  const token = process.env.ADMIN_API_TOKEN;
  return token && token.length > 0 ? token : null;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

function toBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Index-based rather than `for...of`: this tsconfig targets es5, and
  // iterating a typed array needs --downlevelIteration or an es2015+ target
  // to compile (same class of fix as apps/web/src/components/strategy-
  // workspace/AnnotatedChart.tsx hit earlier).
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sign(expiresAtMs: number, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(expiresAtMs)));
  return toBase64Url(signature);
}

export async function issueSessionCookieValue(): Promise<string> {
  const secret = adminToken();
  if (!secret) throw new Error('ADMIN_API_TOKEN is not configured');
  const expiresAtMs = Date.now() + SESSION_TTL_MS;
  return `${expiresAtMs}.${await sign(expiresAtMs, secret)}`;
}

/** Validate a session cookie value. Every failure mode resolves to false, never throws. */
export async function isValidSessionValue(value: string | undefined | null): Promise<boolean> {
  const secret = adminToken();
  if (!secret || !value) return false;

  const [expiresAtRaw, signature] = value.split('.');
  const expiresAtMs = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAtMs) || !signature) return false;
  if (Date.now() > expiresAtMs) return false;

  try {
    const key = await hmacKey(secret);
    // Cast to BufferSource at the boundary: @types/node's Uint8Array
    // augmentation (generic over ArrayBufferLike) and lib.dom's
    // crypto.subtle.verify (which wants a plain ArrayBuffer-backed view)
    // disagree on the generic parameter even though the runtime value is
    // always a plain-ArrayBuffer-backed Uint8Array here — a known TS
    // lib-version mismatch, not a real type hazard.
    return await crypto.subtle.verify(
      'HMAC',
      key,
      fromBase64Url(signature) as unknown as BufferSource,
      new TextEncoder().encode(String(expiresAtMs)) as unknown as BufferSource,
    );
  } catch {
    return false;
  }
}

/**
 * Server Component / Route Handler check: is the current request an admin
 * session? Lazily imports `next/headers` — that module requires a live
 * Next.js request context to resolve, and `issueSessionCookieValue` /
 * `isValidSessionValue` above are pure enough to unit-test without one; a
 * top-level import would force every test of this file through Next's
 * runtime for no reason.
 */
export async function hasValidSession(): Promise<boolean> {
  const { cookies } = await import('next/headers');
  return isValidSessionValue(cookies().get(SESSION_COOKIE)?.value);
}

export const ADMIN_SESSION_COOKIE_NAME = SESSION_COOKIE;
export const ADMIN_SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000;

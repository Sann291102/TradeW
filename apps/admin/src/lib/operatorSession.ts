/**
 * apps/admin's session model — Phase 2 of the admin consolidation.
 *
 * WHAT CHANGED FROM THE ORIGINAL `session.ts` (now archived)
 *
 * The old cookie was a signed MARKER: `expiresAtMs.hmac(ADMIN_API_TOKEN, …)`.
 * It proved "this browser once presented the operator token" and nothing more —
 * there was no person behind it, because the standalone console had no identity
 * beyond the shared secret. That is exactly what
 * `knowledge/Decisions/2026-08-12 - Operator identity for the standalone admin
 * console.md` set out to fix.
 *
 * Now the session carries a real OPERATOR ASSERTION minted by
 * `services/api /admin/operator/login` and naming an `OperatorAccount`. Two
 * hard rules govern how it is stored, both dictated by the security brief:
 *
 *  1. The browser gets ONLY an opaque cookie. Neither the operator assertion nor
 *     `ADMIN_API_TOKEN` may ever reach browser-accessible JavaScript. The cookie
 *     is `httpOnly` (JS cannot read it at all) AND its payload is sealed with
 *     AES-256-GCM under a server-only key (`ADMIN_SESSION_SECRET`), so even the
 *     bytes that ride in the cookie are inert ciphertext without that key. The
 *     plaintext assertion exists only inside this server process.
 *
 *  2. The assertion is retrieved server-side, on the proxy leg, and forwarded to
 *     `services/api` as `x-operator-assertion` alongside `x-admin-token` — see
 *     `app/api/proxy/[...path]/route.ts`. It is never handed back to the client.
 *
 * WHY A DEDICATED `ADMIN_SESSION_SECRET` RATHER THAN REUSING `ADMIN_API_TOKEN`
 *
 * `ADMIN_API_TOKEN` travels on the wire to `services/api` on every request. A
 * secret used to seal at-rest session state should not also be one that is
 * transmitted constantly — a capture of the wire secret would otherwise let an
 * attacker forge sessions. Same reasoning `OPERATOR_JWT_SECRET` follows on the
 * API side. Mint a dedicated value.
 *
 * WHY WEB CRYPTO (`crypto.subtle`)
 *
 * `middleware.ts` runs in Next's Edge runtime and cannot load Node's `crypto`.
 * `crypto.subtle` (AES-GCM, SHA-256) is available in BOTH the Edge runtime and
 * Node, so the same sealing code serves the middleware gate and the Node-side
 * Route Handlers. This is why the original file used Web Crypto too.
 */

const SESSION_COOKIE = 'tradew_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h — an operator shift, matching the API assertion TTL.

export interface OperatorIdentity {
  id: string;
  email: string;
  name: string | null;
}

/** The sealed payload. `v` lets a future format change invalidate old cookies
 *  deterministically rather than mis-parsing them. */
interface SessionPayload {
  v: 1;
  assertion: string;
  operator: OperatorIdentity;
  expiresAtMs: number;
}

function sessionSecret(): string | null {
  const secret = process.env.ADMIN_SESSION_SECRET;
  // Fail closed on a missing or too-short key, mirroring services/api's secret
  // policy. An unconfigured deployment has NO working session rather than one
  // sealed with a guessable key.
  return secret && secret.length >= 32 ? secret : null;
}

/** Derive a 256-bit AES key from the configured secret. SHA-256 is sufficient
 *  here because `ADMIN_SESSION_SECRET` is a high-entropy minted value, not a
 *  human password — no salted KDF is warranted. */
async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  // Index-based, not `for...of`: this tsconfig targets es5 and iterating a typed
  // array needs --downlevelIteration otherwise (same fix the old file carried).
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

/**
 * Seal an operator identity + assertion into a cookie value. The caller has
 * already authenticated the operator against `services/api`; this only
 * encrypts the result. Throws if `ADMIN_SESSION_SECRET` is not configured — the
 * login Route Handler turns that into a 500 rather than issuing an unsealed
 * session.
 */
export async function sealSession(assertion: string, operator: OperatorIdentity): Promise<string> {
  const secret = sessionSecret();
  if (!secret) throw new Error('ADMIN_SESSION_SECRET is not configured');

  const payload: SessionPayload = { v: 1, assertion, operator, expiresAtMs: Date.now() + SESSION_TTL_MS };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(secret);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload))),
  );

  // iv ‖ ciphertext(+GCM tag). One base64url blob, no delimiters to mis-split.
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.length);
  return toBase64Url(packed);
}

/** Decrypt + validate. Every failure mode (bad key, tampered bytes, expired,
 *  wrong version) resolves to null, never throws — a broken cookie is simply
 *  "not signed in". */
export async function readSessionValue(value: string | undefined | null): Promise<SessionPayload | null> {
  const secret = sessionSecret();
  if (!secret || !value) return null;

  try {
    const packed = fromBase64Url(value);
    if (packed.length <= 12) return null;
    const iv = packed.slice(0, 12);
    const ciphertext = packed.slice(12);
    const key = await aesKey(secret);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource,
    );
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as SessionPayload;
    if (payload.v !== 1 || typeof payload.assertion !== 'string' || !payload.operator) return null;
    if (typeof payload.expiresAtMs !== 'number' || Date.now() > payload.expiresAtMs) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Edge-safe boolean gate for `middleware.ts` — is this cookie value a live
 *  session? Does NOT expose the assertion. */
export async function isValidSessionValue(value: string | undefined | null): Promise<boolean> {
  return (await readSessionValue(value)) !== null;
}

/**
 * Server Component / Route Handler check: is the current request signed in?
 * Lazily imports `next/headers` (needs a live request context) so the pure
 * seal/read helpers above stay unit-testable without Next's runtime.
 */
export async function hasValidSession(): Promise<boolean> {
  const { cookies } = await import('next/headers');
  return isValidSessionValue(cookies().get(SESSION_COOKIE)?.value);
}

/**
 * The proxy leg's accessor: the operator assertion for the current session, or
 * null if unauthenticated. This is the ONLY function that returns the assertion,
 * and it is only ever called from a server-side Route Handler that immediately
 * forwards it to `services/api` — never serialized into a response body.
 */
export async function currentOperatorAssertion(): Promise<string | null> {
  const { cookies } = await import('next/headers');
  const payload = await readSessionValue(cookies().get(SESSION_COOKIE)?.value);
  return payload?.assertion ?? null;
}

/** The signed-in operator's identity, for rendering the console header. Safe to
 *  send to the client — it is an id/email/name, not a credential. */
export async function currentOperator(): Promise<OperatorIdentity | null> {
  const { cookies } = await import('next/headers');
  const payload = await readSessionValue(cookies().get(SESSION_COOKIE)?.value);
  return payload?.operator ?? null;
}

export const ADMIN_SESSION_COOKIE_NAME = SESSION_COOKIE;
export const ADMIN_SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000;

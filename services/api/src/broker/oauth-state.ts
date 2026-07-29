import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * OAuth/consent state: CSRF and replay protection for the broker connect flow.
 *
 * WHY THIS IS A SEPARATE, PURE MODULE
 *
 * The decision "is this callback allowed to write a credential, and whose?" is
 * the whole security boundary of the broker flow. Keeping it here — no Nest, no
 * Prisma, no clock, no environment — means it is unit-testable directly, the
 * way `discipline-limits.ts` is. The database work stays in the service; every
 * *judgement* lives in `resolvePendingState` below.
 *
 * THREAT MODEL
 *
 * `GET /broker/dhan/callback` cannot require a bearer token: it arrives as a
 * top-level browser navigation from the broker's domain, which carries no
 * Authorization header. So the endpoint is reachable by anyone, and the
 * protections are:
 *
 *   1. It must correspond to a flow an AUTHENTICATED user started (a live state
 *      row). An unsolicited callback matches nothing and is refused.
 *   2. The credential is attributed to the state row's `userId` — never to
 *      anything in the callback request. A caller cannot name the account they
 *      are writing to.
 *   3. Each state is single-use (`consumedAt`) and short-lived (`expiresAt`), so
 *      a captured callback URL cannot be replayed.
 *   4. When the provider echoes `state` back, it MUST match. A mismatch is a
 *      hard refusal, not a fall-through to a looser check.
 *
 * WHY THERE IS ALSO A NO-STATE PATH
 *
 * Dhan's consent flow (`/app/generate-consent` -> browser 2FA -> redirect with
 * `?tokenId=`) documents only `tokenId` on the redirect. The redirect URL is
 * registered with the broker, so we cannot vary it per request, and the broker
 * is not contractually obliged to preserve query parameters we append to it.
 *
 * Refusing every callback without `state` would therefore risk breaking the
 * flow outright. Instead, when `state` is absent, a callback is accepted ONLY
 * when exactly one live pending state exists for the provider — which still
 * requires an authenticated user to have started a flow inside the expiry
 * window, still binds the credential to that user, and is still single-use.
 * Ambiguity (two or more concurrent flows) is refused rather than guessed at,
 * because guessing is precisely how one user's broker token would land on
 * another user's account.
 *
 * Operators who confirm their broker echoes `state` should set
 * `BROKER_OAUTH_REQUIRE_STATE=true`, which removes the no-state path entirely.
 * See `resolvePendingState`.
 */

/** 256 bits from the CSPRNG. Not `Math.random`, which is neither unpredictable
 *  nor safe for anything an attacker would want to guess. */
const STATE_BYTES = 32;

/** Minutes, not hours: the window between "operator clicked Connect" and
 *  "broker redirected back" is a human completing 2FA. */
export const STATE_TTL_MS = 10 * 60_000;

export interface PendingStateRow {
  id: string;
  userId: string;
  provider: string;
  stateHash: string;
  consentAppId: string | null;
  consumedAt: Date | null;
  expiresAt: Date;
}

/** Why a callback was refused. These strings reach the security log and the
 *  redirect's `reason` param, so they are stable and non-revealing — they say
 *  what rule failed, never which values were involved. */
export type StateRejection =
  | 'state_missing'
  | 'state_unknown'
  | 'state_replayed'
  | 'state_expired'
  | 'state_ambiguous'
  | 'state_provider_mismatch';

export type StateResolution =
  | { ok: true; row: PendingStateRow; matchedBy: 'state' | 'sole_pending_flow' }
  | { ok: false; reason: StateRejection };

/** A fresh state value plus the hash to persist. The caller stores the hash and
 *  hands the value to the browser; the value is never written down anywhere it
 *  could be read back out of. */
export function createState(): { state: string; stateHash: string } {
  const state = randomBytes(STATE_BYTES).toString('base64url');
  return { state, stateHash: hashState(state) };
}

/** SHA-256, matching how `AuthService` stores refresh tokens. A state value is
 *  a bearer secret for the duration of one flow, so the database holds only a
 *  digest of it. */
export function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Hash comparison is not the classic timing-attack target — an attacker cannot
 * search a 256-bit space a byte at a time through an HTTP endpoint. It is done
 * anyway because the alternative (`===` on a secret-derived value) is the
 * pattern reviewers have to re-litigate every time they read it, and because
 * `timingSafeEqual` throws on length mismatch, which forces the explicit
 * length check below rather than leaving it implicit.
 */
export function digestsMatch(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Decide which pending flow — if any — a callback belongs to.
 *
 * `rows` is every state row the service loaded for this provider, INCLUDING
 * consumed and expired ones. That is deliberate: a consumed row must be
 * distinguishable from an unknown one so replay is reported as replay, and the
 * caller cannot pre-filter in a way that hides it.
 *
 * @param candidateState the raw `state` from the callback, if the provider
 *        echoed one. Untrusted input; only ever hashed, never compared raw.
 * @param requireState when true, a callback with no `state` is refused outright
 *        (`BROKER_OAUTH_REQUIRE_STATE`). Secure-by-default is not available
 *        here — see the module docstring on why the no-state path exists — so
 *        this is the switch that closes it once an operator has verified their
 *        broker preserves the parameter.
 */
export function resolvePendingState(input: {
  rows: PendingStateRow[];
  provider: string;
  candidateState?: string | null;
  now: Date;
  requireState?: boolean;
}): StateResolution {
  const { rows, provider, candidateState, now, requireState = false } = input;

  // Never let a state minted for one broker satisfy another broker's callback.
  const forProvider = rows.filter((r) => r.provider === provider);

  if (candidateState) {
    const candidateHash = hashState(candidateState);
    const match = forProvider.find((r) => digestsMatch(r.stateHash, candidateHash));

    // A state we have never issued. Also covers a state issued for a different
    // provider, which is why that is checked before this and not after.
    if (!match) {
      const existsElsewhere = rows.some((r) => digestsMatch(r.stateHash, candidateHash));
      return { ok: false, reason: existsElsewhere ? 'state_provider_mismatch' : 'state_unknown' };
    }
    // Order matters: report replay even for a state that has since expired,
    // because a consumed state being presented again is the more serious signal.
    if (match.consumedAt) return { ok: false, reason: 'state_replayed' };
    if (match.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'state_expired' };
    return { ok: true, row: match, matchedBy: 'state' };
  }

  if (requireState) return { ok: false, reason: 'state_missing' };

  // No `state` echoed back. Fall back to "there is exactly one flow in
  // progress" — still authenticated-initiated, still user-bound, still
  // single-use, but it cannot disambiguate concurrent flows, so it refuses to
  // try.
  const live = forProvider.filter(
    (r) => !r.consumedAt && r.expiresAt.getTime() > now.getTime(),
  );
  if (live.length === 1) return { ok: true, row: live[0], matchedBy: 'sole_pending_flow' };
  if (live.length > 1) return { ok: false, reason: 'state_ambiguous' };

  // Nothing live. Distinguish "a flow existed and was already completed" from
  // "no flow ever started" so the log is useful.
  const wasConsumed = forProvider.some((r) => r.consumedAt);
  return { ok: false, reason: wasConsumed ? 'state_replayed' : 'state_unknown' };
}

/** Human-readable, non-revealing text for each refusal. Safe to put in a
 *  redirect URL the user's browser will display. */
export function rejectionMessage(reason: StateRejection): string {
  switch (reason) {
    case 'state_missing':
      return 'Broker callback did not carry the required state parameter.';
    case 'state_unknown':
      return 'Broker callback did not match a connection request started from this account.';
    case 'state_replayed':
      return 'This broker callback has already been used.';
    case 'state_expired':
      return 'The broker connection request expired. Start it again.';
    case 'state_ambiguous':
      return 'More than one broker connection is in progress. Start it again.';
    case 'state_provider_mismatch':
      return 'Broker callback state was issued for a different provider.';
  }
}

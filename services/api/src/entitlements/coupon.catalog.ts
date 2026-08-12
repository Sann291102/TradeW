/**
 * Redemption codes, defined SERVER-SIDE.
 *
 * ── WHY THIS FILE EXISTS (2026-08-12) ──────────────────────────────────────
 *
 * Redeeming a code used to be a browser-only act. `sessionStore.redeemCoupon`
 * compared the string in the client, pushed `'sentinel'` into a local array,
 * and wrote it to localStorage. Nothing was ever sent to the server.
 *
 * The result was a UI that unlocked and a product that did not. The Settings
 * page said Sentinel was active, the Sentinel panel rendered its live state —
 * and every premium call to `services/api` returned 403, because the server had
 * no idea a code had been redeemed. The user had "purchased" a capability that
 * only existed in their own browser, and which vanished when they cleared site
 * data or opened a different device.
 *
 * A capability the client grants itself is not an entitlement, it is a
 * decoration. So the decision moved here, where it can be enforced: a code
 * names a real PLAN, redemption creates a real SUBSCRIPTION through
 * `EntitlementsService.activate`, and `/entitlements/me` reports it because it
 * is genuinely true. Premium routes then authorize on their own — no special
 * case, no client cooperation, and it follows the account to any device.
 *
 * ── WHERE THIS SHOULD END UP ───────────────────────────────────────────────
 *
 * A `Coupon` table with per-code redemption limits, expiry and an audit row per
 * redemption is the right long-term home, and it needs a migration. This
 * catalogue is the same shape in code so that migration is a move rather than a
 * redesign: one list, validated in one place, granting real plans. What it
 * cannot yet express is a global cap ("first 500 users") — per-user
 * idempotency is enforced in the service instead.
 */

export interface Coupon {
  /** Normalised form — compare with `normalizeCode`, never raw. */
  readonly code: string;
  /** A plan code from the Plan table. Must grant the capabilities promised. */
  readonly planCode: string;
  /** How long the granted subscription lasts. */
  readonly months: number;
  /** Shown to the user on success. */
  readonly label: string;
}

/**
 * Codes are matched case-insensitively, with a leading `#` and surrounding
 * whitespace ignored — the code is presented in marketing as
 * "#HashtagTradeWSetup100", and people paste it with the hash, with trailing
 * spaces, and in every capitalisation. Rejecting those is a support ticket, not
 * a security control.
 */
export function normalizeCode(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^#/, '')
    .toLowerCase();
}

const COUPONS: readonly Coupon[] = [
  {
    code: 'hashtagtradewsetup100',
    planCode: 'sentinel_pro',
    months: 1,
    label: '1 Month Sentinel PRO Access',
  },
  // The same promotion, without the "hashtag" prefix people drop when typing.
  // Accepted by the previous client-side check, so it stays accepted here —
  // removing it would break codes already handed out.
  {
    code: 'tradewsetup100',
    planCode: 'sentinel_pro',
    months: 1,
    label: '1 Month Sentinel PRO Access',
  },
];

export function findCoupon(raw: string): Coupon | null {
  const code = normalizeCode(raw);
  if (!code) return null;
  return COUPONS.find((c) => c.code === code) ?? null;
}

/** Exposed for tests, so the catalogue can be asserted rather than eyeballed. */
export const ALL_COUPONS = COUPONS;

import { create } from 'zustand';
import { api, getToken, getRefreshToken, clearToken, syncAuthHint } from '../api';

/**
 * Real authentication/entitlement session state (Phase 2, Milestone 4, Step 1).
 *
 * This is the ONE place the frontend reads "who is logged in" and "what can
 * they access" — `GET /auth/me` and `GET /entitlements/me` are the real,
 * already-working `services/api` endpoints (confirmed live in the backend
 * audit, 2026-07-18). No new backend code was needed for this store; it only
 * calls contracts that already exist.
 *
 * Deliberately NOT persisted (unlike workspaceStore) — session data is
 * server-truth, re-verified on every load via the token already sitting in
 * localStorage (lib/api.ts owns that token, this store never touches
 * localStorage directly, avoiding the "duplicate auth logic" the milestone
 * explicitly forbids).
 *
 * Deliberately does NOT redirect on unauthenticated — per prior direction,
 * TradeW has no login wall; guest-capable pages render a signed-out state
 * instead of bouncing to /login. Pages that need identity read `user`/
 * `status` from this store and decide their own UI, they never call
 * `router.push('/login')` from here.
 */

export interface SessionUser {
  id: string;
  email: string;
  country: string;
  experienceLevel: string | null;
  optionsFamiliarity: string | null;
  createdAt: string;
}

export type SessionStatus = 'idle' | 'loading' | 'authenticated' | 'unauthenticated';

interface SessionState {
  status: SessionStatus;
  user: SessionUser | null;
  /** Capability strings from GET /entitlements/me, e.g. ['sentinel', 'ai_research']. */
  capabilities: string[];
  /** True when the last init() failed because the API was unreachable (not a real 401) — the
   *  token is kept in that case so a later retry can still succeed once the backend is back. */
  offline: boolean;
  init: () => Promise<void>;
  logout: () => Promise<void>;
  hasCapability: (capability: string) => boolean;
  grantCapability: (capability: string) => void;
  redeemCoupon: (code: string) => { success: boolean; message: string };
}

function isOfflineError(err: unknown): boolean {
  return /fetch/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * Locally-redeemed capabilities, PER ACCOUNT.
 *
 * ── WHY THIS IS KEYED BY USER (2026-08-12) ────────────────────────────────
 *
 * This used to be a flat `string[]` under `tradew_unlocked_caps`, merged into
 * whichever account happened to sign in next on that browser. So user1
 * redeeming the testing coupon silently handed user2 a UI that claimed
 * Sentinel was active on their account. `services/api` still returned 403 to
 * user2 for every premium route, which makes it the same failure already
 * documented in `hasCapability` below: a client asserting an entitlement the
 * server denies, producing a UI that lies about the state of an account.
 *
 * The old flat key is deliberately NOT migrated. Migrating would have to guess
 * which account earned the unlock, and guessing wrong is exactly the bug. It
 * is left in place rather than deleted (repo rule 1) and simply no longer read.
 */
const UNLOCKED_CAPS_KEY = 'tradew_unlocked_caps_by_user';

function readCapMap(): Record<string, string[]> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = JSON.parse(localStorage.getItem(UNLOCKED_CAPS_KEY) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/**
 * Signed out there is no account to attribute an unlock to, so there are no
 * local capabilities — returning some would gate UI on behalf of nobody.
 */
function getLocalUnlockedCaps(userId: string | null): string[] {
  if (!userId) return [];
  const caps = readCapMap()[userId];
  return Array.isArray(caps) ? caps : [];
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  status: 'idle',
  user: null,
  capabilities: [],
  offline: false,

  init: async () => {
    if (!getToken()) {
      set({ status: 'unauthenticated', user: null, capabilities: [], offline: false });
      return;
    }
    // This tab holds a session but the device-wide routing cookie may have been
    // cleared by another tab signing out. Re-assert it, or the next navigation
    // gets bounced to the landing page by middleware.
    syncAuthHint();
    set({ status: 'loading' });
    try {
      const [user, entitlements] = await Promise.all([api('/auth/me'), api('/entitlements/me')]);
      // Local unlocks are looked up only once the account is known, so one
      // user's redeemed coupon can never be merged into another's session.
      const localCaps = getLocalUnlockedCaps(user?.id ?? null);
      const mergedCaps = Array.from(new Set([...(entitlements.capabilities ?? []), ...localCaps]));
      set({ status: 'authenticated', user, capabilities: mergedCaps, offline: false });
    } catch (err) {
      const offline = isOfflineError(err);
      if (!offline) clearToken();
      set({ status: 'unauthenticated', user: null, capabilities: [], offline });
    }
  },

  logout: async () => {
    const refreshToken = getRefreshToken();
    try {
      await api('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) });
    } catch {
      // best-effort
    }
    clearToken();
    set({ status: 'unauthenticated', user: null, capabilities: [], offline: false });
  },

  hasCapability: (capability) => {
    /**
     * Reads the real entitlement list. Nothing is unconditionally granted.
     *
     * ── WHAT WAS HERE, AND WHY IT WAS REMOVED (2026-08-11) ────────────────
     *
     * This began with `if (capability === 'sentinel') return true;` — an
     * unconditional, uncommented unlock introduced in bf8944b ("Made changes
     * from antigravity"). Its effects, all observed in the browser on a
     * freshly-created account whose `/entitlements/me` returned an empty
     * capability list:
     *
     *   - Settings told the user "Sentinel is active on your account", which
     *     was simply untrue.
     *   - Because that branch renders instead of the tier grid, the Sentinel
     *     pricing and upgrade UI was unreachable for EVERY user — the plans
     *     could not be seen, let alone bought.
     *   - The `/trade` Sentinel panel showed "ACTIVE PRO · observing" while
     *     `/api/sentinel/observe` returned 403 to the same session.
     *
     * It was never a security hole: `services/api` enforces entitlement on
     * every premium route and did so throughout (SUBSCRIPTIONS.md §4). But a
     * client that asserts an entitlement the server denies produces a UI that
     * lies to the user and hides the product's own pricing.
     *
     * If a blanket unlock is wanted for demos, the mechanism already exists and
     * is visible: the "Redeem Testing Coupon" control, which writes to
     * `tradew_unlocked_caps` and is read below via `getLocalUnlockedCaps()`.
     * Use that — it is opt-in, inspectable, and does not misreport the state of
     * an account nobody unlocked.
     */
    return get().capabilities.includes(capability);
  },

  grantCapability: (capability) => {
    const current = get().capabilities;
    if (current.includes(capability)) return;
    const updated = [...current, capability];
    set({ capabilities: updated });

    // Persist against the signed-in account only. A coupon redeemed while
    // signed out has nobody to belong to, so it lasts for the session in
    // memory and is not written anywhere another account could inherit it.
    const userId = get().user?.id;
    if (!userId || typeof window === 'undefined') return;
    try {
      const map = readCapMap();
      map[userId] = updated;
      localStorage.setItem(UNLOCKED_CAPS_KEY, JSON.stringify(map));
    } catch {
      /* storage unavailable — the unlock still applies to this session */
    }
  },

  redeemCoupon: (code) => {
    const clean = code.trim().replace(/^#/, '').toLowerCase();
    if (clean === 'hashtagtradewsetup100' || clean === 'tradewsetup100') {
      get().grantCapability('sentinel');
      return { success: true, message: '1 Month Sentinel PRO Access Unlocked successfully!' };
    }
    return { success: false, message: 'Invalid coupon code. Please try HashtagTradeWSetup100.' };
  },
}));

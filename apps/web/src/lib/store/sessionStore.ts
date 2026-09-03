import { create } from 'zustand';
import {
  api,
  ApiError,
  getToken,
  getRefreshToken,
  clearToken,
  clearStaleAuthHint,
  syncAuthHint,
} from '../api';

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
  /**
   * Async because redemption is a server call now, not a string comparison in
   * the browser. Every caller must await it and render from the result.
   */
  redeemCoupon: (code: string) => Promise<{ success: boolean; message: string }>;
}

function isOfflineError(err: unknown): boolean {
  return /fetch/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * ── LOCALLY-GRANTED CAPABILITIES ARE GONE (2026-08-12) ────────────────────
 *
 * There used to be a `tradew_unlocked_caps` array in localStorage, merged into
 * `capabilities` on every load. `redeemCoupon` compared the code in the
 * browser, pushed `'sentinel'` into that array, and told the user their plan
 * was active. Nothing was ever sent to the server.
 *
 * So the unlock was a decoration. Settings said Sentinel was active, the
 * Sentinel panel rendered its live state, and `services/api` returned 403 to
 * every premium call because it had never heard of the redemption. Reported as
 * "purchased using redeem code but it failed to load the premium feature" —
 * and that is exactly what it was: a client that granted itself an entitlement
 * the server does not recognise. It also died with the browser profile and did
 * not follow the account to another device.
 *
 * Redemption is now a real server call — `POST /entitlements/redeem` creates a
 * genuine subscription (see coupon.catalog.ts) — so `capabilities` is once
 * again exactly what `GET /entitlements/me` returned and nothing else. There is
 * no local override path left to disagree with the server.
 *
 * The old localStorage keys are left in place rather than deleted (repo rule 1)
 * and are simply never read again.
 */

export const useSessionStore = create<SessionState>()((set, get) => ({
  status: 'idle',
  user: null,
  capabilities: [],
  offline: false,

  init: async () => {
    if (!getToken()) {
      // No credential, so any `tw_auth` still sitting in the cookie jar is an
      // orphan that outlived its token. Drop it, or middleware keeps waving
      // this browser into gated routes to render a signed-out shell — for the
      // cookie's full 30 days, since nothing else in this path clears it.
      clearStaleAuthHint();
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
      // Server truth, unmodified. Nothing is merged in on top — see the note
      // above about why a locally-granted capability is worse than none.
      set({
        status: 'authenticated',
        user,
        capabilities: entitlements.capabilities ?? [],
        offline: false,
      });
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
     * A demo unlock is granted the same way a purchase is: redeem a code, which
     * creates a real subscription server-side (`POST /entitlements/redeem`), or
     * have an operator issue an EntitlementOverride. Both are inspectable, both
     * are enforced by the API, and neither can tell a user something about
     * their account that the server would deny.
     */
    return get().capabilities.includes(capability);
  },

  /**
   * Redeem an access code.
   *
   * The whole of the decision happens on the server: it validates the code,
   * creates the subscription, and answers with the capabilities the account now
   * genuinely holds. This client does not decide anything and does not write a
   * capability anywhere — it stores what it was told.
   *
   * That is the difference between this and what it replaced. Before, the code
   * was compared here and `'sentinel'` was pushed into local state, so the UI
   * unlocked while every premium API call kept returning 403. Redeeming now
   * either works everywhere or reports why it did not.
   */
  redeemCoupon: async (code) => {
    if (!code.trim()) return { success: false, message: 'Enter a code to redeem.' };
    if (get().status !== 'authenticated') {
      return { success: false, message: 'Sign in first — a code is redeemed against your account.' };
    }
    try {
      const res = await api('/entitlements/redeem', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      // Trust the server's list over any local guess about what the plan grants.
      set({ capabilities: res.capabilities ?? get().capabilities });
      return { success: true, message: res.message ?? 'Code redeemed.' };
    } catch (err) {
      // A 400 carries the real reason ("that code is not valid"); anything else
      // is an outage and must not be reported as a bad code, or the user
      // retypes a perfectly good one until they give up.
      if (err instanceof ApiError && err.status === 400) {
        return { success: false, message: err.message };
      }
      if (err instanceof ApiError && err.status === 429) {
        return { success: false, message: 'Too many attempts. Wait a minute and try again.' };
      }
      return {
        success: false,
        message: "Couldn't reach the server to redeem that code. Check your connection and try again.",
      };
    }
  },
}));

import { create } from 'zustand';
import { api, getToken, getRefreshToken, clearToken } from '../api';

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

function getLocalUnlockedCaps(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem('tradew_unlocked_caps') || '[]');
  } catch {
    return [];
  }
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  status: 'idle',
  user: null,
  capabilities: [],
  offline: false,

  init: async () => {
    const localCaps = getLocalUnlockedCaps();
    if (!getToken()) {
      set({ status: 'unauthenticated', user: null, capabilities: localCaps, offline: false });
      return;
    }
    set({ status: 'loading' });
    try {
      const [user, entitlements] = await Promise.all([api('/auth/me'), api('/entitlements/me')]);
      const mergedCaps = Array.from(new Set([...(entitlements.capabilities ?? []), ...localCaps]));
      set({ status: 'authenticated', user, capabilities: mergedCaps, offline: false });
    } catch (err) {
      const offline = isOfflineError(err);
      if (!offline) clearToken();
      set({ status: 'unauthenticated', user: null, capabilities: localCaps, offline });
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
    set({ status: 'unauthenticated', user: null, capabilities: getLocalUnlockedCaps(), offline: false });
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
    if (!current.includes(capability)) {
      const updated = [...current, capability];
      set({ capabilities: updated });
      if (typeof window !== 'undefined') {
        localStorage.setItem('tradew_unlocked_caps', JSON.stringify(updated));
      }
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

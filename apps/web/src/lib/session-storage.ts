/**
 * Where the session credential lives — and why it is TAB-scoped.
 *
 * ── THE BUG THIS EXISTS TO FIX (2026-08-12) ────────────────────────────────
 *
 * Reported: sign in as user1 in tab 1, user2 in tab 2, user3 in tab 3, then
 * reload tab 2 — it comes back as user3. Every tab shows whoever signed in
 * last.
 *
 * The cause is not a bug in the usual sense; it is what `localStorage` is.
 * localStorage is scoped to the ORIGIN, shared by every tab in the browser
 * profile. `setItem('tradew_token', …)` in tab 3 overwrites the one byte of
 * state tabs 1 and 2 read from, so on reload they read user3's token and are
 * correctly served user3's account by an API that is behaving perfectly.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 *
 * This is NOT a server-side multi-user defect and it does not affect users on
 * separate devices. `services/api` is stateless: AuthGuard verifies the bearer
 * token per request and hangs the result on `req.user` (auth.guard.ts) — there
 * is no shared "current user" anywhere in the service. Two customers on two
 * machines were always fully isolated. The scope of the fault is exactly "one
 * browser profile, several accounts", which is a testing and shared-device
 * situation, not a production one.
 *
 * ── THE MODEL ──────────────────────────────────────────────────────────────
 *
 * `sessionStorage` is per-tab and survives reload, which is precisely the
 * lifetime a session should have. But moving wholesale to sessionStorage would
 * regress the ordinary single-user case: closing the browser and returning
 * would land on the sign-in screen every time, because sessionStorage dies
 * with the tab.
 *
 * So the credential is written to BOTH, with different jobs:
 *
 *   sessionStorage — authoritative. THIS tab's session. Never overwritten by
 *                    anything happening in another tab.
 *   localStorage   — the device's most recent session, used once, only by a
 *                    tab that does not yet have one of its own.
 *
 * A tab reads localStorage exactly once, on first need, and then marks itself
 * CLAIMED. From that moment it is immune to sign-ins elsewhere. So:
 *
 *   tab 1 signs in as user1  → tab 1 claimed: user1
 *   tab 3 signs in as user3  → tab 3 claimed: user3, device mirror = user3
 *   reload tab 2             → already claimed as user2, keeps user2  ✅
 *   brand new tab 4          → unclaimed, adopts the mirror → user3   ✅
 *
 * The second line is what makes "open the app again tomorrow" still work.
 *
 * ── STILL SHARED, DELIBERATELY ─────────────────────────────────────────────
 *
 * The `tw_auth` routing cookie (lib/api.ts) remains device-wide, because
 * cookies are. That is tolerable precisely because it is valueless: it decides
 * routing only, and a tab that passes the gate without a real token renders a
 * shell whose first API call 401s. Do not try to make it per-tab; make sure it
 * never carries identity instead.
 */

const ACCESS_KEY = 'tradew_token';
const REFRESH_KEY = 'tradew_refresh_token';
/** Set once a tab owns a session, so it stops reading the device mirror. */
const CLAIMED_KEY = 'tradew_tab_claimed';

/**
 * Storage access that cannot throw.
 *
 * Safari in Private Browsing, and Chrome with third-party storage blocked in
 * an embedded context, both expose `sessionStorage` and then throw on access.
 * An auth layer that crashes there would take the whole app down rather than
 * degrade, so every access is guarded and a failure simply means "no session".
 */
function read(store: 'session' | 'local', key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return (store === 'session' ? window.sessionStorage : window.localStorage).getItem(key);
  } catch {
    return null;
  }
}

function write(store: 'session' | 'local', key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    (store === 'session' ? window.sessionStorage : window.localStorage).setItem(key, value);
  } catch {
    /* storage unavailable — the session simply does not persist */
  }
}

function drop(store: 'session' | 'local', key: string): void {
  if (typeof window === 'undefined') return;
  try {
    (store === 'session' ? window.sessionStorage : window.localStorage).removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * Take ownership of the device's most recent session, once.
 *
 * Only ever called for a tab with no session of its own. Copying the tokens in
 * (rather than reading through to localStorage on every call) is the whole
 * mechanism: after this the tab has its own copy, and a later sign-in in a
 * different tab cannot retarget it.
 */
function claimDeviceSession(): void {
  if (read('session', CLAIMED_KEY)) return;
  write('session', CLAIMED_KEY, '1');

  const access = read('local', ACCESS_KEY);
  if (!access) return;
  write('session', ACCESS_KEY, access);
  const refresh = read('local', REFRESH_KEY);
  if (refresh) write('session', REFRESH_KEY, refresh);
}

export function getAccessToken(): string | null {
  const own = read('session', ACCESS_KEY);
  if (own) return own;
  claimDeviceSession();
  return read('session', ACCESS_KEY);
}

/**
 * Is there a credential anywhere on this device — this tab's or the mirror?
 *
 * Deliberately PEEKS: unlike `getAccessToken` it does not call
 * `claimDeviceSession`, so asking the question cannot change the answer for a
 * tab that has not claimed yet. Callers use it to decide whether the routing
 * cookie is orphaned, and an orphan check must not itself adopt a session.
 *
 * The mirror is included on purpose. A tab that claimed while empty returns
 * null from `getAccessToken` forever, even after another tab signs in and
 * fills the mirror — treating that as "no session on this device" would tear
 * down the routing cookie out from under the tab that just signed in.
 */
export function hasStoredSession(): boolean {
  return Boolean(read('session', ACCESS_KEY) || read('local', ACCESS_KEY));
}

export function getRefreshTokenValue(): string | null {
  const own = read('session', REFRESH_KEY);
  if (own) return own;
  claimDeviceSession();
  return read('session', REFRESH_KEY);
}

/**
 * Store a freshly issued session.
 *
 * Writes the tab copy FIRST. If the localStorage write were to fail (quota,
 * privacy mode) the tab still has a working session, which is the outcome that
 * matters; the reverse order would leave the tab signed out while the device
 * mirror said otherwise.
 */
export function writeSession(accessToken: string, refreshToken?: string): void {
  write('session', CLAIMED_KEY, '1');
  write('session', ACCESS_KEY, accessToken);
  write('local', ACCESS_KEY, accessToken);
  if (refreshToken) {
    write('session', REFRESH_KEY, refreshToken);
    write('local', REFRESH_KEY, refreshToken);
  }
}

/**
 * Sign out.
 *
 * Clears this tab and the device mirror, but leaves OTHER tabs alone — they
 * hold their own claimed copies, which is the point of the split. Signing out
 * of user2 in tab 2 must not sign user1 out of tab 1.
 *
 * CLAIMED is deliberately left set. Without it the tab would immediately
 * re-adopt the mirror on the next read and undo its own sign-out.
 */
export function clearSession(): void {
  write('session', CLAIMED_KEY, '1');
  drop('session', ACCESS_KEY);
  drop('session', REFRESH_KEY);
  drop('local', ACCESS_KEY);
  drop('local', REFRESH_KEY);
}

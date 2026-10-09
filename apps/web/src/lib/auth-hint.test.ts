import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_HINT_COOKIE, clearStaleAuthHint, setToken, syncAuthHint } from './api';
import { clearSession, hasStoredSession, writeSession } from './session-storage';

/**
 * The orphaned routing cookie, reproduced as a test.
 *
 * Reported as "localhost goes straight to the dashboard but the tunnel URL
 * shows the landing page — why does localhost behave like a different build?"
 *
 * It is not a different build. `tw_auth` lives 30 days while the access token
 * it stands for lives 15 minutes, so the marker outlives the credential
 * routinely. The middleware trusts the marker, so a browser holding an orphan
 * is waved into `/dashboard` and renders the signed-out "Guest" shell there —
 * on whichever ORIGIN happens to hold the cookie, which during development is
 * localhost and never the freshly-minted tunnel hostname.
 *
 * Cookies are per-origin, so the split looks environmental and is not.
 */

class FakeStorage {
  private data = new Map<string, string>();
  getItem(k: string) {
    return this.data.has(k) ? this.data.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, String(v));
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

let deviceStorage: FakeStorage;
let currentTab: FakeStorage;

/**
 * Enough of `document.cookie` to be faithful: assignment writes ONE cookie,
 * reading returns all of them, and `max-age=0` deletes rather than storing an
 * empty value. That last detail is the one under test.
 */
function installCookieJar() {
  const jar = new Map<string, string>();
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get cookie() {
        return Array.from(jar, ([k, v]) => `${k}=${v}`).join('; ');
      },
      set cookie(raw: string) {
        const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        const expired = attrs.some((a) => a.toLowerCase() === 'max-age=0');
        if (expired) jar.delete(name);
        else jar.set(name, value);
      },
    },
  });
}

function focus(tab: FakeStorage) {
  currentTab = tab;
  (globalThis as { window?: unknown }).window = {
    get sessionStorage() {
      return currentTab;
    },
    get localStorage() {
      return deviceStorage;
    },
  };
}

function cookiePresent() {
  return document.cookie.includes(`${AUTH_HINT_COOKIE}=1`);
}

beforeEach(() => {
  deviceStorage = new FakeStorage();
  focus(new FakeStorage());
  installCookieJar();
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
});

describe('the orphaned tw_auth cookie', () => {
  it('clears a marker whose credential is gone', () => {
    setToken('real-token');
    expect(cookiePresent()).toBe(true);

    // What a dev-server restart or a cleared localStorage does: the credential
    // vanishes, the cookie does not.
    deviceStorage = new FakeStorage();
    focus(new FakeStorage());

    clearStaleAuthHint();

    // Without this the middleware keeps admitting the browser to /dashboard,
    // which then renders "Guest / Sign in →" on a gated route for 30 days.
    expect(cookiePresent()).toBe(false);
  });

  it('leaves the marker alone while any credential still backs it', () => {
    setToken('real-token');
    clearStaleAuthHint();
    expect(cookiePresent()).toBe(true);
  });

  it('does not revoke routing for a session another tab just signed into', () => {
    // This tab claimed while empty, so it will never see the device mirror.
    const staleTab = new FakeStorage();
    focus(staleTab);
    expect(hasStoredSession()).toBe(false);

    // Another tab signs in, filling the shared mirror and setting the cookie.
    focus(new FakeStorage());
    setToken('token-from-other-tab');

    // Back on the first tab, which still reads null for its OWN token.
    focus(staleTab);
    clearStaleAuthHint();

    // Clearing here would bounce the tab that legitimately just signed in.
    expect(cookiePresent()).toBe(true);
  });

  it('is the exact inverse of syncAuthHint', () => {
    // Token present, cookie missing — syncAuthHint's case.
    writeSession('real-token');
    expect(cookiePresent()).toBe(false);
    syncAuthHint();
    expect(cookiePresent()).toBe(true);

    // Cookie present, token missing — the case that had no handler.
    clearSession();
    clearStaleAuthHint();
    expect(cookiePresent()).toBe(false);
  });
});

describe('hasStoredSession', () => {
  it('sees the device mirror without claiming it', () => {
    focus(new FakeStorage());
    writeSession('t');

    const freshTab = new FakeStorage();
    focus(freshTab);
    expect(hasStoredSession()).toBe(true);

    // The peek must not have marked the tab claimed — asking a question about
    // the session cannot be what adopts it.
    expect(freshTab.getItem('tradew_tab_claimed')).toBeNull();
  });

  it('reports nothing during SSR rather than reaching for storage', () => {
    delete (globalThis as { window?: unknown }).window;
    expect(hasStoredSession()).toBe(false);
  });
});

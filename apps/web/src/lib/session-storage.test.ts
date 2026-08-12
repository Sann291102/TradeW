import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearSession,
  getAccessToken,
  getRefreshTokenValue,
  writeSession,
} from './session-storage';

/**
 * The reported bug, reproduced as a test.
 *
 * "Sign in as user1 in tab 1, user2 in tab 2, user3 in tab 3, then reload tab 2
 * — it comes back as user3. Every tab shows whoever signed in last."
 *
 * A browser tab is modelled here as a sessionStorage instance, because that is
 * exactly what distinguishes one: localStorage is shared by the whole profile,
 * sessionStorage is per-tab and survives reload. Switching `currentTab` is
 * therefore a faithful stand-in for focusing a different tab, and re-reading
 * without clearing it is a reload.
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

/** The one localStorage every tab shares — the root of the reported bug. */
let deviceStorage: FakeStorage;
let currentTab: FakeStorage;

function openTab(): FakeStorage {
  return new FakeStorage();
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

beforeEach(() => {
  deviceStorage = new FakeStorage();
  focus(openTab());
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('the multi-tab bug', () => {
  it('keeps three tabs on three different accounts', () => {
    const tab1 = openTab();
    const tab2 = openTab();
    const tab3 = openTab();

    focus(tab1);
    writeSession('token-user1');
    focus(tab2);
    writeSession('token-user2');
    focus(tab3);
    writeSession('token-user3');

    // Reloading tab 2 used to return 'token-user3'. This is the whole bug.
    focus(tab2);
    expect(getAccessToken()).toBe('token-user2');

    focus(tab1);
    expect(getAccessToken()).toBe('token-user1');
    focus(tab3);
    expect(getAccessToken()).toBe('token-user3');
  });

  it('survives repeated reloads of the same tab', () => {
    const tab1 = openTab();
    const tab2 = openTab();

    focus(tab1);
    writeSession('token-user1');
    focus(tab2);
    writeSession('token-user2');

    for (let i = 0; i < 5; i += 1) {
      focus(tab1);
      expect(getAccessToken()).toBe('token-user1');
      focus(tab2);
      expect(getAccessToken()).toBe('token-user2');
    }
  });

  it('isolates refresh tokens too, not just access tokens', () => {
    const tab1 = openTab();
    const tab2 = openTab();

    focus(tab1);
    writeSession('access-1', 'refresh-1');
    focus(tab2);
    writeSession('access-2', 'refresh-2');

    focus(tab1);
    expect(getRefreshTokenValue()).toBe('refresh-1');
    focus(tab2);
    expect(getRefreshTokenValue()).toBe('refresh-2');
  });
});

describe('the ordinary single-user case still works', () => {
  /**
   * The reason the device mirror exists at all. Moving purely to sessionStorage
   * would fix the bug above and break this, signing everyone out whenever they
   * closed the browser.
   */
  it('a brand new tab adopts the most recent session', () => {
    focus(openTab());
    writeSession('token-user1', 'refresh-1');

    focus(openTab()); // e.g. opened tomorrow, or a link in a new tab
    expect(getAccessToken()).toBe('token-user1');
    expect(getRefreshTokenValue()).toBe('refresh-1');
  });

  it('a tab that adopted a session then keeps it when another tab signs in', () => {
    const tab1 = openTab();
    focus(tab1);
    writeSession('token-user1');

    const tab2 = openTab();
    focus(tab2);
    expect(getAccessToken()).toBe('token-user1'); // adopts

    const tab3 = openTab();
    focus(tab3);
    writeSession('token-user3'); // retargets the device mirror

    focus(tab2);
    expect(getAccessToken()).toBe('token-user1'); // but not tab 2
  });

  it('a fresh tab with no session anywhere is signed out', () => {
    focus(openTab());
    expect(getAccessToken()).toBeNull();
    expect(getRefreshTokenValue()).toBeNull();
  });
});

describe('signing out', () => {
  it('does not re-adopt the device session afterwards', () => {
    focus(openTab());
    writeSession('token-user1');
    clearSession();
    // Without the CLAIMED marker the next read would restore the mirror and
    // silently undo the sign-out.
    expect(getAccessToken()).toBeNull();
  });

  it('leaves other tabs signed in', () => {
    const tab1 = openTab();
    const tab2 = openTab();

    focus(tab1);
    writeSession('token-user1');
    focus(tab2);
    writeSession('token-user2');

    focus(tab2);
    clearSession();
    expect(getAccessToken()).toBeNull();

    // Signing user2 out of tab 2 must not sign user1 out of tab 1.
    focus(tab1);
    expect(getAccessToken()).toBe('token-user1');
  });

  it('clears the device mirror so a new tab does not inherit a dead session', () => {
    focus(openTab());
    writeSession('token-user1');
    clearSession();

    focus(openTab());
    expect(getAccessToken()).toBeNull();
  });
});

describe('hostile storage', () => {
  /** Safari private mode and blocked third-party storage both throw on access. */
  it('degrades to signed-out instead of throwing', () => {
    const throwing = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('SecurityError');
      },
      removeItem() {
        throw new Error('SecurityError');
      },
    };
    (globalThis as { window?: unknown }).window = {
      sessionStorage: throwing,
      localStorage: throwing,
    };

    expect(() => writeSession('t')).not.toThrow();
    expect(getAccessToken()).toBeNull();
    expect(() => clearSession()).not.toThrow();
  });

  it('reports no session during SSR rather than reaching for storage', () => {
    delete (globalThis as { window?: unknown }).window;
    expect(getAccessToken()).toBeNull();
    expect(getRefreshTokenValue()).toBeNull();
  });
});

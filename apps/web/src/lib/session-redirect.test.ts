import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decideSessionRedirect } from './session-redirect';

/**
 * Regression cover for the infinite redirect loop between `middleware.ts` and
 * the landing page's pre-paint script (fixed 2026-08-11).
 *
 * Symptom: a blank page with the tab title set and a spinner that never stops,
 * then ERR_TOO_MANY_REDIRECTS at `/?next=%2Fdashboard#auth`. Measured at 27
 * navigations before the browser gave up. It appeared most often right after
 * starting the web server, because that is when a cookie is dropped while
 * localStorage survives.
 */

describe('decideSessionRedirect', () => {
  it('sends a genuinely signed-in visitor to the workspace', () => {
    expect(
      decideSessionRedirect({ hasToken: true, hasCookie: true, cameFromMiddleware: false }),
    ).toBe('redirect');
  });

  it('leaves a signed-out visitor on the landing page', () => {
    expect(
      decideSessionRedirect({ hasToken: false, hasCookie: false, cameFromMiddleware: false }),
    ).toBe('stay');
  });

  // The loop, in one assertion.
  it('does NOT redirect when the token outlived the cookie', () => {
    expect(
      decideSessionRedirect({ hasToken: true, hasCookie: false, cameFromMiddleware: true }),
    ).toBe('clear-stale-token');
  });

  it('clears the stale token rather than leaving it to 401 every request', () => {
    expect(
      decideSessionRedirect({ hasToken: true, hasCookie: false, cameFromMiddleware: false }),
    ).toBe('clear-stale-token');
  });

  it('has a second, independent loop-breaker: never bounce straight back at the middleware', () => {
    // Even with a cookie present, arriving via ?next= means the middleware just
    // sent us here. Redirecting back immediately is how a loop starts.
    expect(
      decideSessionRedirect({ hasToken: true, hasCookie: true, cameFromMiddleware: true }),
    ).toBe('stay');
  });

  it('ignores a cookie with no token', () => {
    expect(
      decideSessionRedirect({ hasToken: false, hasCookie: true, cameFromMiddleware: false }),
    ).toBe('stay');
  });

  /**
   * Exhaustive: no combination of the three inputs may produce 'redirect'
   * without BOTH credentials. This is the property that actually prevents the
   * loop, so it is asserted over the whole input space rather than by example.
   */
  it('never redirects without both a token and a cookie', () => {
    for (const hasToken of [true, false]) {
      for (const hasCookie of [true, false]) {
        for (const cameFromMiddleware of [true, false]) {
          const d = decideSessionRedirect({ hasToken, hasCookie, cameFromMiddleware });
          if (d === 'redirect') {
            expect(hasToken && hasCookie).toBe(true);
          }
        }
      }
    }
  });
});

/**
 * The shipped code is an inline `<script>` string in `app/page.tsx` — it cannot
 * import the function above, because it must run before first paint. These
 * assertions are the tripwire for the two drifting apart.
 */
describe('the inline pre-paint script keeps its guards', () => {
  const src = readFileSync(resolve(__dirname, '../app/page.tsx'), 'utf8');
  const script = src.slice(src.indexOf('SESSION_REDIRECT_SCRIPT'));

  it('checks the tw_auth cookie, not just the token', () => {
    expect(script).toContain("document.cookie.indexOf('tw_auth=')");
  });

  it('clears both stored tokens when the cookie is gone', () => {
    expect(script).toContain("localStorage.removeItem('tradew_token')");
    expect(script).toContain("localStorage.removeItem('tradew_refresh_token')");
  });

  it('refuses to bounce back when the URL carries next=', () => {
    expect(script).toContain("location.search.indexOf('next=')");
  });

  it('still redirects somewhere, i.e. was not simply disabled', () => {
    expect(script).toContain("location.replace('/dashboard')");
  });
});

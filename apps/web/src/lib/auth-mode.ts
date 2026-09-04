/**
 * Which half of the auth panel the visitor is actually looking at.
 *
 * This lives outside the components because TWO of them have to agree on it:
 * the section heading on the landing page and the form inside `AuthPanel`. It
 * used to be a `useState` private to the panel, with the heading hardcoded to
 * "Create your TradeW account." — so the page confidently offered to make an
 * account above a form whose button said "Sign in", pre-filled with an
 * existing address. Two different answers to "what am I doing here?" on one
 * screen. One owner of the state, one source of copy, fixes that by
 * construction rather than by remembering to edit both places.
 */

export type AuthMode = 'login' | 'signup';

/** The heading and sub-copy for each mode. Kept together so they can't drift. */
export const AUTH_COPY: Record<AuthMode, { heading: string; sub: string }> = {
  signup: {
    heading: 'Create your TradeW account.',
    sub: "Choose how you'd like to begin. Paper trading by default — nothing moves real money until you connect a broker yourself.",
  },
  login: {
    heading: 'Sign in to TradeW.',
    sub: "Welcome back. Choose how you'd like to continue — paper trading stays the default until you connect a broker yourself.",
  },
};

/** The query/hash parameter carrying the intent, e.g. `/?auth=signup#auth`. */
export const AUTH_MODE_PARAM = 'auth';

function normalise(value: string | null): AuthMode | null {
  if (value === 'signup' || value === 'register') return 'signup';
  if (value === 'login' || value === 'signin') return 'login';
  return null;
}

/**
 * The mode a URL asks for, or null when it expresses no preference.
 *
 * Read from the query string (`?auth=signup`, which is what `/signup`
 * redirects to) and also from the fragment (`#auth=signup`), because the
 * in-page links to this section are fragments and a fragment is all a
 * same-page anchor can carry. Anything unrecognised is no preference at all
 * rather than a guess — the caller's default wins.
 */
export function readAuthMode(search: string, hash: string): AuthMode | null {
  const fromQuery = normalise(new URLSearchParams(search).get(AUTH_MODE_PARAM));
  if (fromQuery) return fromQuery;

  // Fragment forms, for links written by hand: `#auth?auth=signup` keeps the
  // `#auth` anchor intact and is the one to prefer; `#auth=signup` is accepted
  // too, and the landing page scrolls the section into view itself when the
  // URL named a mode, so neither form depends on the browser matching an id.
  const raw = hash.replace(/^#/, '');
  const [target, query] = raw.split('?');
  if (query) {
    const fromHashQuery = normalise(new URLSearchParams(query).get(AUTH_MODE_PARAM));
    if (fromHashQuery) return fromHashQuery;
  }
  const [name, value] = target.split('=');
  if (name === AUTH_MODE_PARAM) return normalise(value ?? null);
  return null;
}

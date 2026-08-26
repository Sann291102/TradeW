/**
 * The preference keys a user is allowed to store against their own account.
 *
 * `POST /auth/preferences/:key` used to accept ANY key with ANY JSON body,
 * which made the table an unbounded, user-writable key/value store hanging off
 * an authenticated route — a place to park arbitrary data, and a shape nothing
 * downstream could rely on. Settings needs a handful of named documents, so
 * the route now names them.
 *
 * Adding a preference = adding a key here AND to
 * `apps/web/src/lib/settings/preferences.ts`, which owns the shape of each
 * document and its defaults. The two lists are deliberately duplicated rather
 * than shared through a package: services/api does not depend on
 * `@tradew/types` today, and adding that dependency to gate a string list
 * would be a heavier coupling than the list is worth. They are short, and a
 * key missing from either side fails loudly (400 here, default there).
 *
 * `display` predates this list — the profile page has always written it. It
 * stays, unchanged, for the accounts that already have a row.
 */
export const ALLOWED_PREFERENCE_KEYS = [
  /** Legacy — profile page: { defaultInstrumentType }. */
  'display',
  /** Locale/format/landing behaviour — see PreferencesSection. */
  'general',
  /** Theme + candle colours + chart chrome — see AppearanceSection. */
  'appearance',
  /** Order-ticket defaults and the extra confirmation step. */
  'trading',
  /** Per-category notification opt-ins. */
  'notifications',
  /** Privacy toggles the app can actually honour. */
  'privacy',
  /** Research watchlist and saved research notes/history. */
  'research',
] as const;

export type PreferenceKey = (typeof ALLOWED_PREFERENCE_KEYS)[number];

export function isAllowedPreferenceKey(key: string): key is PreferenceKey {
  return (ALLOWED_PREFERENCE_KEYS as readonly string[]).includes(key);
}

/**
 * Cap on the serialized size of one preference document.
 *
 * Nothing legitimate comes close — the largest document here is a dozen short
 * scalars. The limit exists so the route cannot be used to store a payload.
 */
export const MAX_PREFERENCE_BYTES = 8 * 1024;

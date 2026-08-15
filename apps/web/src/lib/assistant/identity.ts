/**
 * Who the assistant is — one name, one voice, one place.
 *
 * ── WHY A NAME AT ALL ──────────────────────────────────────────────────────
 *
 * "TradeW AI" is a label, not a name: it describes which company's AI you are
 * talking to, the way "Acme Support Bot" does. Named 2026-08-11 at product
 * direction. A named assistant that greets you and speaks is a different
 * product from a chat box with a company logo on it, and every surface has to
 * agree on which one this is.
 *
 * ── WHAT MUST NOT DRIFT ────────────────────────────────────────────────────
 *
 * The name appears in the dock header, the greeting, the capability reply, the
 * landing page, aria-labels and the observation-only disclaimer that legally
 * has to accompany anything she says. Seventeen files referenced "TradeW AI"
 * before this existed. Renaming her should be one edit here, not a search and
 * replace across the app, so import from this module rather than typing the
 * name — including inside strings.
 *
 * ── PRODUCT NAME vs ASSISTANT NAME ─────────────────────────────────────────
 *
 * `TradeW` remains the product. `Tara` is the assistant inside it. Surfaces
 * that mean the platform (the sidebar logo, the page title, the marketing
 * headline) keep saying TradeW; surfaces that mean the agent say Tara. Where
 * both are needed, `ASSISTANT_FULL` reads naturally: "Tara, TradeW's AI".
 */

export const ASSISTANT_NAME = 'Tara';

/** For the first introduction, where the reader does not yet know who she is. */
export const ASSISTANT_FULL = `${ASSISTANT_NAME}, TradeW's AI`;

/**
 * The observation-only line. Required on anything that touches trading data
 * (`TRADEW-AI.md` §4), so it is built from the name rather than retyped.
 */
export const ASSISTANT_DISCLAIMER = `${ASSISTANT_NAME} shares observations only — never investment advice.`;

/** Aria-label for the floating trigger. */
export const ASSISTANT_TRIGGER_LABEL = `Ask ${ASSISTANT_NAME}`;

/**
 * Voice preference: English first, female.
 *
 * Ordered by how well each handles Indian tickers and place names while still
 * sounding like the English the product is written in. en-IN first because
 * "BANKNIFTY", "SENSEX" and "Reliance" are mangled by a US voice; en-GB and
 * en-US follow so the assistant still speaks on a machine with no Indian voice
 * installed rather than falling silent.
 *
 * Voice availability is entirely a property of the user's OS and browser — we
 * express a preference and take the best match that exists. See
 * `useVoiceOutput.ts` for the selection, which never throws when nothing
 * matches.
 */
export const VOICE_LANG_PREFERENCE = ['en-IN', 'en-GB', 'en-US', 'en'] as const;

/**
 * Substrings that identify a female voice across platforms. There is no
 * standard gender field on `SpeechSynthesisVoice` — `voice.name` is all the API
 * exposes — so this is a name match against the voices Windows, macOS, iOS,
 * Android and Chrome actually ship. Matched case-insensitively.
 */
export const FEMALE_VOICE_HINTS = [
  'female',
  'aria', // Windows
  'jenny',
  'michelle',
  'heera', // Windows en-IN
  'neerja', // Windows/Azure en-IN
  'swara',
  'samantha', // macOS/iOS
  'karen',
  'moira',
  'tessa',
  'fiona',
  'serena',
  'google uk english female',
  'google us english',
  'zira', // Windows
  'susan',
  'catherine',
  'linda',
  'hazel',
] as const;

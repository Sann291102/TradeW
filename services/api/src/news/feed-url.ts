/**
 * Link validation for third-party feed content.
 *
 * WHY THIS EXISTS
 *
 * `parseRss` takes `<link>` verbatim out of a publisher's RSS and the value is
 * rendered by the web app as `<a href={item.url}>`. React escapes text content
 * but does NOT block dangerous URL schemes in `href` — a `javascript:` URI in an
 * anchor executes in the app's origin when clicked, and that origin holds the
 * API bearer token in `localStorage`. `data:` and `blob:` are the same class of
 * problem (either can carry an HTML document with script), and `file:` is a
 * local disclosure vector.
 *
 * The feed URLs are hardcoded HTTPS constants today, so reaching this requires
 * an upstream publisher compromise. That is a trust assumption, not a control:
 * nothing in the code enforced it, nothing recorded it, and the endpoint caches
 * whatever it parses for five minutes and serves it to every visitor. This
 * module makes the assumption explicit and cheap to hold.
 *
 * DESIGN: an allowlist, never a denylist. Blocking a list of known-bad schemes
 * fails open on everything not thought of (`vbscript:`, `filesystem:`, whatever
 * a future browser adds). Only `http:` and `https:` pass; everything else is
 * rejected whether or not it appears in any list.
 *
 * Pure and dependency-free so it is unit-testable directly.
 */

/** The only two schemes a news link may use. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Long enough for real article URLs with tracking parameters, short enough that
 * a link cannot be used to smuggle a large payload through the feed into every
 * client. Real Economic Times / Moneycontrol links sit well under 300.
 */
const MAX_URL_LENGTH = 2048;

/**
 * C0 control characters and DEL.
 *
 * Checked against the RAW string before parsing, and the ordering is the point.
 * The WHATWG URL parser STRIPS embedded tabs, newlines and carriage returns
 * before parsing, so `java\tscript:alert(1)` normalises into a working
 * `javascript:` URL. The scheme check below would still catch that specific
 * case, but the class of bug is real: any validator that reads a scheme off the
 * raw string, or that stores the raw string after validating the parsed one, can
 * be split apart this way. Rejecting these outright means the string that was
 * validated is the string that gets stored.
 *
 * Space is deliberately NOT in this class: the parser percent-encodes it rather
 * than stripping it, so it cannot forge a scheme, and publishers do emit
 * unencoded spaces in query strings.
 */
function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    // C0 range (includes TAB 0x09, LF 0x0a and CR 0x0d — the three the URL
    // parser strips) plus DEL (0x7f). Space (0x20) is intentionally excluded.
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export type FeedUrlRejection =
  | 'not_a_string'
  | 'empty'
  | 'too_long'
  | 'control_characters'
  | 'malformed'
  | 'disallowed_scheme'
  | 'no_host';

export type FeedUrlResult =
  | { ok: true; url: string; protocol: string }
  | { ok: false; reason: FeedUrlRejection };

/**
 * Validate one feed link.
 *
 * Returns a discriminated result rather than throwing: a malformed link in one
 * item must drop that item, not fail the whole feed — which is the existing
 * `parseRss` contract ("skips anything it cannot make a title and link out of").
 */
export function validateFeedUrl(raw: unknown): FeedUrlResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_a_string' };

  const value = raw.trim();
  if (value.length === 0) return { ok: false, reason: 'empty' };
  if (value.length > MAX_URL_LENGTH) return { ok: false, reason: 'too_long' };
  if (hasControlCharacters(value)) return { ok: false, reason: 'control_characters' };

  let parsed: URL;
  try {
    // No base URL: a relative link has no meaning in a syndicated feed, and
    // supplying one would silently resolve it against this API's own origin.
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // `URL.protocol` is lowercased and normalised by the parser, so `JavaScript:`
  // and `javascript:` both arrive here as `javascript:` and both fail.
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: 'disallowed_scheme' };
  }

  // Belt and braces. For "special" schemes (which http/https are) the WHATWG
  // parser treats an empty host as a parse error, so by this point a hostname is
  // effectively guaranteed and `http:///a/b` has already been re-parsed as host
  // `a`, path `/b`. The check stays because it is the invariant the rest of the
  // pipeline relies on — a link with no host is not a link to anywhere — and
  // because it must not silently become false if the allowlist above ever grows
  // a non-special scheme.
  if (!parsed.hostname) return { ok: false, reason: 'no_host' };

  // Return the PARSED serialization, not the input: it is normalised and
  // percent-encoded, so nothing downstream has to reason about the raw form.
  return { ok: true, url: parsed.toString(), protocol: parsed.protocol };
}

/**
 * Convenience wrapper for call sites that only need "a safe URL or nothing".
 * Returns null for every rejection, which is the shape `parseRss` wants.
 */
export function safeFeedUrl(raw: unknown): string | null {
  const result = validateFeedUrl(raw);
  return result.ok ? result.url : null;
}

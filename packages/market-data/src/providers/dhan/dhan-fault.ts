/**
 * Telling a Dhan FAULT apart from a Dhan ANSWER.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * This module is the fix for a whole class of incident, not one bug. Every
 * failure path in the Dhan integration used to degrade to the same shape as a
 * legitimately empty answer:
 *
 *   · `optionchain/expirylist` returned `[]` for ANY 4xx. That branch was
 *     written for one real case — Dhan answers 4xx ("813 Invalid SecurityId")
 *     for a cash-only stock, which genuinely means "this instrument has no
 *     derivatives market". But 401 (dead access token) and 429 (rate limited)
 *     are also 4xx, so a credential that expired mid-session reported that
 *     NIFTY — the most liquid option chain in India — has no option chain.
 *     Worse, the caller cached that for five minutes.
 *
 *   · `charts/intraday` failures became `{ candles: [], source: 'error' }` with
 *     HTTP 200, and the consumer keyed only on `source !== 'dhan'`, so an auth
 *     fault and "this contract has no traded history" were indistinguishable.
 *     Sentinel then told the user "the Dhan live-feed bridge is unreachable"
 *     while the bridge was up and answering — the real reason (DH-901, expired
 *     token) was discarded at the boundary.
 *
 * The consequences all follow from that single conflation. An absence is a fact
 * about the market: it is safe to cache, safe to render, and needs no operator.
 * A fault is a fact about US: caching it freezes a lie in place, and retrying it
 * per-request turns one dead credential into a metered-API retry storm that
 * grows linearly with the number of users.
 *
 * So classification happens ONCE, here, and everything downstream branches on
 * the verdict rather than re-deriving it from a status code it may read
 * differently.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
 *
 * No retry, no backoff, no caching policy. Those are the caller's, because they
 * differ per endpoint (a chain read may serve its last good value, a candle
 * read may not fabricate one). This module only answers "what kind of thing did
 * Dhan just tell us", which is the question every one of those policies needs
 * answered first and none of them can answer alone.
 */

/**
 * What a non-2xx Dhan response means.
 *
 * `no-market` is the only one that is information about the instrument. The
 * other three are information about the integration, and none of them may ever
 * be presented — or cached — as a property of the market.
 */
export type DhanFaultKind =
  /** Access token expired, revoked, or not entitled to this API. Operator action. */
  | 'auth'
  /** Dhan is throttling us. Transient, and made worse by retrying. */
  | 'rate-limit'
  /** Dhan's definitive "this security has no derivatives market". A FACT, not a fault. */
  | 'no-market'
  /** 5xx, network failure, malformed body — upstream is unwell. Transient. */
  | 'upstream';

/** Dhan error codes that mean the credential is the problem, not the request. */
const AUTH_ERROR_CODES = new Set([
  'DH-901', // "Client ID or user generated access token is invalid or expired"
  'DH-902', // invalid/missing authentication header
  'DH-808', // data API not subscribed / not entitled
]);

export class DhanUpstreamError extends Error {
  constructor(
    readonly kind: Exclude<DhanFaultKind, 'no-market'>,
    /** HTTP status, or 0 when the request never got a response. */
    readonly status: number,
    /** Dhan's own message, kept verbatim — this is what an operator needs. */
    readonly detail: string,
    /** Which Dhan endpoint, for the log line. */
    readonly endpoint: string,
  ) {
    super(`Dhan ${endpoint} ${status || 'unreachable'} (${kind})${detail ? `: ${detail}` : ''}`);
    this.name = 'DhanUpstreamError';
  }

  /** True when waiting will not help — only a new credential will. */
  get needsOperator(): boolean {
    return this.kind === 'auth';
  }
}

/**
 * Classify a non-2xx Dhan response.
 *
 * `body` is Dhan's raw response text. It matters: Dhan returns 400 for both
 * "this security has no options" and "your token died", and only the body
 * distinguishes them. Reading the status alone is precisely the mistake this
 * module exists to stop.
 */
export function classifyDhanFault(status: number, body: string): DhanFaultKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status >= 500 || status === 0) return 'upstream';

  // A 4xx that is not 401/403/429. Dhan's own error code decides, because the
  // status is genuinely ambiguous at this point.
  const code = extractErrorCode(body);
  if (code && AUTH_ERROR_CODES.has(code)) return 'auth';

  // Dhan phrases auth failures the same way across several codes, so match the
  // wording too — a new DH-xxx auth code must not silently become 'no-market'.
  if (/access[- ]?token|invalid or expired|unauthori[sz]ed|not subscribed/i.test(body)) return 'auth';
  if (/rate limit|too many requests/i.test(body)) return 'rate-limit';

  // Everything left is Dhan telling us this security has no derivatives market
  // under this segment — the one case the old blanket `return []` was written
  // for, and now the only case that reaches it.
  return 'no-market';
}

function extractErrorCode(body: string): string | null {
  try {
    const json = JSON.parse(body) as { errorCode?: unknown };
    return typeof json.errorCode === 'string' ? json.errorCode : null;
  } catch {
    // Not JSON — fall back to a scan, so a proxy's HTML error page still gets
    // read rather than silently classified as 'no-market'.
    const match = /DH-\d{3}/.exec(body);
    return match ? match[0] : null;
  }
}

/**
 * How long a fault's verdict may be reused before it is worth asking again.
 *
 * A fault is cached ONLY to stop per-request retries from amplifying it — never
 * to serve a stale answer. So the windows are short, and they differ by kind
 * because the recovery conditions differ:
 *
 *   · auth       — nothing recovers without an operator, and every attempt is a
 *                  guaranteed failure. The longest window; the credential
 *                  holder's own invalidation is what clears it early.
 *   · rate-limit — recovers on its own in seconds. Long enough to drain the
 *                  burst that caused it.
 *   · upstream   — recovers on its own, unpredictably. Short.
 *
 * `no-market` is absent on purpose: it is not a fault, and its caching is the
 * caller's normal reference-data TTL.
 */
export const FAULT_CACHE_MS: Record<Exclude<DhanFaultKind, 'no-market'>, number> = {
  auth: 30_000,
  'rate-limit': 5_000,
  upstream: 3_000,
};

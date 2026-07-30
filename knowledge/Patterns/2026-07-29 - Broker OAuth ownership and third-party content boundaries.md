---
type: pattern
date: 2026-07-29
tags: [security, authorization, oauth, broker, xss, csp, patterns]
---

# Broker OAuth ownership and third-party content boundaries

**Read before touching `services/api/src/broker/`, the news feed, or the `/feed` proxy.**
Canonical route-by-route detail lives in
[docs/product-architecture/SECURITY-AUTHORIZATION.md](../../docs/product-architecture/SECURITY-AUTHORIZATION.md)
— this note records the *reasoning* and the traps, not the map.

## The failure shape: an assumption written in a comment instead of a check

`BrokerCredential` shipped with `provider @unique`, no user FK, and a schema comment saying
plaintext storage was acceptable because "there is exactly one operator account behind the
feed". Nothing enforced that. The consequences compounded:

- every credential write targeted the same global row, so the last account to complete
  consent owned the platform's broker session;
- `/broker/dhan/callback` was public with no record that any flow had started, so it accepted
  any well-formed callback;
- `/status` returned that global row to every authenticated caller, disclosing the operator's
  broker client id and name.

**The generalisable lesson:** a security property stated in a comment is a property that does
not exist. The reviewer-facing version of this is that any comment of the form "this is safe
because there is only one X" should be read as "there is no constraint preventing a second X".
Both the schema comment and the controller docstring here read confidently and were wrong.

Related: the *same* comment told the next reader to encrypt `accessToken` "if per-user broker
linking is ever added". Per-user linking is exactly what the fix introduced — so that
condition is now met and the encryption debt is real rather than hypothetical. It was
deliberately **not** bundled into this pass, because it needs a key-management decision
(KMS vs. app-held key) rather than a code edit. Cross-user exposure is closed; at-rest
exposure is not.

## OAuth state when the provider does not echo `state`

The textbook fix for an unauthenticated callback is a `state` parameter. Dhan's consent flow
documents only `?tokenId=` on the redirect, and the redirect URL is *registered* with the
broker, so it cannot vary per request and the provider is not obliged to preserve parameters
appended to it.

Refusing every callback without `state` would break the flow outright. What was built instead,
in `oauth-state.ts`:

1. `state` is generated (32 bytes, CSPRNG), stored **hashed**, bound to the authenticated
   user, and appended to the login URL anyway — free if the provider preserves it.
2. When `state` comes back, it **must** match. A mismatch is a hard refusal, never a
   fall-through to something looser.
3. When it does not come back, the callback is accepted only if **exactly one** flow is live
   for that provider. Still authenticated-initiated, still user-bound, still single-use.
4. Two concurrent flows → refused as `state_ambiguous`. Guessing is precisely how one user's
   broker token lands on another user's account.
5. `BROKER_OAUTH_REQUIRE_STATE=true` removes path 3 entirely, for any provider verified to
   preserve the parameter.

**Trap worth remembering:** consume the state *before* the token exchange, not after. Two
concurrent callbacks both pass validation; a conditional
`updateMany({ where: { id, consumedAt: null } })` lets exactly one win, and burning the state
on a failed exchange is the safe direction — the cost is one retry the user can trigger
themselves.

**Second trap:** report replay in preference to expiry when a consumed state has *also*
expired. A consumed state being presented again is the more serious signal and must not be
masked by an expiry check that happens to fire first.

## `href` is a script sink that React does not close

The `/news` endpoint passed a publisher's `<link>` straight through to
`<a href={item.url}>`. React escapes text content but does **not** block dangerous URL schemes
in `href` — `javascript:` in an anchor executes in the app origin, which holds the API bearer
token in `localStorage`. `data:`, `blob:` and `vbscript:` are the same class; `file:` is local
disclosure.

Two things worth carrying forward:

- **Allowlist, never denylist.** Only `http:`/`https:` pass. A denylist of known-bad schemes
  fails open on `filesystem:`, on `vbscript:` if you forget it, and on whatever a browser adds
  next.
- **Validate the raw string before parsing, and store the parsed result.** The WHATWG URL
  parser *strips* TAB/LF/CR before parsing, so `java\tscript:alert(1)` normalises into a
  working `javascript:` URL. A validator that reads a scheme off the raw string, or that
  stores the raw string after checking the parsed one, can be split apart on exactly that.

**Surprise found while writing the tests:** `http:///just/a/path` is *not* hostless. For
"special" schemes the parser collapses the slashes and re-reads the first path segment as the
host, so it parses as host `just`. The `no_host` branch is therefore unreachable for
http/https and is documented as an invariant guard rather than a live check — worth knowing
before writing a test that asserts otherwise, as one here initially did.

## `:path*` on an unauthenticated service is a standing exposure

`apps/web/next.config.mjs` proxied `/feed/:path*` to the live-feed bridge, which has no
authentication of its own. Nothing user-scoped was exposed *at the time*, which is why it read
as fine. The defect is structural: the next route added to that file becomes internet-reachable
by default, with no change to the proxy config and no review step that would notice.

Inverting the default (`feed-proxy-routes.mjs`: exact sources, one per allowlisted route)
makes "unlisted means unreachable" true rather than aspirational. The allowlist also refuses
traversal and percent-encoded paths outright rather than normalising them — `%2e%2e` is how an
exact-match allowlist is normally bypassed, and no bridge route needs an encoded character in
its path.

CORS on the bridge moved off `*` to a reflected allowlist, but the file says plainly that this
is a browser read restriction and **not** an access control — the real boundary is that the
process binds to localhost and reaches the internet only through the allowlist. Writing that
down matters more than the header does.

## Logging: make leaking a secret impossible, not discouraged

`common/security-log.ts` redacts by field **name** and by **shape** (a long opaque string is
truncated even under an innocent key like `reason` or `note`). The point is that a caller
cannot leak a token by passing it to a log call — which is how access tokens reach log
aggregators. Relying on each call site to remember is the failure mode being designed out.

## Honest limits of this pass

- **Web CSP includes `script-src 'unsafe-inline'`** (plus `'unsafe-eval'` in dev for React
  Refresh) because Next's App Router injects inline bootstrap and streaming-payload scripts.
  Nonces require routing every page through middleware — a larger change than a hardening pass
  should make silently. The policy is written to be genuinely enforced rather than to look
  strict and get deleted on the first regression.
- **HSTS is production-only.** Pinning `Strict-Transport-Security` for `localhost` makes a
  browser refuse plain HTTP for every other project on the machine for the max-age.
- **The migration deletes existing `BrokerCredential` rows** rather than backfilling an owner.
  There is no way to know which user an unowned row belonged to, and guessing would hand one
  user's broker session to another. Cost is one re-run of the consent flow; the bridge falls
  back to `DHAN_ACCESS_TOKEN` throughout.
- **Not applied.** The migration is written, not run — operator's call, same convention as
  the crypto-space migration.

## See also

- [[Patterns/2026-07-26 - TradeW AI assistant control layer (Comet-style app control)]] — the
  assistant's `domain-guard.ts` carries the mirror-image version of the lesson at the top of
  this note: a client-side fence documented as inadequate once Phase 2 generates prose.
- [[Patterns/2026-07-24 - Sentinel live data across the full universe]] — why the feed bridge
  exists and what it serves.

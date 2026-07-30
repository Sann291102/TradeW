# Authorization model — services/api and the feed bridge

**Status:** current as of 2026-07-29, written during the broker-credential hardening pass.
**Scope:** what authenticates each HTTP surface, what authorizes it, and where ownership is enforced.

This document exists because the broker module shipped with an *implicit* authorization
assumption — "there is exactly one operator account behind the feed" — that no code
enforced. The assumption was written in a schema comment, not in a check, and the result was
an endpoint any authenticated user could use to overwrite the credential the platform runs
on. Every row below is therefore stated as an enforced control, with the file that enforces
it. An entry that cannot name its enforcement point is a defect, not a documentation gap.

## Authentication mechanisms

| Mechanism | File | What it proves | Notes |
|---|---|---|---|
| `AuthGuard` | [auth.guard.ts](../../services/api/src/auth/auth.guard.ts) | A valid, unexpired JWT; sets `req.user = { sub, email }` | `sub` is the only accepted source of caller identity |
| `AdminTokenGuard` | [admin-token.guard.ts](../../services/api/src/auth/admin-token.guard.ts) | Possession of `ADMIN_API_TOKEN` | A *role*, not an identity — carries no `userId`. Constant-time compare; fails closed when unset |
| `CapabilityGuard` | [capability.guard.ts](../../services/api/src/entitlements/capability.guard.ts) | Entitlement for a paid capability | Layered on top of `AuthGuard`, never instead of it |
| `KnowledgeWorkspaceGuard` | [knowledge.guard.ts](../../services/api/src/knowledge/knowledge.guard.ts) | Environment flag; 404s in production by default | A kill switch for a dev tool, not user authorization |
| OAuth state | [oauth-state.ts](../../services/api/src/broker/oauth-state.ts) | This request continues a flow an authenticated user started | The substitute for bearer auth on a redirect that cannot carry one |

## Route map

### User-scoped — `AuthGuard`, subject from `req.user.sub`

| Routes | Controller | Ownership enforcement |
|---|---|---|
| `/auth/me`, `/auth/preferences`, `/auth/logout` | `auth.controller.ts` | Every query keyed on `sub` |
| `/sim/*` (orders, trades, positions, portfolio) | `sim.controller.ts` | `sub` passed into every service call; mutations use `updateMany({ where: { id, userId } })` |
| `/discipline/*` | `discipline.controller.ts` | Guard applied at class level; session rows keyed `(userId, date)` |
| `/notifications/*` | `notification.controller.ts` | Class-level guard; `updateMany({ id, userId })` for reads-then-writes |
| `/sentinel/*` | `sentinel.controller.ts` | `AuthGuard` + `CapabilityGuard`; journal and observations keyed on `sub` |
| `/instruments/search`, `/market-data/*` | respective controllers | No user state; auth-gated because they address the broker feed |
| `/entitlements/me*` | `entitlements.controller.ts` | Keyed on `sub` |

**Invariant:** no route in this group reads a user identifier from a body, query or path
parameter. Verified by grep: the only client-supplied `userId` sites in `services/api/src`
are the operator routes below and `/broker/dhan/status`, where a supplied value is *compared*
against the token subject and refused on mismatch — never used as the lookup key.

### Operator-scoped — `AdminTokenGuard`

| Routes | Why it cannot be user-authorized |
|---|---|
| `/entitlements/admin/*` | Grants and cancels other users' subscriptions |
| `/broker/dhan/admin/credentials` | Cross-user view; ownership cannot authorize a list of everyone |
| `/broker/dhan/admin/feed-default/:userId` | Platform-wide effect — promotes one credential to the token every market-data consumer is served from |

### Public by design — no guard

| Routes | Classification |
|---|---|
| `/health` | Liveness |
| `/news` | Third-party headlines. Links validated by [feed-url.ts](../../services/api/src/news/feed-url.ts) before they can reach a browser |
| `/crypto/*`, `/forex/*`, `/us-stocks/*` | Read-only public market data. Rationale is documented in each controller: these numbers are readable from Binance, the newswires and the vendor directly, and the Dhan feed was already public, so gating them was an inconsistency rather than a boundary. Vendor quota is protected by the server-side cache, not by auth |
| Allowlisted `/feed/*` via the web proxy | See below |

**The rule for this table:** a route belongs here only if its response is identical for every
caller and safe to serve to an anonymous stranger. Anything scoped to a user, an account, a
position, an order or a credential does not qualify.

### Public but state-bound — `/broker/dhan/callback`

The one route that is neither guarded nor unconditionally public. It is the URL registered
with Dhan and arrives as a cross-site top-level navigation, which carries no `Authorization`
header — so `AuthGuard` cannot apply. What replaces it:

1. It must match a live, unconsumed, unexpired `BrokerOAuthState` row created by an
   authenticated `/connect` call.
2. The credential is written to **that row's** `userId`. Nothing in the callback request
   selects the account.
3. State consumption is a conditional `UPDATE` that runs *before* the token exchange, so a
   replayed callback loses the race and exchanges nothing.
4. An optional `HttpOnly`/`Secure`/`SameSite=Lax` cookie is a second binding factor: absent
   is allowed, conflicting is refused.

Covered by [oauth-state.spec.ts](../../services/api/src/broker/oauth-state.spec.ts) — mismatch,
replay, expiry, boundary, ambiguity, provider mismatch, unsolicited callback.

## Broker credential ownership

| Before | After |
|---|---|
| One row, `provider @unique` | `@@unique([provider, userId])` with a `User` FK, `onDelete: Cascade` |
| Every method resolved it by provider | Every method takes `userId` and filters on it |
| Feed used "the only row" | Feed uses the explicitly designated `isFeedDefault` row, unique per provider by a partial index, set only by an operator |
| `/status` returned the global row to any authenticated caller | Returns the caller's own row; a mismatched `?userId=` is a logged 403 |

`currentAccessToken()` is the single deliberate exception to user scoping — the feed bridge
has no user context. It reads only the designated row and is not exposed over HTTP.

**Outstanding:** `BrokerCredential.accessToken` is plaintext at rest. Per-user linking now
exists, which is the condition the original comment said must trigger encryption. This pass
removed the cross-user exposure but not the at-rest exposure; encryption needs a key
management decision (KMS vs. app-held key) and is tracked separately.

## Feed bridge exposure

The bridge ([live-feed-server.ts](../../services/market-data/scripts/live-feed-server.ts)) has
**no authentication of its own**. Two controls bound it:

1. **Route allowlist** — [feed-proxy-routes.mjs](../../apps/web/feed-proxy-routes.mjs) replaces
   `/feed/:path*`. Exact sources only, no wildcard, so a route added to the bridge is
   unreachable from the web origin until it is deliberately listed. Traversal and
   percent-encoded paths are refused rather than normalised.
2. **CORS allowlist** — reflects an allowlisted origin instead of `*`, with `Vary: Origin` and
   no `Allow-Credentials`.

Neither is an access control for non-browser callers, and the file says so. The real boundary
is that the process binds to localhost and reaches the internet only through the allowlist.
Anything user-scoped must go through `services/api` behind `AuthGuard` instead.

## Security response headers

Set in [next.config.mjs](../../apps/web/next.config.mjs) (documents) and
[main.ts](../../services/api/src/main.ts) (JSON):

`Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy`, `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy`, and
`Strict-Transport-Security` (production only — pinning HSTS for `localhost` would break every
plain-HTTP project on a developer's machine).

**Known limit, stated rather than hidden:** the web CSP includes `script-src 'unsafe-inline'`
because Next's App Router injects inline bootstrap and streaming-payload scripts, plus
`'unsafe-eval'` in development for React Refresh. Moving to nonces requires routing every page
through middleware and is a larger change than a hardening pass should make silently. The
policy still enforces `default-src 'self'`, `object-src 'none'`, `base-uri 'self'`,
`form-action 'self'` and `frame-ancestors 'none'`. The API's CSP is `default-src 'none'`.

## Security logging

[security-log.ts](../../services/api/src/common/security-log.ts) emits one JSON line per event
under a `[security]` prefix. Events: OAuth start/failure/rejection, credential store and
disconnect, feed-default changes, admin denials, cross-user refusals, rejected feed links.

Secrets cannot be logged through it: values are redacted by field name *and* by shape (a long
opaque string is truncated even under an innocent key), so a caller cannot leak a token by
passing it to a log call. Asserted by
[security-log.spec.ts](../../services/api/src/common/security-log.spec.ts).

## Test coverage

`npm test -w @tradew/api` (116 tests) and `npm test -w @tradew/web` (21 tests).

| Suite | Covers |
|---|---|
| `broker/oauth-state.spec.ts` | State mismatch, replay, expiry + boundary, ambiguity, provider mismatch, unsolicited callback, `requireState`, CSPRNG properties |
| `broker/broker-authz.spec.ts` | Anonymous rejection, forged token, operator-token denial + prefix attack + fail-closed, cross-user refusal (asserting the lookup never runs with the supplied id) |
| `news/feed-url.spec.ts` | `javascript:`, `data:`, `vbscript:`, `blob:`, `file:`, unknown schemes, control-character smuggling, malformed input, valid links |
| `common/security-log.spec.ts` | Redaction by name and by shape |
| `apps/web/feed-proxy-routes.spec.mjs` | Allowlist enforcement, prefix/extension rejection, traversal, percent-encoding, no wildcard in generated rewrites |

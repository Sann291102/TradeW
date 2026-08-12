---
type: plan
date: 2026-08-12
tags: [plan, security, admin, auth, architecture]
---

# Admin consolidation — the authentication design, before any code moves

**Status:** DECIDED → **Option B**, and the backend (Phase 1) is built and
tested. The operator-token-only working-tree change described below was reverted.
See [[Decisions/2026-08-12 - Operator identity for the standalone admin console]]
for what actually shipped and what remains (Phase 2 wiring). This note is kept as
the reasoning of record — it is why the shipped design looks the way it does.

Originally written as design-only, because the auth boundary had to be decided
before the UI migration started, not discovered during it.

**Read with:** [[Research/2026-08-10 - Offensive security assessment (auth-bypass class)]]
(the assessment that produced the current two-factor design) and
`apps/web/src/app/admin/README.md`.

## The finding that triggered this

`services/api/src/admin/admin.guard.ts` currently has an **uncommitted
working-tree change** that makes the operator token sufficient on its own:

```diff
+    // No JWT — this is a server-to-server call from the standalone apps/admin
+    // portal's Route Handlers, which authenticate via the operator token alone
     if (!token) {
-      deny('admin.portal.no_session');
-      throw new UnauthorizedException('Missing bearer token');
+      req.user = { isAdmin: true, email: 'admin-service@tradew.internal', sub: null };
+      return true;
     }
```

It is not committed and not pushed. It should not be.

### Three concrete consequences, not hypothetical ones

**1. The blast radius of the operator token becomes total.** Today a leaked
`ADMIN_API_TOKEN` — from `.env`, a CI secret, a backup, a screen share — buys
nothing on its own, because the caller also needs a JWT for a user whose *database
row* has `isAdmin = true`. After this change the token alone reads every user's
orders, activity, AI calls and the cognition network. That token has a history:
the 2026-08-10 assessment found it set to a live Anthropic API key. It is a
static 64-character string with no expiry and no rotation mechanism.

**2. Privileged actions become unattributable.** `sub: null` means two call sites
fall through to `'unknown'`:

| Call site | Field | What is lost |
| --- | --- | --- |
| `admin.controller.ts:280` `setAdmin` | actor | **Who granted admin to whom** |
| `admin.controller.ts:385` `resolveProposal` | `CognitiveProposal.resolvedBy` | Which operator labelled a finding wrong |

The second one matters more than it looks. `resolvedBy` on a dismissed proposal
is the cognition network's **only negative training label** — the one input that
moves weights downward. An audit trail that records "somebody said this was
wrong" without recording who cannot be reviewed, and a wrong label cannot be
traced back to a mistaken operator.

**3. A detection signal disappears.** `deny('admin.portal.no_session')` is
removed. A caller holding the token and no session used to be logged; now it is
indistinguishable from legitimate proxy traffic and logs nothing. The portal's
README states "every denial is written to the security log — this surface WILL
be probed, and the probing is the signal."

**4. Two documents become false.** `AdminGuard`'s own class comment ("Two
independent factors, both required") and the two-factor table in
`apps/web/src/app/admin/README.md` would both be describing a guard that no
longer behaves that way.

## The rule this design holds to

> Possession of a shared secret is proof that a **process** is trusted. It is
> never proof that a **person** is present, and never proof of *which* person.
> Every privileged action needs both.

The operator token answers "is this the admin application?". It cannot answer
"and who is driving it?", and the admin surface needs an answer to both.

## Two options

Both keep `apps/web`'s existing product-admin path **byte-for-byte unchanged**.
Neither weakens `AdminGuard`.

### Option A — the standalone console acquires a real product session

`apps/admin`'s login takes the operator token **and** TradeW account
credentials. The Route Handler performs the product login server-side, keeps the
resulting JWT in the encrypted httpOnly session cookie, and the proxy sends both
factors on every call.

```
Browser ──(httpOnly session cookie, no secrets)──> apps/admin Route Handler
                                                        │ Authorization: Bearer <product JWT>
                                                        │ X-Admin-Token: <from process.env>
                                                        ▼
                                                   services/api  →  AdminGuard UNCHANGED
```

- **Guard change required: none.** Both factors arrive exactly as they do today.
- Attribution is a real user id. Revocation is `isAdmin = false`, DB-checked per
  request, effective immediately.
- **Cost:** the proxy must handle product-JWT refresh, since an access token is
  much shorter-lived than a 12h operator shift. That is the whole implementation.
- **Weakness:** operator identity is a trader identity. A control plane arguably
  should not depend on the product's user table.

### Option B — a dedicated operator identity (recommended)

A separate credential store for operators, and a composed guard.

```
AdminAccessGuard
├─ operator token (REQUIRED on both paths — never sufficient alone)
└─ then exactly one of:
   ├─ product-admin flow    JWT → User.isAdmin (apps/web — unchanged)
   └─ operator flow         signed operator assertion → OperatorAccount.disabledAt IS NULL
```

New `OperatorAccount` table: `id`, `email`, `passwordHash`, `totpSecret`,
`disabledAt`, `lastSeenAt`. `apps/admin` authenticates against it and mints a
short assertion naming the operator id; the proxy sends that alongside the
operator token. `req.user.sub` becomes `operator:<id>`, so both attribution call
sites keep working.

- Truly independent of the product's user table — the property you asked for.
- Revocation is `disabledAt`, checked against the database on every request, so
  it is immediate rather than waiting for a session to expire.
- **Cost:** a second credential store to secure — password hashing, MFA, lockout,
  reset. This is real work and should not be hand-waved.

**Recommendation: B**, with A as a legitimate interim if the proxy needs to ship
sooner. B is what makes the console a control plane rather than a privileged
view of the product.

## The ten questions, answered

**1. How does `apps/admin` authenticate?**
Two credentials at login: the operator token (proves the deployment) and an
operator identity — a TradeW admin account under A, an `OperatorAccount` under B.
The token alone never establishes a session.

**2. Where is the operator token stored?**
`process.env.ADMIN_API_TOKEN` on the `apps/admin` server, read only inside Route
Handlers (`lib/adminApi.ts` already does exactly this). It is never in the
database, never in the cookie, never in a client bundle.

**3. Can the browser ever receive it?**
No, and the current design is already correct here — worth preserving verbatim.
The cookie holds `expiresAtMs.hmac(token, expiresAtMs)`, a *marker*, not the
secret. Under B the cookie additionally carries the operator assertion, which is
scoped, expiring and useless without the server-side token.

**4. How does `services/api` distinguish a trusted admin proxy?**
By possession of the operator token, which never leaves a server — plus network
placement (the API binds localhost/private by default since 2026-08-10). There is
**no trusted-proxy header**, and there must never be one. See question 9.

**5. Does `AdminGuard` behaviour change for `apps/web`?**
No. Under A it is not touched at all. Under B the product-admin path is lifted
into `AdminAccessGuard` unchanged, and its existing spec files must pass without
modification — if a test has to be edited, the behaviour changed and the change
is wrong.

**6. Can existing admin endpoints remain protected?**
Yes. The class-level `@UseGuards` on `AdminController` is what makes forgetting a
route impossible; that placement does not move. Route handlers are untouched.

**7. How are sessions revoked?**
Today: only by 12h expiry, or by rotating the token (which invalidates every
cookie at once, since they are HMAC'd with it — a crude but genuine kill switch,
worth keeping). Under A: `isAdmin = false`, immediate. Under B: `disabledAt`,
immediate. Both are database-checked per request, deliberately never a token
claim — the same reasoning that already governs `User.isAdmin`.

**8. What stops a normal trader calling `/api/admin/*`?**
`/api/admin/*` on `apps/admin` is a different origin from the trader app and
requires the admin session cookie. Even with the cookie, the proxy only attaches
the operator token for an authenticated operator session, and `services/api`
independently re-checks both factors. A trader who reaches `services/api`
directly has no operator token and is denied at the first check, before any
database round-trip.

**9. What stops someone spoofing the proxy headers?**
**Nothing — which is why no header may ever confer trust.** `X-Admin-Proxy: true`
or a trusted `X-Forwarded-For` are both settable by any client that can reach the
API. Trust comes from the operator token (a secret) and from network reachability
(the API is not internet-exposed). If the API ever becomes publicly reachable,
mutual TLS or a signed request envelope is the answer, not a header.

Related and already handled: `TRUSTED_PROXY_HOPS` must match the real deployment,
or a client can forge `X-Forwarded-For` and mint itself a fresh rate-limit bucket.

**10. What happens when the operator token rotates?**
Every `apps/admin` session cookie becomes invalid immediately, because the HMAC
key is the token — mass logout as a side effect of rotation, which is the correct
behaviour and should be documented rather than engineered away. `apps/web`'s
console is also affected: its `sessionStorage` copy stops working and the gate
reappears. Rotation therefore needs `.env` on the API and on `apps/admin` updated
together; a drift check already exists in `apps/admin/app/api/session/route.ts`,
which validates the submitted token against a real API endpoint.

## Sequencing

Auth first, and it must be provably neutral before a single page moves.

1. **Decide A or B.** Nothing else starts until this is answered.
2. **Build the auth path**, with `apps/web`'s existing guard specs passing
   unmodified as the acceptance criterion.
3. **Add the catch-all proxy** `apps/admin/src/app/api/admin/[...path]/route.ts`.
   Deny by default: an allowlist of forwarded paths, not a wildcard — the same
   lesson `feed-proxy-routes.mjs` already records for the Dhan bridge.
4. **Migrate the UI by function, not by file copy.** For each page map
   page → components → API calls → types → hooks → shared packages, and move only
   what belongs to the operator app. This is what prevents two divergent admin
   API clients.
5. **Reach parity, verified page by page** against the running console.
6. **Only then** archive `apps/web/src/app/admin` to `TradeW/archive/` per Rule 1.

## Never

- Operator token as a sufficient credential on its own.
- Any header (`X-Admin-Proxy`, `X-Forwarded-*`) treated as proof of a trusted caller.
- `sub: null` on a request that can perform a privileged action.
- Removing a `deny(...)` call to make a path succeed. If a denial is in the way,
  the design is wrong, not the logging.
- Editing an existing `AdminGuard` spec to make a new auth path pass.

## Related

- [[Decisions/2026-08-12 - Cognition network (perceptors + four layers)]] — `resolveProposal`'s attribution is one of the two call sites affected.
- [[Gotchas/2026-08-12 - Nest DTOs must be declared above the controller]] — `AdminService` is provided in two modules; anything added to the admin surface has to hold for both.

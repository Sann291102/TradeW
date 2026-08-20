# Broker Credential — Threat Model

**Subject:** `BrokerCredential.accessToken` — the live Dhan access token TradeW
stores on a user's behalf.
**Written:** 2026-08-20 · **Method:** source trace, no assumptions from memory.
**Status of the finding:** confirmed. The column is plaintext at rest.

> Escalation note. This was found during a footer and legal audit, while
> checking whether the landing page's claim "end-to-end encryption in transit
> and at rest" was true. It is not, and the way the finding surfaced has no
> bearing on its severity. It is treated here as a first-class security issue.

---

## 1. What the credential is

A Dhan access token obtained through the app-key consent flow. It is a **bearer
credential for a real brokerage account**: presented as the `access-token`
header, it reads the account's positions, orders and funds through Dhan's API.

Two properties bound the blast radius, and both are load-bearing:

| Property | Consequence |
| --- | --- |
| Dhan caps every access token at **24 hours** (their SEBI-driven API access rule) | A leaked token is a one-day window, not a permanent compromise |
| TradeW's own order path is **paper-only** — `ExecutionEnvironment` has exactly one member, `PAPER` (asserted by `services/api/scripts/verify-user-account-binding.ts`) | TradeW itself cannot place a live order with this token. An attacker holding it could, directly against Dhan, subject to Dhan's own controls |

Neither property makes plaintext storage acceptable. They set the severity at
**high** rather than critical.

## 2. The lifecycle, end to end

Traced through `services/api/src/broker/`, `services/market-data/scripts/`,
and `packages/database/prisma/schema.prisma`.

| # | Stage | Where | Secret present? |
| --- | --- | --- | --- |
| 1 | User input | The user's Dhan **2FA on `auth.dhan.co`** | No — never typed into TradeW |
| 2 | Frontend | `GET /broker/dhan/connect` → opens Dhan's login URL | **No** |
| 3 | API request | `GET /broker/dhan/callback?tokenId=…` | No — `tokenId` is an exchange handle, not the token |
| 4 | Validation | `oauth-state.ts` `resolvePendingState` | No |
| 5 | Service layer | `DhanAuthService.consumeConsent` | **Yes** — held in memory after the exchange |
| 6 | **Database write** | `prisma.brokerCredential.upsert({ data: { accessToken } })` | **YES — PLAINTEXT. The finding.** |
| 7 | **Database storage** | `BrokerCredential.accessToken String` | **YES — PLAINTEXT** |
| 8 | Database read | `live-feed-server.ts` `resolveDhanCredential`; `DhanAuthService.currentAccessToken` | **Yes** |
| 9 | Decryption | *Does not exist* | — |
| 10 | Broker API request | `'access-token': accessToken` header to Dhan | Yes — necessarily |
| 11 | Background jobs | The feed bridge re-reads on invalidation | Yes |
| 12 | Logs | `securityLog` — key- and shape-based redaction | **No.** Verified §4 |
| 13 | Error handling | `rejectionMessage` returns stable non-revealing reasons | No |
| 14 | Admin interfaces | `GET /broker/dhan/admin/credentials` — explicit Prisma `select`, no token column | No |
| 15 | Analytics/telemetry | No analytics provider exists in the web app | No |
| 16 | Backups/exports | Whatever backs up Postgres | **YES — PLAINTEXT** |
| 17 | API responses | `DhanCredentialStatus` — a fixed DTO with no token field | **No** |

**The exposure is stages 6, 7 and 16 — and only those.** Everything either side
of the database is already correct. That is why the remediation is narrow.

### 2.1 The two read points

There are exactly two, which is what makes a decryption boundary practical:

1. `services/market-data/scripts/live-feed-server.ts:136-148` — the real
   consumer. Reads the `isFeedDefault` row directly through Prisma.
2. `services/api/src/broker/dhan-auth.service.ts:490` `currentAccessToken()` —
   **has zero callers.** Confirmed by repository-wide grep. It is a maintained
   but unused seam.

## 3. Threat questions, answered

| Question | Answer | Evidence |
| --- | --- | --- |
| Who can read the database? | Anyone with Postgres credentials, a backup, or a disk image. Today they read live broker tokens directly. | `schema.prisma:1193` |
| Which services can read credentials? | `services/api` and the market-data feed bridge. Nothing else queries the table. | grep for `brokerCredential` |
| Can an authenticated user retrieve their own raw credential? | **No.** `/status` returns a fixed DTO with no token field. | `dhan-auth.service.ts:335-350` |
| Can one user access another's? | **No.** Every route derives its subject from `req.user.sub`; `?userId=` is compared and refused on mismatch, never used as a lookup key. Uniqueness is `(provider, userId)`. | `dhan-auth.controller.ts`, `broker-authz.spec.ts` |
| Can admins access raw credentials? | **Not through the API.** The operator route uses an explicit `select` that omits the column. An operator with database access can read it directly — which is the finding. | `dhan-auth.service.ts:449-466` |
| Are credentials in API responses? | **No.** No DTO carries a token field. | §2 stage 17 |
| Are they logged? | **No.** `securityLog` redacts by key pattern *and* by shape, and the call sites pass `brokerClientId`, never the token. | `common/security-log.ts` |
| Are they in backups? | **Yes, in plaintext.** A backup is as sensitive as the live database and is usually stored with weaker controls. | §2 stage 16 |
| Exposed to frontend JavaScript? | **No.** No broker token crosses the API boundary. The `accessToken` in `apps/web` is TradeW's own JWT — a different credential. | grep across `apps/web/src` |
| Encrypted in transit? | **Yes.** TLS, HSTS, `upgrade-insecure-requests`. | `apps/web/next.config.mjs` |
| Encrypted at rest? | **No.** The finding. | `schema.prisma:1183-1193` |

## 4. Adjacent secrets — checked, and clean

Every other secret-shaped column was audited. `accessToken` is the **only**
plaintext secret in the schema:

| Column | Model | Treatment | Verdict |
| --- | --- | --- | --- |
| `passwordHash` | `User`, operator | bcrypt | Correct |
| `tokenHash` | `RefreshToken` | SHA-256 | Correct |
| `stateHash` | `BrokerOAuthState` | SHA-256, unique | Correct |
| `codeHash` | `Otp` | SHA-256, TTL, attempt cap | Correct |
| `accessToken` | `BrokerCredential` | **plaintext** | **The finding** |

**Why hashing is not the answer here.** Every correct row above is a credential
TradeW only ever needs to *verify*. A broker token must be *replayed* to Dhan,
so it has to be recoverable — which makes reversible encryption the only
option, not a weaker choice.

Also confirmed clean:

- **Google OAuth** (`auth/google-oauth.service.ts`): the provider access token is
  used once, in-scope, to fetch the profile. Never persisted.
- **The OAuth landing page** (`apps/web/src/app/auth/callback/page.tsx`): TradeW's
  own tokens arrive in the URL **fragment**, not the query string — never sent to
  a server, never in an access log or `Referer` — and the fragment is cleared
  with `history.replaceState` immediately. Correct as written.
- **`dhan-token.ts` CLI**: `describeToken` prints only decoded JWT claims
  (expiry, client id), never token material. `writeToken` writes to a gitignored
  `.env` — an operator-local file, out of scope for database encryption but
  named in the design's operational notes.
- **Test fixtures**: every `accessToken: '…'` literal is a synthetic value in a
  `.spec.ts`. None is real.

## 5. Attack scenarios

| Scenario | Today | After remediation |
| --- | --- | --- |
| **Database leak** — dump, stolen backup, snapshot, misconfigured replica | Every stored token is **immediately usable** against Dhan until it expires | Ciphertext only. Useless without the key, which is not in the database |
| **Application server compromise** | Full compromise: the process holds the tokens | Still full compromise — the process must hold the key to do its job. Encryption at rest does not defend this, and this document does not claim it does |
| **SQL injection returning rows** | Live tokens | Ciphertext |
| **Row substitution** — an attacker with DB write access copies the feed-default user's ciphertext into their own row | N/A (plaintext is already readable) | **Refused.** The ciphertext is bound to `provider|userId` as AEAD associated data, so a moved ciphertext fails authentication |
| **Operator with read-only DB access** | Reads every user's broker token | Ciphertext, unless they also hold the key |
| **Accidental log/telemetry leak** | Already prevented | Unchanged |

The honest summary: **encryption at rest defends the database, not the running
process.** Anyone claiming otherwise is overselling it, and `/legal/security`
must not.

## 6. What is out of scope for this remediation

- Hardware or cloud KMS. TradeW has no KMS integration and mission §4 forbids
  inventing an architecture. The design uses an application-held keyring and
  states the residual risk plainly.
- Protecting a fully compromised application host.
- Dhan-side controls (their token TTL, their own 2FA).
- The operator-local `.env` `DHAN_ACCESS_TOKEN` fallback, which is a filesystem
  secret rather than a database one.

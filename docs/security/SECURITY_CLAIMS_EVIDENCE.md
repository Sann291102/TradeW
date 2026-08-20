# TradeW — Security Claims Evidence Register

**Every public security statement TradeW makes, and the file that backs it.**

**Last audited:** 2026-08-20 (post broker-credential remediation)

Rule: a claim may be published only when the Evidence column names something a
reviewer can open. "We believe" and "industry standard" are not evidence. A
claim that loses its evidence must be removed from the public surface in the
same commit that removes the evidence.

---

## 1. Claims currently published

Surfaces: the landing page (`apps/web/src/components/landing/LandingPage.tsx`)
and `/legal/security` (`apps/web/src/lib/legal/documents.ts`).

| Claim | Evidence | Verified | Publicly safe? |
| --- | --- | --- | --- |
| Encryption in transit (TLS, HSTS, insecure requests upgraded) | `apps/web/next.config.mjs` — `Strict-Transport-Security`, `upgrade-insecure-requests` | **Yes** | Yes |
| **Broker credentials encrypted at rest (AES-256-GCM)** | `packages/database/src/credential-crypto.ts`; write boundary `dhan-auth.service.ts` `seal()`; tests `credential-crypto.spec.ts` (20), `credential-storage.spec.ts` (11) | **Yes — new 2026-08-20** | Yes |
| Credential ciphertext bound to its row, so it cannot be moved between users | AEAD associated data `v1|provider|userId`; asserted by "a ciphertext is bound to its row" | **Yes** | Yes |
| One-time sign-in codes over email and SMS: hashed at rest, 10-minute TTL, 5-attempt cap, resend cooldown, no account enumeration | `services/api/src/auth/otp.service.ts` | **Yes** | Yes |
| Passwords hashed | `bcryptjs`; `User.passwordHash`, operator `passwordHash` | **Yes** | Yes |
| Refresh tokens stored hashed, revocable | `RefreshToken.tokenHash` (SHA-256); `auth.service.ts` `refresh`/`logout` | **Yes** | Yes |
| A single audited ingress — every request passes one policy layer | `services/api` `AuthGuard`; same-origin proxy in `next.config.mjs`; `TRADEW-OS.md` §2.2 | **Yes** | Yes |
| An enforced Content-Security-Policy, *including* its `unsafe-inline` limitation | `apps/web/next.config.mjs` — the limitation is stated in the policy's own comment and on `/legal/security` | **Yes** | Yes |
| Per-tab session isolation | `apps/web/src/lib/session-storage.ts`; `session-storage.test.ts` | **Yes** | Yes |
| Google sign-in | `services/api/src/auth/google-oauth.service.ts` | **Yes** | Yes |
| Separate operator boundary; admin console is a different app with its own session | `apps/admin`; `AdminTokenGuard`; `admin-access.guard.spec.ts` | **Yes** | Yes |
| No AI service can reach the order path | `TRADEW-OS.md` §5; Sentinel component tests assert no recommendation is rendered | **Yes** | Yes |
| Broker credentials are never returned by any API response | `DhanCredentialStatus` DTO; `listCredentials()` explicit `select`; asserted by "the credential never leaves the service" | **Yes** | Yes |
| Secrets are redacted from logs | `services/api/src/common/security-log.ts` — key-pattern **and** value-shape rules; `security-log.spec.ts` | **Yes** | Yes |
| Broker OAuth callback is CSRF- and replay-protected | `oauth-state.ts`; `oauth-state.spec.ts` (20), `dhan-auth.service.spec.ts` (9) | **Yes** | Yes |
| A user cannot read or modify another user's broker connection | `dhan-auth.controller.ts` subject derivation; `denyCrossUserAccess`; `broker-authz.spec.ts` (13) | **Yes** | Yes |
| No advertising or third-party tracking cookies; no analytics provider in the web app | `lib/analytics.ts` is a console stub; `/legal/cookies` enumerates all five storage items | **Yes** | Yes |

## 2. Claims explicitly NOT made, and why

Published on `/legal/security` under "What is not in place", because a security
page that lists only the flattering half is misleading by omission.

| Not claimed | Why it cannot be | Would need |
| --- | --- | --- |
| **"End-to-end encryption"** | TradeW can read this data. E2E means the service provider cannot, which is not this architecture | A different product |
| **Encryption at rest for *all* data** | Only broker credentials are encrypted. The rest of the database is not | Full-disk or column-level encryption plus a key strategy |
| **Authenticator-app (TOTP) 2FA** | No implementation exists. Repository-wide grep for `totp`/`authenticator`/`otpauth` finds nothing | Building it |
| ISO 27001 / SOC 2 / PCI DSS | No certification held | An audit |
| Penetration test results | None published | An engagement |
| Uptime, availability or SLA figures | Nothing measures one | A status/monitoring surface |
| "Security monitoring" | `securityLog` writes structured events. **Nothing consumes them** — no aggregator, no alerting, nobody paged | A log sink and an on-call rota |
| A vulnerability disclosure programme | No monitored security contact exists — see §4 | A monitored address |
| Protection against a compromised application host | Encryption at rest does not defend a process that must hold the key | Out of scope by design |
| SEBI or regulatory certification | TradeW is not registered as an Investment Adviser or Research Analyst and does not hold itself out as either | Registration, if the product ever needs it |

## 3. Claims corrected during this work

| Claim as published | Corrected to | Date |
| --- | --- | --- |
| "End-to-end encryption in transit and at rest" | "Encryption in transit — TLS everywhere, with strict transport security enforced" — then, after remediation, broker credentials at rest stated **specifically** rather than as a blanket claim | 2026-08-20 |
| "Two-factor authentication, including authenticator apps" | "One-time sign-in codes over email and SMS, stored hashed, expiring, and rate-limited" | 2026-08-20 |
| FAQ: "encrypted in transit and at rest" | Rewritten to point at `/legal/security` and `/legal/privacy` rather than assert a blanket claim | 2026-08-20 |

## 4. `/.well-known/security.txt` — decision

**Decision: DO NOT PUBLISH. Blocked on a monitored contact.**

RFC 9116 requires at least a `Contact:` field and an `Expires:` field. TradeW has
neither a monitored security address nor a canonical domain to serve the file
from — every `tradew.*` string in this repository is a test fixture or an
illustrative hostname in a design document.

Publishing one anyway would be worse than publishing none: it advertises a
reporting channel, and a researcher who uses an unmonitored one concludes they
were ignored and discloses publicly. The absence is stated on `/legal/security`
instead, along with a request to hold findings until a contact exists.

**Unblocks when:** one monitored address and one canonical domain exist. Then:

```
Contact: mailto:security@<domain>
Expires: <ISO 8601, ≤ 1 year out>
Preferred-Languages: en
Policy: https://<domain>/legal/security
```

Served from `/.well-known/security.txt` — a Next route handler at
`apps/web/src/app/.well-known/security.txt/route.ts`, and added to the
`robots.ts` allow list.

## 5. Contact and incident response — the minimum, and the gap

| Need | Status | Blocking? |
| --- | --- | --- |
| Security reports | **BLOCKED — monitored contact required** | Yes. Highest-priority open item |
| Privacy / DPDP data-subject requests | **BLOCKED — monitored contact required.** Substantive DPDP obligations commence 13 May 2027 | Yes, with a deadline |
| Legal notices | **BLOCKED — no contracting entity named** | Yes |
| Support requests | **BLOCKED — monitored contact required** | Yes |

The minimum infrastructure is genuinely small: **one monitored address, and a
named human who reads it.** Everything in this table clears at once when that
exists. It is not an engineering task, which is why it is recorded here rather
than half-built.

No address is invented anywhere in the product. `/legal/privacy`,
`/legal/security` and `/legal/terms` each carry an `Outstanding` note saying so.

### Minimum incident response, once a contact exists

1. Acknowledge within a stated window (publish the window; do not exceed it).
2. Triage against this register — which claim, if any, is now false.
3. Contain. For a credential incident: rotate the keyring, then require broker
   reconnection. Dhan tokens expire in 24 hours, which bounds the exposure.
4. Notify affected users, and the Data Protection Board where the DPDP Rules
   require it.
5. Update this register and `/legal/security` in the same change.

## 6. Review cadence

| When | Action |
| --- | --- |
| Every change touching auth, credentials, storage or logging | Re-read §1. A claim whose evidence moved is a claim to re-verify or delete |
| Every 90 days | Walk §1 top to bottom and open each file |
| Before any marketing copy ships | Every security sentence must appear in §1 first |
| On any incident | §5 step 5 |

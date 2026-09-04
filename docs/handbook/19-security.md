# Chapter 19 — Security

**Status: 🟡.** Structural controls (one ingress, service tokens, hashed refresh tokens, append-only audit, per-service secrets) are 🟢. **RBAC and rate limiting are missing and are release blockers.** The platform has never been deployed, which is why several 🔴 items are not yet incidents.

🔒 marks a security-critical control. ⚖️ marks a compliance obligation.

---

## 19.1 Security posture

> **The posture is structural, not procedural: security comes from boundaries that make the bad thing impossible, not from rules that make it forbidden.**

Four structural properties do most of the work:

```
   1. ONE INGRESS          nothing but services/api is internet-reachable
   2. NO CREDENTIALS       Sentinel holds no trading credentials — it
      WHERE NOT NEEDED     receives DTOs (§5.6.1). A compromised Sentinel
                           cannot exfiltrate positions because it cannot
                           see them.
   3. NO CAPABILITY        no order-placement tool exists. Not disabled —
      WHERE NOT NEEDED     absent (§18.8.1).
   4. IDENTITY FROM        req.user.sub is the ONLY source of user identity.
      THE TOKEN, ALWAYS    No controller reads a userId from a body.
```

Each removes a class of vulnerability rather than defending against it.

---

## 19.2 Threat model

### 19.2.1 Assets, ranked

| # | Asset | Impact if compromised |
|---|---|---|
| 1 | User credentials | account takeover; reused passwords elsewhere |
| 2 | ⚖️ Broker API credentials (Dhan) | market-data abuse; **real order placement if order scopes are ever enabled** |
| 3 | ⚖️ Audit trail integrity | regulatory finding; unprovable compliance |
| 4 | User trading history | ⚖️ DPDP personal data; commercially sensitive |
| 5 | `SERVICE_TOKEN` | full internal-service access |
| 6 | `JWT_SECRET` | forge any user's session |
| 7 | Database | everything above |
| 8 | AI provider keys | cost abuse |
| 9 | Knowledge base / ontology | product IP |

### 19.2.2 Adversaries

| Adversary | Motivation | Most likely vector |
|---|---|---|
| **Opportunistic attacker** | credentials, resale | credential stuffing, known CVEs, exposed admin endpoints |
| **Targeted attacker** | broker credentials → real money | phishing an operator, supply chain, `SERVICE_TOKEN` theft |
| **Malicious user** | privilege escalation, free premium | 🔴 **admin endpoints with no RBAC**, IDOR, quota bypass |
| **Insider** | data exfiltration | direct database access, log access |
| **Automated scanner** | opportunistic | default credentials, exposed ports, unpatched dependencies |

### 19.2.3 STRIDE

| Threat | Vector | Control | Status |
|---|---|---|---|
| **S**poofing | forged JWT | signed, verified; short TTL | 🟢 |
| | stolen refresh token | hashed at rest, rotated | 🟢 |
| | | reuse detection | 🔵 SEC-1 |
| | forged service token | `x-service-token`, fail-closed | 🟢 |
| | | timing-safe compare | 🔵 SEC-5 |
| **T**ampering | mass assignment | `ValidationPipe({ whitelist: true })` | 🟢 |
| | SQL injection | Prisma parameterises | 🟢 |
| | ⚖️ audit tampering | append-only by convention | 🟡 — not enforced at the DB |
| | price manipulation | prices from the bridge, never the client | 🟢 |
| **R**epudiation | ⚖️ "I didn't do that" | `AuditEvent` with IP + UA | 🟢 |
| | ⚖️ "it told me to buy" | `SentinelObservation` with evidence | 🟢 |
| **I**nformation disclosure | IDOR | identity from `req.user.sub` only | 🟢 |
| | user enumeration | uniform `'Invalid credentials'` | 🟢 |
| | secrets in logs | discipline only | 🟡 |
| | stack traces to client | Nest filters | 🟡 |
| | ⚖️ cross-user data | Sentinel holds no trading credentials | 🟢 |
| **D**enial of service | brute force | rate limiting | 🔴 **SEC-4** |
| | expensive endpoints | quotas exist; no rate limit | 🔴 |
| | broker rate-limit ban | `TokenBucket` | 🟢 |
| **E**levation of privilege | **admin endpoints** | 🔴 **no RBAC — SEC-3** | 🔴 |
| | entitlement bypass | `CapabilityGuard`, one decision point | 🟢 |
| | AI places an order | no tool, no client, no arrow | 🟢 |

### 19.2.4 🔴 The two findings that block release

> **SEC-3 — No RBAC.** `POST /entitlements/admin/overrides` is protected by `AuthGuard` only. **Any authenticated user can grant themselves any capability.** Trivially exploitable; total bypass of the monetisation model.
>
> **SEC-4 — No rate limiting.** `POST /auth/login` accepts unlimited attempts from any source. Credential stuffing is unimpeded.

Both are cheap to fix (a guard + a role column; a Redis sliding window). Both must be fixed before the first deployment. They are named here in the threat model rather than in a debt appendix because that is where a reviewer will look for them.

---

## 19.3 OWASP Top 10 (2021)

| # | Risk | Our exposure | Control | Status |
|---|---|---|---|---|
| **A01** | Broken access control | 🔴 **high** | `AuthGuard` + `CapabilityGuard` 🟢; **RBAC missing** 🔴 | 🔴 |
| **A02** | Cryptographic failures | medium | bcrypt (cost 10, want 12); hashed refresh tokens; TLS via Caddy | 🟡 |
| **A03** | Injection | low | Prisma parameterises; `class-validator` at the boundary; React escapes | 🟢 |
| **A04** | Insecure design | low | ARCH-1..4 are design-level controls; documented decisions | 🟢 |
| **A05** | Security misconfiguration | medium | env-split CORS 🟢; **no security headers** 🔵; no hardened baseline 🔵 | 🟡 |
| **A06** | Vulnerable components | **unknown** | **no dependency scanning at all** | 🔴 |
| **A07** | Auth failures | 🔴 **high** | uniform errors 🟢; rotation 🟢; **no rate limit** 🔴; no MFA 🔵 | 🔴 |
| **A08** | Data integrity failures | medium | no CI signing/provenance 🔵; migrations reviewed 🟢 | 🟡 |
| **A09** | Logging & monitoring failures | **high** | `AuditEvent` 🟢; **no alerting, no aggregation, no metrics** 🔴 | 🔴 |
| **A10** | SSRF | low | no user-supplied URLs are fetched; research providers are allowlisted | 🟢 |

### 19.3.1 A06 — the invisible risk

**There is no dependency scanning.** No Dependabot, no `npm audit` in CI, no SCA. The dependency tree includes NestJS, Prisma, Next.js, React, and their transitive closure — thousands of packages, none monitored.

This is the highest-severity item that produces no symptom until it produces a breach.

🔵 **Fix, in order of cost:** enable Dependabot (free, 10 minutes) → `npm audit --audit-level=high` in CI (free, 10 minutes) → an SCA tool with license checking (later).

### 19.3.2 A09 — you cannot respond to what you cannot see

`AuditEvent` records what happened. Nothing alerts on it. A brute-force run against `/auth/login` would produce thousands of `user.login.failure` rows and **no notification to anyone.**

---

## 19.4 Authentication controls

### 19.4.1 What is right 🟢

| Control | Implementation |
|---|---|
| Passwords hashed | bcrypt |
| Uniform failure message | unknown email and wrong password both return `'Invalid credentials'` |
| Refresh tokens hashed at rest | `RefreshToken.tokenHash @unique` |
| Rotation on every refresh | presented token revoked, new pair issued |
| Revoked, not deleted | audit trail preserved; enables reuse detection |
| ⚖️ Both failure branches audited | with the attempted email on the unknown-user branch |
| Email normalised | `.trim().toLowerCase()` on read and write |
| Identity from the token only | `req.user.sub` — never from a body |

### 19.4.2 What is missing 🔵

| Gap | Severity | Fix |
|---|---|---|
| **Rate limiting on login** | 🔴 critical | Redis sliding window, keyed on IP **and** attempted email |
| bcrypt cost 10 vs. NFR-S2's 12 | low | rehash on login |
| Refresh-token reuse detection | medium | a revoked token presented ⇒ revoke the family |
| Account lockout / progressive delay | medium | after N failures, exponential backoff |
| Password strength policy | medium | length + breach check (k-anonymity against HIBP) |
| MFA (TOTP) | medium | for admin roles at minimum |
| Email verification | medium | blocks throwaway signups |
| Session listing / remote revoke | low | `RefreshToken` already models it |
| Suspicious-login notification | low | new IP / new device |

**The login rate limiter must key on IP *and* email.** IP-only is defeated by a botnet; email-only by rotating targets. Both, with different thresholds.

### 19.4.3 Token lifetimes

| Token | TTL | Storage |
|---|---|---|
| Access JWT | ≤15 min (NFR-S3) | memory only — `sessionStore` is deliberately unpersisted |
| Refresh token | ≤30 days (NFR-S4), rotating | httpOnly, Secure, SameSite=Strict cookie |
| `SERVICE_TOKEN` | rotated quarterly 🔵 | secrets manager |

**The access token is never written to `localStorage`.** A stolen storage dump contains no credential — the same reasoning that keeps `sessionStore` unpersisted (Chapter 15 §15.4.2).

---

## 19.5 Secrets management 🔒

### 19.5.1 Rules

```
   □ No secret in git — ever, in any branch, in any history
   □ Each service ships .env.example with PLACEHOLDER values  (ARCH-6)
   □ .env is gitignored
   □ Production secrets come from a secrets manager, never a file
   □ Rotation: quarterly for service tokens, annually for API keys,
     IMMEDIATELY on any suspected exposure
   □ No secret in a log line, an error message, or a stack trace
   □ CI secrets are repository secrets, never workflow literals
```

### 19.5.2 ⚠️ The known exposure

A **Neon Postgres credential was found committed in cleartext** in the superseded `tradew-prototype/backend/prisma/schema.prisma`.

- That prototype is **not** the current monorepo, which uses `.env`-based `DATABASE_URL`
- The credential must be **confirmed rotated** regardless of whether that folder is ever touched again
- ⚠️ **Git history is forever.** Removing the file does not remove the secret. Rotation is the only remediation.

**Status: unconfirmed.** Tracked as SEC-0 and is a prerequisite for the first production deployment.

### 19.5.3 🔵 Pre-commit secret scanning

```
   gitleaks / trufflehog as a pre-commit hook  ← catches it before the commit
   + the same scan in CI on every PR           ← catches it before the merge
   + a full history scan, once                 ← finds what is already there
```

The full history scan should be run before the first deployment. It costs an hour and answers a question nobody currently knows the answer to.

---

## 19.6 Encryption

| Layer | Control | Status |
|---|---|---|
| In transit, public | TLS 1.3, auto-cert via Caddy | 🟡 written, never deployed |
| In transit, internal | plaintext on a private network | 🟡 — mTLS is 🔵 |
| At rest, database | volume encryption | 🔵 depends on host |
| At rest, backups | encrypted before upload | 🔵 |
| Passwords | bcrypt | 🟢 |
| Refresh tokens | SHA-256 hash | 🟢 |
| ⚖️ PII columns | not encrypted | 🔵 |

### 19.6.1 Field-level encryption 🔵

⚖️ DPDP-sensitive fields worth encrypting at the application layer: `User.email`, `JournalEntry.content` (a user's private reflections about their own trading), and any future KYC data.

The trade-off is real: encrypted columns cannot be indexed or searched. `User.email` needs an exact-match lookup for login, which a deterministic encryption scheme or a separate hash column can serve. `JournalEntry.content` needs neither, so it is the easy win.

---

## 19.7 Input validation 🟢

### 19.7.1 Three layers

```
   1. TRANSPORT   ValidationPipe({ whitelist: true, transform: true })
                  strips undeclared properties → mass assignment impossible

   2. DTO         class-validator decorators
                  @IsInt @Min(1) @IsEnum @IsNumber @IsOptional

   3. DOMAIN      business rules in the service
                  lot-size multiples, price required for LIMIT,
                  trigger required for SL
```

### 19.7.2 ⭐ `whitelist: true` is the control

Without it, a body of `{ symbol, side, quantity, userId: '<victim>' }` passes an undeclared `userId` into the service layer. **Every mass-assignment vulnerability has this shape.** One option, one class of bug.

### 19.7.3 Output encoding

React escapes by default. `dangerouslySetInnerHTML` appears only in the knowledge vault viewer's markdown rendering, which goes through `react-markdown` (sanitising) — not raw HTML injection.

> ⚠️ If you ever add `dangerouslySetInnerHTML`, it needs a security review. There are currently no exceptions to route through a sanitiser.

---

## 19.8 Compliance ⚖️

### 19.8.1 SEBI posture

TradeW is **not** a registered investment adviser and does not intend to become one. The entire compliance posture rests on one distinction:

```
   ADVICE (regulated)              OBSERVATION (not regulated)
   ──────────────────              ───────────────────────────
   "Buy NIFTY 25000 CE"            "Volume on this breakout is 62%
   "Target 180, SL 120"             of the 20-bar average"
   "This is a good trade"          "This resembles a low-conviction
   "Reduce your position"           breakout"
   "68% probability of profit"     "You entered within 15 minutes of
                                    a losing exit, 3 times today"
```

**Controls that keep us on the right side:**

| # | Control | Where |
|---|---|---|
| C1 | No Buy/Sell/Entry/Target language anywhere | `CORE_GUARDRAILS` + deterministic composition + copy review |
| C2 | Output structure fixed: evidence → pattern → **soft** suggestion | orchestrator, by construction |
| C3 | Every AI output carries a disclaimer | `SENTINEL_DISCLAIMER` is a response field, not UI copy |
| C4 | Every observation logged with evidence + SEBI category | `ComplianceService` |
| C5 | No order outside a written mandate, and no mandate without recorded consent | ARCH-2 / ADR-046 — the `ExecutionProfile` row, two-switch arming, `User.agentPaperTradingEnabledAt`, and an `ExecutionIntent` written before any order exists |
| C6 | Confidence never claims certainty | 0.95 cap |
| C7 | Statistics withheld below sample size | `MIN_SAMPLE = 5` |
| C8 | Unavailable dimensions reported honestly | never fabricated |

**C1 is enforced by code, not by policy.** That is the point: a policy can be forgotten by a copywriter, a deterministic composer cannot.

### 19.8.2 The category taxonomy

```ts
'behavioral_pattern_observation'    // Emotion agent
'market_risk_awareness'             // Trap & Safety agent
'market_structure_observation'      // Market & Technical agent
'synthesized_risk_awareness'        // Orchestrator
```

⚖️ Every `SentinelObservation` carries one. This is what makes the "Why" panel *defensible*: a regulator asking "on what basis did you tell this user X?" receives a category, evidence lines, a confidence value, and a timestamp.

### 19.8.3 DPDP Act 2023

| Obligation | Status | Gap |
|---|---|---|
| Lawful purpose + consent | 🔵 | consent flow not built |
| Purpose limitation | 🟡 | data used as collected; not documented |
| Data minimisation | 🟢 | we collect little |
| Accuracy | 🟢 | user-editable profile |
| **Storage limitation** | 🔴 | **no retention policy** (DB-3) |
| Security safeguards | 🟡 | this chapter's gaps |
| **Breach notification** | 🔴 | **no incident-response plan** |
| Right to access | 🔵 | data export not built |
| **Right to erasure** | 🔴 | **not designed** (Chapter 17 §17.8.1) |
| Grievance officer | 🔵 | not appointed |

### 19.8.4 ⚖️ The erasure/retention collision

DPDP grants erasure; SEBI mandates retention. The resolution is pseudonymisation, and it must be designed **before** the first erasure request:

```
   ERASE                        RETAIN + PSEUDONYMISE
   ─────                        ─────────────────────
   JournalEntry.content         Order / Trade / Position   } legal
   UserPreference               AuditEvent                 } obligation
   user-scoped MemoryRecord     Subscription               }
   name, contact details
                                User.email → deleted-{uuid}@erased.invalid
                                passwordHash → random, unusable
                                → transaction record survives,
                                  unlinkable to a person
```

### 19.8.5 Data residency ⚖️

NFR-C5: personal data resident in India. Drives the hosting decision (OCI Mumbai / AWS ap-south-1) and constrains third-party processors — including AI providers.

> ⚠️ **Sending a user's journal entry or trade history to an overseas LLM API is a cross-border data transfer.** The current architecture does not do this (Sentinel receives DTOs and sends *evidence strings* to the model, not raw personal data), but it is one careless prompt change away from doing so. Any prompt that includes user-identifying data needs a data-transfer review.

---

## 19.9 Audit logging ⚖️

### 19.9.1 Two trails

| Table | Records | Indexed |
|---|---|---|
| `AuditEvent` | auth and admin actions, IP, user agent, metadata | `[userId,createdAt]`, `[eventType,createdAt]` |
| `SentinelObservation` | every AI observation with evidence + category | `[userId,createdAt]`, `[agent,createdAt]`, `[symbol,createdAt]` |

### 19.9.2 The failure posture

```ts
catch (err) {
  // audit logging must never break the observation flow, but a silent
  // audit gap is a compliance issue — log loudly
  this.logger.error(`failed to persist ${observations.length} observations: ${err}`);
}
```

Non-fatal, but `error`-level — and 🔵 `sentinel_audit_write_failures_total > 0` is one of only four alerts that page a human (Chapter 9 §9.7.2).

### 19.9.3 Append-only is a convention, not a constraint 🔵

Nothing at the database level prevents an `UPDATE` or `DELETE` on `AuditEvent`.

🔵 **Enforce it properly:**

```sql
REVOKE UPDATE, DELETE ON "AuditEvent" FROM tradew_app;
REVOKE UPDATE, DELETE ON "SentinelObservation" FROM tradew_app;
-- retention pruning runs as a separate role, on a documented schedule
```

⚖️ An audit trail the application can rewrite is not an audit trail.

### 19.9.4 What must be audited 🔵

Currently: signup, login success/failure, refresh success/failure, logout.

Missing and required:

```
   □ every admin action (grant, revoke, override) — WITH the acting user
     and a mandatory reason  ← the pattern EntitlementOverride already sets
   □ password change, email change
   □ ⚖️ data export request, erasure request
   □ entitlement change (any source)
   □ ⚖️ role change (once RBAC exists)
   □ failed authorization (a 403 is a signal)
```

---

## 19.10 Frontend security

| Control | Status |
|---|---|
| XSS — React escaping | 🟢 |
| No `dangerouslySetInnerHTML` outside sanitised markdown | 🟢 |
| Access token never in `localStorage` | 🟢 |
| httpOnly + Secure + SameSite=Strict refresh cookie | 🟡 |
| **Content-Security-Policy** | 🔴 |
| Subresource Integrity | 🔵 |
| **CSRF protection** | 🟡 — SameSite=Strict covers most of it |
| Clickjacking (`X-Frame-Options` / `frame-ancestors`) | 🔴 |
| Secrets in `NEXT_PUBLIC_*` | 🟢 — only `NEXT_PUBLIC_API_URL` |

### 19.10.1 🔵 Security headers (Caddy)

```
   Content-Security-Policy: default-src 'self';
                            script-src 'self' 'unsafe-inline';   ← Next needs this today
                            style-src 'self' 'unsafe-inline';
                            img-src 'self' data:;
                            connect-src 'self';
                            frame-ancestors 'none';
                            base-uri 'self';
                            form-action 'self'
   Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
   X-Content-Type-Options: nosniff
   Referrer-Policy: strict-origin-when-cross-origin
   Permissions-Policy: geolocation=(), microphone=(), camera=()
```

Five headers in the Caddyfile. Perhaps thirty minutes of work, and it closes the entire clickjacking and content-sniffing category.

`'unsafe-inline'` on `script-src` is a real weakening required by Next.js's inline bootstrap and the no-flash theme script. Nonce-based CSP is the correct answer and is more work; it is worth doing before handling real money.

---

## 19.11 Infrastructure security 🔵

```
   □ Only 80/443 exposed publicly            (Caddy terminates TLS)
   □ Postgres NEVER internet-reachable
   □ Internal services on a private network only
   □ SSH: key-only, no password, non-default port, fail2ban
   □ Automatic security updates
   □ Container images: non-root user, minimal base, pinned digests
   □ Docker socket never mounted into a container
   □ Read-only root filesystem where possible
   □ Resource limits per container (a runaway must not take the host)
   □ Static IP reserved (needed if Dhan order APIs are ever in scope)
```

### 19.11.1 ⚠️ The local compose is not a production baseline

```yaml
POSTGRES_USER: tradew
POSTGRES_PASSWORD: tradew          # ← development only
PGADMIN_DEFAULT_PASSWORD: admin    # ← development only
ports: ['5433:5432']               # ← must NOT be published in production
```

Fine for local development, catastrophic if `docker-compose.yml` is ever used in production instead of `docker-compose.prod.yml`. **pgAdmin must not run in production at all.**

---

## 19.12 Secure development

### 19.12.1 In CI 🔵

```
   □ Dependabot enabled                          ← 10 minutes, do it today
   □ npm audit --audit-level=high (blocking)     ← 10 minutes
   □ gitleaks on every PR
   □ ⚖️ compliance-language suite (§18.13.1)
   □ container image scan (Trivy)
   □ SAST (CodeQL)
```

The first two are free, take twenty minutes combined, and close the highest-severity unknown in this chapter (A06).

### 19.12.2 Security review triggers

Any PR touching these requires a security reviewer:

```
   · authentication or session handling
   · authorization, guards, entitlement logic
   · anything reading process.env
   · CORS, CSP, or any header policy
   · a new external network call
   · a new dependency
   · anything that logs a request body
   · ⚖️ anything that changes what data leaves the system
   · SQL that is not generated by Prisma
```

### 19.12.3 The developer checklist

```
   □ Is user identity taken from req.user.sub, never from the request?
   □ Is every new endpoint guarded?
   □ Does the DTO declare EVERY accepted field? (whitelist strips the rest)
   □ Could this leak another user's data? Trace the userId.
   □ Does any log line contain a secret, a token, or ⚖️ personal data?
   □ Does an error message reveal whether an account exists?
   □ Is a new dependency actually necessary?
   □ ⚖️ Does any new copy or prompt contain directive language?
```

---

## 19.13 Incident response 🔵

**Status: no plan exists.** ⚖️ DPDP requires breach notification, which requires a plan.

### 19.13.1 Severity

| Sev | Definition | Response |
|---|---|---|
| **SEV1** | Confirmed data breach; broker credentials compromised; funds at risk | immediate, all hands, ⚖️ regulator clock starts |
| **SEV2** | Suspected breach; auth bypass; ⚖️ audit integrity compromised | within 1 hour |
| **SEV3** | Vulnerability with no evidence of exploitation | within 1 business day |
| **SEV4** | Low-severity finding | next sprint |

### 19.13.2 The runbook

```
   1. DETECT      alert, report, or discovery → declare severity
   2. CONTAIN     revoke tokens · rotate secrets · block the vector
                  · isolate, DO NOT wipe (preserve evidence)
   3. ASSESS      what data, how many users, over what window
   4. ⚖️ NOTIFY   regulator per DPDP timelines · affected users ·
                  a plain-language description, not a euphemism
   5. ERADICATE   patch, verify, re-scan
   6. RECOVER     restore service, monitor for recurrence
   7. POSTMORTEM  blameless, ≤5 business days, published internally
```

### 19.13.3 The credential-compromise runbook

Most likely SEV1 scenario:

```
   JWT_SECRET compromised
     → rotate immediately; every session is invalidated (accepted cost)
     → force re-authentication
     → ⚖️ audit for forged-token activity in the window

   SERVICE_TOKEN compromised
     → rotate; redeploy every internal service
     → audit internal-service access logs

   DHAN credentials compromised
     → revoke at Dhan IMMEDIATELY
     → ⚖️ verify no order-scope activity occurred
     → notify Dhan

   DATABASE credentials compromised
     → rotate; audit connections by source IP
     → assume full read; treat as a data breach until disproven
```

---

## 19.14 Security debt

| ID | Item | Severity | Effort |
|---|---|---|---|
| **SEC-0** | Neon credential rotation unconfirmed | **critical** | hours |
| **SEC-3** | **No RBAC — admin endpoints open to any user** | **critical** | 1 day |
| **SEC-4** | **No rate limiting** | **critical** | 1 day |
| SEC-6 | No dependency scanning (A06) | **high** | 20 minutes |
| SEC-7 | No security headers / CSP | **high** | hours |
| SEC-8 | ⚖️ No incident-response plan | **high** | 1 day |
| SEC-9 | ⚖️ Audit tables not DB-enforced append-only | high | hours |
| SEC-10 | ⚖️ No retention policy / erasure design | high | 2 days |
| SEC-11 | No alerting on auth anomalies (A09) | high | 1 day |
| SEC-1 | No refresh-token reuse detection | medium | hours |
| SEC-12 | No MFA | medium | 2 days |
| SEC-13 | No secret scanning in CI | medium | hours |
| SEC-14 | No mTLS between services | medium | 2 days |
| SEC-2 | bcrypt cost 10 vs. 12 | low | hours |
| SEC-5 | Non-timing-safe token compare | low | minutes |

### 19.14.1 The pre-deployment gate

**Nothing ships to production until SEC-0, SEC-3, SEC-4, SEC-6, SEC-7, and SEC-8 are closed.**

Combined effort: roughly one engineer-week. That is the price of the first deployment, and it is cheap relative to any one of the incidents it prevents.

### 19.14.2 The honest summary

The **design** is sound. One ingress, service tokens, identity from the token, no credentials where they are not needed, no capability where it is not needed, ⚖️ an audit trail with evidence — these are good structural decisions and they are already in place.

The **operational controls** are missing: no rate limiting, no RBAC, no dependency scanning, no alerting, no incident plan. That is the difference between a system designed securely and a system operated securely, and it is exactly the gap you would expect in a platform that has never been deployed.

The gap closes in about a week. It has to close before the first user, not after the first incident.

---

*Next: [Chapter 20 — Performance Engineering](20-performance-engineering.md)*

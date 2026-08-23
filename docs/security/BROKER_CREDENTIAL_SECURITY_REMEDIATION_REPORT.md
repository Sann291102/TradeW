# Broker Credential — Security Remediation Report

**Date:** 2026-08-20 · **Severity:** High · **Status:** Fixed in code; operational steps outstanding

---

## Finding

`BrokerCredential.accessToken` — a live Dhan brokerage access token stored on a
user's behalf — was persisted in **plaintext** in Postgres.

The schema said so in its own comment: encryption at rest was *"genuinely
outstanding … NOT solved by this change"*, deferred pending a key-management
decision. Anyone holding the database, a backup, a snapshot or a replica held
working brokerage credentials for every user who had linked an account.

The finding surfaced while verifying whether the landing page's claim
*"end-to-end encryption in transit and at rest"* was true. It was not. How it
was found has no bearing on its severity, and it was escalated out of that work
into this one.

## Root cause

Not an oversight — a **correctly identified deferral that was never picked up.**

The column was written when TradeW ran on a single operator credential, and the
comment at the time justified plaintext on that basis while instructing the next
reader to encrypt before adding per-user linking. Per-user linking then shipped
(2026-07-29, `20260729020000_broker_credential_ownership`). That change did the
harder half — ownership, CSRF-protected state, single-use consumption — and
correctly recorded that the encryption half remained, because it needed a key
decision rather than a code edit.

The key decision was never made, and the deferral had no owner and no date. The
process failure is that a known plaintext credential was tracked only in a
schema comment.

## Attack surface

Seventeen lifecycle stages traced (`BROKER_CREDENTIAL_THREAT_MODEL.md` §2).
**Exactly three were exposed:**

| Stage | Status before |
| --- | --- |
| 6 — database write | Plaintext |
| 7 — database storage | Plaintext |
| 16 — backups | Plaintext |

Everything either side was already correct, and that is what made a narrow fix
possible: the credential never reached the frontend, never appeared in an API
response, never entered a log, never reached an admin interface, and never
appeared in an error. The operator listing already excluded the column at the
query level rather than filtering it afterwards.

## Data affected

Every `BrokerCredential` row written before 2026-08-20 — the Dhan access token,
alongside the broker client id and name (which are not secrets).

**Row count could not be determined from the repository**: no database is
reachable from this environment. The backfill's dry run prints the census, and
the design document records this as an operator prerequisite rather than
guessing at it.

## Current exposure

**Bounded, and the bound is real.**

- Dhan caps every access token at **24 hours**. A token exposed before today has
  already expired. The exposure is "every token issued during the plaintext
  window", each live for a day.
- TradeW's own order path is **paper-only** — `ExecutionEnvironment` has exactly
  one member, `PAPER`. TradeW itself could not place a live trade with a leaked
  token. An attacker could, directly against Dhan, subject to Dhan's controls.
- **Backups taken during the plaintext window still contain live-format tokens.**
  Sealing the live rows does not reach them. This is the residual exposure that
  code cannot close.

## Remediation

**AES-256-GCM at rest**, with the key held outside the database.

| Element | Detail |
| --- | --- |
| Module | `packages/database/src/credential-crypto.ts` — the only code that encrypts or decrypts this column |
| Format | `enc:v1:<keyId>:<iv>:<tag>:<ciphertext>` — self-describing, and its own legacy discriminator |
| Key | `BROKER_CREDENTIAL_ENC_KEYS`, a keyring: all keys decrypt, one encrypts. Rotatable without downtime |
| Binding | `v1|provider|userId` as AEAD associated data — a ciphertext moved to another row **fails to open**, closing the row-substitution path an attacker with DB write access would otherwise have |
| Write boundary | One place: `DhanAuthService.seal()`, immediately before the upsert |
| Read boundaries | Two, both at the point of use: the feed bridge's `resolveDhanCredential`, and `DhanAuthService.currentAccessToken` (which has no callers today, corrected anyway so the first one inherits the right behaviour) |
| Failure posture | **Fails closed on write.** No keyring → the connection is refused and nothing is stored. A plaintext fallback would recreate the vulnerability at the moment an operator believes it fixed |
| Home | `packages/database`, the package that owns the schema — so the API and the feed bridge cannot drift into incompatible envelopes |

Also changed: the schema comment now documents the format and the history; the
security logger's allowlist admits `keyId` (a label like `k1`, the one field
that makes a decryption failure diagnosable) while everything else stays
redacted; four new audit events cover sealing, decryption failure, legacy reads
and refused writes.

**Why encryption and not hashing:** every other secret in this schema is hashed,
correctly — `RefreshToken.tokenHash`, `Otp.codeHash`, `BrokerOAuthState.stateHash`
— because those are only ever *verified*. A broker token is *replayed to Dhan*,
so it must be recoverable.

## Migration

**No Prisma migration exists, deliberately.** The column type is unchanged, so
there is no SQL — and therefore no automatic, unattended transform over live
credentials that can destroy them by being subtly wrong.

Instead: reads accept both formats from the moment this ships, so deploying it
disconnects nobody, and sealing is an explicit operator command.

```
npm run credential:migrate -w @tradew/database              # dry run + census
npm run credential:migrate -w @tradew/database -- --apply   # seal
```

Safety properties, each chosen against a specific way this goes wrong:

- **Dry run by default.** Prints how many rows are plaintext before touching any.
- **Round-trip verified per row.** A plaintext value is overwritten only by a
  ciphertext that has *already been decrypted back to exactly it*.
- **Idempotent**; already-sealed rows are skipped.
- **Per-row, not one transaction.** A part-way failure leaves a mixture, and the
  application reads both correctly.
- **Reversible** — `--decrypt` restores plaintext for a rollback, and says
  loudly that it is a break-glass action.
- `--rekey` re-seals under a new active key for rotation.

**The operational recommendation stands separately from the code:** if this
schema has ever run against production, treat every stored token as already
exposed and **have users reconnect their broker accounts** after the backfill.
One click each, tokens expire in 24 hours anyway, and it closes the exposure
that backups keep open.

## Tests

**31 new assertions**, all passing.

`packages/database/src/credential-crypto.spec.ts` — **20**

- Round-trip; the stored value contains no fragment of the token; fresh nonce
  per encryption.
- A different key, an unknown key id, and no keyring at all each fail to
  decrypt — the "stolen database is useless" property.
- Tampered and truncated envelopes are refused rather than returning garbage.
- **A ciphertext will not open under a different `userId` or `provider`** — the
  row-binding property, tested as the attack it prevents.
- Legacy plaintext is recognised and returned, so deployment disconnects nobody.
- Rotation: an old key still decrypts while a new key encrypts.
- Key material is validated: wrong length, unknown active id, malformed entry
  and duplicate id are all refused, and the error names the length without
  echoing the material.

`services/api/src/broker/credential-storage.spec.ts` — **11**

- What reaches Prisma is ciphertext, never the token Dhan returned.
- The ciphertext is sealed against the state row's user and is useless elsewhere.
- **Fail-closed:** with no keyring, and with a malformed keyring, the write is
  refused and `upsert` is never called.
- The refusal message names the missing variable and not the credential.
- The read path decrypts, tolerates legacy plaintext, falls back to the env
  token rather than returning an unopenable value, and returns null when nothing
  can serve.
- `status()` returns a fixed DTO with no token field; `listCredentials()`
  excludes the column **at the query level**, asserted on the `select` object.

Pre-existing coverage that already covered §9 and §10's authorization
requirements, re-run and passing: `broker-authz.spec.ts` (13 — anonymous
rejected, cross-user refused, operator-only routes), `oauth-state.spec.ts` (20),
`dhan-auth.service.spec.ts` (9), `security-log.spec.ts` (8 — proof a secret
cannot be logged).

### Results

| Suite | Before | After |
| --- | --- | --- |
| `services/api` | 407 passing, **3 files failing to load** | **466 passing, 35/35 files** |
| `packages/database` | *(no suite)* | **20 passing** |
| `apps/web` | 611 passing | **611 passing** |
| `services/api` typecheck | 20+ errors | **Clean** |
| `services/api` build (`nest build`) | — | **Passes** |
| `apps/web` build | — | **Passes**, 52 static pages |

The three previously-failing API files (`entitlements`, `coupon-redeem`,
`otp-disclosure`) were failing because the Prisma client had never been
generated in this checkout, not because of anything in this change. Running
`prisma generate` cleared them and the API typecheck at the same time.

## Remaining risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| **Pre-remediation backups still contain plaintext tokens** | High until handled | Rotate or destroy per retention policy; require broker reconnection. Code cannot reach this |
| A compromised application host exposes key and data together | Accepted | Inherent to any application-held key. Stated on `/legal/security` rather than glossed |
| The key is held in an environment variable, not a KMS | Medium | Documented. Only `credential-crypto.ts` changes when a KMS exists |
| Key stored beside a database backup would undo the control | High if it happens | Called out in the design and in `.env.example` |
| Key lost with no backup | Medium | Credentials unrecoverable; users reconnect, feed runs on `DHAN_ACCESS_TOKEN`. Acceptable for a 24-hour credential — and the reason the key must be backed up somewhere that is *not* the database backup |
| **Security events are written but nothing consumes them** | Medium | `securityLog` emits structured events; no aggregator, no alerting, nobody paged. Recorded in the evidence register as a claim TradeW must not make |
| The rest of the database is not column-encrypted | Medium | Scoped out deliberately; stated publicly rather than implied away |
| **No vulnerability disclosure channel** | High | §"Operational requirements" below. Unchanged by this work and still the single highest-return open item |

## Operational requirements

Before this is finished in production, not just in the repository:

1. **Generate a key** and set `BROKER_CREDENTIAL_ENC_KEYS` in every environment
   that runs the API or the feed bridge. Until then, broker connect refuses —
   visibly, with a message naming the variable.
2. **Store the key outside the database backup.** Co-locating them undoes the
   entire control.
3. **Run the backfill** — dry run, read the census, then `--apply`.
4. **Require broker reconnection.** Cheap, and it retires every token that sat
   in plaintext.
5. **Handle pre-remediation backups** per retention policy.
6. **Publish a monitored security contact**, then `/.well-known/security.txt`.
   Everything in `SECURITY_CLAIMS_EVIDENCE.md` §5 unblocks at once.

## Security claims now supported

Added to the public surface, each with evidence in
`SECURITY_CLAIMS_EVIDENCE.md` §1:

- Broker credentials are encrypted at rest with AES-256-GCM, using a key not
  stored in the database.
- Each credential is cryptographically bound to its account, so its stored form
  is useless in anyone else's row.
- Broker credentials are never returned by any API response — now asserted, not
  just true.

## Security claims that remain unsupported

Published on `/legal/security` under "What is not in place":

- "End-to-end encryption" — TradeW can read this data; E2E means it cannot.
- Encryption at rest for the **whole** database. Only broker credentials.
- **Authenticator-app (TOTP) 2FA** — no implementation exists.
- ISO 27001, SOC 2, PCI DSS, any certification.
- Published penetration-test results.
- Uptime, availability or SLA figures.
- **"Security monitoring"** — events are written, nothing consumes them.
- A vulnerability disclosure programme — no monitored contact.
- Protection against a compromised application host.

## Definition of done

| | Item | Status |
| --- | --- | --- |
| ✅ | Credential lifecycle mapped | 17 stages, `BROKER_CREDENTIAL_THREAT_MODEL.md` §2 |
| ✅ | Threat model documented | Same file |
| ✅ | Storage encrypted | AES-256-GCM, row-bound |
| ✅ | Decryption boundary defined | One write, two reads, at point of use |
| ✅ | API responses audited | No DTO carries a token; asserted |
| ✅ | Authorization audited | Already correct; 13 existing tests re-run |
| ✅ | Logs audited | Redaction verified; `keyId` allowlisted deliberately |
| ✅ | Error handling audited | Refusals name the rule, never the material |
| ✅ | Frontend exposure audited | No broker credential crosses the API boundary |
| ⚠️ | Existing credentials migrated safely | **Tooling built and tested; the run is an operator action** |
| ✅ | Secret redaction implemented | Pre-existing, verified, extended |
| ✅ | Regression tests added | 31 new, all passing |
| ✅ | Production build passes | `nest build` and `next build` both green |
| ✅ | Existing test suite passes | 466 API + 20 database + 611 web |
| ✅ | Security claims re-audited | `SECURITY_CLAIMS_EVIDENCE.md` |
| ✅ | `security.txt` decision documented | Do not publish — blocked on a contact |
| ⚠️ | Contact / incident-response gap documented | Documented. **Still BLOCKED** |

Two items are not green, and neither is a code gap: both need a person.

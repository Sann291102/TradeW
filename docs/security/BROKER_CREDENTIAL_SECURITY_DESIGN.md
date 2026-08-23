# Broker Credential — Security Design

**Written:** 2026-08-20 · Companion to `BROKER_CREDENTIAL_THREAT_MODEL.md`.

---

## 1. The shape of the problem

From the threat model: the credential is correct everywhere except stages 6, 7
and 16 — database write, database storage, backups. One write point, two read
points, one of which has no callers. That is a small enough surface that a
narrow fix is the right fix.

**Design rule for this change:** do not invent infrastructure. TradeW has no
KMS, no secrets manager and no `packages/shared`. Building any of those to
encrypt one column would be a bigger, riskier change than the one it exists to
make, and would ship less securely for having more moving parts.

## 2. Decisions

| Decision | Choice | Why not the alternative |
| --- | --- | --- |
| **Reversible or one-way?** | Reversible encryption | The token is replayed to Dhan. Hashing — correct for `RefreshToken`, `Otp`, `BrokerOAuthState` — would destroy the credential |
| **Algorithm** | **AES-256-GCM** | Authenticated. Detects tampering rather than decrypting to garbage. Available in Node's `crypto`, no dependency |
| **Per-record or envelope?** | **Per-record, with a keyring** | Envelope encryption (a per-record DEK wrapped by a KEK) exists to let a KMS hold the KEK. With no KMS the wrapping key would sit in the same env var as the direct key — all the complexity, none of the benefit |
| **Key location** | `BROKER_CREDENTIAL_ENC_KEYS` env var | The only secret channel this deployment has. `.env` in development, workflow secrets in CI, container env in production — the same path `DHAN_APP_SECRET` already travels |
| **Rotation** | A **keyring**: many keys, one active. Ciphertext names its key id | A single key cannot be rotated without downtime or a big-bang re-encrypt |
| **Ciphertext binding** | `provider|userId` as **AEAD associated data** | Without it, an attacker with DB write access could copy the feed-default user's ciphertext into their own row and inherit that credential |
| **Storage** | Same `String` column, self-describing prefixed envelope | A new column means a two-phase migration and a window where both are authoritative. A prefix lets read handle legacy and new simultaneously |
| **Where the code lives** | `packages/database` — a new `src/`, built to `dist/` exactly like `@tradew/types` | The schema owner owns the column's storage format. Both consumers already depend on the database package's schema |

## 3. Ciphertext format

```
enc:v1:<keyId>:<iv-b64url>:<tag-b64url>:<ciphertext-b64url>
```

- `enc:v1:` — version prefix. Also the **legacy discriminator**: a value without
  it is plaintext from before this change.
- `keyId` — which key decrypts this. `[A-Za-z0-9_-]{1,32}`. Enables rotation
  without re-encrypting everything at once.
- `iv` — 12 random bytes, GCM's standard nonce length, fresh per encryption.
- `tag` — 16-byte GCM authentication tag.
- Associated data (not stored — reconstructed at decrypt): `v1|<provider>|<userId>`.

Self-describing on purpose: an operator looking at a database row can tell what
they are holding without reading code.

## 4. Boundaries

```
Frontend            never sees a broker credential (verified, unchanged)
   ↓
TradeW API          DhanAuthService
   ↓
Credential service  encryptCredential / decryptCredential   ← the ONLY crypto callers
   ↓
Postgres            enc:v1:… ciphertext
   ↓
Feed bridge         decrypts at the point of use
   ↓
Dhan API            plaintext token in the access-token header
```

**Encrypt** at exactly one place: `DhanAuthService.consumeConsent`, immediately
before the `upsert`.

**Decrypt** at exactly two, both as late as possible:

1. `live-feed-server.ts` `resolveDhanCredential` — the real consumer.
2. `DhanAuthService.currentAccessToken` — no callers today; corrected anyway, so
   the first caller inherits the right behaviour.

Nothing between the database and those points ever holds plaintext.

## 5. Failure behaviour

The most consequential part of the design, so it is stated explicitly.

| Situation | Behaviour | Why |
| --- | --- | --- |
| **No key configured, write path** | **Refuse.** `ServiceUnavailableException` naming the missing variable. Nothing is stored | Fail closed. The alternative — storing plaintext when the key is absent — recreates the vulnerability precisely when the operator believes it is fixed |
| **No key configured, read path** | Legacy plaintext still returns; ciphertext returns `null` with a security log | The feed keeps running on a legacy row or the `DHAN_ACCESS_TOKEN` fallback. An outage is not a safer failure than a degraded read |
| **Wrong key / tampered ciphertext** | GCM auth fails → `null`, logged as `broker.credential.decrypt_failed` | Never return garbage as a credential |
| **Unknown `keyId`** | `null`, logged | A rotated-out key that is still needed is an operator error worth surfacing |
| **Legacy plaintext read** | Returned, and logged once as `broker.credential.legacy_plaintext_read` | Migration must be observable. Silence would let a half-migrated deployment look finished |
| **Malformed key material** | Throws at first use with a specific message | A 31-byte key is a configuration error, not a runtime condition |

## 6. Key management

```bash
# Generate:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
BROKER_CREDENTIAL_ENC_KEYS="k1:<base64-32-bytes>"
BROKER_CREDENTIAL_ENC_ACTIVE="k1"   # optional; defaults to the first entry
```

- 32 bytes (256 bits) from a CSPRNG, base64. Anything else is rejected at load.
- Multiple entries are comma-separated. **All** are available for decryption;
  **one** is used for encryption.
- The key must never be committed, never logged, and never stored in the same
  place as a database backup — that co-location would undo the whole control.

### Rotation

1. Add the new key: `BROKER_CREDENTIAL_ENC_KEYS="k2:<new>,k1:<old>"`.
2. Point `BROKER_CREDENTIAL_ENC_ACTIVE="k2"`. New writes use `k2`; `k1`
   ciphertext still decrypts.
3. Run `npm run credential:migrate -w @tradew/database` to re-encrypt under `k2`.
4. Remove `k1` once nothing reports `keyId: "k1"`.

Because Dhan tokens expire in 24 hours, **rotation is also achievable by doing
nothing for a day**: every credential is naturally replaced. That is worth
knowing during an incident.

## 7. Migration

The plaintext is a live credential. A migration that gets this wrong disconnects
every linked broker account.

**Chosen strategy: lazy-compatible read + explicit backfill.** Nothing
destructive runs automatically.

- **No schema migration.** The column stays `String`. Encrypted values are
  longer but not longer than Postgres `text` permits, so there is nothing to
  alter. No SQL migration file means no migration that can destroy credentials.
- **Reads accept both** from the moment this ships. A legacy row keeps working.
- **Writes are always encrypted**, from the same moment.
- **Backfill is a separate, explicit, idempotent command** —
  `packages/database/scripts/encrypt-broker-credentials.ts`, `--dry-run` by
  default. It skips rows that already carry the prefix, re-encrypts nothing
  under the active key unless asked, and **verifies each row round-trips before
  writing** — the plaintext is only overwritten by a ciphertext that has already
  been decrypted back to it.
- **Reversibility.** A `--decrypt` mode restores plaintext for a documented
  rollback. It exists because the alternative — an operator who cannot roll back
  a bad key deployment — is a worse risk than the mode itself. Its use is a
  break-glass action and it says so when it runs.

### Environment questions the operator must answer before running it

The remediation cannot answer these from the repository, and says so rather than
guessing:

| Question | How to answer |
| --- | --- |
| How many plaintext rows exist? | `SELECT count(*) FROM "BrokerCredential" WHERE "accessToken" NOT LIKE 'enc:v1:%';` — the backfill prints this in `--dry-run` |
| Is this development, staging or production? | Operator's own knowledge of the `DATABASE_URL` target |
| Migrate in place, or require reconnection? | **Both are safe.** In-place preserves working sessions. Requiring reconnection is stronger, because a token that has sat in plaintext should be considered exposed |
| Should rotation be required? | **Yes, recommended.** See §8 |
| Remove plaintext afterwards? | The backfill overwrites in place, so plaintext is gone from the live row on success. **Backups taken before this still contain plaintext** and must be handled separately |

### The recommendation, stated plainly

If this schema has ever run against a **production** database, treat every
stored token as **already exposed**: it sat in plaintext in a database and in
every backup taken since. The safe order is

1. deploy the encrypting build,
2. run the backfill,
3. **have users reconnect their broker accounts**, which mints new tokens under
   encryption and retires the ones that were exposed,
4. rotate or destroy pre-remediation backups per retention policy.

Step 3 costs each user one click and closes the exposure completely. Skipping it
leaves tokens whose plaintext may already be in a backup — and they expire
within 24 hours anyway, which makes this cheap.

## 8. Audit logging

New events, through the existing `securityLog` helper (which already redacts by
key pattern and by value shape):

| Event | Outcome | When |
| --- | --- | --- |
| `broker.credential.encrypted` | success | A credential is stored. Records `keyId`, never material |
| `broker.credential.decrypt_failed` | failure | Auth tag mismatch, unknown key, malformed envelope |
| `broker.credential.legacy_plaintext_read` | failure | A pre-migration row was read. Deliberately `failure`, so it surfaces at warn level without debug logging — a half-migrated deployment should be loud |
| `broker.credential.encryption_unavailable` | denied | A write was refused for want of a key |

## 9. Redaction

Already implemented and verified (`common/security-log.ts`): forbidden-key
matching plus a shape rule that truncates any string over 64 characters. The
existing `FORBIDDEN_KEY_PATTERN` already covers `token`, `credential`, `secret`
and `key`.

This change adds `keyId` to `ALLOWED_KEY_EXACT` — it is a label like `k1`, not
material, and it is the one field that makes a decryption failure diagnosable.
Everything else stays redacted, and the tests pin it.

## 10. Operational procedures

**First deployment.** Generate a key → set `BROKER_CREDENTIAL_ENC_KEYS` → deploy
→ `--dry-run` the backfill → run it → confirm zero legacy rows → ask users to
reconnect.

**Suspected key compromise.** Rotate (§6). Then require reconnection: a key
compromise plus a database copy equals plaintext, so the tokens are burned.

**Suspected database compromise.** Every ciphertext is safe *unless the key
leaked with it*. If the attacker had the application host, assume both.
Reconnect all users; tokens expire in 24 hours regardless.

**Lost key, no backup.** Stored credentials are unrecoverable. Users reconnect;
the feed runs on `DHAN_ACCESS_TOKEN` meanwhile. This is a real and acceptable
failure mode for a credential that expires daily — and it is why the key must be
backed up somewhere that is **not** the database backup.

## 11. What this design does not do

- It does not protect a compromised application host. The process must hold the
  key to use the credential.
- It does not encrypt the operator-local `.env` `DHAN_ACCESS_TOKEN` fallback.
- It does not add a KMS. When one exists, only `credential-crypto.ts` changes —
  which is why the crypto is one module with two exported functions.
- It does not retroactively protect backups taken before the backfill. §7 covers
  that operationally, because nothing in code can.

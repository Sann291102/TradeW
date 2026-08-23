import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Encryption at rest for broker credentials.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * `BrokerCredential.accessToken` held a live Dhan access token in PLAINTEXT.
 * The schema comment said so and said the fix needed a key-management decision
 * rather than a code edit. This module is that decision.
 *
 * A stolen database, a stolen backup or a snapshot of the disk handed an
 * attacker working brokerage credentials for every linked user. Dhan caps a
 * token at 24 hours, so the window was a day rather than forever — that sets
 * the severity, it does not make plaintext acceptable.
 *
 * ── WHY ENCRYPTION AND NOT HASHING ─────────────────────────────────────────
 *
 * Every other secret in this schema is hashed, correctly: `RefreshToken`,
 * `Otp.codeHash`, `BrokerOAuthState.stateHash`. Those are credentials TradeW
 * only ever needs to VERIFY. A broker token has to be REPLAYED to Dhan, so it
 * must be recoverable. Reversible encryption is the only option here, not a
 * weaker choice made for convenience.
 *
 * ── WHY AES-256-GCM, PER RECORD, WITH A KEYRING ────────────────────────────
 *
 * GCM is authenticated: a tampered ciphertext fails to decrypt rather than
 * decrypting to garbage that then gets presented to a broker. Per-record rather
 * than envelope encryption because envelope encryption exists to let a KMS hold
 * the wrapping key — with no KMS the wrapping key would live in the same
 * environment variable as the direct key, which is all of the complexity and
 * none of the benefit. A keyring (many keys, one active) because a single key
 * cannot be rotated without downtime or a big-bang re-encrypt.
 *
 * ── THE ASSOCIATED DATA IS NOT DECORATION ──────────────────────────────────
 *
 * Every ciphertext is bound to `v1|<provider>|<userId>` as AEAD associated
 * data. Without that binding, an attacker with database WRITE access could copy
 * the feed-default user's ciphertext into their own row and inherit that
 * credential without ever decrypting anything. With it, a moved ciphertext
 * fails authentication. This is the one property that would be easy to leave
 * out and expensive to discover missing.
 *
 * ── WHAT THIS DOES NOT PROTECT ─────────────────────────────────────────────
 *
 * A compromised application host. The process must hold the key to use the
 * credential at all. Encryption at rest defends the database and its backups,
 * and `/legal/security` must not claim more than that.
 *
 * Full design: docs/security/BROKER_CREDENTIAL_SECURITY_DESIGN.md
 * Threat model: docs/security/BROKER_CREDENTIAL_THREAT_MODEL.md
 */

/** Env var holding the keyring: `id:base64key[,id2:base64key2…]`. */
export const KEYRING_ENV = 'BROKER_CREDENTIAL_ENC_KEYS';
/** Env var naming which key id encrypts. Optional — defaults to the first. */
export const ACTIVE_KEY_ENV = 'BROKER_CREDENTIAL_ENC_ACTIVE';

/**
 * Version prefix, and the LEGACY DISCRIMINATOR.
 *
 * A stored value that does not start with this is plaintext written before this
 * module existed. That is the whole migration strategy: reads accept both, so
 * shipping this cannot disconnect a single linked broker account, and the
 * backfill script is a separate explicit action rather than an automatic
 * migration that could destroy credentials.
 */
const PREFIX = 'enc:v1:';

/** GCM's standard nonce length. 12 bytes, fresh per encryption, never reused. */
const IV_BYTES = 12;
/** GCM authentication tag. */
const TAG_BYTES = 16;
/** AES-256. A key of any other length is a configuration error, not a runtime condition. */
const KEY_BYTES = 32;

const ALGORITHM = 'aes-256-gcm';

export interface CredentialContext {
  /** Broker provider slug, e.g. 'dhan'. */
  provider: string;
  /** Owning user id. Binds the ciphertext to one row — see the header. */
  userId: string;
}

export class CredentialCryptoError extends Error {
  constructor(
    message: string,
    /** Stable, non-revealing code for logs and tests. Never contains material. */
    readonly code:
      | 'no_keyring'
      | 'malformed_keyring'
      | 'unknown_active_key'
      | 'malformed_envelope'
      | 'unknown_key_id'
      | 'auth_failed',
  ) {
    super(message);
    this.name = 'CredentialCryptoError';
  }
}

interface Keyring {
  keys: Map<string, Buffer>;
  activeId: string;
}

/**
 * Parsed once per process, then cached — but keyed on the raw env values, so a
 * test (or a process that reloads its environment) picks up a change instead of
 * being stuck with the first keyring it ever saw.
 */
let cache: { rawKeys: string; rawActive: string; ring: Keyring } | null = null;

function parseKeyring(rawKeys: string, rawActive: string): Keyring {
  const keys = new Map<string, Buffer>();

  for (const entry of rawKeys.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const sep = trimmed.indexOf(':');
    if (sep <= 0) {
      throw new CredentialCryptoError(
        `${KEYRING_ENV} entries must be "keyId:base64Key".`,
        'malformed_keyring',
      );
    }

    const id = trimmed.slice(0, sep).trim();
    const material = trimmed.slice(sep + 1).trim();

    // Constrained so a key id is always safe to put in a log line and can never
    // collide with the envelope's ':' separator.
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      throw new CredentialCryptoError(
        `${KEYRING_ENV} key ids must match [A-Za-z0-9_-]{1,32}.`,
        'malformed_keyring',
      );
    }
    if (keys.has(id)) {
      throw new CredentialCryptoError(`${KEYRING_ENV} repeats key id "${id}".`, 'malformed_keyring');
    }

    let key: Buffer;
    try {
      key = Buffer.from(material, 'base64');
    } catch {
      throw new CredentialCryptoError(`${KEYRING_ENV} key "${id}" is not valid base64.`, 'malformed_keyring');
    }
    if (key.length !== KEY_BYTES) {
      // The length, never the material. A 31-byte key is worth naming precisely
      // because the usual cause is a truncated copy-paste.
      throw new CredentialCryptoError(
        `${KEYRING_ENV} key "${id}" is ${key.length} bytes; AES-256 needs ${KEY_BYTES}. ` +
          `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
        'malformed_keyring',
      );
    }
    keys.set(id, key);
  }

  if (keys.size === 0) {
    throw new CredentialCryptoError(`${KEYRING_ENV} contains no usable keys.`, 'malformed_keyring');
  }

  const firstId = keys.keys().next().value as string;
  const activeId = rawActive.trim() || firstId;
  if (!keys.has(activeId)) {
    throw new CredentialCryptoError(
      `${ACTIVE_KEY_ENV}="${activeId}" names a key that is not in ${KEYRING_ENV}.`,
      'unknown_active_key',
    );
  }

  return { keys, activeId };
}

function loadKeyring(env: NodeJS.ProcessEnv = process.env): Keyring {
  const rawKeys = env[KEYRING_ENV] ?? '';
  const rawActive = env[ACTIVE_KEY_ENV] ?? '';

  if (!rawKeys.trim()) {
    throw new CredentialCryptoError(
      `${KEYRING_ENV} is not set. Broker credentials cannot be stored without it. ` +
        `Generate a key with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" ` +
        `and set ${KEYRING_ENV}="k1:<that value>".`,
      'no_keyring',
    );
  }

  if (cache && cache.rawKeys === rawKeys && cache.rawActive === rawActive) return cache.ring;
  const ring = parseKeyring(rawKeys, rawActive);
  cache = { rawKeys, rawActive, ring };
  return ring;
}

/** Whether a keyring is configured and valid. Callers use this to fail closed
 *  with a useful message rather than throwing from deep inside a write. */
export function isCredentialEncryptionConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    loadKeyring(env);
    return true;
  } catch {
    return false;
  }
}

/** True when a stored value is already an envelope produced by this module. */
export function isEncryptedCredential(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}

/** The AEAD associated data. Not stored — reconstructed from the row at decrypt,
 *  which is exactly what makes moving a ciphertext between rows fail. */
function associatedData(ctx: CredentialContext): Buffer {
  return Buffer.from(`v1|${ctx.provider}|${ctx.userId}`, 'utf8');
}

/**
 * Encrypt a broker credential for storage.
 *
 * Throws rather than falling back to plaintext when no keyring is configured.
 * That is deliberate and is the most important line in this module: a fallback
 * would recreate the vulnerability precisely when the operator believes it is
 * fixed.
 */
export function encryptCredential(
  plaintext: string,
  ctx: CredentialContext,
  env: NodeJS.ProcessEnv = process.env,
): { value: string; keyId: string } {
  if (!plaintext) throw new CredentialCryptoError('Refusing to encrypt an empty credential.', 'malformed_envelope');

  const ring = loadKeyring(env);
  const key = ring.keys.get(ring.activeId)!;
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData(ctx));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    value: [
      PREFIX + ring.activeId,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join(':'),
    keyId: ring.activeId,
  };
}

export type DecryptResult =
  /** An envelope this module wrote, successfully opened. */
  | { kind: 'decrypted'; accessToken: string; keyId: string }
  /**
   * A value written before this module existed. Returned so the feed keeps
   * running on a half-migrated database — and flagged so a caller can log it,
   * because a silent legacy read is how a migration looks finished when it is
   * not.
   */
  | { kind: 'legacy-plaintext'; accessToken: string }
  /** Could not be opened. Never returns material; `code` is safe to log. */
  | { kind: 'failed'; code: CredentialCryptoError['code'] };

/**
 * Decrypt a stored credential.
 *
 * Never throws. Every failure mode is a value, because the callers are a
 * long-running feed bridge and a service method whose only sensible response to
 * "this credential cannot be opened" is to fall back rather than crash.
 */
export function decryptCredential(
  stored: string | null | undefined,
  ctx: CredentialContext,
  env: NodeJS.ProcessEnv = process.env,
): DecryptResult {
  if (!stored) return { kind: 'failed', code: 'malformed_envelope' };

  if (!isEncryptedCredential(stored)) {
    return { kind: 'legacy-plaintext', accessToken: stored };
  }

  // `enc:v1:<keyId>:<iv>:<tag>:<ct>` — split into exactly 6, so a ciphertext
  // that somehow contains ':' cannot shift the fields.
  const parts = stored.split(':');
  if (parts.length !== 6) return { kind: 'failed', code: 'malformed_envelope' };

  const [, , keyId, ivB64, tagB64, ctB64] = parts as [string, string, string, string, string, string];

  let ring: Keyring;
  try {
    ring = loadKeyring(env);
  } catch (err) {
    return {
      kind: 'failed',
      code: err instanceof CredentialCryptoError ? err.code : 'no_keyring',
    };
  }

  const key = ring.keys.get(keyId);
  if (!key) return { kind: 'failed', code: 'unknown_key_id' };

  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const ciphertext = Buffer.from(ctB64, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) {
    return { kind: 'failed', code: 'malformed_envelope' };
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(associatedData(ctx));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return { kind: 'decrypted', accessToken: plaintext, keyId };
  } catch {
    // GCM tag mismatch. Wrong key, tampered ciphertext, or a row whose
    // provider/userId no longer matches what it was encrypted against. All three
    // mean the same thing to a caller: do not use this value.
    return { kind: 'failed', code: 'auth_failed' };
  }
}

/**
 * Which key opened a stored value, without opening it.
 *
 * For the backfill and rotation scripts, which need to report "how many rows are
 * still on k1" without decrypting anything.
 */
export function credentialKeyId(stored: string | null | undefined): string | null {
  if (!isEncryptedCredential(stored)) return null;
  const parts = stored!.split(':');
  return parts.length === 6 ? parts[2]! : null;
}

/** The key id new writes will use. Throws if the keyring is unusable. */
export function activeKeyId(env: NodeJS.ProcessEnv = process.env): string {
  return loadKeyring(env).activeId;
}

/**
 * Exported for tests only.
 *
 * `timingSafeEqual` is imported and re-exported here rather than used above
 * because nothing in this module compares secrets by equality — GCM's tag check
 * is the comparison, and it is constant-time inside OpenSSL. Kept visible so the
 * next reader does not add a naive `===` comparison believing none was needed.
 */
export const __internals = { PREFIX, IV_BYTES, TAG_BYTES, KEY_BYTES, associatedData, timingSafeEqual };

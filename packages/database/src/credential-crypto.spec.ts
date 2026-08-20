import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  ACTIVE_KEY_ENV,
  CredentialCryptoError,
  KEYRING_ENV,
  activeKeyId,
  credentialKeyId,
  decryptCredential,
  encryptCredential,
  isCredentialEncryptionConfigured,
  isEncryptedCredential,
} from './credential-crypto';

/**
 * The at-rest format for broker credentials.
 *
 * Every assertion here corresponds to a way a live brokerage token could leak
 * or be misused, not to an implementation detail:
 *
 *  · "never persisted in the clear" is the finding this module exists to fix.
 *  · "a wrong key cannot decrypt" is what makes a stolen database useless.
 *  · "a ciphertext cannot be moved between rows" is the AEAD binding — the
 *    property that is easy to omit and expensive to discover missing, because
 *    without it an attacker with DB write access inherits the feed-default
 *    user's credential without decrypting anything.
 *  · "legacy plaintext is recognised" is what makes deploying this safe on a
 *    database that already holds unencrypted tokens.
 */

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.REAL-LOOKING-DHAN-ACCESS-TOKEN.signature';
const CTX = { provider: 'dhan', userId: 'user-alice' };

const saved = { keys: process.env[KEYRING_ENV], active: process.env[ACTIVE_KEY_ENV] };

beforeEach(() => {
  process.env[KEYRING_ENV] = `k1:${KEY_A}`;
  delete process.env[ACTIVE_KEY_ENV];
});

afterEach(() => {
  if (saved.keys === undefined) delete process.env[KEYRING_ENV];
  else process.env[KEYRING_ENV] = saved.keys;
  if (saved.active === undefined) delete process.env[ACTIVE_KEY_ENV];
  else process.env[ACTIVE_KEY_ENV] = saved.active;
});

describe('storage format', () => {
  it('round-trips a credential', () => {
    const { value } = encryptCredential(TOKEN, CTX);
    const opened = decryptCredential(value, CTX);
    expect(opened).toEqual({ kind: 'decrypted', accessToken: TOKEN, keyId: 'k1' });
  });

  it('never persists the credential in the clear', () => {
    const { value } = encryptCredential(TOKEN, CTX);
    // The whole finding, as an assertion: no substring of the stored value is
    // the token, and no recognisable fragment of it survives.
    expect(value).not.toContain(TOKEN);
    expect(value).not.toContain('REAL-LOOKING-DHAN-ACCESS-TOKEN');
    expect(value.startsWith('enc:v1:k1:')).toBe(true);
    expect(isEncryptedCredential(value)).toBe(true);
  });

  it('uses a fresh nonce, so the same token seals differently every time', () => {
    // Reused GCM nonces are catastrophic, and identical ciphertexts would also
    // tell an observer that two users hold the same credential.
    const a = encryptCredential(TOKEN, CTX).value;
    const b = encryptCredential(TOKEN, CTX).value;
    expect(a).not.toEqual(b);
    expect(decryptCredential(a, CTX)).toMatchObject({ accessToken: TOKEN });
    expect(decryptCredential(b, CTX)).toMatchObject({ accessToken: TOKEN });
  });

  it('names its key without being opened', () => {
    const { value } = encryptCredential(TOKEN, CTX);
    expect(credentialKeyId(value)).toBe('k1');
    expect(credentialKeyId('plaintext-token')).toBeNull();
  });
});

describe('a stolen database is useless without the key', () => {
  it('cannot be decrypted by a different key', () => {
    const { value } = encryptCredential(TOKEN, CTX);
    process.env[KEYRING_ENV] = `k1:${KEY_B}`; // same id, different material
    expect(decryptCredential(value, CTX)).toEqual({ kind: 'failed', code: 'auth_failed' });
  });

  it('cannot be decrypted when the key id is unknown', () => {
    const { value } = encryptCredential(TOKEN, CTX);
    process.env[KEYRING_ENV] = `k9:${KEY_B}`;
    expect(decryptCredential(value, CTX)).toEqual({ kind: 'failed', code: 'unknown_key_id' });
  });

  it('cannot be decrypted with no keyring at all', () => {
    const { value } = encryptCredential(TOKEN, CTX);
    delete process.env[KEYRING_ENV];
    expect(decryptCredential(value, CTX)).toEqual({ kind: 'failed', code: 'no_keyring' });
  });

  it('rejects a tampered ciphertext rather than returning garbage', () => {
    const { value } = encryptCredential(TOKEN, CTX);
    const parts = value.split(':');
    // Flip one character of the ciphertext body.
    const body = parts[5]!;
    parts[5] = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
    expect(decryptCredential(parts.join(':'), CTX)).toEqual({ kind: 'failed', code: 'auth_failed' });
  });

  it('rejects a truncated or malformed envelope', () => {
    expect(decryptCredential('enc:v1:k1:short', CTX).kind).toBe('failed');
    expect(decryptCredential('enc:v1:k1:AAAA:BBBB:', CTX)).toEqual({
      kind: 'failed',
      code: 'malformed_envelope',
    });
  });
});

describe('a ciphertext is bound to its row', () => {
  // The scenario: an attacker with write access to BrokerCredential copies the
  // feed-default user's ciphertext into their own row, hoping the application
  // will decrypt it for them.
  it('refuses to open under a different userId', () => {
    const { value } = encryptCredential(TOKEN, { provider: 'dhan', userId: 'user-victim' });
    const stolen = decryptCredential(value, { provider: 'dhan', userId: 'user-attacker' });
    expect(stolen).toEqual({ kind: 'failed', code: 'auth_failed' });
  });

  it('refuses to open under a different provider', () => {
    const { value } = encryptCredential(TOKEN, { provider: 'dhan', userId: 'user-alice' });
    expect(decryptCredential(value, { provider: 'zerodha', userId: 'user-alice' })).toEqual({
      kind: 'failed',
      code: 'auth_failed',
    });
  });
});

describe('legacy plaintext', () => {
  it('is recognised and returned, so deploying this disconnects nobody', () => {
    // A row written before encryption shipped.
    expect(decryptCredential('RAW-DHAN-TOKEN', CTX)).toEqual({
      kind: 'legacy-plaintext',
      accessToken: 'RAW-DHAN-TOKEN',
    });
    expect(isEncryptedCredential('RAW-DHAN-TOKEN')).toBe(false);
  });

  it('is distinguishable from an empty column', () => {
    expect(decryptCredential(null, CTX).kind).toBe('failed');
    expect(decryptCredential('', CTX).kind).toBe('failed');
  });
});

describe('rotation', () => {
  it('decrypts under an old key while encrypting under the new one', () => {
    const oldValue = encryptCredential(TOKEN, CTX).value;

    process.env[KEYRING_ENV] = `k2:${KEY_B},k1:${KEY_A}`;
    process.env[ACTIVE_KEY_ENV] = 'k2';

    expect(activeKeyId()).toBe('k2');
    // The old ciphertext still opens...
    expect(decryptCredential(oldValue, CTX)).toMatchObject({ accessToken: TOKEN, keyId: 'k1' });
    // ...and new writes use the new key.
    expect(encryptCredential(TOKEN, CTX).keyId).toBe('k2');
  });

  it('defaults the active key to the first entry', () => {
    process.env[KEYRING_ENV] = `first:${KEY_A},second:${KEY_B}`;
    expect(activeKeyId()).toBe('first');
  });
});

describe('key material is validated, not trusted', () => {
  it('refuses a key that is not 32 bytes', () => {
    process.env[KEYRING_ENV] = `k1:${randomBytes(31).toString('base64')}`;
    expect(isCredentialEncryptionConfigured()).toBe(false);
    expect(() => encryptCredential(TOKEN, CTX)).toThrow(CredentialCryptoError);
    // The message names the length so a truncated paste is obvious; it must not
    // echo the material.
    try {
      encryptCredential(TOKEN, CTX);
    } catch (err) {
      expect((err as Error).message).toContain('31 bytes');
      expect((err as Error).message).not.toContain(process.env[KEYRING_ENV]!.split(':')[1]);
    }
  });

  it('refuses an active key id that is not in the ring', () => {
    process.env[ACTIVE_KEY_ENV] = 'nope';
    expect(isCredentialEncryptionConfigured()).toBe(false);
    expect(() => activeKeyId()).toThrow(/nope/);
  });

  it('refuses a malformed entry and a duplicate id', () => {
    process.env[KEYRING_ENV] = 'no-colon-here';
    expect(isCredentialEncryptionConfigured()).toBe(false);
    process.env[KEYRING_ENV] = `k1:${KEY_A},k1:${KEY_B}`;
    expect(isCredentialEncryptionConfigured()).toBe(false);
  });

  it('reports an unconfigured keyring rather than silently encrypting with nothing', () => {
    delete process.env[KEYRING_ENV];
    expect(isCredentialEncryptionConfigured()).toBe(false);
    // The write path depends on this throwing — a plaintext fallback here would
    // recreate the vulnerability at the moment the operator believes it fixed.
    expect(() => encryptCredential(TOKEN, CTX)).toThrow(CredentialCryptoError);
  });

  it('refuses to seal an empty credential', () => {
    expect(() => encryptCredential('', CTX)).toThrow(CredentialCryptoError);
  });
});

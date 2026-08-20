import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { DhanAuthService } from './dhan-auth.service';
import { STATE_TTL_MS } from './oauth-state';
import { decryptCredential, KEYRING_ENV, ACTIVE_KEY_ENV } from '@tradew/database';

/**
 * Broker credentials at rest, end to end through the service.
 *
 * `credential-crypto.spec.ts` in @tradew/database proves the format. This suite
 * proves the SERVICE uses it — which is the part that can regress silently, and
 * the part that was actually wrong:
 *
 *  · what reaches Prisma is ciphertext, never the token Dhan returned;
 *  · a missing keyring REFUSES the write instead of falling back to plaintext;
 *  · the read boundary opens a sealed row, tolerates a legacy plaintext one,
 *    and falls back rather than returning a value that cannot work;
 *  · no response DTO and no log line carries the credential.
 *
 * Prisma is a hand-written stub, as in `dhan-auth.service.spec.ts` — these are
 * assertions about arguments and call order, which a stub captures exactly.
 */

const NOW = Date.now();
const KEY = randomBytes(32).toString('base64');
const PLAINTEXT_TOKEN = 'DHAN-ACCESS-TOKEN-VERY-SECRET-VALUE';

function stateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'state-1',
    userId: 'user-bob',
    provider: 'dhan',
    stateHash: 'unset',
    consentAppId: 'consent-1',
    consumedAt: null,
    expiresAt: new Date(NOW + STATE_TTL_MS),
    ...overrides,
  };
}

function harness() {
  const upsert = vi.fn(async (args: unknown) => args);
  const prisma = {
    brokerOAuthState: {
      findMany: vi.fn(async () => [stateRow()]),
      updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    brokerCredential: {
      upsert,
      findUnique: vi.fn(async () => ({
        brokerClientId: 'DHAN-BOB',
        brokerClientName: 'Bob',
        expiresAt: null,
        source: 'consent',
        isFeedDefault: false,
      })),
      findFirst: vi.fn(async () => null),
    },
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        accessToken: PLAINTEXT_TOKEN,
        expiryTime: new Date(NOW + 86_400_000).toISOString(),
        dhanClientId: 'DHAN-BOB',
        dhanClientName: 'Bob',
      }),
    })),
  );

  return { service: new DhanAuthService(prisma as never), prisma, upsert };
}

const saved = {
  appId: process.env.DHAN_APP_ID,
  secret: process.env.DHAN_APP_SECRET,
  client: process.env.DHAN_CLIENT_ID,
  keys: process.env[KEYRING_ENV],
  active: process.env[ACTIVE_KEY_ENV],
  envToken: process.env.DHAN_ACCESS_TOKEN,
};

beforeEach(() => {
  process.env.DHAN_APP_ID = 'app-id';
  process.env.DHAN_APP_SECRET = 'app-secret';
  process.env.DHAN_CLIENT_ID = 'client-id';
  process.env[KEYRING_ENV] = `k1:${KEY}`;
  delete process.env[ACTIVE_KEY_ENV];
  delete process.env.DHAN_ACCESS_TOKEN;
});

afterEach(() => {
  vi.unstubAllGlobals();
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore('DHAN_APP_ID', saved.appId);
  restore('DHAN_APP_SECRET', saved.secret);
  restore('DHAN_CLIENT_ID', saved.client);
  restore(KEYRING_ENV, saved.keys);
  restore(ACTIVE_KEY_ENV, saved.active);
  restore('DHAN_ACCESS_TOKEN', saved.envToken);
});

describe('the write path never persists a plaintext credential', () => {
  it('hands Prisma ciphertext, not the token Dhan returned', async () => {
    const { service, upsert } = harness();
    await service.consumeConsent({ tokenId: 'tok-1' });

    const args = upsert.mock.calls[0]![0] as {
      create: { accessToken: string; userId: string };
      update: { accessToken: string };
    };

    // THE regression this suite exists for.
    expect(args.create.accessToken).not.toBe(PLAINTEXT_TOKEN);
    expect(args.create.accessToken).not.toContain(PLAINTEXT_TOKEN);
    expect(args.update.accessToken).not.toContain(PLAINTEXT_TOKEN);
    expect(args.create.accessToken.startsWith('enc:v1:k1:')).toBe(true);

    // ...and what was stored is the credential, bound to the state row's user.
    expect(
      decryptCredential(args.create.accessToken, { provider: 'dhan', userId: 'user-bob' }),
    ).toMatchObject({ kind: 'decrypted', accessToken: PLAINTEXT_TOKEN });
  });

  it('seals against the state row’s user, so the ciphertext is useless in another row', async () => {
    const { service, upsert } = harness();
    await service.consumeConsent({ tokenId: 'tok-1' });
    const stored = (upsert.mock.calls[0]![0] as { create: { accessToken: string } }).create.accessToken;

    expect(
      decryptCredential(stored, { provider: 'dhan', userId: 'user-attacker' }),
    ).toEqual({ kind: 'failed', code: 'auth_failed' });
  });

  it('FAILS CLOSED when no keyring is configured — nothing is written', async () => {
    delete process.env[KEYRING_ENV];
    const { service, upsert } = harness();

    await expect(service.consumeConsent({ tokenId: 'tok-1' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // The whole point: no row, rather than a plaintext row.
    expect(upsert).not.toHaveBeenCalled();
  });

  it('fails closed on a malformed keyring too', async () => {
    process.env[KEYRING_ENV] = `k1:${randomBytes(16).toString('base64')}`;
    const { service, upsert } = harness();

    await expect(service.consumeConsent({ tokenId: 'tok-1' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses without echoing the credential or the key in the error', async () => {
    delete process.env[KEYRING_ENV];
    const { service } = harness();

    await expect(service.consumeConsent({ tokenId: 'tok-1' })).rejects.toThrow(
      /BROKER_CREDENTIAL_ENC_KEYS/,
    );
    await expect(service.consumeConsent({ tokenId: 'tok-1' })).rejects.not.toThrow(
      new RegExp(PLAINTEXT_TOKEN),
    );
  });
});

describe('the read path opens as late as possible, and never returns garbage', () => {
  function readHarness(row: Record<string, unknown> | null) {
    const prisma = {
      brokerCredential: { findFirst: vi.fn(async () => row) },
    };
    return new DhanAuthService(prisma as never);
  }

  it('decrypts the feed-default credential', async () => {
    const sealed = (await (async () => {
      const { service, upsert } = harness();
      await service.consumeConsent({ tokenId: 'tok-1' });
      return (upsert.mock.calls[0]![0] as { create: { accessToken: string } }).create.accessToken;
    })());

    const service = readHarness({
      userId: 'user-bob',
      accessToken: sealed,
      expiresAt: new Date(NOW + 3_600_000),
      source: 'consent',
    });

    await expect(service.currentAccessToken()).resolves.toEqual({
      accessToken: PLAINTEXT_TOKEN,
      source: 'consent',
    });
  });

  it('still serves a legacy plaintext row, so deploying this disconnects nobody', async () => {
    const service = readHarness({
      userId: 'user-bob',
      accessToken: 'LEGACY-RAW-TOKEN',
      expiresAt: null,
      source: 'consent',
    });
    await expect(service.currentAccessToken()).resolves.toEqual({
      accessToken: 'LEGACY-RAW-TOKEN',
      source: 'consent',
    });
  });

  it('falls back to the env token rather than returning an unopenable value', async () => {
    const sealed = (await (async () => {
      const { service, upsert } = harness();
      await service.consumeConsent({ tokenId: 'tok-1' });
      return (upsert.mock.calls[0]![0] as { create: { accessToken: string } }).create.accessToken;
    })());

    // Key rotated away without a backfill.
    process.env[KEYRING_ENV] = `k9:${randomBytes(32).toString('base64')}`;
    process.env.DHAN_ACCESS_TOKEN = 'ENV-FALLBACK-TOKEN';

    const service = readHarness({
      userId: 'user-bob',
      accessToken: sealed,
      expiresAt: new Date(NOW + 3_600_000),
      source: 'consent',
    });

    await expect(service.currentAccessToken()).resolves.toEqual({
      accessToken: 'ENV-FALLBACK-TOKEN',
      source: 'env',
    });
  });

  it('returns null when nothing can serve a credential', async () => {
    process.env[KEYRING_ENV] = `k9:${randomBytes(32).toString('base64')}`;
    const service = readHarness({
      userId: 'user-bob',
      accessToken: 'enc:v1:k1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBB:CCCC',
      expiresAt: new Date(NOW + 3_600_000),
      source: 'consent',
    });
    await expect(service.currentAccessToken()).resolves.toBeNull();
  });
});

describe('the credential never leaves the service', () => {
  it('status() returns a fixed DTO with no token field', async () => {
    const prisma = {
      brokerCredential: {
        findUnique: vi.fn(async () => ({
          accessToken: 'enc:v1:k1:secret',
          brokerClientId: 'DHAN-BOB',
          brokerClientName: 'Bob',
          expiresAt: null,
          source: 'consent',
          isFeedDefault: false,
        })),
      },
    };
    const status = await new DhanAuthService(prisma as never).status('user-bob');

    expect(Object.keys(status).sort()).toEqual([
      'brokerClientId',
      'brokerClientName',
      'connected',
      'expired',
      'expiresAt',
      'isFeedDefault',
      'source',
    ]);
    expect(JSON.stringify(status)).not.toContain('enc:v1');
  });

  it('listCredentials() excludes the column at the QUERY level, not afterwards', async () => {
    // The parameter is declared so the mock's call tuple types as `[unknown]`
    // rather than `[]` — otherwise reading `mock.calls[0][0]` does not
    // typecheck. Same reason as the note in dhan-auth.service.spec.ts.
    const findMany = vi.fn(async (_args: unknown) => []);
    const prisma = { brokerCredential: { findMany } };
    await new DhanAuthService(prisma as never).listCredentials();

    const select = (findMany.mock.calls[0]![0] as { select: Record<string, boolean> }).select;
    // Filtering after the fact would still pull the secret into process memory
    // and into any query log. It must never be selected.
    expect(select.accessToken).toBeUndefined();
    expect(Object.keys(select).sort()).toEqual([
      'brokerClientId',
      'expiresAt',
      'isFeedDefault',
      'source',
      'userId',
    ]);
  });
});

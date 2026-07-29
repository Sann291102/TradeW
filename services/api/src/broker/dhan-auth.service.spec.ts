import { BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DhanAuthService } from './dhan-auth.service';
import { createState, STATE_TTL_MS } from './oauth-state';

/**
 * `consumeConsent` — the single-use claim and the attribution decision.
 *
 * `oauth-state.spec.ts` covers the pure resolver. This suite covers what the
 * resolver cannot: that the state is claimed by a CONDITIONAL update, that the
 * claim happens BEFORE the token exchange, and that the credential is written to
 * the state row's user rather than to anything the (unauthenticated) callback
 * supplied.
 *
 * Prisma is a hand-written stub rather than a live database — these assertions
 * are about call order and arguments, which a stub captures exactly. The one
 * thing a stub cannot prove is that Postgres makes the UPDATE atomic; that is
 * asserted here as "count 0 means someone else won", which is the contract the
 * service depends on and which `WHERE id = ? AND consumedAt IS NULL` provides.
 */

const NOW = Date.now();

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

/** Records the order of every interesting call so ordering can be asserted. */
function harness(options: {
  rows: Array<Record<string, unknown>>;
  claimCount?: number;
}) {
  const calls: string[] = [];
  const upsert = vi.fn(async (args: unknown) => {
    calls.push('upsert');
    return args;
  });
  // Declares the parameter so the mock's call tuple is typed `[unknown]` rather
  // than `[]` — otherwise reading `mock.calls[0][0]` does not typecheck.
  const updateMany = vi.fn(async (_args: unknown) => {
    calls.push('claim');
    return { count: options.claimCount ?? 1 };
  });

  const prisma = {
    brokerOAuthState: {
      findMany: vi.fn(async () => {
        calls.push('findMany');
        return options.rows;
      }),
      updateMany,
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
    },
  };

  const fetchMock = vi.fn(async () => {
    calls.push('exchange');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        accessToken: 'DHAN-ACCESS-TOKEN-SECRET',
        expiryTime: new Date(NOW + 86_400_000).toISOString(),
        dhanClientId: 'DHAN-BOB',
        dhanClientName: 'Bob',
      }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    service: new DhanAuthService(prisma as never),
    prisma,
    calls,
    fetchMock,
    updateMany,
    upsert,
  };
}

describe('consumeConsent', () => {
  const saved = {
    id: process.env.DHAN_APP_ID,
    secret: process.env.DHAN_APP_SECRET,
    client: process.env.DHAN_CLIENT_ID,
  };

  beforeEach(() => {
    process.env.DHAN_APP_ID = 'app-id';
    process.env.DHAN_APP_SECRET = 'app-secret';
    process.env.DHAN_CLIENT_ID = 'client-id';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.DHAN_APP_ID = saved.id ?? '';
    process.env.DHAN_APP_SECRET = saved.secret ?? '';
    process.env.DHAN_CLIENT_ID = saved.client ?? '';
  });

  it('claims the state BEFORE exchanging the token', async () => {
    const { state, stateHash } = createState();
    const h = harness({ rows: [stateRow({ stateHash })] });

    await h.service.consumeConsent({ tokenId: 'tok-1', candidateState: state });

    // Ordering is the security property: if the exchange ran first, a replayed
    // callback would burn a real token before losing the claim.
    expect(h.calls).toEqual(['findMany', 'claim', 'exchange', 'upsert']);
  });

  it('claims with a conditional update, not a blind write', async () => {
    const { state, stateHash } = createState();
    const h = harness({ rows: [stateRow({ stateHash })] });

    await h.service.consumeConsent({ tokenId: 'tok-1', candidateState: state });

    expect(h.updateMany).toHaveBeenCalledTimes(1);
    const args = h.updateMany.mock.calls[0][0] as {
      where: { id: string; consumedAt: null };
      data: { consumedAt: Date };
    };
    // `consumedAt: null` in the WHERE clause is what makes this single-use under
    // concurrency — without it two callbacks both "succeed".
    expect(args.where).toEqual({ id: 'state-1', consumedAt: null });
    expect(args.data.consumedAt).toBeInstanceOf(Date);
  });

  it('the loser of a concurrent callback exchanges nothing', async () => {
    // Both callbacks pass the resolver; Postgres awards the row to one of them
    // and the other sees count 0.
    const { state, stateHash } = createState();
    const h = harness({ rows: [stateRow({ stateHash })], claimCount: 0 });

    await expect(
      h.service.consumeConsent({ tokenId: 'tok-1', candidateState: state }),
    ).rejects.toThrow(BadRequestException);

    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.calls).toEqual(['findMany', 'claim']);
  });

  it('attributes the credential to the state row\'s user, not the request', async () => {
    const { state, stateHash } = createState();
    const h = harness({ rows: [stateRow({ stateHash, userId: 'user-bob' })] });

    await h.service.consumeConsent({ tokenId: 'tok-1', candidateState: state });

    const args = h.upsert.mock.calls[0][0] as {
      where: { provider_userId: { provider: string; userId: string } };
      create: { userId: string };
    };
    // The callback is unauthenticated. This is the assertion that a caller cannot
    // choose whose credential gets written.
    expect(args.where.provider_userId).toEqual({ provider: 'dhan', userId: 'user-bob' });
    expect(args.create.userId).toBe('user-bob');
  });

  it('refuses a replayed state without touching the claim or the exchange', async () => {
    const { state, stateHash } = createState();
    const h = harness({ rows: [stateRow({ stateHash, consumedAt: new Date(NOW - 1_000) })] });

    await expect(
      h.service.consumeConsent({ tokenId: 'tok-1', candidateState: state }),
    ).rejects.toThrow(BadRequestException);

    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an expired state', async () => {
    const { state, stateHash } = createState();
    const h = harness({ rows: [stateRow({ stateHash, expiresAt: new Date(NOW - 1) })] });

    await expect(
      h.service.consumeConsent({ tokenId: 'tok-1', candidateState: state }),
    ).rejects.toThrow(BadRequestException);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an unsolicited callback with no flow in progress', async () => {
    const h = harness({ rows: [] });

    await expect(h.service.consumeConsent({ tokenId: 'tok-1' })).rejects.toThrow(
      BadRequestException,
    );
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('refuses a forged state that matches no issued row', async () => {
    const issued = createState();
    const forged = createState();
    const h = harness({ rows: [stateRow({ stateHash: issued.stateHash })] });

    await expect(
      h.service.consumeConsent({ tokenId: 'tok-1', candidateState: forged.state }),
    ).rejects.toThrow(BadRequestException);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('never returns the access token to the caller', async () => {
    const { state, stateHash } = createState();
    const h = harness({ rows: [stateRow({ stateHash })] });

    const result = await h.service.consumeConsent({ tokenId: 'tok-1', candidateState: state });

    expect(JSON.stringify(result)).not.toContain('DHAN-ACCESS-TOKEN-SECRET');
    expect(result.userId).toBe('user-bob');
  });
});

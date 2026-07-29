import { describe, expect, it } from 'vitest';
import { __testables } from './security-log';

const { redact } = __testables;

/**
 * The logging helper's job is that a caller CANNOT leak a secret by passing it
 * to a log call. These tests are the contract for that, because the failure mode
 * — an access token in a log aggregator — is silent and permanent.
 */

describe('redact — by field name', () => {
  it('drops anything whose key names a credential', () => {
    const out = redact({
      accessToken: 'eyJhbGciOiJIUzI1NiJ9.abc',
      refreshToken: 'r-123',
      app_secret: 'shh',
      password: 'hunter2',
      authorization: 'Bearer abc',
      cookie: 'session=abc',
      apiKey: 'k-1',
      stateHash: 'deadbeef',
      nonce: 'n-1',
      signature: 'sig',
      brokerCredentialId: 'c-1',
    });
    for (const value of Object.values(out)) expect(value).toBe('[redacted]');
  });

  it('matches case-insensitively and as a substring', () => {
    const out = redact({ DhanAccessToken: 'abc', MY_SECRET_THING: 'abc', xTokenY: 'abc' });
    for (const value of Object.values(out)) expect(value).toBe('[redacted]');
  });

  it('keeps identifiers and outcomes that are not secret material', () => {
    const out = redact({
      provider: 'dhan',
      brokerClientId: 'DHAN-1234',
      reason: 'state_replayed',
      userId: 'user-alice',
      rejectedCount: 3,
      expiresAt: '2026-07-30T00:00:00.000Z',
      matchedBy: 'state',
    });
    expect(out).toEqual({
      provider: 'dhan',
      brokerClientId: 'DHAN-1234',
      reason: 'state_replayed',
      userId: 'user-alice',
      rejectedCount: 3,
      expiresAt: '2026-07-30T00:00:00.000Z',
      matchedBy: 'state',
    });
  });

  it('keeps the explicitly allowed presence flags', () => {
    // These are booleans about whether a secret was supplied — the useful signal
    // — and would otherwise be caught by the `token`/`state` name patterns.
    expect(redact({ tokenIdPresent: true, statePresent: false })).toEqual({
      tokenIdPresent: true,
      statePresent: false,
    });
  });
});

describe('redact — by value shape', () => {
  it('truncates a long opaque string even under an innocent key', () => {
    // The case where a token is passed as `value`, `message` or `reason`.
    const jwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${'x'.repeat(200)}`;
    const out = redact({ reason: jwt });
    expect(out.reason).not.toContain('x'.repeat(20));
    expect(String(out.reason)).toMatch(/^eyJhbGci…\[truncated \d+\]$/);
  });

  it('leaves short strings intact so ordinary detail stays readable', () => {
    expect(redact({ reason: 'state_expired' })).toEqual({ reason: 'state_expired' });
  });

  it('passes non-string values through unchanged', () => {
    expect(redact({ count: 7, ok: false, when: null })).toEqual({ count: 7, ok: false, when: null });
  });
});

describe('redact — end to end on a realistic broker payload', () => {
  it('cannot be made to emit an access token', () => {
    const serialized = JSON.stringify(
      redact({
        provider: 'dhan',
        brokerClientId: 'DHAN-9999',
        accessToken: 'eyJ0b2tlbiI6InNlY3JldCJ9.SUPERSECRETVALUE',
        appSecret: 'app-secret-value',
        note: 'eyJ0b2tlbiI6InNlY3JldCJ9.SUPERSECRETVALUE-padded-to-be-long-enough-to-truncate',
      }),
    );
    expect(serialized).not.toContain('SUPERSECRETVALUE');
    expect(serialized).not.toContain('app-secret-value');
    expect(serialized).toContain('DHAN-9999');
  });
});

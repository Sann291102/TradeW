import { describe, expect, it } from 'vitest';
import {
  createState,
  digestsMatch,
  hashState,
  rejectionMessage,
  resolvePendingState,
  STATE_TTL_MS,
  type PendingStateRow,
} from './oauth-state';

/**
 * The broker callback's authorization decision.
 *
 * These are the tests that would have failed against the previous
 * implementation, which had no state concept at all: every case below where a
 * callback is REFUSED was previously accepted and wrote a credential to a single
 * global row.
 */

const NOW = new Date('2026-07-29T10:00:00.000Z');
const LATER = (ms: number) => new Date(NOW.getTime() + ms);

function row(overrides: Partial<PendingStateRow> & { stateHash: string }): PendingStateRow {
  return {
    id: 'state-1',
    userId: 'user-alice',
    provider: 'dhan',
    consentAppId: 'consent-1',
    consumedAt: null,
    expiresAt: LATER(STATE_TTL_MS),
    ...overrides,
  };
}

describe('createState', () => {
  it('produces an unpredictable, URL-safe value with a matching hash', () => {
    const a = createState();
    expect(a.stateHash).toBe(hashState(a.state));
    // base64url: no +, /, or = padding, so it survives a query string untouched.
    expect(a.state).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes of entropy — the point is that it is not guessable, and not
    // Math.random.
    expect(Buffer.from(a.state, 'base64url')).toHaveLength(32);
  });

  it('never repeats', () => {
    const values = new Set(Array.from({ length: 500 }, () => createState().state));
    expect(values.size).toBe(500);
  });
});

describe('digestsMatch', () => {
  it('matches identical digests and rejects everything else', () => {
    const h = hashState('abc');
    expect(digestsMatch(h, h)).toBe(true);
    expect(digestsMatch(h, hashState('abd'))).toBe(false);
    // Length mismatch must be false, not a thrown error from timingSafeEqual.
    expect(digestsMatch(h, h.slice(0, 10))).toBe(false);
    // An empty digest must never match an empty digest — otherwise a row with a
    // blank stateHash would be satisfied by a blank candidate.
    expect(digestsMatch('', '')).toBe(false);
  });
});

describe('resolvePendingState — state supplied', () => {
  it('accepts a live state and returns the OWNING user', () => {
    const { state, stateHash } = createState();
    const result = resolvePendingState({
      rows: [row({ stateHash, userId: 'user-alice' })],
      provider: 'dhan',
      candidateState: state,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matchedBy).toBe('state');
    // The credential is attributed to this id and nothing from the request.
    expect(result.row.userId).toBe('user-alice');
  });

  it('refuses a state that was never issued (mismatch)', () => {
    const issued = createState();
    const attacker = createState();
    const result = resolvePendingState({
      rows: [row({ stateHash: issued.stateHash })],
      provider: 'dhan',
      candidateState: attacker.state,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'state_unknown' });
  });

  it('refuses a replayed state', () => {
    const { state, stateHash } = createState();
    const result = resolvePendingState({
      rows: [row({ stateHash, consumedAt: LATER(1_000) })],
      provider: 'dhan',
      candidateState: state,
      now: LATER(2_000),
    });
    expect(result).toEqual({ ok: false, reason: 'state_replayed' });
  });

  it('reports replay rather than expiry when a consumed state has also expired', () => {
    // A consumed state being presented again is the more serious signal and must
    // not be masked by the expiry check.
    const { state, stateHash } = createState();
    const result = resolvePendingState({
      rows: [row({ stateHash, consumedAt: LATER(1_000), expiresAt: LATER(2_000) })],
      provider: 'dhan',
      candidateState: state,
      now: LATER(STATE_TTL_MS * 2),
    });
    expect(result).toEqual({ ok: false, reason: 'state_replayed' });
  });

  it('refuses an expired state', () => {
    const { state, stateHash } = createState();
    const result = resolvePendingState({
      rows: [row({ stateHash, expiresAt: LATER(1_000) })],
      provider: 'dhan',
      candidateState: state,
      now: LATER(1_001),
    });
    expect(result).toEqual({ ok: false, reason: 'state_expired' });
  });

  it('treats the expiry boundary as expired', () => {
    const { state, stateHash } = createState();
    const expiresAt = LATER(5_000);
    const result = resolvePendingState({
      rows: [row({ stateHash, expiresAt })],
      provider: 'dhan',
      candidateState: state,
      now: expiresAt,
    });
    expect(result).toEqual({ ok: false, reason: 'state_expired' });
  });

  it('refuses a state issued for a different provider', () => {
    const { state, stateHash } = createState();
    const result = resolvePendingState({
      rows: [row({ stateHash, provider: 'some-other-broker' })],
      provider: 'dhan',
      candidateState: state,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'state_provider_mismatch' });
  });

  it('picks the right row when several users have flows in progress', () => {
    const alice = createState();
    const bob = createState();
    const result = resolvePendingState({
      rows: [
        row({ id: 's-a', stateHash: alice.stateHash, userId: 'user-alice' }),
        row({ id: 's-b', stateHash: bob.stateHash, userId: 'user-bob' }),
      ],
      provider: 'dhan',
      candidateState: bob.state,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Cross-user attribution is the whole risk: Bob's state must never resolve
    // to Alice's account.
    expect(result.row.userId).toBe('user-bob');
  });
});

describe('resolvePendingState — no state supplied', () => {
  it('accepts when exactly one flow is live, binding to its user', () => {
    const { stateHash } = createState();
    const result = resolvePendingState({
      rows: [row({ stateHash, userId: 'user-alice' })],
      provider: 'dhan',
      candidateState: null,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matchedBy).toBe('sole_pending_flow');
    expect(result.row.userId).toBe('user-alice');
  });

  it('refuses an unsolicited callback when no flow was started', () => {
    // This is the core exploit the previous implementation allowed: a callback
    // arriving with no corresponding user-initiated flow.
    const result = resolvePendingState({
      rows: [],
      provider: 'dhan',
      candidateState: null,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'state_unknown' });
  });

  it('refuses rather than guessing when two flows are concurrently live', () => {
    const result = resolvePendingState({
      rows: [
        row({ id: 's-a', stateHash: createState().stateHash, userId: 'user-alice' }),
        row({ id: 's-b', stateHash: createState().stateHash, userId: 'user-bob' }),
      ],
      provider: 'dhan',
      candidateState: null,
      now: NOW,
    });
    // Guessing here would hand one user's broker token to the other.
    expect(result).toEqual({ ok: false, reason: 'state_ambiguous' });
  });

  it('reports replay when the only flow was already consumed', () => {
    const result = resolvePendingState({
      rows: [row({ stateHash: createState().stateHash, consumedAt: LATER(1_000) })],
      provider: 'dhan',
      candidateState: null,
      now: LATER(2_000),
    });
    expect(result).toEqual({ ok: false, reason: 'state_replayed' });
  });

  it('ignores expired rows when counting live flows', () => {
    const live = createState();
    const result = resolvePendingState({
      rows: [
        row({ id: 'expired', stateHash: createState().stateHash, expiresAt: LATER(-1) }),
        row({ id: 'live', stateHash: live.stateHash, userId: 'user-carol' }),
      ],
      provider: 'dhan',
      candidateState: null,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.userId).toBe('user-carol');
  });

  it('ignores another provider\'s live flow when counting', () => {
    const mine = createState();
    const result = resolvePendingState({
      rows: [
        row({ id: 'other', stateHash: createState().stateHash, provider: 'other-broker' }),
        row({ id: 'mine', stateHash: mine.stateHash, userId: 'user-alice' }),
      ],
      provider: 'dhan',
      candidateState: null,
      now: NOW,
    });
    // Would be `state_ambiguous` if the provider filter were missing.
    expect(result.ok).toBe(true);
  });

  it('refuses outright when requireState is set', () => {
    const result = resolvePendingState({
      rows: [row({ stateHash: createState().stateHash })],
      provider: 'dhan',
      candidateState: null,
      now: NOW,
      requireState: true,
    });
    expect(result).toEqual({ ok: false, reason: 'state_missing' });
  });

  it('an empty string is treated as no state, not as a candidate to match', () => {
    const result = resolvePendingState({
      rows: [row({ stateHash: createState().stateHash })],
      provider: 'dhan',
      candidateState: '',
      now: NOW,
      requireState: true,
    });
    expect(result).toEqual({ ok: false, reason: 'state_missing' });
  });
});

describe('rejectionMessage', () => {
  it('gives a non-revealing message for every rejection reason', () => {
    const reasons = [
      'state_missing',
      'state_unknown',
      'state_replayed',
      'state_expired',
      'state_ambiguous',
      'state_provider_mismatch',
    ] as const;
    for (const reason of reasons) {
      const message = rejectionMessage(reason);
      expect(message.length).toBeGreaterThan(0);
      // These strings reach a URL the user's browser displays, so they must not
      // carry values or internals.
      expect(message).not.toMatch(/hash|userId|token|secret/i);
    }
  });
});

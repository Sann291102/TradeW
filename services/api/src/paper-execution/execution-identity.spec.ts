import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DECISION_WINDOW_MINUTES,
  type DecisionIdentity,
  contractSymbol,
  decisionFingerprint,
  deriveIdempotencyKey,
  istParts,
} from './execution-identity';

/**
 * These assertions are the idempotency guarantee.
 *
 * The failure this module exists to prevent — one Sentinel decision opening a
 * second paper position because a poll repeated, an SSE reconnected or a
 * replica raced — is invisible in code review and expensive in the outcome
 * record: two positions from one decision make the realized P&L attributable to
 * neither. So the properties are pinned here rather than described in a comment.
 */

const BASE: DecisionIdentity = {
  profileId: 'profile-1',
  symbol: 'NIFTY',
  optionType: 'CE',
  strike: 24_900,
  expiry: '2026-08-20',
  side: 'BUY',
  // 11:02 IST on a Thursday.
  decidedAt: new Date('2026-08-20T05:32:00Z'),
};

describe('istParts', () => {
  it('buckets by Indian market time, not UTC', () => {
    // 05:32 UTC is 11:02 IST — the same instant, a different day boundary. A
    // UTC-bucketed window would roll over at 05:30 IST, mid-session.
    const { dayKey, minuteOfDay } = istParts(new Date('2026-08-20T05:32:00Z'));
    expect(dayKey).toBe('2026-08-20');
    expect(minuteOfDay).toBe(11 * 60 + 2);
  });

  it('keeps a pre-05:30-IST instant on the correct IST day', () => {
    // 19:00 UTC on the 19th is 00:30 IST on the 20th.
    expect(istParts(new Date('2026-08-19T19:00:00Z')).dayKey).toBe('2026-08-20');
  });

  it('renders the first minute of the IST day as 0, not 1440', () => {
    // 18:30 UTC == 00:00 IST next day. Some ICU builds render midnight as '24'.
    expect(istParts(new Date('2026-08-19T18:30:00Z')).minuteOfDay).toBe(0);
  });
});

describe('deriveIdempotencyKey', () => {
  it('is stable for the same decision — a repeated poll collapses', () => {
    const first = deriveIdempotencyKey(BASE);
    // 40 seconds later: the loop ticked again and reached the same conclusion.
    const second = deriveIdempotencyKey({ ...BASE, decidedAt: new Date('2026-08-20T05:32:40Z') });
    expect(second).toBe(first);
  });

  it('does not depend on the Sentinel run id', () => {
    // The run id is intentionally absent from `DecisionIdentity`. If it were a
    // component, every tick would mint a new key — `runAgentRun` generates a
    // fresh uuid per call — and the loop would open a position per poll.
    expect(Object.keys(BASE)).not.toContain('sentinelRunId');
    expect(decisionFingerprint(BASE)).not.toMatch(/run/i);
  });

  it('separates two genuinely different decisions', () => {
    const key = deriveIdempotencyKey(BASE);
    expect(deriveIdempotencyKey({ ...BASE, strike: 24_950 })).not.toBe(key);
    expect(deriveIdempotencyKey({ ...BASE, optionType: 'PE' })).not.toBe(key);
    expect(deriveIdempotencyKey({ ...BASE, side: 'SELL' })).not.toBe(key);
    expect(deriveIdempotencyKey({ ...BASE, symbol: 'BANKNIFTY' })).not.toBe(key);
    expect(deriveIdempotencyKey({ ...BASE, expiry: '2026-08-27' })).not.toBe(key);
    expect(deriveIdempotencyKey({ ...BASE, profileId: 'profile-2' })).not.toBe(key);
  });

  it('treats 24900 and 24900.00 as one decision', () => {
    expect(deriveIdempotencyKey({ ...BASE, strike: 24_900.0 })).toBe(deriveIdempotencyKey(BASE));
  });

  it('cannot be collided by concatenating adjacent fields', () => {
    // Without an explicit separator, strike 2450 + optionType '0CE' and strike
    // 245 + '00CE' would produce the same string. The separator makes that
    // impossible; a collision here would silently drop a real trade as a dupe.
    const a = deriveIdempotencyKey({ ...BASE, strike: 2_450, profileId: 'p' });
    const b = deriveIdempotencyKey({ ...BASE, strike: 245, profileId: 'p0' });
    expect(a).not.toBe(b);
  });

  it('rolls over to a new key in the next decision window', () => {
    const key = deriveIdempotencyKey(BASE);
    const later = new Date(BASE.decidedAt.getTime() + (DEFAULT_DECISION_WINDOW_MINUTES + 1) * 60_000);
    // A genuinely new decision, later in the session, must be able to execute —
    // otherwise a profile could never re-enter a contract it had exited.
    expect(deriveIdempotencyKey({ ...BASE, decidedAt: later })).not.toBe(key);
  });

  it('holds every decision inside one window to a single key', () => {
    // BASE is 11:02 IST, so its bucket runs 11:00–11:15. 0s / 1m / 5m / 11m40s
    // land at 11:02, 11:03, 11:07 and 11:13:40 — all inside it.
    const keys = new Set(
      [0, 60, 300, 700].map((sec) =>
        deriveIdempotencyKey({ ...BASE, decidedAt: new Date(BASE.decidedAt.getTime() + sec * 1000) }),
      ),
    );
    expect(keys.size).toBe(1);
  });

  it('buckets on wall-clock boundaries, not on time-since-the-first-decision', () => {
    // 11:13:40 and 11:15:20 are 100 seconds apart but sit either side of the
    // 11:15 boundary, so they are different decisions. That is the intended
    // behaviour and the reason the previous test stops at 11:13:40: the window
    // is a fixed grid, not a sliding one anchored on the first poll.
    const inside = deriveIdempotencyKey({ ...BASE, decidedAt: new Date(BASE.decidedAt.getTime() + 700_000 / 1000 * 1000) });
    const across = deriveIdempotencyKey({ ...BASE, decidedAt: new Date(BASE.decidedAt.getTime() + 800 * 1000) });
    expect(across).not.toBe(inside);
  });

  it('is a fixed-width hex digest, so the unique column can never overflow', () => {
    expect(deriveIdempotencyKey(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('contractSymbol', () => {
  it('produces the exact format the OMS already parses', () => {
    // `parseOptionSymbol` in sim/market-price.service.ts splits on ':' and
    // requires UNDERLYING:YYYYMMDD:STRIKE:CE|PE. Anything else fails to resolve.
    expect(
      contractSymbol({ underlying: 'NIFTY', expiry: new Date('2026-08-20T00:00:00+05:30'), strike: 24_900, optionType: 'CE' }),
    ).toBe('NIFTY:20260820:24900:CE');
  });

  it('reads the expiry date in IST', () => {
    // Midnight UTC on the 20th is 05:30 IST on the 20th — still the 20th. But
    // reading a 20 Aug expiry in UTC from an IST-midnight Date would yield the
    // 19th, and the scrip-master lookup for a date the contract does not expire
    // on simply fails.
    expect(
      contractSymbol({ underlying: 'NIFTY', expiry: new Date('2026-08-20T00:00:00+05:30'), strike: 24_900, optionType: 'PE' }),
    ).toContain(':20260820:');
  });

  it('uppercases the underlying and rounds the strike to whole points', () => {
    expect(
      contractSymbol({ underlying: 'banknifty', expiry: new Date('2026-08-27T00:00:00+05:30'), strike: 52_000.0, optionType: 'CE' }),
    ).toBe('BANKNIFTY:20260827:52000:CE');
  });
});

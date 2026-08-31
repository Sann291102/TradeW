import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_QUOTE_AGE_MS, assessFreshness } from './execution-freshness';

/**
 * "Reachable" is not "alive".
 *
 * On 2026-08-17 the live-feed bridge answered every request in about 30 ms
 * while its Dhan credential had been dead for hours, so the tick map it served
 * had stopped advancing. Nothing in the system noticed, because everything was
 * asking whether the bridge responded. These assertions are about asking the
 * other question.
 */

const NOW = new Date('2026-08-30T09:30:00.000Z');

const base = {
  now: NOW,
  quotedAt: new Date(NOW.getTime() - 900),
  marketOpen: true,
  maxQuoteAgeMs: DEFAULT_MAX_QUOTE_AGE_MS,
};

describe('assessFreshness', () => {
  it('passes a feed that is ticking', () => {
    const read = assessFreshness(base);
    expect(read.ok).toBe(true);
    expect(read.ageMs).toBe(900);
    expect(read.failedCheckId).toBeNull();
  });

  it('refuses a feed that answers but has stopped ticking', () => {
    const read = assessFreshness({ ...base, quotedAt: new Date(NOW.getTime() - 4 * 60_000) });
    expect(read.ok).toBe(false);
    expect(read.failedCheckId).toBe('quote-age');
    expect(read.ageMs).toBe(240_000);
    // The wording has to name the actual failure, not "no market data".
    expect(read.reason).toContain('answering but not ticking');
  });

  it('FAILS on an unmeasurable age rather than assuming freshness', () => {
    // The single most important case: the state in which this check is most
    // valuable is exactly the state where a broken bridge produces no stamp.
    const read = assessFreshness({ ...base, quotedAt: null });
    expect(read.ok).toBe(false);
    expect(read.failedCheckId).toBe('quote-age');
    expect(read.ageMs).toBeNull();
    expect(read.reason).toContain('Refusing rather than assuming');
  });

  it('refuses when the session is closed', () => {
    const read = assessFreshness({ ...base, marketOpen: false });
    expect(read.ok).toBe(false);
    expect(read.failedCheckId).toBe('session-open');
  });

  it('reports every check whatever the outcome', () => {
    expect(assessFreshness(base).checks.map((c) => c.id)).toEqual(['quote-age', 'session-open']);
    expect(assessFreshness({ ...base, quotedAt: null, marketOpen: false }).checks).toHaveLength(2);
  });

  it('never reports a negative age when the bridge clock runs ahead', () => {
    const read = assessFreshness({ ...base, quotedAt: new Date(NOW.getTime() + 5_000) });
    expect(read.ageMs).toBe(0);
    expect(read.ok).toBe(true);
  });

  it('honours a per-profile allowance', () => {
    const twoSeconds = { ...base, quotedAt: new Date(NOW.getTime() - 3_000), maxQuoteAgeMs: 2_000 };
    expect(assessFreshness(twoSeconds).ok).toBe(false);
    expect(assessFreshness({ ...twoSeconds, maxQuoteAgeMs: 5_000 }).ok).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  MAX_RELIABILITY_ADJUSTMENT,
  MIN_CALIBRATION_SAMPLE,
  calibrationFrom,
  shouldRunDailyPass,
} from './adaptive-calibration.service';

/** A UTC instant for a given IST wall-clock time. IST is UTC+5:30. */
function ist(dateIso: string, hour: number, minute = 0): Date {
  return new Date(Date.parse(`${dateIso}T00:00:00Z`) + (hour * 60 + minute - 330) * 60_000);
}

describe('shouldRunDailyPass — the schedule', () => {
  // 2026-08-06 is a Thursday.
  const DAY = '2026-08-06';

  it('runs after the close when it has not run today', () => {
    const d = shouldRunDailyPass(ist(DAY, 16, 0), null);
    expect(d.run).toBe(true);
    expect(d.istDate).toBe(DAY);
  });

  it('does not run twice in the same IST day', () => {
    const d = shouldRunDailyPass(ist(DAY, 18, 0), DAY);
    expect(d.run).toBe(false);
    expect(d.reason).toBe('already ran today');
  });

  it('runs again the next day', () => {
    expect(shouldRunDailyPass(ist('2026-08-07', 16, 0), DAY).run).toBe(true);
  });

  it('never rewrites scoring weights during the session', () => {
    // Two observations minutes apart must not be scored by different models.
    for (const hour of [10, 12, 14]) {
      const d = shouldRunDailyPass(ist(DAY, hour), null);
      expect(d.run).toBe(false);
      expect(d.reason).toBe('market is open');
    }
  });

  it('does not run before the close — today’s outcomes do not exist yet', () => {
    const d = shouldRunDailyPass(ist(DAY, 7, 0), null);
    expect(d.run).toBe(false);
    expect(d.reason).toBe('before the close');
  });

  it('does not run on a weekend or an NSE holiday', () => {
    // No session means no observations and no outcomes, so a pass here would
    // recalibrate on the previous session's sample twice. 2026-08-08 is a
    // Saturday; 2026-08-26 is Ganesh Chaturthi, a Wednesday the NSE is shut.
    for (const day of ['2026-08-08', '2026-08-26']) {
      const d = shouldRunDailyPass(ist(day, 16, 0), null);
      expect(d.run, day).toBe(false);
      expect(d.reason, day).toBe('not a trading day');
    }
  });

  it('reports the IST date it decided for, so the caller records the right day', () => {
    // 23:00 UTC on the 6th is already 04:30 IST on the 7th — recomputing the
    // date separately could disagree across the boundary.
    const d = shouldRunDailyPass(new Date('2026-08-06T23:00:00Z'), null);
    expect(d.istDate).toBe('2026-08-07');
  });
});

/**
 * `calibrationFrom` is the arithmetic that decides how much a learned track
 * record moves a strategy's confidence contribution — the number that changes
 * what a trader actually sees. It is pure and exported precisely so it can be
 * verified without a database.
 */

function bucket(successes: number, failures: number, regime = 'trending') {
  return { successes, failures, strategyId: 'orb_retest', regime };
}

describe('calibrationFrom', () => {
  it('applies no adjustment below the sample floor', () => {
    const c = calibrationFrom(bucket(4, 1));
    expect(c.sample).toBe(5);
    expect(c.successRate).toBeNull();
    expect(c.reliability).toBe(1);
    expect(c.rationale).toContain(`below the ${MIN_CALIBRATION_SAMPLE}-sample floor`);
  });

  it('reuses the Brain’s existing sample floor rather than inventing one', () => {
    // A third independently-tuned threshold would be a third answer to one
    // question, drifting apart from the other two silently.
    expect(MIN_CALIBRATION_SAMPLE).toBe(8);
  });

  it('treats a coin flip as neutral', () => {
    const c = calibrationFrom(bucket(5, 5));
    expect(c.successRate).toBe(0.5);
    expect(c.reliability).toBe(1);
  });

  it('raises reliability for a strategy that works in this regime', () => {
    const c = calibrationFrom(bucket(9, 1));
    expect(c.successRate).toBe(0.9);
    expect(c.reliability).toBeGreaterThan(1);
    expect(c.reliability).toBeLessThanOrEqual(1 + MAX_RELIABILITY_ADJUSTMENT);
  });

  it('lowers reliability for a strategy that fails in this regime', () => {
    const c = calibrationFrom(bucket(1, 9));
    expect(c.successRate).toBe(0.1);
    expect(c.reliability).toBeLessThan(1);
    expect(c.reliability).toBeGreaterThanOrEqual(1 - MAX_RELIABILITY_ADJUSTMENT);
  });

  it('caps the adjustment in both directions so one fortnight cannot rewrite the model', () => {
    const perfect = calibrationFrom(bucket(50, 0));
    const hopeless = calibrationFrom(bucket(0, 50));
    expect(perfect.reliability).toBe(Number((1 + MAX_RELIABILITY_ADJUSTMENT).toFixed(3)));
    expect(hopeless.reliability).toBe(Number((1 - MAX_RELIABILITY_ADJUSTMENT).toFixed(3)));
  });

  it('never suppresses a strategy outright, however badly it performed', () => {
    // Suppression would starve the outcome record that lets it recover — a
    // silenced strategy can never demonstrate that it stopped failing.
    expect(calibrationFrom(bucket(0, 100)).reliability).toBeGreaterThan(0);
  });

  it('separates the same strategy by regime', () => {
    // Master Plan Module 12's own example: ORB retests work in trending
    // markets and poorly in ranges. Pooling them makes the strategy read as
    // mediocre everywhere instead of good somewhere.
    const trending = calibrationFrom(bucket(9, 1, 'trending'));
    const ranging = calibrationFrom(bucket(2, 8, 'ranging'));
    expect(trending.reliability).toBeGreaterThan(1);
    expect(ranging.reliability).toBeLessThan(1);
    expect(trending.regime).toBe('trending');
    expect(ranging.regime).toBe('ranging');
  });

  it('always explains the multiplier it produced', () => {
    const c = calibrationFrom(bucket(9, 1));
    expect(c.rationale).toContain('9 of 10');
    expect(c.rationale).toContain('trending');
    expect(c.rationale).toMatch(/scaled by/);
  });

  it('handles an empty bucket without dividing by zero', () => {
    const c = calibrationFrom(bucket(0, 0));
    expect(c.sample).toBe(0);
    expect(c.reliability).toBe(1);
    expect(Number.isFinite(c.reliability)).toBe(true);
  });

  it('never emits directive language in its rationale', () => {
    for (const c of [calibrationFrom(bucket(9, 1)), calibrationFrom(bucket(1, 9)), calibrationFrom(bucket(2, 2))]) {
      expect(c.rationale).not.toMatch(/\bbuy\b|\bsell\b|\bexit\b|\bavoid\b|should/i);
    }
  });
});

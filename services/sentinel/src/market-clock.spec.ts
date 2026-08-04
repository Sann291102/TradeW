import { describe, expect, it } from 'vitest';
import {
  MARKET_CLOSE_MIN,
  MARKET_OPEN_MIN,
  SQUARE_OFF_MIN,
  isMarketOpen,
  isWithinSession,
  istDateKey,
  istMinutesOfDay,
  istTimeLabel,
  minutesToClose,
  sessionPhaseAt,
  sessionProgress,
} from './market-clock';

/**
 * IST session boundaries — the clock seven Sentinel services reason against.
 *
 * `confidence.engine`, `explain.service`, `risk-intelligence.service`,
 * `strategy-engine.service`, `market-close-analysis.service`,
 * `state-machine.service` and `timeline.engine` all import this module, and
 * `state-machine.service` seeds session state directly from `sessionPhaseAt`.
 * Nothing asserted any of it before this file.
 *
 * Dates are written as UTC instants with the IST equivalent in a comment, since
 * IST is UTC+5:30 with no DST. 2026-08-03T05:00:00Z is Monday 10:30 IST — a
 * normal mid-session weekday, used as the baseline throughout.
 *
 * Note the final `describe` block: it pins a KNOWN GAP rather than correct
 * behaviour, and says so loudly. See the comment there before changing it.
 */

/** Monday 2026-08-03, `hh:mm` IST, as a UTC instant. */
const ist = (hh: number, mm: number) =>
  new Date(Date.UTC(2026, 7, 3, hh - 5, mm - 30));

describe('IST conversion primitives', () => {
  it('formats the IST wall clock regardless of the host zone', () => {
    expect(istTimeLabel(ist(10, 30))).toBe('10:30');
    expect(istTimeLabel(new Date('2026-08-03T00:00:00Z'))).toBe('05:30'); // UTC+5:30
  });

  it('produces the IST calendar day as the session key', () => {
    expect(istDateKey(ist(10, 30))).toBe('2026-08-03');
  });

  it('rolls the session key at IST midnight, not UTC midnight', () => {
    // 18:45 UTC is already 00:15 the next day in IST — a server on UTC must
    // not file those observations under the previous trading day.
    expect(istDateKey(new Date('2026-08-03T18:45:00Z'))).toBe('2026-08-04');
    expect(istDateKey(new Date('2026-08-03T18:15:00Z'))).toBe('2026-08-03');
  });

  it('counts minutes from IST midnight', () => {
    expect(istMinutesOfDay(ist(0, 0))).toBe(0);
    expect(istMinutesOfDay(ist(9, 15))).toBe(MARKET_OPEN_MIN);
    expect(istMinutesOfDay(ist(15, 30))).toBe(MARKET_CLOSE_MIN);
  });

  it('pins the NSE session constants', () => {
    expect(MARKET_OPEN_MIN).toBe(9 * 60 + 15);
    expect(MARKET_CLOSE_MIN).toBe(15 * 60 + 30);
    expect(SQUARE_OFF_MIN).toBe(14 * 60 + 45);
  });
});

describe('isMarketOpen — time-of-day boundaries', () => {
  it('is closed before the opening bell', () => {
    expect(isMarketOpen(ist(9, 14))).toBe(false);
  });

  it('is open at exactly 09:15 — the boundary is inclusive', () => {
    expect(isMarketOpen(ist(9, 15))).toBe(true);
  });

  it('is open through the session', () => {
    expect(isMarketOpen(ist(12, 0))).toBe(true);
  });

  it('is open at exactly 15:30 — the closing boundary is inclusive too', () => {
    expect(isMarketOpen(ist(15, 30))).toBe(true);
  });

  it('is closed one minute after the bell', () => {
    expect(isMarketOpen(ist(15, 31))).toBe(false);
  });

  it('is closed overnight', () => {
    expect(isMarketOpen(ist(3, 0))).toBe(false);
    expect(isMarketOpen(ist(22, 0))).toBe(false);
  });
});

describe('sessionPhaseAt', () => {
  it('reports pre-market before the open', () => {
    expect(sessionPhaseAt(ist(8, 0))).toBe('pre-market');
    expect(sessionPhaseAt(ist(9, 14))).toBe('pre-market');
  });

  it('reports active from the open until square-off', () => {
    expect(sessionPhaseAt(ist(9, 15))).toBe('active');
    expect(sessionPhaseAt(ist(14, 44))).toBe('active');
  });

  it('reports closing from 14:45, when brokers begin intraday square-off', () => {
    expect(sessionPhaseAt(ist(14, 45))).toBe('closing');
    expect(sessionPhaseAt(ist(15, 30))).toBe('closing');
  });

  it('reports closed after the bell', () => {
    expect(sessionPhaseAt(ist(15, 31))).toBe('closed');
    expect(sessionPhaseAt(ist(23, 59))).toBe('closed');
  });

  it('never reports active while isMarketOpen is false', () => {
    // The invariant the state machine relies on: a phase of 'active' or
    // 'closing' must imply the market is open.
    for (let m = 0; m < 24 * 60; m += 7) {
      const at = ist(Math.floor(m / 60), m % 60);
      const phase = sessionPhaseAt(at);
      if (phase === 'active' || phase === 'closing') {
        expect(isMarketOpen(at)).toBe(true);
      }
    }
  });
});

describe('minutesToClose and sessionProgress', () => {
  it('counts down to the close and goes negative afterwards', () => {
    expect(minutesToClose(ist(15, 0))).toBe(30);
    expect(minutesToClose(ist(9, 15))).toBe(MARKET_CLOSE_MIN - MARKET_OPEN_MIN);
    expect(minutesToClose(ist(16, 30))).toBe(-60);
  });

  it('runs 0 to 1 across the session', () => {
    expect(sessionProgress(ist(9, 15))).toBe(0);
    expect(sessionProgress(ist(15, 30))).toBe(1);
    expect(sessionProgress(ist(12, 22))).toBeCloseTo(0.5, 2);
  });

  it('clamps outside the session rather than reporting a negative or >1 fraction', () => {
    expect(sessionProgress(ist(4, 0))).toBe(0);
    expect(sessionProgress(ist(23, 0))).toBe(1);
  });
});

describe('isWithinSession — strategy time windows', () => {
  it('treats an absent window as always in-session', () => {
    expect(isWithinSession(undefined, ist(3, 0))).toBe(true);
  });

  it('honours a well-formed window', () => {
    expect(isWithinSession('09:30-11:00', ist(10, 0))).toBe(true);
    expect(isWithinSession('09:30-11:00', ist(11, 30))).toBe(false);
    expect(isWithinSession('09:30-11:00', ist(9, 29))).toBe(false);
  });

  it('includes both endpoints', () => {
    expect(isWithinSession('09:30-11:00', ist(9, 30))).toBe(true);
    expect(isWithinSession('09:30-11:00', ist(11, 0))).toBe(true);
  });

  it('tolerates surrounding whitespace and a single-digit hour', () => {
    expect(isWithinSession('  9:30 - 11:00  ', ist(10, 0))).toBe(true);
  });

  it('fails OPEN on a malformed window, by documented design', () => {
    // market-clock.ts:75-77 states the intent: a malformed user strategy config
    // must never silently disable the strategy without explanation. Pinned so
    // the fail-open direction is a decision on the record, not an accident.
    expect(isWithinSession('garbage', ist(3, 0))).toBe(true);
    expect(isWithinSession('25:00', ist(3, 0))).toBe(true);
    expect(isWithinSession('09:30–11:00', ist(3, 0))).toBe(true); // en-dash, not hyphen
  });
});

/**
 * ⚠ KNOWN GAP — these assertions describe a DEFECT, not desired behaviour.
 *
 * `isMarketOpen` and `sessionPhaseAt` look only at the time of day. They have
 * no `getDay()` check and no holiday list, so Sentinel believes the market is
 * open at 10:30 on a Saturday, a Sunday, and on Republic Day.
 *
 * This is a documented, deliberate deferral, not an unknown bug: see
 * `services/api/src/discipline/market-calendar.ts:13` — `TODO(clock-unification)`
 * — which already owns a correct `isTradingDay` (weekend + NSE holiday aware)
 * and names this exact module as the one that should adopt it. It was left
 * alone because seven Sentinel services key off the current semantics, so
 * changing it is a behaviour change wanting its own review.
 *
 * The tests are written the way they are so the gap is impossible to forget and
 * impossible to change silently. WHEN clock-unification lands, these assertions
 * SHOULD flip from `true` to `false` — that inversion is the intended signal
 * that the fix worked, not a regression. Do not "fix" the tests to match new
 * behaviour without also deleting this block's premise.
 */
describe('KNOWN GAP: the clock is day-of-week and holiday blind', () => {
  const SATURDAY = new Date('2026-08-01T05:00:00Z'); // Sat 10:30 IST
  const SUNDAY = new Date('2026-08-02T05:00:00Z'); // Sun 10:30 IST
  const REPUBLIC_DAY = new Date('2026-01-26T05:00:00Z'); // Mon 10:30 IST, NSE closed

  it('wrongly reports the market OPEN on a Saturday', () => {
    expect(isMarketOpen(SATURDAY)).toBe(true);
    expect(sessionPhaseAt(SATURDAY)).toBe('active');
  });

  it('wrongly reports the market OPEN on a Sunday', () => {
    expect(isMarketOpen(SUNDAY)).toBe(true);
    expect(sessionPhaseAt(SUNDAY)).toBe('active');
  });

  it('wrongly reports the market OPEN on an NSE holiday', () => {
    expect(isMarketOpen(REPUBLIC_DAY)).toBe(true);
    expect(sessionPhaseAt(REPUBLIC_DAY)).toBe('active');
  });

  it('gives a weekend the same session key and progress as a trading day', () => {
    // Consequence, not cosmetics: session state is keyed by IST date, so a
    // weekend produces a full phantom session in the state machine.
    expect(istDateKey(SATURDAY)).toBe('2026-08-01');
    expect(sessionProgress(SATURDAY)).toBeGreaterThan(0);
  });
});

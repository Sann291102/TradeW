import { describe, expect, it } from 'vitest';
import {
  MARKET_CLOSE_MIN,
  MARKET_OPEN_MIN,
  SQUARE_OFF_MIN,
  isMarketOpen,
  isTradingDay,
  isWithinSession,
  istDateKey,
  istMinutesOfDay,
  istTimeLabel,
  minutesToClose,
  nonTradingReason,
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
 * Every date used by the first blocks is Monday 2026-08-03 — a real trading
 * day. That matters now: since clock unification (2026-08-16) the clock also
 * reads the NSE calendar, so a baseline on a weekend would make half these
 * assertions fail for the right reason and hide the boundary they test.
 *
 * The final `describe` block used to pin a KNOWN GAP and now pins its fix; the
 * comment there explains why the block was inverted rather than deleted.
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
 * ✅ CLOSED 2026-08-16 — the gap this block used to pin.
 *
 * These assertions previously read `expect(isMarketOpen(SATURDAY)).toBe(true)`
 * and were documented as describing a DEFECT: the clock looked only at the time
 * of day, so Sentinel believed the market was open at 10:30 on a Saturday, a
 * Sunday and on Republic Day. The block's own comment said the assertions
 * SHOULD flip from `true` to `false` when clock-unification landed, and that
 * the inversion would be the signal the fix worked rather than a regression.
 *
 * That is what happened. `market-clock.ts` now reads the NSE calendar in
 * `@tradew/market-data` (one list, shared with `services/api`), so both
 * `isMarketOpen` and `sessionPhaseAt` honour weekends and holidays. The block
 * is kept — inverted — because the direction of these particular assertions is
 * the whole point, and a deleted test cannot fail if someone reverts the gate.
 */
describe('the clock honours the NSE trading calendar', () => {
  const SATURDAY = new Date('2026-08-01T05:00:00Z'); // Sat 10:30 IST
  const SUNDAY = new Date('2026-08-02T05:00:00Z'); // Sun 10:30 IST
  const REPUBLIC_DAY = new Date('2026-01-26T05:00:00Z'); // Mon 10:30 IST, NSE closed
  const MONDAY = new Date('2026-08-03T05:00:00Z'); // Mon 10:30 IST, a normal session

  it('reports the market CLOSED on a Saturday', () => {
    expect(isMarketOpen(SATURDAY)).toBe(false);
    expect(sessionPhaseAt(SATURDAY)).toBe('closed');
    expect(isTradingDay(SATURDAY)).toBe(false);
  });

  it('reports the market CLOSED on a Sunday', () => {
    expect(isMarketOpen(SUNDAY)).toBe(false);
    expect(sessionPhaseAt(SUNDAY)).toBe('closed');
    expect(isTradingDay(SUNDAY)).toBe(false);
  });

  it('reports the market CLOSED on an NSE holiday that is a weekday', () => {
    // The case a `getDay()` check alone cannot catch, and the reason the
    // calendar had to be shared rather than reimplemented as a weekday test.
    expect(istDateKey(REPUBLIC_DAY)).toBe('2026-01-26');
    expect(isMarketOpen(REPUBLIC_DAY)).toBe(false);
    expect(sessionPhaseAt(REPUBLIC_DAY)).toBe('closed');
    expect(isTradingDay(REPUBLIC_DAY)).toBe(false);
  });

  it('still reports a normal weekday session as open', () => {
    // The other half of the gate: closing the gap must not close the market.
    expect(isMarketOpen(MONDAY)).toBe(true);
    expect(sessionPhaseAt(MONDAY)).toBe('active');
    expect(isTradingDay(MONDAY)).toBe(true);
  });

  it('names WHY a day is not a trading day', () => {
    // "Sentinel is not observing" needs a reason a trader can read, and a
    // weekend and a holiday are different sentences.
    expect(nonTradingReason(SATURDAY)).toBe('weekend');
    expect(nonTradingReason(REPUBLIC_DAY)).toBe('holiday');
    expect(nonTradingReason(MONDAY)).toBeNull();
  });

  it('is never pre-market on a non-trading day', () => {
    // PRE_MARKET seeds a session that spends the day waiting for a bell that
    // will not ring; MARKET_CLOSE is the honest seed. See sessionPhaseAt.
    expect(sessionPhaseAt(new Date('2026-08-01T02:00:00Z'))).toBe('closed'); // Sat 07:30 IST
    expect(sessionPhaseAt(new Date('2026-01-26T02:00:00Z'))).toBe('closed'); // Republic Day 07:30 IST
  });

  it('leaves the time-of-day arithmetic day-blind on purpose', () => {
    // `sessionProgress` and `minutesToClose` size things ("how far into the
    // window are we", "how long until 15:30"); they are not gates. Making them
    // calendar-aware would break `MarketWatchService.expiryFor`, which needs
    // minutes-to-close whatever day it is asked on.
    expect(sessionProgress(SATURDAY)).toBeGreaterThan(0);
    expect(istDateKey(SATURDAY)).toBe('2026-08-01');
  });
});

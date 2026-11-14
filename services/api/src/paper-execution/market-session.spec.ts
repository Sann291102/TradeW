import { describe, expect, it } from 'vitest';
import { classifyMarketSession } from './market-session';

/**
 * Dates are pinned as IST wall-clock via an explicit +05:30 offset, so the
 * assertions hold regardless of the machine's timezone. 2026-01-05 is a plain
 * trading Monday; 2026-01-03 is a Saturday; 2026-01-26 (Republic Day) and
 * 2026-08-26 (Ganesh Chaturthi) are real entries in the shared NSE calendar.
 */
const ist = (s: string) => new Date(`${s}+05:30`);

describe('classifyMarketSession', () => {
  it('is active inside the 09:15–15:30 window on a trading day', () => {
    const s = classifyMarketSession(ist('2026-01-05T10:30:00'));
    expect(s.phase).toBe('active');
    expect(s.isOpen).toBe(true);
    expect(s.isTradingDay).toBe(true);
    expect(s.minuteOfDay).toBe(10 * 60 + 30);
    expect(s.dayKey).toBe('2026-01-05');
  });

  it('opens exactly at 09:15 and closes exactly at 15:30', () => {
    expect(classifyMarketSession(ist('2026-01-05T09:15:00')).isOpen).toBe(true);
    expect(classifyMarketSession(ist('2026-01-05T15:29:00')).isOpen).toBe(true);
    // 15:30 itself is post-market — the close is exclusive.
    const close = classifyMarketSession(ist('2026-01-05T15:30:00'));
    expect(close.isOpen).toBe(false);
    expect(close.phase).toBe('post-market');
  });

  it('is pre-market before the bell', () => {
    const s = classifyMarketSession(ist('2026-01-05T09:00:00'));
    expect(s.phase).toBe('pre-market');
    expect(s.isOpen).toBe(false);
    expect(s.isTradingDay).toBe(true);
    expect(s.reason).toContain('09:15');
  });

  it('is post-market after the close', () => {
    const s = classifyMarketSession(ist('2026-01-05T16:00:00'));
    expect(s.phase).toBe('post-market');
    expect(s.isOpen).toBe(false);
    expect(s.isTradingDay).toBe(true);
  });

  it('never opens on a weekend, even during session hours', () => {
    const s = classifyMarketSession(ist('2026-01-03T10:30:00')); // Saturday
    expect(s.phase).toBe('weekend');
    expect(s.isOpen).toBe(false);
    expect(s.isTradingDay).toBe(false);
    expect(s.reason).toContain('weekend');
  });

  it('never opens on an NSE holiday, even during session hours', () => {
    const s = classifyMarketSession(ist('2026-01-26T10:30:00')); // Republic Day
    expect(s.phase).toBe('holiday');
    expect(s.isOpen).toBe(false);
    expect(s.isTradingDay).toBe(false);
    expect(s.reason).toContain('holiday');
  });

  it('treats 2026-08-26 (Ganesh Chaturthi) as a holiday — a real calendar entry', () => {
    // The date this work was authored on is itself an exchange holiday, so the
    // loop would correctly refuse to trade. Pinned so a stale calendar can never
    // silently re-open it.
    const s = classifyMarketSession(ist('2026-08-26T11:00:00'));
    expect(s.isOpen).toBe(false);
    expect(s.phase).toBe('holiday');
  });
});

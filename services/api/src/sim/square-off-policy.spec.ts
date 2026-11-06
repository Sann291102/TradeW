import { describe, expect, it } from 'vitest';
import { decideSweep, intrinsicValue, type SweepClock, type SweepPosition } from './square-off-policy';

const at = (hhmm: string, dayKey = '2026-11-10', tradingDay = true): SweepClock => {
  const [h, m] = hhmm.split(':').map(Number);
  return { dayKey, minuteOfDay: h * 60 + m, tradingDay };
};

const mis = (over: Partial<SweepPosition> = {}): SweepPosition => ({
  productType: 'MIS',
  quantity: 50,
  instrumentType: 'EQUITY',
  expiryDayKey: null,
  lastActivityDayKey: '2026-11-10',
  managedByAgent: false,
  ...over,
});

const option = (expiryDayKey: string, over: Partial<SweepPosition> = {}): SweepPosition =>
  mis({ instrumentType: 'OPTION', expiryDayKey, ...over });

describe('decideSweep — intraday session end', () => {
  it('leaves a MIS position alone before 15:15', () => {
    expect(decideSweep(mis(), at('15:14')).kind).toBe('none');
  });
  it('squares off a MIS position at 15:15', () => {
    expect(decideSweep(mis(), at('15:15'))).toEqual({ kind: 'square-off', reason: 'session-end' });
  });
  it('never touches CNC delivery', () => {
    expect(decideSweep(mis({ productType: 'CNC' }), at('15:20')).kind).toBe('none');
  });
  it('does nothing on a flat position', () => {
    expect(decideSweep(mis({ quantity: 0 }), at('15:20')).kind).toBe('none');
  });
  it('does not act on an exchange holiday', () => {
    expect(decideSweep(mis(), at('15:20', '2026-11-10', false)).kind).toBe('none');
  });
});

describe('decideSweep — carried over a previous session', () => {
  it('exits a stale MIS position once the market has opened', () => {
    expect(decideSweep(mis({ lastActivityDayKey: '2026-11-09' }), at('09:20'))).toEqual({
      kind: 'square-off',
      reason: 'carried-overnight',
    });
  });
  it('waits for the open rather than exiting against a pre-open price', () => {
    expect(decideSweep(mis({ lastActivityDayKey: '2026-11-09' }), at('09:10')).kind).toBe('none');
  });
});

describe('decideSweep — expiry day', () => {
  it('leaves an option alone on expiry morning', () => {
    expect(decideSweep(option('2026-11-10', { productType: 'NRML' }), at('11:00')).kind).toBe('none');
  });
  it('squares off an expiring option at 15:15 whatever its product type', () => {
    expect(decideSweep(option('2026-11-10', { productType: 'NRML' }), at('15:15'))).toEqual({
      kind: 'square-off',
      reason: 'expiry-day',
    });
  });
  it('still squares off between 15:15 and the close', () => {
    expect(decideSweep(option('2026-11-10'), at('15:29')).kind).toBe('square-off');
  });
  it('settles an option still open five minutes after the close', () => {
    expect(decideSweep(option('2026-11-10'), at('15:35'))).toEqual({ kind: 'settle', reason: 'expired' });
  });
  it('settles a contract whose expiry is already in the past, at any hour', () => {
    expect(decideSweep(option('2026-11-06'), at('08:00'))).toEqual({ kind: 'settle', reason: 'expired' });
  });
  it('settles an expired contract even on a non-trading day', () => {
    expect(decideSweep(option('2026-11-06'), at('11:00', '2026-11-08', false)).kind).toBe('settle');
  });
  it('does not treat a later expiry as due', () => {
    expect(decideSweep(option('2026-11-17', { productType: 'NRML' }), at('15:20')).kind).toBe('none');
  });
});

describe('decideSweep — agent-managed positions', () => {
  it('lets the agent flatten its own position first', () => {
    expect(decideSweep(mis({ managedByAgent: true }), at('15:15')).kind).toBe('none');
    expect(decideSweep(mis({ managedByAgent: true }), at('15:24')).kind).toBe('none');
  });
  it('steps in as a backstop at 15:25 if the agent has not', () => {
    expect(decideSweep(mis({ managedByAgent: true }), at('15:25')).kind).toBe('square-off');
  });
  it('settles an expired agent position without waiting for the agent', () => {
    expect(decideSweep(option('2026-11-06', { managedByAgent: true }), at('10:00')).kind).toBe('settle');
  });
});

describe('intrinsicValue', () => {
  it('values an in-the-money call as spot minus strike', () => {
    expect(intrinsicValue('CE', 24000, 24150)).toBe(150);
  });
  it('values an in-the-money put as strike minus spot', () => {
    expect(intrinsicValue('PE', 24000, 23880)).toBe(120);
  });
  it('is zero, never negative, when out of the money', () => {
    expect(intrinsicValue('CE', 24000, 23900)).toBe(0);
    expect(intrinsicValue('PE', 24000, 24100)).toBe(0);
  });
  it('refuses to value without a real underlying price or contract details', () => {
    expect(intrinsicValue('CE', 24000, 0)).toBeNull();
    expect(intrinsicValue('CE', null, 24000)).toBeNull();
    expect(intrinsicValue(null, 24000, 24000)).toBeNull();
  });
});

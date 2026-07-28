import { describe, expect, it } from 'vitest';
import {
  MIN_DWELL_MS,
  MIN_REASON_LENGTH,
  SessionLimits,
  computeBudget,
  computeOrderIntent,
  elapsedMinutesSince,
  evaluateBreach,
  issueOverrideToken,
  shouldSendTargetNotice,
  validateLimits,
  validateReason,
  verifyOverrideToken,
} from './discipline-limits';

/**
 * The rules a trader's money depends on. Every function under test is pure and
 * takes its clock as an argument, so nothing here needs fake timers, a
 * database, or a Nest context.
 */

const SECRET = 'test-signing-key';
const START = new Date('2026-07-27T04:00:00.000Z'); // 09:30 IST

function session(overrides: Partial<SessionLimits> = {}): SessionLimits {
  return {
    maxMinutes: 120,
    maxTrades: 5,
    maxLoss: 5000,
    targetProfit: null,
    startedAt: START,
    tradesTaken: 0,
    realizedPnl: 0,
    ...overrides,
  };
}

/** `START` plus n minutes. */
function at(minutes: number): Date {
  return new Date(START.getTime() + minutes * 60_000);
}

describe('evaluateBreach', () => {
  it('returns null when every limit has headroom', () => {
    expect(evaluateBreach(session({ tradesTaken: 2, realizedPnl: -1000 }), at(30))).toBeNull();
  });

  it('breaches MAX_TRADES on the count the trader set, not one past it', () => {
    // maxTrades 5 means the 6th order is the one that breaches, so the check
    // fires once tradesTaken has reached 5.
    expect(evaluateBreach(session({ tradesTaken: 4 }), at(1))).toBeNull();
    expect(evaluateBreach(session({ tradesTaken: 5 }), at(1))).toMatchObject({
      limitType: 'MAX_TRADES',
      detail: { limit: 5, current: 5 },
    });
  });

  it('breaches MAX_LOSS exactly at the limit, treating maxLoss as a magnitude', () => {
    expect(evaluateBreach(session({ realizedPnl: -4999.99 }), at(1))).toBeNull();
    expect(evaluateBreach(session({ realizedPnl: -5000 }), at(1))).toMatchObject({
      limitType: 'MAX_LOSS',
      detail: { limit: 5000, current: -5000 },
    });
  });

  it('never breaches MAX_LOSS on a profit of the same magnitude', () => {
    // A sign error here would friction a trader who is up ₹5,000.
    expect(evaluateBreach(session({ realizedPnl: 5000 }), at(1))).toBeNull();
  });

  it('breaches MAX_MINUTES once the planned session length has elapsed', () => {
    expect(evaluateBreach(session(), at(119))).toBeNull();
    expect(evaluateBreach(session(), at(120))).toMatchObject({
      limitType: 'MAX_MINUTES',
      detail: { limit: 120, current: 120 },
    });
  });

  it('reports the first breach in spec order when several are crossed at once', () => {
    const breached = session({ tradesTaken: 9, realizedPnl: -9000 });
    // trades, then loss, then time — the trader is told the one thing, not a list.
    expect(evaluateBreach(breached, at(999))?.limitType).toBe('MAX_TRADES');
    expect(evaluateBreach({ ...breached, tradesTaken: 0 }, at(999))?.limitType).toBe('MAX_LOSS');
    expect(evaluateBreach({ ...breached, tradesTaken: 0, realizedPnl: 0 }, at(999))?.limitType).toBe('MAX_MINUTES');
  });
});

describe('elapsedMinutesSince', () => {
  it('floors to whole minutes', () => {
    expect(elapsedMinutesSince(START, new Date(START.getTime() + 59_999))).toBe(0);
    expect(elapsedMinutesSince(START, new Date(START.getTime() + 60_000))).toBe(1);
  });

  it('clamps clock skew to zero rather than reporting a negative session', () => {
    expect(elapsedMinutesSince(START, new Date(START.getTime() - 600_000))).toBe(0);
  });
});

describe('computeOrderIntent', () => {
  it('treats any order with no open position as opening', () => {
    expect(computeOrderIntent(0, 'BUY', 50)).toBe('open');
    expect(computeOrderIntent(0, 'SELL', 50)).toBe('open');
  });

  it('treats adding to a position in either direction as opening', () => {
    expect(computeOrderIntent(100, 'BUY', 50)).toBe('open');
    expect(computeOrderIntent(-100, 'SELL', 50)).toBe('open');
  });

  it('treats a partial or exact close as reducing', () => {
    expect(computeOrderIntent(100, 'SELL', 50)).toBe('reduce');
    expect(computeOrderIntent(100, 'SELL', 100)).toBe('reduce');
    expect(computeOrderIntent(-100, 'BUY', 100)).toBe('reduce');
  });

  it('treats a flip as opening, because the overshoot is new exposure', () => {
    // Long 100, SELL 150 = close 100 + open 50 short. The short half is
    // exposure taken after the breach, so it must not ride the close exemption.
    expect(computeOrderIntent(100, 'SELL', 150)).toBe('open');
    expect(computeOrderIntent(-100, 'BUY', 150)).toBe('open');
  });
});

describe('validateReason', () => {
  const real =
    'I am going past my trade limit because the range broke and I want to stay engaged with the session.';

  it('accepts a written sentence at or past the minimum length', () => {
    expect(validateReason(real)).toBeNull();
    expect(real.length).toBeGreaterThanOrEqual(MIN_REASON_LENGTH);
  });

  it('rejects anything shorter than the minimum, including padded whitespace', () => {
    expect(validateReason('too short')).toBe('too_short');
    expect(validateReason('   ' + 'x'.repeat(20) + '   ')).toBe('too_short');
    expect(validateReason(undefined)).toBe('too_short');
    expect(validateReason(null)).toBe('too_short');
  });

  it('rejects a held-down key that clears the length bar', () => {
    expect(validateReason('a'.repeat(80))).toBe('low_effort');
    expect(validateReason('asdf'.repeat(20))).toBe('low_effort');
  });

  it('rejects one or two words repeated to length', () => {
    expect(validateReason('because because because because because because')).toBe('low_effort');
  });
});

describe('override tokens', () => {
  it('accepts a token presented after the mandatory dwell', () => {
    const token = issueOverrideToken('sess-1', 'MAX_LOSS', SECRET, START);
    const result = verifyOverrideToken(
      token,
      { sessionId: 'sess-1', limitType: 'MAX_LOSS' },
      SECRET,
      new Date(START.getTime() + MIN_DWELL_MS),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it('refuses a token presented too fast — the wait is enforced server-side', () => {
    // This is the whole feature: a client-only countdown is bypassable.
    const token = issueOverrideToken('sess-1', 'MAX_LOSS', SECRET, START);
    const result = verifyOverrideToken(
      token,
      { sessionId: 'sess-1', limitType: 'MAX_LOSS' },
      SECRET,
      new Date(START.getTime() + MIN_DWELL_MS - 1),
    );
    expect(result).toMatchObject({ ok: false, reason: 'too_fast' });
  });

  it('refuses a token backdated to fake the dwell', () => {
    // Forging an older issuedAt changes the signed body, so the signature
    // fails before the age is ever considered.
    const token = issueOverrideToken('sess-1', 'MAX_LOSS', SECRET, START);
    const [sessionId, limitType, , nonce, sig] = token.split('.');
    const backdated = [sessionId, limitType, String(START.getTime() - 60_000), nonce, sig].join('.');
    expect(
      verifyOverrideToken(backdated, { sessionId: 'sess-1', limitType: 'MAX_LOSS' }, SECRET, at(1)),
    ).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a token signed with a different secret', () => {
    const token = issueOverrideToken('sess-1', 'MAX_LOSS', 'other-key', START);
    expect(
      verifyOverrideToken(token, { sessionId: 'sess-1', limitType: 'MAX_LOSS' }, SECRET, at(1)),
    ).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it("refuses a token minted for another trader's session", () => {
    const token = issueOverrideToken('sess-OTHER', 'MAX_LOSS', SECRET, START);
    expect(
      verifyOverrideToken(token, { sessionId: 'sess-1', limitType: 'MAX_LOSS' }, SECRET, at(1)),
    ).toMatchObject({ ok: false, reason: 'wrong_session' });
  });

  it('refuses a token reused against a different limit', () => {
    // A reason typed for the loss limit must not clear the trade-count limit.
    const token = issueOverrideToken('sess-1', 'MAX_LOSS', SECRET, START);
    expect(
      verifyOverrideToken(token, { sessionId: 'sess-1', limitType: 'MAX_TRADES' }, SECRET, at(1)),
    ).toMatchObject({ ok: false, reason: 'wrong_limit' });
  });

  it('expires a stale token', () => {
    const token = issueOverrideToken('sess-1', 'MAX_LOSS', SECRET, START);
    expect(
      verifyOverrideToken(token, { sessionId: 'sess-1', limitType: 'MAX_LOSS' }, SECRET, at(11)),
    ).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('rejects malformed and missing tokens without throwing', () => {
    for (const bad of [undefined, null, '', 'nope', 'a.b.c.d.e.f']) {
      expect(verifyOverrideToken(bad, { sessionId: 'sess-1', limitType: 'MAX_LOSS' }, SECRET, at(1))).toMatchObject({
        ok: false,
      });
    }
  });

  it('issues a distinct nonce per token, so one reason cannot cover two orders', () => {
    // Single use is enforced by the unique index on DisciplineOverride.tokenNonce;
    // this guarantees the nonces it indexes actually differ.
    const a = issueOverrideToken('sess-1', 'MAX_LOSS', SECRET, START).split('.')[3];
    const b = issueOverrideToken('sess-1', 'MAX_LOSS', SECRET, START).split('.')[3];
    expect(a).not.toBe(b);
  });
});

describe('shouldSendTargetNotice', () => {
  it('fires once the target is reached and the notice has not gone out', () => {
    expect(
      shouldSendTargetNotice({ targetProfit: 2000, realizedPnl: 2000, targetNoticeSentAt: null }),
    ).toBe(true);
  });

  it('does not fire twice', () => {
    expect(
      shouldSendTargetNotice({ targetProfit: 2000, realizedPnl: 5000, targetNoticeSentAt: START }),
    ).toBe(false);
  });

  it('does not fire below the target, or when no target was set', () => {
    expect(shouldSendTargetNotice({ targetProfit: 2000, realizedPnl: 1999, targetNoticeSentAt: null })).toBe(false);
    expect(shouldSendTargetNotice({ targetProfit: null, realizedPnl: 99999, targetNoticeSentAt: null })).toBe(false);
  });
});

describe('computeBudget', () => {
  it('reports remaining budget against the limits set', () => {
    const budget = computeBudget(session({ tradesTaken: 2, realizedPnl: -1500 }), at(30));
    expect(budget).toMatchObject({
      elapsedMinutes: 30,
      remainingMinutes: 90,
      remainingTrades: 3,
      remainingLoss: 3500,
      breachedLimits: [],
    });
  });

  it('never reports negative remaining budget', () => {
    const budget = computeBudget(session({ tradesTaken: 12, realizedPnl: -9000 }), at(500));
    expect(budget.remainingMinutes).toBe(0);
    expect(budget.remainingTrades).toBe(0);
    expect(budget.remainingLoss).toBe(0);
  });

  it('leaves the loss budget whole on a profitable session rather than inflating it', () => {
    // A trader up ₹10,000 has their full ₹5,000 loss budget, not ₹15,000.
    expect(computeBudget(session({ realizedPnl: 10_000 }), at(10)).remainingLoss).toBe(5000);
  });

  it('lists every limit already crossed, not just the first', () => {
    // The read-only view marks all of them; only the order path stops at one.
    const budget = computeBudget(session({ tradesTaken: 5, realizedPnl: -5000 }), at(120));
    expect(budget.breachedLimits).toEqual(['MAX_TRADES', 'MAX_LOSS', 'MAX_MINUTES']);
  });

  it('reports a reached profit target without treating it as a breach', () => {
    const budget = computeBudget(session({ targetProfit: 2000, realizedPnl: 2500 }), at(10));
    expect(budget.targetReached).toBe(true);
    expect(budget.breachedLimits).toEqual([]);
  });
});

describe('validateLimits', () => {
  const valid = { maxMinutes: 120, maxTrades: 5, maxLoss: 5000 };

  it('accepts the three required limits, with or without a target', () => {
    expect(validateLimits(valid)).toBeNull();
    expect(validateLimits({ ...valid, targetProfit: 3000 })).toBeNull();
    expect(validateLimits({ ...valid, targetProfit: null })).toBeNull();
  });

  it('rejects zero and negative limits', () => {
    expect(validateLimits({ ...valid, maxTrades: 0 })).toBe('max_trades_out_of_range');
    expect(validateLimits({ ...valid, maxLoss: 0 })).toBe('max_loss_out_of_range');
    expect(validateLimits({ ...valid, maxMinutes: -30 })).toBe('max_minutes_out_of_range');
  });

  it('rejects limits so large they would mean "no limit"', () => {
    // A configured-looking session that can never breach is worse than none.
    expect(validateLimits({ ...valid, maxTrades: 999_999 })).toBe('max_trades_out_of_range');
    expect(validateLimits({ ...valid, maxMinutes: 100_000 })).toBe('max_minutes_out_of_range');
  });

  it('rejects non-integer counts and non-finite amounts', () => {
    expect(validateLimits({ ...valid, maxTrades: 2.5 })).toBe('max_trades_out_of_range');
    expect(validateLimits({ ...valid, maxLoss: Number.NaN })).toBe('max_loss_out_of_range');
    expect(validateLimits({ ...valid, targetProfit: Number.POSITIVE_INFINITY })).toBe('target_profit_out_of_range');
  });
});

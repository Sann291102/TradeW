import { describe, expect, it } from 'vitest';
import {
  describeExpiryResolution,
  displayExpiry,
  isValidFutureExpiry,
  liveExpiries,
  normaliseExpiry,
  normaliseExpiryList,
  resolveActiveExpiry,
  tradingDateIso,
} from '@tradew/types';
import { selectExpiry, selectMarket, validateWatchPair, type PairLadders } from './watchState';
import { qk } from '@/lib/query/keys';

/**
 * Regression cover for the 2026-08-19 expiry-rollover bug: the watch creator's
 * dropdown read "25 Aug" while the panel below it reported "No live chain for
 * NIFTY 18 Aug right now", because the canonical expiry was restored from
 * localStorage and only ever written when it was `null`.
 *
 * ── WHAT THESE TESTS ARE ALLOWED TO CONTAIN ────────────────────────────────
 *
 * Dates appear here as FIXTURES and nowhere else. The rule the fix is built on
 * is that no runtime path may compute or assume an expiry date — no "next
 * Tuesday", no "+7 days", no literal. A test has to name specific days to say
 * anything at all, so every date below is an input or an expectation, never a
 * default. The corresponding assertion is `resolves nothing from an empty
 * list`: with no list, there is no answer to invent.
 *
 * Every case is pinned to an explicit `currentTime`, so none of them changes
 * meaning as real time passes — the trap the previous `pickNearestExpiry` tests
 * fell into, where assertions passed only while their fixtures were still in
 * the future.
 */

/** Noon IST on the given day — comfortably clear of both midnight boundaries,
 *  so the fixture means the day it says in the zone the market trades in. */
const istNoon = (isoDate: string): number => Date.parse(`${isoDate}T12:00:00+05:30`);

describe('tradingDateIso', () => {
  it('reads the IST calendar date, not the UTC one', () => {
    // 2026-08-19 00:30 IST is 2026-08-18 19:00 UTC. The old
    // `new Date().toISOString().slice(0, 10)` returned the 18th here and would
    // therefore have offered an expired contract as live.
    expect(tradingDateIso(Date.parse('2026-08-19T00:30:00+05:30'))).toBe('2026-08-19');
    // And the pre-open session, which sits in that window every single day.
    expect(tradingDateIso(Date.parse('2026-08-19T09:00:00+05:30'))).toBe('2026-08-19');
  });

  it('does not roll early for a late-evening IST instant', () => {
    expect(tradingDateIso(Date.parse('2026-08-19T23:45:00+05:30'))).toBe('2026-08-19');
  });
});

describe('normaliseExpiry', () => {
  it('passes through canonical ISO dates', () => {
    expect(normaliseExpiry('2026-08-25')).toBe('2026-08-25');
  });

  it('reduces ISO datetimes to their date', () => {
    expect(normaliseExpiry('2026-08-25T00:00:00Z')).toBe('2026-08-25');
    expect(normaliseExpiry('2026-08-25 14:30:00')).toBe('2026-08-25');
  });

  it('accepts day-first provider formats', () => {
    expect(normaliseExpiry('25-08-2026')).toBe('2026-08-25');
    expect(normaliseExpiry('5/8/2026')).toBe('2026-08-05');
  });

  it('rejects impossible dates that merely look well-formed', () => {
    // `new Date('2026-02-30')` silently becomes 2 March. A value that rolled
    // would sort somewhere arbitrary and could be picked as "nearest".
    expect(normaliseExpiry('2026-02-30')).toBeNull();
    expect(normaliseExpiry('2026-13-01')).toBeNull();
  });

  it('rejects non-dates and non-strings', () => {
    for (const bad of ['', '   ', 'not-a-date', 'next-tuesday', null, undefined, 20260825, {}]) {
      expect(normaliseExpiry(bad)).toBeNull();
    }
  });
});

describe('normaliseExpiryList', () => {
  it('sorts chronologically, dedupes, and drops malformed entries', () => {
    expect(normaliseExpiryList(['2026-09-01', 'garbage', '2026-08-25', '25-08-2026', ''])).toEqual([
      '2026-08-25',
      '2026-09-01',
    ]);
  });

  it('treats a non-array response as no information', () => {
    expect(normaliseExpiryList(null)).toEqual([]);
    expect(normaliseExpiryList({ expiries: ['2026-08-25'] })).toEqual([]);
  });
});

describe('liveExpiries', () => {
  it('keeps an expiry through its own expiry day', () => {
    // NSE contracts trade until 15:30 IST ON the expiry date. Dropping the
    // series at midnight would roll the workspace off a chain that is still live.
    expect(liveExpiries(['2026-08-25', '2026-09-01'], '2026-08-25')).toEqual(['2026-08-25', '2026-09-01']);
  });

  it('drops the day after', () => {
    expect(liveExpiries(['2026-08-25', '2026-09-01'], '2026-08-26')).toEqual(['2026-09-01']);
  });
});

// ── The eight scenarios from the report ────────────────────────────────────

describe('resolveActiveExpiry', () => {
  /** Test 1 — normal active expiry. */
  it('resolves the current front series when nothing has expired', () => {
    const r = resolveActiveExpiry({
      symbol: 'NIFTY',
      availableExpiries: ['2026-08-18', '2026-08-25'],
      currentTime: istNoon('2026-08-17'),
    });
    expect(r.value).toBe('2026-08-18');
    expect(r.status).toBe('resolved');
    expect(r.autoRolled).toBe(false);
    expect(r.source).toBe('market_api');
  });

  /** Test 2 — expiry rollover. The API has already dropped the dead series. */
  it('resolves the next series once the previous one has gone from the list', () => {
    const r = resolveActiveExpiry({
      symbol: 'NIFTY',
      availableExpiries: ['2026-08-25', '2026-09-01'],
      currentTime: istNoon('2026-08-19'),
    });
    expect(r.value).toBe('2026-08-25');
    expect(r.display).toBe('25 Aug');
  });

  /**
   * Test 3 — stale requested expiry. THE reported bug: state restored from the
   * previous session naming a contract that has stopped trading.
   */
  it('rolls a stale requested expiry forward and says that it did', () => {
    const r = resolveActiveExpiry({
      symbol: 'NIFTY',
      availableExpiries: ['2026-08-25', '2026-09-01'],
      currentTime: istNoon('2026-08-19'),
      requestedExpiry: '2026-08-18',
    });
    expect(r.value).toBe('2026-08-25');
    expect(r.autoRolled).toBe(true);
    expect(r.rollReason).toBe('expired');
    expect(r.source).toBe('market_api');
    // The request is preserved on the result, not overwritten by the answer —
    // the client has to be able to see that its ask was not honoured.
    expect(r.requested).toBe('2026-08-18');
  });

  it('distinguishes a delisted future expiry from an expired one', () => {
    const r = resolveActiveExpiry({
      symbol: 'NIFTY',
      availableExpiries: ['2026-08-25', '2026-09-01'],
      currentTime: istNoon('2026-08-19'),
      requestedExpiry: '2026-08-27',
    });
    expect(r.value).toBe('2026-08-25');
    expect(r.rollReason).toBe('not-listed');
  });

  it('rolls a malformed request rather than passing it upstream', () => {
    const r = resolveActiveExpiry({
      symbol: 'NIFTY',
      availableExpiries: ['2026-08-25'],
      currentTime: istNoon('2026-08-19'),
      requestedExpiry: 'nearest',
    });
    expect(r.value).toBe('2026-08-25');
    expect(r.autoRolled).toBe(true);
    expect(r.rollReason).toBe('malformed');
  });

  /** Test 4 — multiple future expiries: the EARLIEST valid one wins. */
  it('picks the earliest valid expiry from a long unsorted list', () => {
    const r = resolveActiveExpiry({
      symbol: 'NIFTY',
      availableExpiries: ['2026-09-29', '2026-08-25', '2026-09-08', '2026-09-01', '2026-08-18'],
      currentTime: istNoon('2026-08-19'),
    });
    expect(r.value).toBe('2026-08-25');
    expect(r.available).toEqual(['2026-08-25', '2026-09-01', '2026-09-08', '2026-09-29']);
  });

  /** Test 5 — no valid expiry: an explicit unavailable state, never a guess. */
  it('reports unavailable rather than falling back to a past expiry', () => {
    const r = resolveActiveExpiry({
      symbol: 'NIFTY',
      availableExpiries: ['2026-08-11', '2026-08-18'],
      currentTime: istNoon('2026-08-19'),
    });
    expect(r.status).toBe('unavailable');
    expect(r.value).toBeNull();
    expect(r.display).toBe('');
    expect(r.source).toBe('none');
  });

  it('resolves nothing from an empty list', () => {
    const r = resolveActiveExpiry({
      symbol: 'NIFTY',
      availableExpiries: [],
      currentTime: istNoon('2026-08-19'),
    });
    expect(r.status).toBe('unavailable');
    expect(r.value).toBeNull();
  });

  /**
   * The rule the write-once guard was protecting, kept. Without this a manual
   * choice of a later series would be dragged back to the front month on the
   * next poll — a control that undoes itself while you watch.
   */
  it('honours a valid manual selection instead of pulling it to the nearest', () => {
    const r = resolveActiveExpiry({
      symbol: 'NIFTY',
      availableExpiries: ['2026-08-25', '2026-09-01', '2026-09-08'],
      currentTime: istNoon('2026-08-19'),
      requestedExpiry: '2026-09-01',
    });
    expect(r.value).toBe('2026-09-01');
    expect(r.autoRolled).toBe(false);
    expect(r.source).toBe('requested');
  });

  it('accepts a manual selection on its own expiry day', () => {
    const r = resolveActiveExpiry({
      symbol: 'NIFTY',
      availableExpiries: ['2026-08-25', '2026-09-01'],
      currentTime: istNoon('2026-08-25'),
      requestedExpiry: '2026-08-25',
    });
    expect(r.value).toBe('2026-08-25');
    expect(r.source).toBe('requested');
  });

  /** Test 6 — symbol change resolves that symbol's own list, independently. */
  it('resolves each symbol against its own expiry list', () => {
    const at = istNoon('2026-08-19');
    const nifty = resolveActiveExpiry({
      symbol: 'NIFTY',
      availableExpiries: ['2026-08-25', '2026-09-01'],
      currentTime: at,
    });
    // A monthly-only underlying has no weekly series at all.
    const reliance = resolveActiveExpiry({
      symbol: 'RELIANCE',
      availableExpiries: ['2026-08-27', '2026-09-24'],
      currentTime: at,
    });
    expect(nifty.value).toBe('2026-08-25');
    expect(reliance.value).toBe('2026-08-27');
    // Neither symbol's answer can be reached from the other's list, which is
    // what `selectMarket` clearing the expiry depends on being true.
    expect(nifty.available).not.toContain('2026-08-27');
  });

  /**
   * Test 7 — live rollover. The same selection, resolved either side of the
   * boundary, with the API list changing underneath a running page.
   */
  it('re-resolves when the expiry list changes while the page is running', () => {
    const beforeList = ['2026-08-18', '2026-08-25', '2026-09-01'];
    const before = resolveActiveExpiry({
      symbol: 'NIFTY',
      availableExpiries: beforeList,
      currentTime: istNoon('2026-08-18'),
      requestedExpiry: '2026-08-18',
    });
    expect(before.value).toBe('2026-08-18');
    expect(before.autoRolled).toBe(false);

    // Next morning: the same requested expiry, the list the API now returns.
    const after = resolveActiveExpiry({
      symbol: 'NIFTY',
      availableExpiries: ['2026-08-25', '2026-09-01', '2026-09-08'],
      currentTime: istNoon('2026-08-19'),
      requestedExpiry: before.value,
    });
    expect(after.value).toBe('2026-08-25');
    expect(after.autoRolled).toBe(true);
    expect(after.value).not.toBe(before.value);
  });

  it('rolls on the date alone, even if the API has not dropped the dead series yet', () => {
    // A provider that keeps an expired entry in its list for a while must not
    // be able to hold the workspace on a dead contract.
    const r = resolveActiveExpiry({
      symbol: 'NIFTY',
      availableExpiries: ['2026-08-18', '2026-08-25'],
      currentTime: istNoon('2026-08-19'),
      requestedExpiry: '2026-08-18',
    });
    expect(r.value).toBe('2026-08-25');
    expect(r.autoRolled).toBe(true);
    expect(r.available).not.toContain('2026-08-18');
  });
});

describe('isValidFutureExpiry', () => {
  const available = ['2026-08-25', '2026-09-01'];

  it('is the guard that stops an expired expiry reaching the chain request', () => {
    expect(isValidFutureExpiry('2026-08-18', available, '2026-08-19')).toBe(false);
  });

  it('rejects a future expiry the market does not list', () => {
    // Future and absent are independent; neither implies the other.
    expect(isValidFutureExpiry('2026-08-27', available, '2026-08-19')).toBe(false);
  });

  it('rejects null, empty and malformed values', () => {
    expect(isValidFutureExpiry(null, available, '2026-08-19')).toBe(false);
    expect(isValidFutureExpiry('', available, '2026-08-19')).toBe(false);
    expect(isValidFutureExpiry('soon', available, '2026-08-19')).toBe(false);
  });

  it('accepts a listed, live expiry', () => {
    expect(isValidFutureExpiry('2026-08-25', available, '2026-08-19')).toBe(true);
  });
});

describe('displayExpiry', () => {
  it('renders the label the design prints', () => {
    expect(displayExpiry('2026-08-25')).toBe('25 Aug');
    expect(displayExpiry('2026-09-01')).toBe('1 Sep');
  });

  it('renders nothing for a value that is not a date', () => {
    // An empty label is a visible gap. A wrong one reads as a real contract.
    expect(displayExpiry(null)).toBe('');
    expect(displayExpiry('nearest')).toBe('');
  });
});

/**
 * Test 8 — cache isolation. Two expiries of one symbol must not be able to
 * share a cache entry, or a rollover would be served the dead series' ladder
 * and every check downstream would pass against the wrong contract.
 */
describe('option-chain cache identity', () => {
  it('keys the chain on symbol AND expiry', () => {
    const aug18 = qk.optionChain.chain('NIFTY', '2026-08-18');
    const aug25 = qk.optionChain.chain('NIFTY', '2026-08-25');
    expect(aug18).not.toEqual(aug25);
    expect(JSON.stringify(aug18)).not.toBe(JSON.stringify(aug25));
  });

  it('keys different symbols separately for the same expiry', () => {
    expect(qk.optionChain.chain('NIFTY', '2026-08-25')).not.toEqual(
      qk.optionChain.chain('BANKNIFTY', '2026-08-25'),
    );
  });

  it('shares one entry for the same symbol and expiry', () => {
    expect(qk.optionChain.chain('NIFTY', '2026-08-25')).toEqual(qk.optionChain.chain('NIFTY', '2026-08-25'));
  });

  /**
   * The bridge's own cache key, asserted as a shape rather than by importing
   * the server (it boots a Dhan credential on import). The property under test
   * is that the key is built from the RESOLVED expiry: if it were built from
   * the requested one, an auto-rolled response would be filed under the dead
   * contract's name and served to the next caller asking for it.
   */
  it('files an auto-rolled response under the served expiry, not the requested one', () => {
    const resolution = resolveActiveExpiry({
      symbol: 'NIFTY',
      availableExpiries: ['2026-08-25'],
      currentTime: istNoon('2026-08-19'),
      requestedExpiry: '2026-08-18',
    });
    const cacheKey = `NIFTY:${resolution.value}`;
    expect(cacheKey).toBe('NIFTY:2026-08-25');
    expect(cacheKey).not.toBe('NIFTY:2026-08-18');
  });
});

// ── The chain of custody the report asked to be verified end to end ────────

describe('the canonical expiry through the watch flow', () => {
  const ladders = (expiryStrikes: number[]): PairLadders => ({
    status: 'live',
    ce: expiryStrikes.map((strike) => ({ strike, ltp: 100 })),
    pe: expiryStrikes.map((strike) => ({ strike, ltp: 100 })),
    fetchedAt: Date.now(),
  });

  it('drops both legs when the expiry rolls, because 24200 is a different contract', () => {
    const rolled = selectExpiry(
      {
        symbol: 'NIFTY',
        expiry: '2026-08-18',
        focusedSide: 'CE',
        callStrike: 24200,
        putStrike: 24200,
        callInstrument: {
          securityId: '1',
          exchangeSegment: 'NSE_FNO',
          dhanInstrument: 'OPTIDX',
          tradingSymbol: 'X',
          displayName: 'X',
          underlying: 'NIFTY',
          expiry: '2026-08-18',
          strike: 24200,
          optionType: 'CE',
          lotSize: 75,
          tickSize: 0.05,
        },
        putInstrument: null,
        underlyingOnly: false,
        selectedWatchId: null,
      },
      '2026-08-25',
    );
    expect(rolled.expiry).toBe('2026-08-25');
    expect(rolled.callStrike).toBeNull();
    expect(rolled.putStrike).toBeNull();
    // The token is what would have addressed a dead contract on the charts and
    // in the engine. It must not survive the roll.
    expect(rolled.callInstrument).toBeNull();
  });

  it('refuses to start a watch on an expired expiry', () => {
    const problems = validateWatchPair(
      {
        symbol: 'NIFTY',
        expiry: '2026-08-18',
        focusedSide: 'CE',
        callStrike: 24200,
        putStrike: 24200,
        callInstrument: null,
        putInstrument: null,
        underlyingOnly: false,
        selectedWatchId: null,
      },
      ladders([24200]),
      Date.now(),
      '2026-08-19',
    );
    expect(problems.map((p) => p.code)).toContain('expired');
  });

  it('clears the expiry on a market change so the new symbol resolves its own', () => {
    const moved = selectMarket(
      {
        symbol: 'NIFTY',
        expiry: '2026-08-25',
        focusedSide: 'CE',
        callStrike: 24200,
        putStrike: 24200,
        callInstrument: null,
        putInstrument: null,
        underlyingOnly: false,
        selectedWatchId: null,
      },
      'BANKNIFTY',
    );
    // Null, not carried and not guessed — the resolver fills it from
    // BANKNIFTY's own list on the next tick.
    expect(moved.expiry).toBeNull();
    expect(moved.callStrike).toBeNull();
  });
});

describe('describeExpiryResolution', () => {
  it('prints the fields a rollover post-mortem needs', () => {
    const line = describeExpiryResolution(
      resolveActiveExpiry({
        symbol: 'NIFTY',
        availableExpiries: ['2026-08-25', '2026-09-01'],
        currentTime: istNoon('2026-08-19'),
        requestedExpiry: '2026-08-18',
      }),
    );
    expect(line).toContain('symbol=NIFTY');
    expect(line).toContain('requested=2026-08-18');
    expect(line).toContain('available=[2026-08-25,2026-09-01]');
    expect(line).toContain('resolved=2026-08-25');
    expect(line).toContain('autoRolled=true');
    expect(line).toContain('source=market_api');
  });
});

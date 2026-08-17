import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression suite for the Sentinel half of the 2026-08-17 outage.
 *
 * The bridge answered every request with HTTP 200 and an empty payload, and THIS
 * service turned that into two false statements the user actually read:
 *
 *   "No real market data available for NIFTY (15m candles). The Dhan live-feed
 *    bridge is unreachable and no backfilled candles exist for it."
 *
 *   "NIFTY has no live option chain, so this watch will follow the underlying
 *    itself. Indices like NIFTY, BANKNIFTY, FINNIFTY and SENSEX have one."
 *
 * Both were wrong. The bridge was up and answering in ~30 ms; 1,627 NIFTY 15m
 * candles were in the table; and NIFTY's option chain was live — Dhan returned
 * 18 expiries for it when asked with a working token. What had failed was the
 * bridge's own Dhan credential, and this service discarded that fact at the
 * boundary.
 *
 * Every test below fails against the pre-fix provider. `LIVE_FEED_URL` is read at
 * module load, so the env is set before the dynamic import in `beforeEach`.
 */

const FEED = 'http://feed.test';

type Provider = import('./candle-market-data.provider').CandleMarketDataProvider;
type UnavailableError = typeof import('./candle-market-data.provider').MarketDataUnavailableError;

let CandleMarketDataProvider: new (prisma: unknown) => Provider;
let MarketDataUnavailableError: UnavailableError;

/** A Prisma double with no rows — the "nothing backfilled" baseline. */
function emptyPrisma() {
  return {
    instrument: { findUnique: vi.fn(async () => null) },
    candle: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
  };
}

/** Answers every fetch with one JSON body, and counts the calls. */
function stubFeed(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(async () => {
  vi.resetModules();
  process.env.SENTINEL_LIVE_FEED_URL = FEED;
  process.env.SENTINEL_LIVE_FEED_TIMEOUT_MS = '4000';
  const mod = await import('./candle-market-data.provider');
  CandleMarketDataProvider = mod.CandleMarketDataProvider as never;
  MarketDataUnavailableError = mod.MarketDataUnavailableError;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getCandles — the fault must reach the message, not be replaced by a guess', () => {
  const from = new Date('2026-08-12T00:00:00Z');
  const to = new Date('2026-08-17T00:00:00Z');

  it('reports the bridge’s named auth fault instead of "the bridge is unreachable"', async () => {
    // The exact body the fixed bridge returns for the outage condition.
    stubFeed({
      candles: [],
      source: 'error',
      fault: 'auth',
      error: 'Dhan /charts/intraday 401 (auth): {"errorCode":"DH-901","errorMessage":"...invalid or expired."}',
      needsOperator: true,
    });
    const provider = new CandleMarketDataProvider(emptyPrisma());

    await expect(provider.getCandles('NIFTY', '15m', from, to)).rejects.toThrow(MarketDataUnavailableError);
    const err = await provider.getCandles('NIFTY', '15m', from, to).catch((e) => e);

    // The claim that was false and must never be made again.
    expect(err.message).not.toContain('The Dhan live-feed bridge is unreachable');
    // The fact that was true and was being thrown away.
    expect(err.message).toContain('DH-901');
    expect(err.diagnosis.needsOperator).toBe(true);
  });

  it('says the stored history is STALE when rows exist outside the window', async () => {
    // 1,627 NIFTY 15m rows existed; the newest was 2026-08-11, six days before
    // the 5-day window. The old message said "no backfilled candles exist",
    // which sent an operator to run a backfill that had already run.
    stubFeed({ candles: [], source: 'error', fault: 'auth', error: 'DH-901' });
    const prisma = {
      instrument: { findUnique: vi.fn(async () => ({ id: 'inst-1' })) },
      candle: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => ({ bucketStart: new Date('2026-08-11T06:00:00Z') })),
      },
    };
    const provider = new CandleMarketDataProvider(prisma);

    const err = await provider.getCandles('NIFTY', '15m', from, to).catch((e) => e);
    expect(err.message).not.toContain('no backfilled candles exist');
    expect(err.diagnosis.storedHistory).toContain('none inside the requested window');
    expect(err.diagnosis.storedHistory).toContain('2026-08-11');
    expect(err.diagnosis.storedHistory).toContain('stale');
  });

  it('distinguishes a genuinely un-backfilled symbol from a stale backfill', async () => {
    stubFeed({ candles: [], source: 'error', fault: 'upstream', error: 'boom' });
    const prisma = {
      instrument: { findUnique: vi.fn(async () => ({ id: 'inst-1' })) },
      candle: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    };
    const provider = new CandleMarketDataProvider(prisma);
    const err = await provider.getCandles('OBSCURE', '15m', from, to).catch((e) => e);
    expect(err.diagnosis.storedHistory).toContain('no 15m rows backfilled');
  });

  it('names a timeout as a timeout — the multi-user failure mode', async () => {
    // The bridge serializes option-chain calls behind a 3.1s floor gap, so with
    // several concurrent users the later callers exceed this 4s abort. Measured:
    // 6.2s, 9.4s, 12.5s, 15.6s for the 3rd-6th concurrent caller. "Timed out"
    // points at the queue; "no data" points nowhere.
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw abort;
      }),
    );
    const provider = new CandleMarketDataProvider(emptyPrisma());
    const err = await provider.getCandles('NIFTY', '15m', from, to).catch((e) => e);
    expect(err.diagnosis.liveFeed).toContain('did not answer within 4000ms');
  });

  it('distinguishes "bridge does not cover this symbol" from a fault', async () => {
    stubFeed({ candles: [], source: 'none' });
    const provider = new CandleMarketDataProvider(emptyPrisma());
    const err = await provider.getCandles('WEIRD', '15m', from, to).catch((e) => e);
    expect(err.diagnosis.liveFeed).toContain('does not cover this symbol');
    expect(err.diagnosis.needsOperator).toBe(false);
  });

  it('still returns real candles when the bridge serves them', async () => {
    const ts = new Date('2026-08-16T05:00:00Z').getTime();
    stubFeed({
      source: 'dhan',
      candles: [{ timestamp: ts, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
    });
    const provider = new CandleMarketDataProvider(emptyPrisma());
    const candles = await provider.getCandles('NIFTY', '15m', new Date(ts - 1000), new Date(ts + 1000));
    expect(candles).toHaveLength(1);
    expect(candles[0].close).toBe(1.5);
  });
});

describe('getOptionExpiries — [] means "no options market", nothing else', () => {
  it('THROWS on a named auth fault rather than claiming no options market', async () => {
    // THE regression. Pre-fix this returned `cached?.expiries ?? []`, i.e. `[]`,
    // and `[]` is the contract's value for "this instrument has no options
    // market" — so a refused credential became a factual claim about NIFTY.
    stubFeed({ expiries: [], fault: 'auth', error: 'DH-901 token expired', needsOperator: true });
    const provider = new CandleMarketDataProvider(emptyPrisma());

    await expect(provider.getOptionExpiries('NIFTY')).rejects.toThrow(MarketDataUnavailableError);
    const err = await provider.getOptionExpiries('NIFTY').catch((e) => e);
    expect(err.diagnosis.needsOperator).toBe(true);
    expect(err.message).toContain('DH-901');
  });

  it('THROWS on a rate-limit fault — the concurrency case', async () => {
    stubFeed({ expiries: [], fault: 'rate-limit', error: 'option-chain queue is 5 deep' });
    const provider = new CandleMarketDataProvider(emptyPrisma());
    await expect(provider.getOptionExpiries('BANKNIFTY')).rejects.toThrow(MarketDataUnavailableError);
  });

  it('THROWS when the bridge cannot be reached at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const provider = new CandleMarketDataProvider(emptyPrisma());
    await expect(provider.getOptionExpiries('NIFTY')).rejects.toThrow(MarketDataUnavailableError);
  });

  it('returns [] for a clean read with no expiries — the real no-options answer', async () => {
    // Must keep working: this is how every cash-only equity and commodity
    // legitimately reports itself, and over-throwing here would break them all.
    stubFeed({ expiries: [] });
    const provider = new CandleMarketDataProvider(emptyPrisma());
    await expect(provider.getOptionExpiries('GOLD')).resolves.toEqual([]);
  });

  it('returns the sorted list on a clean read', async () => {
    stubFeed({ expiries: ['2026-09-29', '2026-08-18', '2026-08-25'] });
    const provider = new CandleMarketDataProvider(emptyPrisma());
    await expect(provider.getOptionExpiries('NIFTY')).resolves.toEqual([
      '2026-08-18',
      '2026-08-25',
      '2026-09-29',
    ]);
  });

  it('does not CACHE a fault as "no options market"', async () => {
    // The bridge cached the empty list for 5 minutes and this provider for 15,
    // so one transient rate limit removed a symbol's option chain for a quarter
    // of an hour, for every user.
    const faulting = stubFeed({ expiries: [], fault: 'auth', error: 'DH-901' });
    const provider = new CandleMarketDataProvider(emptyPrisma());
    await expect(provider.getOptionExpiries('NIFTY')).rejects.toThrow();
    expect(faulting).toHaveBeenCalledTimes(1);

    // A later good read must be believed immediately, not shadowed by a cached
    // empty list.
    stubFeed({ expiries: ['2026-08-18'] });
    await expect(provider.getOptionExpiries('NIFTY')).resolves.toEqual(['2026-08-18']);
  });

  it('serves a still-valid cached list rather than throwing, when it has one', async () => {
    // Stale-but-real beats failing: a list read 30 seconds ago is a true answer.
    stubFeed({ expiries: ['2026-08-18', '2026-08-25'] });
    const provider = new CandleMarketDataProvider(emptyPrisma());
    await provider.getOptionExpiries('NIFTY');

    stubFeed({ expiries: [], fault: 'rate-limit', error: 'throttled' });
    await expect(provider.getOptionExpiries('NIFTY')).resolves.toEqual(['2026-08-18', '2026-08-25']);
  });
});

describe('getOptionChain — absorbs an expiry fault without asserting no chain', () => {
  it('returns [] and does not throw when the expiry read faults', async () => {
    // The chain is optional context: `snapshot()` degrades the option factor to
    // "no data" rather than failing the observation. What must NOT happen is the
    // fault escaping into the observation, or being silently invisible — it is
    // logged (see the provider).
    stubFeed({ expiries: [], fault: 'auth', error: 'DH-901' });
    const provider = new CandleMarketDataProvider(emptyPrisma());
    await expect(provider.getOptionChain('NIFTY')).resolves.toEqual([]);
  });
});

describe('getOptionCandles — a refused leg is named, never a flat series', () => {
  it('reports the auth fault verbatim', async () => {
    stubFeed({ candles: [], source: 'error', fault: 'auth', error: 'DH-901', needsOperator: true });
    const provider = new CandleMarketDataProvider(emptyPrisma());
    const err = await provider
      .getOptionCandles(
        { symbol: 'NIFTY', expiry: '2026-08-18', strike: 24300, side: 'CE' },
        '15m',
        new Date('2026-08-16T00:00:00Z'),
        new Date('2026-08-17T00:00:00Z'),
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(MarketDataUnavailableError);
    expect(err.message).toContain('DH-901');
    expect(err.diagnosis.needsOperator).toBe(true);
  });
});

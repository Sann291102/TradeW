import type { Candle, MarketDataProvider } from '@tradew/types';
import { describe, expect, it } from 'vitest';
import { MarketIntelligenceService } from './market-intelligence.service';

/**
 * `snapshot(symbol, interval)` must judge the forming bar on the interval it
 * actually read, and `contracts(snapshot, interval)` must read the CE/PE legs
 * on that same interval.
 *
 * Found while porting the 2026-08-31 analysis branch: `snapshot()` gained an
 * `interval` parameter for the bar fetch but still told `composeSnapshot` the
 * clock was `SNAPSHOT_INTERVAL` (15m). A 5m bar that opened 10 minutes ago is
 * finished, but on a 15m clock it is "still forming" — so "analyse NIFTY on 5m"
 * silently dropped the newest closed bar from every measurement. The legs had
 * the same mismatch: a 5m index read against 15m premiums is the cross-clock
 * comparison `contracts()` documents as the thing it must never do.
 */

const MIN = 60_000;

function bars5m(count: number, lastOpenedMsAgo: number): Candle[] {
  const lastOpen = Date.now() - lastOpenedMsAgo;
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const t = lastOpen - (count - 1 - i) * 5 * MIN;
    const close = 24_000 + i;
    out.push({ timestamp: new Date(t), open: close - 1, high: close + 2, low: close - 2, close, volume: 1_000 + i });
  }
  return out;
}

function provider(candles: Candle[], legIntervals: string[] = []): MarketDataProvider {
  return {
    getCandles: async (_s: string, interval: string) => (interval === '1d' ? [] : candles),
    getMarketBreadth: async () => ({ advances: 1, declines: 1, unchanged: 0 }),
    getOptionChain: async () => [],
    getOptionExpiries: async () => ['2099-12-31'],
    getOptionCandles: async (_c: unknown, interval: string) => {
      legIntervals.push(interval);
      return [];
    },
  } as unknown as MarketDataProvider;
}

describe('snapshot(symbol, interval) — the forming bar is judged on the interval read', () => {
  it('keeps a 5m bar that opened 10 minutes ago: it is closed on the 5m clock', async () => {
    const candles = bars5m(60, 10 * MIN);
    const svc = new MarketIntelligenceService(provider(candles));

    const snap = await svc.snapshot('NIFTY', '5m');

    expect(snap.formingCandle).toBeNull();
    expect(snap.candles).toHaveLength(60);
    expect(snap.candles[snap.candles.length - 1].close).toBe(candles[59].close);
  });

  it('still drops a 5m bar that opened 2 minutes ago', async () => {
    const candles = bars5m(60, 2 * MIN);
    const svc = new MarketIntelligenceService(provider(candles));

    const snap = await svc.snapshot('NIFTY', '5m');

    expect(snap.formingCandle?.close).toBe(candles[59].close);
    expect(snap.candles).toHaveLength(59);
  });
});

describe('contracts(snapshot, interval) — the legs are read on the index clock', () => {
  it('reads CE and PE on the interval passed, not on SNAPSHOT_INTERVAL', async () => {
    const legIntervals: string[] = [];
    const svc = new MarketIntelligenceService(provider(bars5m(60, 10 * MIN), legIntervals));
    const snap = await svc.snapshot('NIFTY', '5m');

    const read = await svc.contracts(snap, '5m');

    expect(legIntervals).toEqual(['5m', '5m']);
    expect(read.interval).toBe('5m');
  });

  it('defaults to the engine interval, so /observe is unchanged', async () => {
    const legIntervals: string[] = [];
    const svc = new MarketIntelligenceService(provider(bars5m(60, 10 * MIN), legIntervals));
    const snap = await svc.snapshot('NIFTY');

    await svc.contracts(snap);

    expect(legIntervals).toEqual(['15m', '15m']);
  });
});

/**
 * The shadow-outcome walk: the arithmetic that turns a prediction into a
 * measurable one.
 *
 * Every case here is a way of being wrong that would flatter the brain. An
 * optimistic shadow book is worse than no shadow book, because it reads as
 * evidence — so the assertions are mostly about REFUSING to give credit.
 *
 * The service is constructed directly with a stub Prisma and stub sources: the
 * walk is pure arithmetic over bars and needs neither a database nor a network.
 */

import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { Candle } from '@tradew/types';
import { OutcomeResolverService, HORIZON_BARS } from './outcome-resolver.service';

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 9, 4, 0);

const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  timestamp: new Date(T0 + i * 15 * MIN),
  open: o,
  high: h,
  low: l,
  close: c,
  volume: 1000,
});

/** A long candidate: entry 100, stop 95 (risk 5), target 115 (3R). */
const longCandidate = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  symbol: 'BTCUSDT',
  signalBarAt: new Date(T0),
  direction: 'long',
  entry: new Prisma.Decimal(100),
  stop: new Prisma.Decimal(95),
  target: new Prisma.Decimal(115),
  ...over,
});

/** Capture what the resolver would persist, without a database. */
function harness(bars: Candle[], candidates: unknown[]) {
  const upserts: Record<string, unknown>[] = [];
  const prisma = {
    autonomousCandidate: { findMany: vi.fn().mockResolvedValue(candidates) },
    autonomousOutcome: {
      upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
        upserts.push(args.create);
        return args.create;
      }),
    },
  };
  const source = {
    id: 'stub',
    markets: ['CRYPTO'] as const,
    read: async () => ({
      symbol: 'BTCUSDT',
      interval: '15m' as const,
      candles: bars,
      lastPrice: null,
      lastDataAt: null,
      marketOpen: true,
      source: 'stub',
    }),
  };
  const service = new OutcomeResolverService(prisma as never, source as never, source as never);
  return { service, upserts };
}

const resolveOne = async (bars: Candle[], candidate = longCandidate()) => {
  const { service, upserts } = harness(bars, [candidate]);
  await service.resolvePending(10, new Date(T0 + 200 * 15 * MIN));
  return upserts[0];
};

describe('the shadow walk', () => {
  it('records a target hit at the target, with the R it implies', async () => {
    const bars = [
      bar(0, 100, 101, 99, 100), // the signal bar itself — never traded on
      bar(1, 100, 108, 99, 107),
      bar(2, 107, 116, 106, 115), // target 115 reached
    ];
    const out = await resolveOne(bars);

    expect(out.status).toBe('TARGET_HIT');
    expect(Number(out.exitPrice)).toBe(115);
    expect(Number(out.actualR)).toBeCloseTo(3, 3);
    expect(out.barsToOutcome).toBe(2);
  });

  it('records a stop hit at the stop, at −1R', async () => {
    const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 94, 96)];
    const out = await resolveOne(bars);

    expect(out.status).toBe('STOP_HIT');
    expect(Number(out.exitPrice)).toBe(95);
    expect(Number(out.actualR)).toBeCloseTo(-1, 3);
  });

  it('resolves a bar that spans BOTH levels as a stop', async () => {
    // The assumption that decides whether a losing strategy looks like a
    // winning one. Nothing in an OHLC row says which came first.
    const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 120, 90, 110)];
    const out = await resolveOne(bars);

    expect(out.status).toBe('STOP_HIT');
    expect(Number(out.actualR)).toBeCloseTo(-1, 3);
  });

  it('fills a gap THROUGH the stop at the open, not at the stop', async () => {
    // A stop is an instruction, not a guarantee, and the difference is the
    // entire risk of holding through a gap.
    const bars = [bar(0, 100, 101, 99, 100), bar(1, 88, 92, 86, 90)];
    const out = await resolveOne(bars);

    expect(out.status).toBe('STOP_HIT');
    expect(Number(out.exitPrice)).toBe(88);
    // Worse than −1R, which is the honest answer.
    expect(Number(out.actualR)).toBeLessThan(-1);
  });

  it('never acts on the signal bar itself', async () => {
    // The decision came from this bar's close, so it could not have been acted
    // on inside it. Counting it would be look-ahead.
    const bars = [bar(0, 100, 130, 90, 100)]; // spans both levels, but is the signal bar
    const out = await resolveOne(bars);
    expect(out.status).toBe('UNRESOLVED');
  });

  it('stays UNRESOLVED while the horizon is still running', async () => {
    const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 102, 99, 101)];
    const out = await resolveOne(bars);

    expect(out.status).toBe('UNRESOLVED');
    expect(out.resolvedAt).toBeNull();
  });

  it('EXPIRES only once the full horizon has actually been observed', async () => {
    const bars = [bar(0, 100, 101, 99, 100)];
    for (let i = 1; i <= HORIZON_BARS; i += 1) bars.push(bar(i, 100, 101, 99, 100));
    const out = await resolveOne(bars);

    expect(out.status).toBe('EXPIRED');
    expect(out.barsToOutcome).toBe(HORIZON_BARS);
  });
});

describe('excursions', () => {
  it('includes the resolving bar, so a target hit reports at least 3R of MFE', async () => {
    const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 116, 98, 115)];
    const out = await resolveOne(bars);

    expect(Number(out.mfeR)).toBeGreaterThanOrEqual(3);
    // And the adverse side is measured too — this trade went against first.
    expect(Number(out.maeR)).toBeLessThan(0);
  });

  it('separates a thesis that was right and badly timed from one that was wrong', async () => {
    // Stopped out, then the original target was reached. The level was right;
    // the stop placement was not — and only `wouldHaveHitTarget` can say so.
    const bars = [
      bar(0, 100, 101, 99, 100),
      bar(1, 100, 101, 94, 96), // stop
      bar(2, 96, 118, 96, 117), // …then the target
    ];
    const out = await resolveOne(bars);

    expect(out.status).toBe('STOP_HIT');
    expect(out.wouldHaveHitTarget).toBe(true);
    expect(Number(out.postExitHigh)).toBeGreaterThanOrEqual(115);
  });
});

describe('shorts', () => {
  it('mirrors every rule', async () => {
    const short = longCandidate({
      direction: 'short',
      entry: new Prisma.Decimal(100),
      stop: new Prisma.Decimal(105),
      target: new Prisma.Decimal(85),
    });
    const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 84, 86)];
    const out = await resolveOne(bars, short);

    expect(out.status).toBe('TARGET_HIT');
    expect(Number(out.exitPrice)).toBe(85);
    expect(Number(out.actualR)).toBeCloseTo(3, 3);
  });
});

describe('what it refuses to judge', () => {
  it('marks a candidate with no levels UNEVALUABLE rather than guessing', async () => {
    const noPlan = longCandidate({ entry: null, stop: null, target: null });
    const out = await resolveOne([bar(0, 100, 101, 99, 100)], noPlan);
    expect(out.status).toBe('UNEVALUABLE');
    expect(out.unevaluableReason).toBeTruthy();
  });

  it('never writes back onto the candidate', async () => {
    // The immutability guarantee: decision-time state must still say what it
    // said before the answer was known.
    const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 116, 99, 115)];
    const { service, upserts } = harness(bars, [longCandidate()]);
    await service.resolvePending(10, new Date(T0 + 200 * 15 * MIN));

    expect(upserts).toHaveLength(1);
    // Only the outcome table was touched — there is no candidate update at all
    // in this service, which is what makes the guarantee structural.
    expect(upserts[0]).toHaveProperty('candidateId', 'c1');
  });
});

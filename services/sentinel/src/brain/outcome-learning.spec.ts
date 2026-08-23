import { describe, expect, it, vi } from 'vitest';
import { OutcomeLearningService } from './outcome-learning.service';
import type { MemoryStore } from '@tradew/ai-core';
import type { MarketDataProvider } from '@tradew/types';
import type { PrismaService } from '../prisma.service';

/**
 * The outcome tagger is what turns a recorded occurrence into evidence the
 * live-performance gate can read. An untagged occurrence is invisible to
 * `StrategyIntelligenceService.baseRateFor`, so a tagger that does not run
 * silently holds every directional read back — which is why it now has its own
 * timer rather than depending on `/observe` traffic.
 *
 * `tick()` is driven directly. Nothing here waits on a timer.
 */

/** A Tuesday, 11:00 IST — inside the session. */
const TRADING = new Date('2026-08-04T05:30:00.000Z');
/** Tuesday 20:00 IST — after the close. */
const AFTER_CLOSE = new Date('2026-08-04T14:30:00.000Z');
/** The Saturday of the same week, 11:00 IST. */
const SATURDAY = new Date('2026-08-08T05:30:00.000Z');

function occurrence(id: string, priceAtDetection = 100) {
  return {
    id,
    metadata: {
      pattern: 'ema_cross',
      symbol: 'NIFTY',
      priceAtDetection,
      detectedAt: '2026-08-04T05:00:00.000Z',
      outcome: null,
    },
  };
}

function harness(opts: { rows?: ReturnType<typeof occurrence>[]; lastPrice?: number } = {}) {
  const rows = opts.rows ?? [occurrence('a')];
  const findMany = vi.fn().mockResolvedValue(rows);
  const update = vi.fn().mockResolvedValue(undefined);
  const getQuote = vi.fn().mockResolvedValue({ lastPrice: opts.lastPrice ?? 105 });

  const service = new OutcomeLearningService(
    { memoryRecord: { findMany } } as unknown as PrismaService,
    { update } as unknown as MemoryStore,
    { getQuote } as unknown as MarketDataProvider,
  );

  return { service, findMany, update, getQuote };
}

describe('the outcome-learning scheduler', () => {
  it('tags pending occurrences on a tick inside the session', async () => {
    const h = harness();
    const result = await h.service.tick(TRADING);

    expect(result.skipped).toBeNull();
    expect(result.evaluated).toBe(1);
    expect(h.update).toHaveBeenCalledOnce();
    // +5% on a 0.3% threshold — decisively up.
    expect(h.update.mock.calls[0][1].metadata.outcome).toBe('continued_up');
  });

  it('declines outside market hours rather than pricing against a stale close', async () => {
    const h = harness();

    expect((await h.service.tick(AFTER_CLOSE)).skipped).toBe('market-closed');
    expect((await h.service.tick(SATURDAY)).skipped).toBe('market-closed');
    // The point of declining: no quote is fetched, so no `unclear` outcome is
    // manufactured out of a price that simply has not moved since the close.
    expect(h.getQuote).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('does not stack a second pass on top of one still running', async () => {
    const h = harness();
    let release!: () => void;
    h.getQuote.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({ lastPrice: 105 }))),
    );

    const first = h.service.tick(TRADING);
    await Promise.resolve();
    const second = await h.service.tick(TRADING);

    expect(second.skipped).toBe('in-progress');
    release();
    await first;
  });

  it('reports its own liveness, so a dead tagger is distinguishable from an idle one', async () => {
    const h = harness();
    expect(h.service.status(TRADING).ticks).toBe(0);

    await h.service.tick(TRADING);

    expect(h.service.status(TRADING).ticks).toBe(1);
    expect(h.service.status(TRADING).occurrencesTagged).toBe(1);
    expect(h.service.status(TRADING).tradingTime).toBe(true);
    expect(h.service.status(AFTER_CLOSE).tradingTime).toBe(false);
  });

  it('starts and stops its timer under the lifecycle hooks', () => {
    const h = harness();
    expect(h.service.status().running).toBe(false);

    h.service.onModuleInit();
    expect(h.service.status().running).toBe(true);

    h.service.onModuleDestroy();
    expect(h.service.status().running).toBe(false);
  });

  it('honours the kill switch', () => {
    const h = harness();
    process.env.SENTINEL_OUTCOME_LEARNING_TICK = 'false';
    try {
      h.service.onModuleInit();
      expect(h.service.status().running).toBe(false);
    } finally {
      delete process.env.SENTINEL_OUTCOME_LEARNING_TICK;
      h.service.onModuleDestroy();
    }
  });
});

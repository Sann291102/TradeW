/**
 * The journal's two guarantees: one row per BAR, and decision-time state that
 * is never rewritten.
 *
 * Both are properties of how it writes rather than of what it writes, so these
 * assert against a stub Prisma that records the calls — which Prisma verb was
 * used matters more here than the row contents, because the verb is the
 * guarantee.
 */

import { describe, expect, it, vi } from 'vitest';
import { BrainJournalService } from './brain-journal.service';
import type { ScanResult } from './setup-scanner.service';
import type { TradeCandidate } from '@tradew/strategy-core';

const BAR = new Date('2026-09-09T14:15:00.000Z');

const candidate = (over: Partial<TradeCandidate> = {}): TradeCandidate =>
  ({
    market: 'CRYPTO',
    symbol: 'BTCUSDT',
    timeframe: '15m',
    decidedAt: new Date(),
    signalBarAt: BAR,
    setupId: 'agent-ema-cross',
    setupName: 'EMA Cross Continuation',
    setupVersion: '1.0.0',
    archetype: 'signal-bar',
    bias: 'bullish',
    direction: 'long',
    quality: 100,
    confirmed: [{ ruleId: 'ema_fast_above_slow', note: 'EMA20 above EMA50' }],
    unmet: [],
    invalidated: [],
    regime: 'trending',
    features: { lastPrice: 79000, atr: 300 } as never,
    plan: {
      direction: 'long',
      entry: 79000,
      stop: 78700,
      target: 79900,
      riskPerUnit: 300,
      rewardPerUnit: 900,
      plannedRR: 3,
      anchor: { archetype: 'signal-bar', level: 78750, note: 'Signal bar low at 78750' },
      atr: 300,
      riskAtr: 1,
      targetAtr: 3,
      rationale: ['because'],
    },
    accepted: true,
    rejectionReason: null,
    rejectionDetail: null,
    explanation: 'Entered long because…',
    ...over,
  }) as TradeCandidate;

const scanned = (candidates: TradeCandidate[]): ScanResult => ({
  symbol: 'BTCUSDT',
  market: 'CRYPTO',
  status: 'scanned',
  candidates,
  detail: null,
  source: 'binance',
  dataAgeSeconds: 3,
});

function harness() {
  const calls: string[] = [];
  const prisma = {
    autonomousScan: {
      upsert: vi.fn(async (_args: { where: Record<string, never>; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        calls.push('scan.upsert');
        return { id: 'scan-1' };
      }),
      create: vi.fn(async () => {
        calls.push('scan.create');
        return { id: 'scan-skip' };
      }),
      findFirst: vi.fn(async () => {
        calls.push('scan.findFirst');
        return null;
      }),
      update: vi.fn(async () => {
        calls.push('scan.update');
        return {};
      }),
    },
    autonomousCandidate: {
      createMany: vi.fn(async (args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }) => {
        calls.push('candidate.createMany');
        return { count: args.data.length };
      }),
      update: vi.fn(async () => {
        calls.push('candidate.update');
        return {};
      }),
      upsert: vi.fn(async () => {
        calls.push('candidate.upsert');
        return {};
      }),
    },
  };
  return { service: new BrainJournalService(prisma as never), prisma, calls };
}

describe('one row per bar', () => {
  it('keys the scan on the signal bar, not on the poll clock', async () => {
    const { service, prisma } = harness();
    await service.record(scanned([candidate()]), 'BINANCE');

    const where = prisma.autonomousScan.upsert.mock.calls[0]![0].where as Record<string, unknown>;
    expect((where as { symbol_timeframe_signalBarAt: unknown }).symbol_timeframe_signalBarAt).toEqual({
      symbol: 'BTCUSDT',
      timeframe: '15m',
      signalBarAt: BAR,
    });
  });

  it('refreshes only volatile counters on a repeat poll of the same bar', async () => {
    const { service, prisma } = harness();
    await service.record(scanned([candidate()]), 'BINANCE');

    const update = prisma.autonomousScan.upsert.mock.calls[0]![0].update;
    // The decision, the bar and the brain version must NOT be in the update —
    // a later poll on the same bar is the same decision seen again.
    expect(Object.keys(update).sort()).toEqual(
      ['acceptedCount', 'candidateCount', 'dataAgeSeconds'].sort(),
    );
    expect(update).not.toHaveProperty('signalBarAt');
    expect(update).not.toHaveProperty('brainVersion');
  });
});

describe('decision-time state is never rewritten', () => {
  it('writes candidates with skipDuplicates, never an upsert or update', async () => {
    const { service, prisma, calls } = harness();
    await service.record(scanned([candidate()]), 'BINANCE');

    expect(prisma.autonomousCandidate.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    // The guarantee, structurally: this service has no path that edits a
    // candidate once written. "Was the original reasoning correct?" is
    // unanswerable if hindsight can edit the reasoning.
    expect(calls).not.toContain('candidate.update');
    expect(calls).not.toContain('candidate.upsert');
  });

  it('carries the full learning payload onto the row', async () => {
    const { service, prisma } = harness();
    await service.record(scanned([candidate()]), 'BINANCE');

    const row = prisma.autonomousCandidate.createMany.mock.calls[0]![0].data[0]!;
    expect(row.features).toBeTruthy();
    expect(row.confirmed).toBeTruthy();
    expect(row.explanation).toContain('Entered long');
    expect(Number(row.entry)).toBe(79000);
    expect(Number(row.stop)).toBe(78700);
    expect(Number(row.target)).toBe(79900);
    expect(Number(row.plannedRR)).toBe(3);
    expect(row.anchorNote).toContain('Signal bar low');
  });

  it('records a refused candidate WITH the levels it would have used', async () => {
    // The counterfactual the learning loop needs: a refusal whose levels would
    // have paid is evidence the gate is too strict.
    const refused = candidate({
      accepted: false,
      rejectionReason: 'risk-below-noise-floor',
      rejectionDetail: 'Risk 12.4 is 0.31 ATR, under the 0.4 floor',
    });
    const { service, prisma } = harness();
    await service.record(scanned([refused]), 'BINANCE');

    const row = prisma.autonomousCandidate.createMany.mock.calls[0]![0].data[0]!;
    expect(row.accepted).toBe(false);
    expect(row.rejectionReason).toBe('risk-below-noise-floor');
    expect(Number(row.entry)).toBe(79000);
  });
});

describe('rows that would otherwise be noise', () => {
  it('dedupes a closed-market scan on a time window, not on a null bar', async () => {
    // Postgres treats NULLs in a unique index as distinct, so keying these on
    // a null bar would append a row every poll all night — exactly the
    // 98%-noise ledger this dataset exists to avoid.
    const closed: ScanResult = {
      symbol: 'NIFTY',
      market: 'INDIA',
      status: 'skipped-closed',
      candidates: [],
      detail: 'NSE is closed at this time.',
      source: 'dhan-bridge',
      dataAgeSeconds: null,
    };
    const { service, prisma } = harness();
    prisma.autonomousScan.findFirst.mockResolvedValueOnce({ id: 'existing' } as never);

    const write = await service.record(closed, 'NSE');
    expect(write.deduped).toBe(true);
    expect(prisma.autonomousScan.create).not.toHaveBeenCalled();
  });

  it('sends a scanned-but-empty market down the same path', async () => {
    // Nothing came within one rule of validating, so no candidate carries a
    // signal bar to key on.
    const { service, prisma } = harness();
    await service.record(scanned([]), 'BINANCE');
    expect(prisma.autonomousScan.upsert).not.toHaveBeenCalled();
    expect(prisma.autonomousScan.findFirst).toHaveBeenCalled();
  });
});

describe('journalling never breaks the brain', () => {
  it('swallows a write failure and reports it, rather than throwing', async () => {
    const { service, prisma } = harness();
    prisma.autonomousScan.upsert.mockRejectedValueOnce(new Error('deadlock'));

    const write = await service.record(scanned([candidate()]), 'BINANCE');
    // An observer that crashed on a write would stop collecting the dataset
    // it exists to collect.
    expect(write.scanId).toBeNull();
    expect(write.candidatesWritten).toBe(0);
  });
});

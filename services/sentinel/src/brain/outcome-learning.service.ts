import { Inject, Injectable, Logger } from '@nestjs/common';
import { MemoryStore } from '@tradew/ai-core';
import { MarketDataProvider } from '@tradew/types';
import { PrismaService } from '../prisma.service';
import { MARKET_DATA } from '../intelligence/market-intelligence.service';
import { MEMORY_STORE } from './tokens';

interface PatternMetadata {
  pattern: string;
  symbol: string;
  priceAtDetection: number;
  detectedAt: string;
  outcome: string | null;
  outcomeMovePct?: number;
  outcomeEvaluatedAt?: string;
}

/**
 * Continuous Learning from Outcomes — pattern occurrences (Pattern
 * Recognition Engine's output) start with outcome: null. Once enough time
 * has passed to judge them, this tags what actually happened: price moved
 * further in one direction, or stayed put ("unclear"). Directional labels
 * only (continued_up/continued_down/unclear) — deliberately not
 * pattern-specific "confirmed/failed" semantics, which would require
 * opinionated per-pattern interpretation this phase doesn't build yet.
 *
 * Piggybacks on the existing observe() cadence rather than a new scheduler
 * — Sentinel already runs continuously during market hours (Phase 12).
 */
@Injectable()
export class OutcomeLearningService {
  private readonly logger = new Logger(OutcomeLearningService.name);
  private static readonly MIN_AGE_MS = 15 * 60_000;
  private static readonly MOVE_THRESHOLD_PCT = 0.3;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MEMORY_STORE) private readonly memory: MemoryStore,
    @Inject(MARKET_DATA) private readonly marketData: MarketDataProvider,
  ) {}

  async evaluatePending(limit = 5): Promise<{ evaluated: number }> {
    try {
      const cutoff = new Date(Date.now() - OutcomeLearningService.MIN_AGE_MS);
      const rows = await this.prisma.memoryRecord.findMany({
        where: { tags: { has: 'pattern_occurrence' }, namespace: 'sentinel', createdAt: { lte: cutoff } },
        take: limit * 4,
        orderBy: { createdAt: 'asc' },
      });
      const pending = rows
        .map((row) => ({ row, meta: row.metadata as unknown as PatternMetadata | null }))
        .filter((r) => r.meta && r.meta.outcome === null && typeof r.meta.priceAtDetection === 'number')
        .slice(0, limit);

      let evaluated = 0;
      for (const { row, meta } of pending) {
        try {
          const quote = await this.marketData.getQuote(meta!.symbol);
          const movePct = ((quote.lastPrice - meta!.priceAtDetection) / meta!.priceAtDetection) * 100;
          const outcome =
            Math.abs(movePct) < OutcomeLearningService.MOVE_THRESHOLD_PCT
              ? 'unclear'
              : movePct > 0
                ? 'continued_up'
                : 'continued_down';
          await this.memory.update(row.id, {
            metadata: { ...meta, outcome, outcomeMovePct: movePct, outcomeEvaluatedAt: new Date().toISOString() },
          });
          evaluated++;
        } catch (err) {
          this.logger.warn(`could not evaluate outcome for memory ${row.id}: ${err}`);
        }
      }
      return { evaluated };
    } catch (err) {
      this.logger.warn(`outcome evaluation pass failed (non-fatal): ${err}`);
      return { evaluated: 0 };
    }
  }
}

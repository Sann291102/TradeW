/**
 * Sentinel as a benchmark — never as an authority.
 *
 * For the same market event, records what the production brain concluded
 * beside what the autonomous brain concluded. Over thousands of paired
 * observations that answers questions neither brain can answer alone: where
 * Sentinel is early or late, which setups it misses, which the autonomous brain
 * wrongly accepts, and whether their disagreements have a direction.
 *
 * ## Why this does NOT break Sentinel independence
 *
 * It reads Sentinel's OUTPUT from `ExecutionEvaluationLog` — a table the
 * existing execution loop already writes for its own reasons. It does not call
 * Sentinel, does not import from `services/sentinel`, and does not construct a
 * client. If Sentinel is switched off, the query returns nothing, the benchmark
 * columns stay null, and the autonomous brain is completely unaffected.
 *
 * The direction of the dependency is the whole point: the brain does not need
 * Sentinel to decide, and Sentinel does not need the brain to run. This is an
 * observer of both, and it is allowed to fail.
 *
 * ## The one rule that must never be broken
 *
 * **A benchmark value must never become an input to a decision.** The moment
 * the brain reads `sentinelConfidence` before deciding, it has stopped being an
 * independent brain and become a filter on Sentinel — which is exactly the
 * architecture this work exists to replace. That is why this service is called
 * AFTER the decision is journalled, takes the scan id rather than the snapshot,
 * and returns void.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * How close in time a Sentinel evaluation must be to count as the same event.
 *
 * The execution loop evaluates every 30 s and the observer every 60 s, so the
 * nearest Sentinel row is normally seconds away. Two minutes is generous enough
 * to survive a slow tick on either side and tight enough that it cannot pair a
 * decision with one about a materially different market.
 */
const PAIRING_WINDOW_MS = 120_000;

/** The comparison, precomputed so it is groupable rather than derived per query. */
export type Agreement =
  | 'both-acted'
  | 'both-waited'
  | 'autonomous-only'
  | 'sentinel-only'
  | 'sentinel-silent';

@Injectable()
export class SentinelBenchmarkService {
  private readonly logger = new Logger(SentinelBenchmarkService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Attach Sentinel's view of the same moment to an already-written scan.
   *
   * Failures are swallowed. The benchmark is a nice-to-have; a brain that
   * stopped observing because its benchmark query failed would have inverted
   * the priority this whole design is built on.
   */
  async attach(scanId: string, symbol: string, at: Date, autonomousAccepted: number): Promise<void> {
    try {
      const since = new Date(at.getTime() - PAIRING_WINDOW_MS);
      const until = new Date(at.getTime() + PAIRING_WINDOW_MS);

      const nearest = await this.prisma.executionEvaluationLog.findFirst({
        where: { symbol, at: { gte: since, lte: until } },
        orderBy: { at: 'desc' },
        select: {
          verdict: true,
          executable: true,
          confidence: true,
          strategyId: true,
          marketState: true,
        },
      });

      if (!nearest) {
        // Sentinel said nothing about this symbol in the window — it may be
        // off, unarmed for this instrument, or simply not evaluating it. That
        // is a fact worth recording, and it is NOT the same as Sentinel
        // declining to trade.
        await this.prisma.autonomousScan.update({
          where: { id: scanId },
          data: { agreement: 'sentinel-silent' satisfies Agreement },
        });
        return;
      }

      const sentinelActed = nearest.executable === true;
      const brainActed = autonomousAccepted > 0;
      const agreement: Agreement =
        brainActed && sentinelActed
          ? 'both-acted'
          : !brainActed && !sentinelActed
            ? 'both-waited'
            : brainActed
              ? 'autonomous-only'
              : 'sentinel-only';

      await this.prisma.autonomousScan.update({
        where: { id: scanId },
        data: {
          sentinelVerdict: nearest.verdict,
          sentinelExecutable: nearest.executable,
          sentinelConfidence: nearest.confidence,
          sentinelStrategyId: nearest.strategyId,
          sentinelMarketState: nearest.marketState,
          agreement,
        },
      });
    } catch (err) {
      this.logger.warn(
        `benchmark attach failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

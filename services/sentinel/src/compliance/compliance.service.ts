import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SentinelObservationOut, Signal } from '../domain';

/**
 * Compliance & Audit agent — logs every observation from the other agents
 * with evidence and a SEBI-relevant category label (SENTINEL.md §6). The
 * Observation Feed and Agent Activity Timeline are views over this trail.
 */
@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** SEBI-relevant category taxonomy for observation labelling. */
  categoryFor(signal: Signal): string {
    if (signal.agent === 'emotion') return 'behavioral_pattern_observation';
    if (signal.agent === 'trap-safety') return 'market_risk_awareness';
    // Risk Intelligence (Master Plan Module 6) reports the same class of
    // concern as the trap agent — account, timing and volatility exposure —
    // so it shares the risk-awareness label rather than inventing a second one.
    if (signal.agent === 'risk') return 'market_risk_awareness';
    // Strategy Engine (Module 2) describes structure, never a recommendation,
    // so it belongs with the other structural observations.
    if (signal.agent === 'strategy') return 'market_structure_observation';
    return 'market_structure_observation';
  }

  async record(
    userId: string | null,
    observations: SentinelObservationOut[],
    surfacedContent?: string | null,
  ): Promise<void> {
    try {
      await this.prisma.sentinelObservation.createMany({
        data: observations.map((o) => ({
          userId,
          agent: o.agent,
          category: o.category,
          pattern: o.pattern ?? null,
          symbol: o.symbol ?? null,
          content: o.content,
          evidence: o.evidence,
          confidence: o.confidence,
          surfaced: surfacedContent !== null && surfacedContent !== undefined && o.agent === 'orchestrator',
        })),
      });
    } catch (err) {
      // audit logging must never break the observation flow, but a silent
      // audit gap is a compliance issue — log loudly
      this.logger.error(`failed to persist ${observations.length} observations: ${err}`);
    }
  }

  async feed(userId: string, limit = 50) {
    try {
      return await this.prisma.sentinelObservation.findMany({
        where: { OR: [{ userId }, { userId: null }] },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 200),
      });
    } catch (err) {
      // read path — degrade to an empty feed rather than a 500, matching
      // every other Brain query surface (KnowledgeCenterService et al).
      this.logger.warn(`observation feed lookup failed, returning empty feed: ${err}`);
      return [];
    }
  }
}

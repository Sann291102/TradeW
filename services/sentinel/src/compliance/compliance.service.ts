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
    if (observations.length === 0) return;
    try {
      await this.prisma.sentinelObservation.createMany({
        data: observations.map((o) => ({
          userId: userId || null,
          agent: o.agent,
          category: o.category,
          pattern: o.pattern ?? null,
          symbol: o.symbol ?? null,
          content: o.content,
          evidence: o.evidence,
          confidence: o.confidence,
          surfaced: surfacedContent !== null && surfacedContent !== undefined && o.agent === 'orchestrator',
          createdAt: o.createdAt ? new Date(o.createdAt) : new Date(),
        })),
      });
    } catch (err) {
      // audit logging must never break the observation flow, but a silent
      // audit gap is a compliance issue — log loudly
      this.logger.error(`failed to persist ${observations.length} observations: ${err}`);
    }
  }

  async feed(userId: string | null, limit = 100): Promise<SentinelObservationOut[]> {
    try {
      const since24h = new Date(Date.now() - 24 * 3600 * 1000);
      const rows = await this.prisma.sentinelObservation.findMany({
        where: {
          OR: userId ? [{ userId }, { userId: null }] : [{ userId: null }],
          createdAt: { gte: since24h },
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 200),
      });
      return rows.map((r) => ({
        agent: r.agent,
        category: r.category,
        pattern: r.pattern ?? undefined,
        symbol: r.symbol ?? undefined,
        content: r.content,
        evidence: Array.isArray(r.evidence) ? (r.evidence as string[]) : [r.content],
        confidence: r.confidence,
        createdAt: r.createdAt.toISOString(),
      }));
    } catch (err) {
      // read path — degrade to an empty feed rather than a 500, matching
      // every other Brain query surface (KnowledgeCenterService et al).
      this.logger.warn(`observation feed lookup failed, returning empty feed: ${err}`);
      return [];
    }
  }
}

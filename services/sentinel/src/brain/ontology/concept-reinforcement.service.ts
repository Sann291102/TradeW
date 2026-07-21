import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma.service';
import { isRelationType, RelationType } from './relations';

/**
 * The learning half of the graph: how observation strengthens or weakens what
 * the ontology claims, without ever rewriting the ontology itself.
 *
 * Three invariants hold everything together, and all three exist to stop
 * runtime learning from corrupting canonical knowledge:
 *
 *   1. Observations are append-only. A learned weight is always re-derivable
 *      from the log, and a past explanation's evidence never changes under it.
 *   2. Reinforcement writes `learnedWeight` and the counters — never `weight`.
 *      The authored prior stays intact and reseed-safe, so YAML and runtime
 *      can never fight over the same column.
 *   3. New knowledge is *proposed*, never merged. Sentinel cannot promote its
 *      own findings; it queues them for a human, who accepts by editing YAML.
 */

export type ObservationOutcome = 'confirmed' | 'refuted' | 'inconclusive';

export interface RecordObservationInput {
  conceptId: string;
  outcome: ObservationOutcome;
  /** 0..1 — how strongly this instance evidences the outcome. */
  strength?: number;
  symbol?: string;
  /** Relation being evidenced, when the observation is about a link rather than a concept. */
  edge?: { toConceptId: string; relation: RelationType };
  /** SentinelObservation.id, for audit traceability back to what produced this. */
  observationId?: string;
  namespace?: string;
  context?: Record<string, unknown>;
}

/**
 * Evidence needed before a learned weight is allowed to override the authored
 * prior. Below this, observations accumulate but the authored weight still
 * governs — otherwise a single coincidence would outweigh a reviewed judgement.
 */
export const MIN_OBSERVATIONS_FOR_LEARNED_WEIGHT = 8;

/** Support needed before a runtime-discovered link is worth a human's attention. */
export const MIN_SUPPORT_FOR_PROMOTION = 12;

@Injectable()
export class ConceptReinforcementService {
  private readonly logger = new Logger(ConceptReinforcementService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record one observation and update derived weights.
   *
   * Defensive by design, matching the rest of the Brain: a learning failure
   * must never break the observation path that called it. Sentinel comments in
   * parallel with the user's activity and is never a gate (ARCHITECTURE.md §4),
   * so this returns quietly rather than throwing.
   */
  async record(input: RecordObservationInput): Promise<void> {
    try {
      const node = await this.prisma.conceptNode.findUnique({ where: { conceptId: input.conceptId } });
      if (!node) {
        this.logger.debug(`observation for unknown concept "${input.conceptId}" — ignored`);
        return;
      }

      let edgeId: string | null = null;
      if (input.edge) {
        const target = await this.prisma.conceptNode.findUnique({ where: { conceptId: input.edge.toConceptId } });
        if (target) {
          const edge = await this.prisma.conceptEdge.findFirst({
            where: { fromId: node.id, toId: target.id, relation: input.edge.relation },
          });
          if (edge) {
            edgeId = edge.id;
          } else {
            // A link the ontology does not declare. Not an error — this is
            // precisely the signal worth surfacing for review.
            await this.proposeRelation(input.conceptId, input.edge.toConceptId, input.edge.relation, input.outcome);
          }
        }
      }

      const strength = clamp01(input.strength ?? 0.5);

      await this.prisma.conceptObservation.create({
        data: {
          conceptId: node.id,
          edgeId,
          symbol: input.symbol ?? null,
          outcome: input.outcome,
          strength,
          context: (input.context ?? {}) as never,
          observationId: input.observationId ?? null,
          namespace: input.namespace ?? 'global',
        },
      });

      await this.prisma.conceptNode.update({
        where: { id: node.id },
        data: { observationCount: { increment: 1 }, lastObservedAt: new Date() },
      });

      if (edgeId) await this.recomputeEdgeWeight(edgeId);
    } catch (err) {
      this.logger.warn(`failed to record concept observation: ${(err as Error).message}`);
    }
  }

  /**
   * Re-derive an edge's learned weight from its full observation history.
   *
   * Recomputed from the log rather than incrementally adjusted, so the value
   * is always reproducible and a bug in one update cannot permanently skew the
   * weight. Inconclusive observations count toward the evidence threshold but
   * pull the estimate toward neutral, which is the honest treatment.
   */
  private async recomputeEdgeWeight(edgeId: string): Promise<void> {
    const edge = await this.prisma.conceptEdge.findUnique({ where: { id: edgeId } });
    if (!edge) return;

    const observations = await this.prisma.conceptObservation.findMany({
      where: { edgeId },
      select: { outcome: true, strength: true },
    });

    let support = 0;
    let refute = 0;
    let weighted = 0;
    let totalStrength = 0;

    for (const obs of observations) {
      if (obs.outcome === 'confirmed') {
        support++;
        weighted += obs.strength;
      } else if (obs.outcome === 'refuted') {
        refute++;
        weighted -= obs.strength;
      }
      totalStrength += obs.strength;
    }

    const total = observations.length;
    let learnedWeight: number | null = null;

    if (total >= MIN_OBSERVATIONS_FOR_LEARNED_WEIGHT && totalStrength > 0) {
      // Map net weighted evidence from [-1, 1] onto [0, 1], then blend toward
      // the authored prior in proportion to how thin the evidence still is.
      const evidence = (weighted / totalStrength + 1) / 2;
      const trust = Math.min(1, total / (MIN_OBSERVATIONS_FOR_LEARNED_WEIGHT * 4));
      learnedWeight = clamp01(edge.weight * (1 - trust) + evidence * trust);
    }

    await this.prisma.conceptEdge.update({
      where: { id: edgeId },
      data: { supportCount: support, refuteCount: refute, learnedWeight, lastObservedAt: new Date() },
    });
  }

  /**
   * Queue a runtime-discovered relation for human review.
   *
   * Idempotent via `dedupeKey`: the same discovery observed repeatedly
   * increments support on one queue entry rather than flooding the queue,
   * which is what makes support count meaningful as a review priority.
   */
  async proposeRelation(
    fromConcept: string,
    toConcept: string,
    relation: RelationType,
    outcome: ObservationOutcome = 'confirmed',
  ): Promise<void> {
    if (!isRelationType(relation)) return;
    if (outcome !== 'confirmed') return;

    const dedupeKey = hashKey(['relation', fromConcept, toConcept, relation]);
    try {
      const existing = await this.prisma.conceptPromotion.findUnique({ where: { dedupeKey } });
      if (existing) {
        if (existing.status !== 'pending') return; // already reviewed — respect the decision
        const supportCount = existing.supportCount + 1;
        await this.prisma.conceptPromotion.update({
          where: { dedupeKey },
          data: { supportCount, confidence: clamp01(supportCount / (MIN_SUPPORT_FOR_PROMOTION * 2)) },
        });
        return;
      }

      await this.prisma.conceptPromotion.create({
        data: {
          dedupeKey,
          kind: 'relation',
          fromConcept,
          toConcept,
          relation,
          supportCount: 1,
          confidence: clamp01(1 / (MIN_SUPPORT_FOR_PROMOTION * 2)),
          rationale:
            `Observed co-occurrence consistent with "${fromConcept} ${relation} ${toConcept}", ` +
            'which the ontology does not currently declare.',
        },
      });
    } catch (err) {
      this.logger.warn(`failed to queue relation promotion: ${(err as Error).message}`);
    }
  }

  /** Queue an entirely new concept for review. Same one-way flow as relations. */
  async proposeConcept(conceptId: string, rationale: string, evidence: Record<string, unknown> = {}): Promise<void> {
    const dedupeKey = hashKey(['concept', conceptId]);
    try {
      const existing = await this.prisma.conceptPromotion.findUnique({ where: { dedupeKey } });
      if (existing) {
        if (existing.status !== 'pending') return;
        const supportCount = existing.supportCount + 1;
        await this.prisma.conceptPromotion.update({
          where: { dedupeKey },
          data: { supportCount, confidence: clamp01(supportCount / (MIN_SUPPORT_FOR_PROMOTION * 2)) },
        });
        return;
      }
      await this.prisma.conceptPromotion.create({
        data: {
          dedupeKey,
          kind: 'concept',
          conceptId,
          rationale,
          evidence: evidence as never,
          supportCount: 1,
          confidence: clamp01(1 / (MIN_SUPPORT_FOR_PROMOTION * 2)),
        },
      });
    } catch (err) {
      this.logger.warn(`failed to queue concept promotion: ${(err as Error).message}`);
    }
  }

  /**
   * The review queue, ranked by accumulated support. This is the only path by
   * which the ontology grows — a person reads this, edits YAML, and reseeds.
   */
  async pendingPromotions(limit = 50) {
    return this.prisma.conceptPromotion.findMany({
      where: { status: 'pending' },
      orderBy: [{ supportCount: 'desc' }, { createdAt: 'asc' }],
      take: limit,
    });
  }

  /**
   * Mark a queue entry reviewed. Note this does NOT write to the graph:
   * accepting a proposal means a human edits YAML and reseeds. Recording the
   * decision here only stops the same proposal being re-queued forever.
   */
  async reviewPromotion(
    id: string,
    decision: 'approved' | 'rejected' | 'merged',
    reviewedBy: string,
    reviewNote?: string,
  ): Promise<void> {
    await this.prisma.conceptPromotion.update({
      where: { id },
      data: { status: decision, reviewedBy, reviewNote: reviewNote ?? null, reviewedAt: new Date() },
    });
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function hashKey(parts: string[]): string {
  return createHash('sha256').update(parts.join(' ')).digest('hex').slice(0, 32);
}

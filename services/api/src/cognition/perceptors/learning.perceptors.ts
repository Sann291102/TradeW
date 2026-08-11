import { NewPercept, SenseContext } from '@tradew/ai-core';
import { PrismaService } from '../../prisma/prisma.service';
import { PrismaPerceptor, clamp01 } from './shared';

/**
 * The knowledge pipeline — is the platform still learning, and learning what?
 *
 * The pipeline that ingests books, extracts concepts and promotes them into the
 * ontology is the slowest-feedback system in the platform. It can stop working
 * entirely and nothing breaks: no error, no failed request, no user complaint.
 * The corpus simply stops growing, and six weeks later somebody notices that
 * Sentinel's vocabulary has not changed since spring.
 *
 * These three perceptors are the pipeline's smoke alarm, and one of them —
 * `concept-quality` — is more than that. The ratio of refuted to confirmed
 * concept observations is the closest thing this platform has to ground truth
 * about its own knowledge, and it is the natural place for outcome signals to
 * come from.
 */

// ---------------------------------------------------------------------------

/**
 * Is the corpus still growing?
 *
 * Fires on a *stall*, not on growth. Knowledge arriving is the normal state and
 * needs no alarm; knowledge stopping is the fault, and it is silent. That makes
 * this an inverted perceptor: its salience rises as the number it measures falls
 * toward zero, which is the opposite of every perceptor in the application
 * domain and worth stating plainly so nobody "fixes" it later.
 */
export class CorpusGrowthPerceptor extends PrismaPerceptor {
  /** How long a quiet pipeline is tolerated before it is a finding. */
  private static readonly STALL_AFTER_MS = 24 * 3_600_000;

  constructor(prisma: PrismaService) {
    super(
      {
        id: 'learning.corpus-growth',
        domain: 'learning',
        label: 'Corpus growth',
        description: 'Fires when knowledge STOPS arriving. An ingestion pipeline can die silently — nothing errors, the corpus simply stops growing.',
        cadence: 'interval',
        expectedIntervalMs: 60 * 60_000,
        emits: ['ingestion_stalled', 'corpus_growth'],
        enabled: true,
      },
      prisma,
    );
  }

  async sense(context: SenseContext): Promise<NewPercept[]> {
    const stallCutoff = new Date(context.until.getTime() - CorpusGrowthPerceptor.STALL_AFTER_MS);

    const [recent, latest, total] = await Promise.all([
      this.prisma.memoryRecord.count({ where: { createdAt: { gte: stallCutoff } } }),
      this.prisma.memoryRecord.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      this.prisma.memoryRecord.count(),
    ]);

    // An empty store is a platform that has not been seeded yet, not a stalled
    // pipeline. Reporting it as a stall would fire on every fresh environment.
    if (total === 0) return [];

    if (recent === 0 && latest) {
      const idleMs = context.until.getTime() - latest.createdAt.getTime();
      return [
        this.percept({
          kind: 'ingestion_stalled',
          subject: { type: 'subsystem', id: 'learning-pipeline', label: 'Knowledge pipeline' },
          observedAt: context.until,
          // Saturates at a week. Past that the exact duration stops mattering —
          // it is broken either way.
          salience: clamp01(0.5 + idleMs / (7 * 24 * 3_600_000)),
          confidence: 1,
          features: { idleMs, totalRecords: total },
          summary: `No new knowledge in ${Math.round(idleMs / 3_600_000)}h — the ingestion pipeline may have stalled`,
          tags: ['learning', 'stall'],
        }),
      ];
    }

    // Growth is recorded at low salience rather than dropped: L3 can still
    // learn that ingestion activity co-occurs with something else, and a
    // perceptor that emits only on failure has no baseline for the console to
    // show as healthy.
    return [
      this.percept({
        kind: 'corpus_growth',
        subject: { type: 'subsystem', id: 'learning-pipeline', label: 'Knowledge pipeline' },
        observedAt: context.until,
        salience: 0.12,
        confidence: 1,
        features: { added24h: recent, totalRecords: total },
        summary: `${recent} knowledge records added in the last 24h (${total} total)`,
        tags: ['learning'],
      }),
    ];
  }
}

// ---------------------------------------------------------------------------

/**
 * The human review queue for proposed ontology changes.
 *
 * Sentinel proposes concepts and relations; a person promotes them into YAML;
 * the next reseed makes them canonical. Sentinel never edits the canonical
 * source itself — that separation is deliberate and documented in the schema.
 * The cost of it is a queue, and an unattended queue is where learning goes to
 * die: the runtime keeps proposing, nothing is ever approved, and the ontology
 * silently freezes while every dashboard says the system is learning.
 */
export class ConceptPromotionPerceptor extends PrismaPerceptor {
  constructor(prisma: PrismaService) {
    super(
      {
        id: 'learning.concept-promotions',
        domain: 'learning',
        label: 'Concept promotion queue',
        description: 'Pending ontology proposals awaiting human review. A queue nobody works is how the ontology silently freezes.',
        cadence: 'interval',
        expectedIntervalMs: 60 * 60_000,
        emits: ['promotions_pending', 'promotion_backlog'],
        enabled: true,
      },
      prisma,
    );
  }

  async sense(context: SenseContext): Promise<NewPercept[]> {
    const [pending, oldest, highConfidence] = await Promise.all([
      this.prisma.conceptPromotion.count({ where: { status: 'pending' } }),
      this.prisma.conceptPromotion.findFirst({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true, rationale: true },
      }),
      this.prisma.conceptPromotion.count({ where: { status: 'pending', confidence: { gte: 0.7 } } }),
    ]);

    if (!pending || !oldest) return [];
    const ageMs = context.until.getTime() - oldest.createdAt.getTime();
    // A week. Under that, a queue is being worked at a human pace.
    const stale = ageMs > 7 * 24 * 3_600_000;

    return [
      this.percept({
        kind: stale ? 'promotion_backlog' : 'promotions_pending',
        subject: { type: 'subsystem', id: 'concept-ontology', label: 'Concept ontology' },
        observedAt: context.until,
        // Confident proposals waiting are worse than uncertain ones waiting —
        // those are the ones the system is most sure it has learned something.
        salience: clamp01((stale ? 0.5 : 0.2) + (highConfidence / Math.max(pending, 1)) * 0.3),
        confidence: 1,
        features: { pending, highConfidence, oldestAgeMs: ageMs },
        summary: `${pending} concept promotion${pending === 1 ? '' : 's'} pending review (${highConfidence} at ≥70% confidence); oldest ${Math.round(ageMs / 86_400_000)}d`,
        tags: ['learning', 'ontology', 'review'],
      }),
    ];
  }
}

// ---------------------------------------------------------------------------

/**
 * Confirmed versus refuted concept observations.
 *
 * The most valuable perceptor in this domain, because it reads the one table
 * that contains something close to ground truth: `ConceptObservation.outcome`
 * records whether a concept the system reasoned with actually held up. A
 * concept whose refutations outnumber its confirmations is one the platform
 * believes and should not.
 *
 * Grouped per concept rather than aggregated: the aggregate is always
 * reassuring, because the many concepts that work drown out the few that do
 * not, and the few that do not are the entire point.
 */
export class ConceptQualityPerceptor extends PrismaPerceptor {
  /** Fewer observations than this and the ratio is noise. */
  private static readonly MIN_OBSERVATIONS = 5;

  constructor(prisma: PrismaService) {
    super(
      {
        id: 'learning.concept-quality',
        domain: 'learning',
        label: 'Concept quality',
        description: 'Per-concept confirmed-versus-refuted ratio. The closest thing the platform has to ground truth about its own knowledge.',
        cadence: 'interval',
        expectedIntervalMs: 30 * 60_000,
        emits: ['concept_refuted', 'concept_reinforced'],
        enabled: true,
      },
      prisma,
    );
  }

  async sense(context: SenseContext): Promise<NewPercept[]> {
    // A 7-day window: outcomes arrive slowly, and a 30-minute sample of this
    // table is almost always empty.
    const since = new Date(context.until.getTime() - 7 * 24 * 3_600_000);

    const rows = await this.prisma.conceptObservation.groupBy({
      by: ['conceptId', 'outcome'],
      where: { observedAt: { gte: since } },
      _count: { _all: true },
    });
    if (!rows.length) return [];

    const byConcept = new Map<string, { confirmed: number; refuted: number; inconclusive: number }>();
    for (const row of rows) {
      const entry = byConcept.get(row.conceptId) ?? { confirmed: 0, refuted: 0, inconclusive: 0 };
      if (row.outcome === 'confirmed') entry.confirmed += row._count._all;
      else if (row.outcome === 'refuted') entry.refuted += row._count._all;
      else entry.inconclusive += row._count._all;
      byConcept.set(row.conceptId, entry);
    }

    // Resolve slugs so the console and the synapse targets read as concept
    // names rather than UUIDs — a weight nobody can read is a weight nobody
    // will trust.
    const concepts = await this.prisma.conceptNode.findMany({
      where: { id: { in: [...byConcept.keys()] } },
      select: { id: true, conceptId: true, name: true },
    });
    const slugs = new Map(concepts.map((c) => [c.id, c]));

    const out: NewPercept[] = [];
    for (const [id, counts] of byConcept) {
      const decided = counts.confirmed + counts.refuted;
      if (decided < ConceptQualityPerceptor.MIN_OBSERVATIONS) continue;
      const confirmRate = counts.confirmed / decided;
      const concept = slugs.get(id);
      const label = concept?.name ?? id;

      // Only the tails. A concept confirming 50–70% of the time is a normal,
      // useful concept, and reporting it would bury the ones that are not.
      const failing = confirmRate < 0.4;
      const strong = confirmRate > 0.85;
      if (!failing && !strong) continue;

      out.push(
        this.percept({
          kind: failing ? 'concept_refuted' : 'concept_reinforced',
          subject: { type: 'concept', id: concept?.conceptId ?? id, label },
          observedAt: context.until,
          // A concept the platform believes and shouldn't is more urgent than
          // one it believes and should.
          salience: failing ? clamp01(0.5 + (0.4 - confirmRate)) : 0.25,
          confidence: this.sampleConfidence(decided),
          features: { confirmed: counts.confirmed, refuted: counts.refuted, inconclusive: counts.inconclusive, confirmRate },
          summary: failing
            ? `${label} refuted ${counts.refuted}/${decided} times (${(confirmRate * 100).toFixed(0)}% confirm rate)`
            : `${label} confirmed ${counts.confirmed}/${decided} times`,
          occurrences: decided,
          tags: ['learning', 'concept', failing ? 'refuted' : 'confirmed'],
        }),
      );
    }
    return out;
  }
}

export function learningPerceptors(prisma: PrismaService) {
  return [new CorpusGrowthPerceptor(prisma), new ConceptPromotionPerceptor(prisma), new ConceptQualityPerceptor(prisma)];
}

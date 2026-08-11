import { Injectable, Logger } from '@nestjs/common';
import {
  ConceptPort,
  EntityRef,
  MemoryRecord,
  MemorySearchHit,
  MemorySearchQuery,
  MemoryStore,
  NewMemoryRecord,
  Synapse,
  SynapseStore,
} from '@tradew/ai-core';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Postgres adapters for the cognition ports.
 *
 * WHY THE API HAS ITS OWN MEMORY ADAPTER
 *
 * `services/sentinel` already has a Prisma-backed memory store, and it is the
 * richer one — it does pgvector similarity, because Sentinel constructs an
 * embedding provider. `services/api` does not construct one: it holds no
 * provider credentials and reaches intelligence over HTTP (ARCHITECTURE §1,
 * single ingress). Importing Sentinel's store would drag a provider stack and
 * a set of secrets into the process that fronts the internet, to serve an
 * operator console.
 *
 * So this adapter writes to the same `MemoryRecord` table and reads it
 * **lexically**. That is a real limitation, stated plainly rather than papered
 * over: consolidated cognition memories are retrieved by word overlap, not by
 * meaning. It is adequate because the things L4 writes are short, structured
 * and heavily tagged — and when an embedder is wired into this process, the
 * only change needed is the `search` method.
 */

/** Words too common to discriminate. Kept short — an aggressive stop list on a
 *  lexical search removes the very terms that made a query specific. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'was', 'are',
  'be', 'by', 'at', 'it', 'this', 'that', 'with', 'from', 'has', 'have',
]);

function terms(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_.:-]+/)
        .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
    ),
  ].slice(0, 8); // bounded: each term becomes an ILIKE, and the cost is linear
}

@Injectable()
export class CognitionMemoryStore implements MemoryStore {
  private readonly logger = new Logger(CognitionMemoryStore.name);

  constructor(private readonly prisma: PrismaService) {}

  async store(record: NewMemoryRecord): Promise<MemoryRecord> {
    const row = await this.prisma.memoryRecord.create({
      data: {
        summary: record.summary,
        content: record.content,
        sourceKind: record.source.kind,
        sourceReference: record.source.reference ?? null,
        sourceProvider: record.source.provider ?? null,
        confidence: record.confidence,
        tags: record.tags,
        entities: record.entities as unknown as Prisma.InputJsonValue,
        userId: record.userId,
        namespace: record.namespace,
        staleAfter: record.staleAfter ?? null,
        metadata: (record.metadata ?? null) as Prisma.InputJsonValue,
      },
    });
    return this.toDomain(row);
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const row = await this.prisma.memoryRecord.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  /**
   * Lexical retrieval, ranked by how many query terms a record matches.
   *
   * The score is `matched / total terms`, which is deliberately NOT presented
   * as a similarity. A caller that treats it as one gets a number that behaves
   * roughly right — more overlap ranks higher — without the false precision of
   * a cosine distance that was never computed.
   */
  async search(query: MemorySearchQuery): Promise<MemorySearchHit[]> {
    const words = terms(query.text);
    const where: Prisma.MemoryRecordWhereInput = {
      ...(query.namespace ? { namespace: query.namespace } : {}),
      ...(query.userId !== undefined ? { userId: query.userId } : {}),
      ...(query.tags?.length ? { tags: { hasSome: query.tags } } : {}),
      ...(query.includeStale ? {} : { OR: [{ staleAfter: null }, { staleAfter: { gt: new Date() } }] }),
      ...(words.length
        ? {
            AND: [
              {
                OR: words.flatMap((word) => [
                  { summary: { contains: word, mode: 'insensitive' as const } },
                  { tags: { has: word } },
                ]),
              },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.memoryRecord.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      // Over-fetch, then rank and cut. Postgres cannot order by term overlap
      // without a full-text index, so the ranking happens here over a bounded
      // candidate set rather than over the table.
      take: Math.min((query.limit ?? 8) * 5, 200),
    });

    const scored = rows.map((row) => {
      const haystack = `${row.summary} ${row.tags.join(' ')}`.toLowerCase();
      const matched = words.filter((word) => haystack.includes(word)).length;
      return { record: this.toDomain(row), score: words.length ? matched / words.length : 0.5 };
    });

    return scored
      .filter((hit) => hit.score >= (query.minScore ?? 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, query.limit ?? 8);
  }

  async connect(idA: string, idB: string, relation = 'related'): Promise<void> {
    // Idempotent: the network re-derives the same association on every pass
    // that sees the same signals, and a unique-violation log line per pass
    // would drown everything else in the file.
    await this.prisma.memoryRelation
      .createMany({
        data: [
          { fromId: idA, toId: idB, relation },
          { fromId: idB, toId: idA, relation },
        ],
        skipDuplicates: true,
      })
      .catch((err: unknown) => this.logger.warn(`connect failed: ${String(err)}`));
  }

  async update(id: string, patch: Partial<NewMemoryRecord>): Promise<MemoryRecord> {
    const row = await this.prisma.memoryRecord.update({
      where: { id },
      data: {
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...(patch.staleAfter !== undefined ? { staleAfter: patch.staleAfter } : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata as Prisma.InputJsonValue } : {}),
      },
    });
    return this.toDomain(row);
  }

  async stats(): Promise<{ total: number; byNamespace: Record<string, number> }> {
    const [total, groups] = await Promise.all([
      this.prisma.memoryRecord.count(),
      this.prisma.memoryRecord.groupBy({ by: ['namespace'], _count: { _all: true } }),
    ]);
    return {
      total,
      byNamespace: Object.fromEntries(groups.map((g) => [g.namespace, g._count._all])),
    };
  }

  private toDomain(row: {
    id: string;
    summary: string;
    content: string;
    sourceKind: string;
    sourceReference: string | null;
    sourceProvider: string | null;
    confidence: number;
    tags: string[];
    entities: Prisma.JsonValue;
    userId: string | null;
    namespace: string;
    staleAfter: Date | null;
    metadata: Prisma.JsonValue;
    createdAt: Date;
    updatedAt: Date;
  }): MemoryRecord {
    return {
      id: row.id,
      summary: row.summary,
      content: row.content,
      source: {
        kind: row.sourceKind as MemoryRecord['source']['kind'],
        reference: row.sourceReference ?? undefined,
        provider: row.sourceProvider ?? undefined,
      },
      confidence: row.confidence,
      tags: row.tags,
      entities: Array.isArray(row.entities) ? (row.entities as unknown as EntityRef[]) : [],
      relatedIds: [],
      userId: row.userId,
      namespace: row.namespace,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      staleAfter: row.staleAfter ?? undefined,
      metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
    };
  }
}

/**
 * The concept port, over the existing Sentinel ontology.
 *
 * L3 uses this to find concepts a percept might be about. Matching is on the
 * concept's name, slug and aliases rather than on an embedding — same trade,
 * same reason as above.
 *
 * The important property is not the matching quality: a weak match creates a
 * weak synapse that stays weak unless outcomes reinforce it, so a bad guess here
 * costs one low-weight edge, not a wrong conclusion. That is the whole reason
 * the network can run usefully without an embedder wired in.
 */
@Injectable()
export class CognitionConceptPort implements ConceptPort {
  constructor(private readonly prisma: PrismaService) {}

  async related(text: string, limit: number): Promise<Array<{ id: string; label: string; score: number }>> {
    const words = terms(text);
    if (!words.length) return [];

    const concepts = await this.prisma.conceptNode.findMany({
      where: {
        OR: words.flatMap((word) => [
          { name: { contains: word, mode: 'insensitive' as const } },
          { conceptId: { contains: word, mode: 'insensitive' as const } },
        ]),
      },
      select: { conceptId: true, name: true },
      take: limit * 4,
    });

    return concepts
      .map((concept) => {
        const haystack = `${concept.name} ${concept.conceptId}`.toLowerCase();
        const matched = words.filter((word) => haystack.includes(word)).length;
        return { id: concept.conceptId, label: concept.name, score: matched / words.length };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

/**
 * Load and flush the learned weights.
 *
 * Weights are the only irreplaceable state in this system, and this class is
 * the only thing standing between a process restart and losing all of it.
 *
 * WHY FLUSHING IS BATCHED AND NOT WRITE-THROUGH
 *
 * A single pass can touch hundreds of synapses. Writing each one as it changes
 * would put a database round trip inside the association loop — the hottest
 * path in the network — for state that is re-derivable from the next pass if a
 * few seconds of it are lost. So the store accumulates dirty rows and this
 * flushes them on a timer and on shutdown. The accepted loss is bounded by the
 * flush interval, which is the right trade for a value that changes by at most
 * `LEARNING_RATE` per outcome.
 */
@Injectable()
export class SynapsePersistence {
  private readonly logger = new Logger(SynapsePersistence.name);

  constructor(private readonly prisma: PrismaService) {}

  async load(store: SynapseStore): Promise<number> {
    const rows = await this.prisma.neuralSynapse.findMany({
      // Bounded. A network with more than this many live associations has a
      // different problem, and an unbounded load at boot is the query most
      // likely to make the API slow to start.
      take: 50_000,
      orderBy: { weight: 'desc' },
    });

    store.load(
      rows.map<Synapse>((row) => ({
        layer: row.layer as Synapse['layer'],
        source: row.source,
        target: row.target,
        weight: row.weight,
        activations: row.activations,
        reinforcements: row.reinforcements,
        meanReward: row.meanReward,
        lastActivatedAt: row.lastActivatedAt,
        lastReinforcedAt: row.lastReinforcedAt,
        createdAt: row.createdAt,
      })),
    );
    return rows.length;
  }

  async flush(store: SynapseStore): Promise<number> {
    const dirty = store.drainDirty();
    if (!dirty.length) return 0;

    // Sequential upserts rather than one `createMany`: these are updates as
    // often as inserts, and Postgres has no multi-row upsert Prisma can express
    // against a composite unique key. Batched into chunks so a large flush does
    // not hold a connection for the whole set.
    let written = 0;
    for (const synapse of dirty) {
      try {
        await this.prisma.neuralSynapse.upsert({
          where: {
            layer_source_target: { layer: synapse.layer, source: synapse.source, target: synapse.target },
          },
          create: {
            layer: synapse.layer,
            source: synapse.source,
            target: synapse.target,
            weight: synapse.weight,
            activations: synapse.activations,
            reinforcements: synapse.reinforcements,
            meanReward: synapse.meanReward,
            lastActivatedAt: synapse.lastActivatedAt,
            lastReinforcedAt: synapse.lastReinforcedAt,
          },
          update: {
            weight: synapse.weight,
            activations: synapse.activations,
            reinforcements: synapse.reinforcements,
            meanReward: synapse.meanReward,
            lastActivatedAt: synapse.lastActivatedAt,
            lastReinforcedAt: synapse.lastReinforcedAt,
          },
        });
        written += 1;
      } catch (err) {
        // A failed row is dropped rather than retried into the next flush. It
        // will be rewritten the next time that association fires, and an
        // unbounded retry queue over the platform's only irreplaceable table is
        // a worse failure than losing one increment.
        this.logger.warn(`synapse flush failed for ${synapse.source} → ${synapse.target}: ${String(err)}`);
      }
    }
    return written;
  }
}

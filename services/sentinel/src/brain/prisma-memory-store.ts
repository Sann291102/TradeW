import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  EmbeddingProvider,
  MemoryRecord,
  MemorySearchHit,
  MemorySearchQuery,
  MemoryStore,
  NewMemoryRecord,
  ProviderManager,
  ProviderNotAvailableError,
} from '@tradew/ai-core';
import { PrismaService } from '../prisma.service';
import { PROVIDER_MANAGER } from './tokens';

/**
 * Persistent Knowledge Brain — the real MemoryStore, backed by the
 * MemoryRecord/MemoryRelation tables from the Phase 3 schema (pgvector on
 * the same Postgres, per the locked Q4 decision: no external vector DB).
 *
 * `embedding` is declared `Unsupported("vector")` in schema.prisma, so
 * Prisma's generated client excludes it from normal CRUD — every write goes
 * through a follow-up raw SQL statement, and every similarity search is raw
 * SQL using pgvector's `<=>` cosine-distance operator. This is the standard,
 * documented workaround for using pgvector columns through Prisma.
 *
 * Never blocks Sentinel's core flow: if no embedding provider is configured,
 * records are stored without a vector and search falls back to a plain text
 * match — degraded, not broken.
 */
@Injectable()
export class PrismaMemoryStore implements MemoryStore {
  private readonly logger = new Logger(PrismaMemoryStore.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROVIDER_MANAGER) private readonly providers: ProviderManager,
  ) {}

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
        metadata: (record.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });

    let embedder: EmbeddingProvider | null = null;
    try {
      embedder = this.providers.getEmbedding();
    } catch (err) {
      if (!(err instanceof ProviderNotAvailableError)) throw err;
      this.logger.warn('no embedding provider configured — storing without a vector (text-search fallback only)');
    }
    if (embedder) {
      try {
        const { embeddings } = await embedder.embed({ texts: [`${record.summary}\n${record.content}`.slice(0, 8000)], inputType: 'document' });
        await this.setEmbedding(row.id, embeddings[0], embedder.name, embeddings[0].length);
      } catch (err) {
        this.logger.warn(`embedding failed for memory ${row.id}, stored without a vector: ${err}`);
      }
    }

    for (const relatedId of record.relatedIds) {
      await this.connect(row.id, relatedId).catch(() => undefined);
    }

    return this.rowToRecord(row);
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const row = await this.prisma.memoryRecord.findUnique({ where: { id } });
    if (!row) return null;
    return this.rowToRecord(row, await this.relatedIdsOf(id));
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchHit[]> {
    let embedder: EmbeddingProvider | null = null;
    try {
      embedder = this.providers.getEmbedding();
    } catch (err) {
      if (!(err instanceof ProviderNotAvailableError)) throw err;
    }

    const limit = query.limit ?? 8;
    const now = new Date();
    const filters: Prisma.Sql[] = [];
    if (query.namespace) filters.push(Prisma.sql`"namespace" = ${query.namespace}`);
    if (query.userId !== undefined) filters.push(Prisma.sql`("userId" = ${query.userId} OR "userId" IS NULL)`);
    if (!query.includeStale) filters.push(Prisma.sql`("staleAfter" IS NULL OR "staleAfter" >= ${now})`);
    if (query.tags?.length) filters.push(Prisma.sql`"tags" && ${query.tags}::text[]`);
    const where = filters.length ? Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}` : Prisma.empty;

    if (!embedder) {
      // No embeddings configured — degrade to a plain text match, not a crash.
      const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "MemoryRecord"
        ${where ? Prisma.sql`${where} AND ("summary" ILIKE ${'%' + query.text + '%'} OR "content" ILIKE ${'%' + query.text + '%'})` : Prisma.sql`WHERE "summary" ILIKE ${'%' + query.text + '%'} OR "content" ILIKE ${'%' + query.text + '%'}`}
        ORDER BY "createdAt" DESC LIMIT ${limit}
      `);
      return this.hydrate(rows.map((r) => ({ id: r.id, score: 0.5 })), query.entityIds);
    }

    const { embeddings } = await embedder.embed({ texts: [query.text], inputType: 'query' });
    const vectorLiteral = `[${embeddings[0].join(',')}]`;
    const rows = await this.prisma.$queryRaw<{ id: string; score: number }[]>(Prisma.sql`
      SELECT "id", 1 - ("embedding" <=> ${vectorLiteral}::vector) as score
      FROM "MemoryRecord"
      ${where ? Prisma.sql`${where} AND "embedding" IS NOT NULL` : Prisma.sql`WHERE "embedding" IS NOT NULL`}
      ORDER BY "embedding" <=> ${vectorLiteral}::vector
      LIMIT ${limit * 3}
    `);
    const filtered = rows.filter((r) => query.minScore === undefined || r.score >= query.minScore).slice(0, limit);
    return this.hydrate(filtered, query.entityIds);
  }

  async connect(idA: string, idB: string, relation = 'related'): Promise<void> {
    await this.prisma.memoryRelation.upsert({
      where: { fromId_toId_relation: { fromId: idA, toId: idB, relation } },
      update: {},
      create: { fromId: idA, toId: idB, relation },
    });
  }

  async update(id: string, patch: Partial<NewMemoryRecord>): Promise<MemoryRecord> {
    const row = await this.prisma.memoryRecord.update({
      where: { id },
      data: {
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...(patch.entities !== undefined ? { entities: patch.entities as unknown as Prisma.InputJsonValue } : {}),
        ...(patch.staleAfter !== undefined ? { staleAfter: patch.staleAfter } : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata as Prisma.InputJsonValue } : {}),
      },
    });
    return this.rowToRecord(row, await this.relatedIdsOf(id));
  }

  async stats(): Promise<{ total: number; byNamespace: Record<string, number> }> {
    const total = await this.prisma.memoryRecord.count();
    const grouped = await this.prisma.memoryRecord.groupBy({ by: ['namespace'], _count: { _all: true } });
    const byNamespace: Record<string, number> = {};
    for (const g of grouped) byNamespace[String(g.namespace)] = g._count._all;
    return { total, byNamespace };
  }

  private async setEmbedding(id: string, vector: number[], model: string, dim: number): Promise<void> {
    const literal = `[${vector.join(',')}]`;
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "MemoryRecord" SET "embedding" = ${literal}::vector, "embeddingModel" = ${model}, "embeddingDim" = ${dim}
      WHERE "id" = ${id}
    `);
  }

  private async relatedIdsOf(id: string): Promise<string[]> {
    const rels = await this.prisma.memoryRelation.findMany({
      where: { OR: [{ fromId: id }, { toId: id }] },
      select: { fromId: true, toId: true },
    });
    return rels.map((r) => (r.fromId === id ? r.toId : r.fromId));
  }

  private async hydrate(hits: { id: string; score: number }[], entityIds?: string[]): Promise<MemorySearchHit[]> {
    if (hits.length === 0) return [];
    const rows = await this.prisma.memoryRecord.findMany({ where: { id: { in: hits.map((h) => h.id) } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: MemorySearchHit[] = [];
    for (const h of hits) {
      const row = byId.get(h.id);
      if (!row) continue;
      const record = this.rowToRecord(row);
      if (entityIds?.length && !record.entities.some((e) => entityIds.includes(e.id))) continue;
      out.push({ record, score: h.score });
    }
    return out;
  }

  private rowToRecord(row: Prisma.MemoryRecordGetPayload<Record<string, never>>, relatedIds: string[] = []): MemoryRecord {
    return {
      id: row.id,
      summary: row.summary,
      content: row.content,
      source: { kind: row.sourceKind as MemoryRecord['source']['kind'], reference: row.sourceReference ?? undefined, provider: row.sourceProvider ?? undefined },
      confidence: row.confidence,
      tags: row.tags,
      entities: (row.entities as unknown as MemoryRecord['entities']) ?? [],
      relatedIds,
      userId: row.userId,
      namespace: row.namespace,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      staleAfter: row.staleAfter ?? undefined,
      metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
    };
  }
}

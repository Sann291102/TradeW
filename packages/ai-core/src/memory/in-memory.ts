import { randomUUID } from 'crypto';
import { MemoryRecord, NewMemoryRecord } from '../domain/knowledge';
import { EmbeddingProvider } from '../providers/interfaces';
import { MemorySearchHit, MemorySearchQuery, MemoryStore, VectorStore } from './interfaces';

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Process-local vector index — dev/test double for the pgvector-backed store. */
export class InMemoryVectorStore implements VectorStore {
  private items = new Map<string, { vector: number[]; payload?: Record<string, unknown> }>();

  async upsert(items: { id: string; vector: number[]; payload?: Record<string, unknown> }[]): Promise<void> {
    for (const item of items) this.items.set(item.id, { vector: item.vector, payload: item.payload });
  }

  async query(vector: number[], limit: number, filter?: Record<string, unknown>): Promise<{ id: string; score: number }[]> {
    const scored: { id: string; score: number }[] = [];
    for (const [id, item] of this.items) {
      if (filter && !Object.entries(filter).every(([k, v]) => item.payload?.[k] === v)) continue;
      scored.push({ id, score: cosineSimilarity(vector, item.vector) });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async remove(ids: string[]): Promise<void> {
    for (const id of ids) this.items.delete(id);
  }
}

/**
 * In-memory MemoryStore for development and tests. The production
 * implementation (Prisma + pgvector) lives with the service that owns the
 * database connection; both satisfy the same contract.
 */
export class InMemoryMemoryStore implements MemoryStore {
  private records = new Map<string, MemoryRecord>();
  private vectors = new InMemoryVectorStore();

  constructor(private embedder: EmbeddingProvider) {}

  async store(record: NewMemoryRecord): Promise<MemoryRecord> {
    const now = new Date();
    const full: MemoryRecord = { ...record, id: randomUUID(), createdAt: now, updatedAt: now };
    this.records.set(full.id, full);
    const { embeddings } = await this.embedder.embed({
      texts: [`${full.summary}\n${full.content}`.slice(0, 8000)],
      inputType: 'document',
    });
    await this.vectors.upsert([{ id: full.id, vector: embeddings[0] }]);
    return full;
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return this.records.get(id) ?? null;
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchHit[]> {
    const { embeddings } = await this.embedder.embed({ texts: [query.text], inputType: 'query' });
    const candidates = await this.vectors.query(embeddings[0], (query.limit ?? 8) * 4);
    const hits: MemorySearchHit[] = [];
    const now = new Date();
    for (const c of candidates) {
      const record = this.records.get(c.id);
      if (!record) continue;
      if (query.minScore !== undefined && c.score < query.minScore) continue;
      if (query.namespace && record.namespace !== query.namespace) continue;
      if (query.userId !== undefined && record.userId !== null && record.userId !== query.userId) continue;
      if (query.tags?.length && !query.tags.some((t) => record.tags.includes(t))) continue;
      if (query.entityIds?.length && !record.entities.some((e) => query.entityIds!.includes(e.id))) continue;
      if (!query.includeStale && record.staleAfter && record.staleAfter < now) continue;
      hits.push({ record, score: c.score });
      if (hits.length >= (query.limit ?? 8)) break;
    }
    return hits;
  }

  async connect(idA: string, idB: string): Promise<void> {
    const a = this.records.get(idA);
    const b = this.records.get(idB);
    if (!a || !b) throw new Error(`connect: unknown record ${!a ? idA : idB}`);
    if (!a.relatedIds.includes(idB)) a.relatedIds.push(idB);
    if (!b.relatedIds.includes(idA)) b.relatedIds.push(idA);
  }

  async update(id: string, patch: Partial<NewMemoryRecord>): Promise<MemoryRecord> {
    const existing = this.records.get(id);
    if (!existing) throw new Error(`update: unknown record ${id}`);
    const updated: MemoryRecord = { ...existing, ...patch, id, updatedAt: new Date() };
    this.records.set(id, updated);
    return updated;
  }

  async stats(): Promise<{ total: number; byNamespace: Record<string, number> }> {
    const byNamespace: Record<string, number> = {};
    for (const r of this.records.values()) byNamespace[r.namespace] = (byNamespace[r.namespace] ?? 0) + 1;
    return { total: this.records.size, byNamespace };
  }
}

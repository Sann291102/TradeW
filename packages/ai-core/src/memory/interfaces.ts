import { MemoryRecord, NewMemoryRecord } from '../domain/knowledge';

/**
 * Memory Engine interfaces.
 *
 * Storage decision (locked Q4): local-first SQL (sqlite-vec or pgvector on the
 * existing Postgres) behind these interfaces — no Pinecone/Weaviate/Neo4j.
 * Implementations live in ai-core's infra layer; consumers only see these types.
 */

export interface MemorySearchQuery {
  /** natural-language query — embedded and searched semantically */
  text: string;
  /** restrict to a user's memory; null/undefined searches global namespace too */
  userId?: string | null;
  namespace?: string;
  tags?: string[];
  entityIds?: string[];
  limit?: number;
  /** drop results below this similarity (0..1) */
  minScore?: number;
  /** include records past their staleAfter date (default false) */
  includeStale?: boolean;
}

export interface MemorySearchHit {
  record: MemoryRecord;
  /** semantic similarity 0..1 */
  score: number;
}

export interface MemoryStore {
  store(record: NewMemoryRecord): Promise<MemoryRecord>;
  get(id: string): Promise<MemoryRecord | null>;
  search(query: MemorySearchQuery): Promise<MemorySearchHit[]>;
  /** create a bidirectional relation between two records (also mirrored to the graph) */
  connect(idA: string, idB: string, relation?: string): Promise<void>;
  /** update mutable fields (summary, confidence, tags, staleAfter, metadata) */
  update(id: string, patch: Partial<NewMemoryRecord>): Promise<MemoryRecord>;
  /** counts, for health/metrics — never used for retrieval */
  stats(): Promise<{ total: number; byNamespace: Record<string, number> }>;
}

/** Low-level vector index — MemoryStore implementations compose one of these. */
export interface VectorStore {
  upsert(items: { id: string; vector: number[]; payload?: Record<string, unknown> }[]): Promise<void>;
  query(vector: number[], limit: number, filter?: Record<string, unknown>): Promise<{ id: string; score: number }[]>;
  remove(ids: string[]): Promise<void>;
}

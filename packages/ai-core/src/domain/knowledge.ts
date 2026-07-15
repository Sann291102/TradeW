/**
 * Core knowledge domain types shared by Memory, Knowledge Graph, RAG and the Brain.
 *
 * Design contract (locked 2026-07-16):
 * - Everything eventually becomes memory: research results, documents, charts,
 *   indicator readings, conversations, market reports, journal entries.
 * - Every stored item carries provenance (source), confidence and timestamps so
 *   downstream consumers (Sentinel compliance logging, RAG ranking) can reason
 *   about trust and freshness.
 */

/** Where a piece of knowledge came from. */
export type KnowledgeSourceKind =
  | 'research' // web research result (Research Engine)
  | 'document' // user-imported document
  | 'chart' // chart snapshot / technical readout
  | 'indicator' // computed indicator observation
  | 'conversation' // user <-> AI interaction
  | 'market_report' // generated market report
  | 'trading_journal' // user's journal entry
  | 'task_output' // output of a completed AI task
  | 'observation' // Sentinel agent observation
  | 'system'; // seeded / internal

export interface KnowledgeSource {
  kind: KnowledgeSourceKind;
  /** e.g. URL for research, document id, conversation id */
  reference?: string;
  /** provider that produced it, if any (e.g. 'tavily', 'anthropic') */
  provider?: string;
}

/** 0..1 — how much the system trusts this item. */
export type Confidence = number;

export interface EntityRef {
  /** e.g. 'symbol', 'sector', 'concept', 'person', 'event', 'pattern' */
  type: string;
  /** canonical identifier, e.g. 'NSE:RELIANCE', 'concept:bull-trap' */
  id: string;
  label?: string;
}

/** A single unit of stored knowledge. */
export interface MemoryRecord {
  id: string;
  /** short human/LLM-readable summary — what gets retrieved first */
  summary: string;
  /** full content (may be long; chunked separately for embedding) */
  content: string;
  source: KnowledgeSource;
  confidence: Confidence;
  tags: string[];
  entities: EntityRef[];
  /** ids of related MemoryRecords (mirrored as graph edges) */
  relatedIds: string[];
  /** owning user, or null for global/shared knowledge */
  userId: string | null;
  /** logical namespace, e.g. 'sentinel', 'research', 'global' */
  namespace: string;
  createdAt: Date;
  updatedAt: Date;
  /** soft-expiry hint for time-sensitive knowledge (news, volatility regimes) */
  staleAfter?: Date;
  metadata?: Record<string, unknown>;
}

/** Input for creating a MemoryRecord (ids/timestamps assigned by the store). */
export type NewMemoryRecord = Omit<MemoryRecord, 'id' | 'createdAt' | 'updatedAt'>;

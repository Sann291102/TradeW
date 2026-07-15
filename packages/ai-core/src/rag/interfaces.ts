import { MemorySearchHit } from '../memory/interfaces';

/**
 * RAG Engine — retrieval + chunking contracts.
 * Retrieval composes MemoryStore (semantic) with KnowledgeGraph expansion;
 * the Brain and agents consume only this interface.
 */

export interface Chunk {
  text: string;
  index: number;
  /** id of the MemoryRecord the chunk belongs to */
  recordId?: string;
  metadata?: Record<string, unknown>;
}

export interface Chunker {
  chunk(text: string, options?: { maxTokens?: number; overlapTokens?: number }): Chunk[];
}

export interface RetrievalRequest {
  query: string;
  userId?: string | null;
  namespace?: string;
  limit?: number;
  /** expand results one hop through the knowledge graph (default true) */
  graphExpansion?: boolean;
}

export interface RetrievalResult {
  hits: MemorySearchHit[];
  /** records pulled in via graph relationships rather than direct similarity */
  graphHits: MemorySearchHit[];
  /** ready-to-inject context block, already ranked and token-budgeted */
  contextText: string;
}

export interface Retriever {
  retrieve(request: RetrievalRequest): Promise<RetrievalResult>;
}

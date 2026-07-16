import { Inject, Injectable } from '@nestjs/common';
import { MemoryStore, Retriever } from '@tradew/ai-core';
import { MEMORY_STORE, RETRIEVER } from './tokens';

/**
 * Knowledge Center — the queryable surface over everything the Brain has
 * learned. Thin by design: it composes the Retriever (semantic + graph
 * expansion) and the MemoryStore's own stats, rather than reimplementing
 * either.
 */
@Injectable()
export class KnowledgeCenterService {
  constructor(
    @Inject(RETRIEVER) private readonly retriever: Retriever,
    @Inject(MEMORY_STORE) private readonly memory: MemoryStore,
  ) {}

  async search(query: string, opts: { userId?: string | null; namespace?: string; limit?: number } = {}) {
    return this.retriever.retrieve({
      query,
      userId: opts.userId,
      namespace: opts.namespace,
      limit: opts.limit ?? 10,
    });
  }

  async stats() {
    return this.memory.stats();
  }
}

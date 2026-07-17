import { Inject, Injectable, Logger } from '@nestjs/common';
import { MemoryStore, Retriever } from '@tradew/ai-core';
import { MEMORY_STORE, RETRIEVER } from './tokens';

/**
 * Knowledge Center — the queryable surface over everything the Brain has
 * learned. Thin by design: it composes the Retriever (semantic + graph
 * expansion) and the MemoryStore's own stats, rather than reimplementing
 * either.
 *
 * Same degrade-not-crash posture as every other Brain service (Historical
 * Similarity, Market Context, Outcome Learning, ...): a database outage
 * must return an empty/zero result, never a 500.
 */
@Injectable()
export class KnowledgeCenterService {
  private readonly logger = new Logger(KnowledgeCenterService.name);

  constructor(
    @Inject(RETRIEVER) private readonly retriever: Retriever,
    @Inject(MEMORY_STORE) private readonly memory: MemoryStore,
  ) {}

  async search(query: string, opts: { userId?: string | null; namespace?: string; limit?: number } = {}) {
    try {
      return await this.retriever.retrieve({
        query,
        userId: opts.userId,
        namespace: opts.namespace,
        limit: opts.limit ?? 10,
      });
    } catch (err) {
      this.logger.warn(`brain search failed, returning empty result: ${err}`);
      return { hits: [], graphHits: [], contextText: '' };
    }
  }

  async stats() {
    try {
      return await this.memory.stats();
    } catch (err) {
      this.logger.warn(`brain stats lookup failed, returning zeroed result: ${err}`);
      return { total: 0, byNamespace: {} };
    }
  }
}

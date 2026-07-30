import { Inject, Injectable, Logger } from '@nestjs/common';
import { MemorySearchHit, MemoryStore } from '@tradew/ai-core';
import { MEMORY_STORE } from '../brain/tokens';
import { KnowledgeCacheService } from './knowledge-cache.service';
import { KnowledgeRankingService } from './knowledge-ranking.service';
import { REASONING_CONFIG, ReasoningConfig } from './reasoning.config';
import { RankedKnowledge, RetrievalRequest, RetrievalResult } from './types';

/**
 * Runtime knowledge retrieval — the composition layer over the existing
 * MemoryStore.
 *
 * The pre-Phase-1 Brain writes to namespace `sentinel` (pattern
 * occurrences, research results, prior explanations). Phase 1 writes to
 * `sentinel-learning` (book-derived concepts). Both namespaces contain
 * genuine market knowledge and both must be searchable at runtime — but
 * `MemoryStore.search()` accepts one namespace at a time, so this service
 * queries each configured namespace in parallel, deduplicates by record
 * id (a record only exists in one namespace anyway, but the dedup guards
 * future changes that might mirror), applies the multi-factor rank, and
 * returns the top-K.
 *
 * Every call goes through the cache. A downstream Brain outage on any
 * single namespace degrades to the other namespaces' hits with a log
 * warning — retrieval must never crash the reasoning path it sits under.
 */
@Injectable()
export class KnowledgeRetrievalService {
  private readonly logger = new Logger(KnowledgeRetrievalService.name);

  constructor(
    @Inject(MEMORY_STORE) private readonly memory: MemoryStore,
    @Inject(REASONING_CONFIG) private readonly config: ReasoningConfig,
    private readonly ranker: KnowledgeRankingService,
    private readonly cache: KnowledgeCacheService,
  ) {}

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const started = Date.now();
    const namespaces = request.namespaces ?? this.config.namespaces;
    const limit = request.limit ?? this.config.defaultLimit;
    const boostTags = request.hints?.boostTags ?? [];
    const key = KnowledgeCacheService.keyFor(request.query, namespaces, limit, boostTags);

    if (!request.bypassCache) {
      const cached = this.cache.get(key);
      if (cached) return cached;
    }

    const hits = await this.searchAcross(request.query, namespaces);
    const ranked = this.ranker.rank(hits, request.hints ?? {});
    const trimmed = ranked.slice(0, limit);

    const result: RetrievalResult = {
      query: request.query,
      items: trimmed,
      rawHitCount: hits.length,
      namespaces,
      cached: false,
      latencyMs: Date.now() - started,
    };
    this.cache.set(key, result);
    return result;
  }

  /**
   * Retrieval that targets a specific tag set — e.g. `domain:trading-psychology`
   * — so services that already know the shape of what they want don't have
   * to invent a semantic query.
   */
  async retrieveByTags(tags: string[], opts: { limit?: number; query?: string; namespaces?: string[] } = {}): Promise<RankedKnowledge[]> {
    const namespaces = opts.namespaces ?? this.config.namespaces;
    const query = opts.query ?? tags.map((t) => t.replace(/^[^:]+:/, '').replace(/-/g, ' ')).join(' ');
    const limit = opts.limit ?? this.config.defaultLimit;
    const hits = await this.searchAcross(query, namespaces, tags);
    return this.ranker.rank(hits, { boostTags: tags }).slice(0, limit);
  }

  invalidateCache(): number {
    return this.cache.invalidate();
  }

  private async searchAcross(query: string, namespaces: string[], tags?: string[]): Promise<MemorySearchHit[]> {
    const perNsLimit = this.config.perNamespaceLimit;
    const results = await Promise.all(
      namespaces.map(async (ns) => {
        try {
          return await this.memory.search({
            text: query,
            namespace: ns,
            tags,
            limit: perNsLimit,
          });
        } catch (err) {
          this.logger.warn(`retrieval failed on namespace ${ns} (non-fatal): ${(err as Error).message}`);
          return [] as MemorySearchHit[];
        }
      }),
    );
    return dedupeById(results.flat());
  }
}

function dedupeById(hits: MemorySearchHit[]): MemorySearchHit[] {
  const seen = new Map<string, MemorySearchHit>();
  for (const h of hits) {
    const existing = seen.get(h.record.id);
    // On duplicate, keep the higher-scoring copy — different namespace calls
    // could produce different similarity numbers if a record was mirrored.
    if (!existing || h.score > existing.score) seen.set(h.record.id, h);
  }
  return [...seen.values()];
}

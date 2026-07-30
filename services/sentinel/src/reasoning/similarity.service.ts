import { Injectable, Logger } from '@nestjs/common';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import { RankedKnowledge, SimilarityResult } from './types';

export type SimilaritySubject = 'strategy' | 'concept' | 'pattern' | 'psychology' | 'regime' | 'indicator';

const SUBJECT_TAGS: Record<SimilaritySubject, string[]> = {
  strategy: ['pattern_occurrence'],
  concept: [],
  pattern: ['pattern_occurrence', 'domain:patterns'],
  psychology: ['domain:trading-psychology'],
  regime: [],
  indicator: ['domain:technical-analysis'],
};

/**
 * Semantic similarity between conceptual objects.
 *
 * The Brain already indexes every stored memory by its embedding, so
 * "similar to X" is a semantic search whose query is the concept's own
 * label — no separate similarity model is needed. This service is the
 * type-safe wrapper that translates a `SimilaritySubject` into the right
 * tag filter and boost, so a caller asking for `similar('psychology',
 * 'fomo')` cannot accidentally pull an indicator note.
 *
 * Results are filtered to exclude the source id itself and re-ranked using
 * the standard multi-factor ranker via KnowledgeRetrievalService.
 */
@Injectable()
export class SimilarityService {
  private readonly logger = new Logger(SimilarityService.name);

  constructor(private readonly retrieval: KnowledgeRetrievalService) {}

  async similar(
    subject: SimilaritySubject,
    query: string,
    opts: { limit?: number; sourceId?: string } = {},
  ): Promise<SimilarityResult> {
    const started = Date.now();
    const subjectTags = SUBJECT_TAGS[subject] ?? [];
    const limit = opts.limit ?? 5;
    // Ask for extra so that filtering out the source id (if provided) still
    // leaves `limit` neighbours in the result.
    const overRequest = opts.sourceId ? limit + 3 : limit;

    let neighbours: RankedKnowledge[] = [];
    try {
      const result = await this.retrieval.retrieve({
        query,
        limit: overRequest,
        hints: { boostTags: subjectTags },
      });
      neighbours = result.items.filter((n) => n.hit.record.id !== opts.sourceId).slice(0, limit);
    } catch (err) {
      this.logger.warn(`similarity(${subject}, "${query}") failed non-fatally: ${(err as Error).message}`);
    }

    return {
      sourceId: opts.sourceId ?? '',
      neighbours,
      latencyMs: Date.now() - started,
    };
  }

  /**
   * Cross-domain similar concepts around a market snapshot description —
   * one call, one merged ranked list, useful for building the "supporting
   * concepts" section of an explanation.
   */
  async similarAcross(query: string, opts: { limit?: number } = {}): Promise<RankedKnowledge[]> {
    const result = await this.retrieval.retrieve({
      query,
      limit: opts.limit ?? 8,
    });
    return result.items;
  }
}

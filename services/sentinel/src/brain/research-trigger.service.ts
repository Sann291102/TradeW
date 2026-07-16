import { Inject, Injectable, Logger } from '@nestjs/common';
import { KnowledgeGraph, ProviderNotAvailableError, ResearchEngine } from '@tradew/ai-core';
import { KNOWLEDGE_GRAPH, RESEARCH_ENGINE } from './tokens';

/**
 * Continuous Research Engine — event-driven, never uncontrolled crawling
 * (locked decision from the original architecture review). Fires exactly
 * once per symbol Sentinel has never met before: checks the knowledge graph
 * first, and only researches when there's genuinely nothing there yet.
 * Silently no-ops when no research provider is configured — research is an
 * enhancement, never a dependency of the core observation flow.
 */
@Injectable()
export class ResearchTriggerService {
  private readonly logger = new Logger(ResearchTriggerService.name);

  constructor(
    @Inject(RESEARCH_ENGINE) private readonly research: ResearchEngine,
    @Inject(KNOWLEDGE_GRAPH) private readonly graph: KnowledgeGraph,
  ) {}

  async researchIfUnfamiliar(symbol: string): Promise<void> {
    try {
      const existing = await this.graph.getNode(`symbol:${symbol}`);
      if (existing) return; // already known — no re-crawling
      await this.research.run({
        query: `${symbol} stock company overview sector business fundamentals`,
        namespace: 'sentinel',
        learn: true,
        maxResults: 3,
      });
    } catch (err) {
      if (!(err instanceof ProviderNotAvailableError)) {
        this.logger.warn(`research trigger failed for ${symbol}: ${err}`);
      }
    }
  }
}

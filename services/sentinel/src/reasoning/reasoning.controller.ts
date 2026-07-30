import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ServiceTokenGuard } from '../app.controller';
import { ExplanationEngineService } from './explanation-engine.service';
import { KnowledgeCacheService } from './knowledge-cache.service';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import { PsychologyIntelligenceService } from './psychology-intelligence.service';
import { RegimeIntelligenceService } from './regime-intelligence.service';
import { SimilarityService } from './similarity.service';
import { StrategyKnowledgeService } from './strategy-knowledge.service';
import { ContextInput } from './types';

/**
 * HTTP surface for the Reasoning module. Same guard as every other
 * Sentinel controller: services/api is the only legitimate caller.
 *
 * Every endpoint is a *read* of Brain knowledge assembled through the
 * reasoning services — no endpoint here mutates state, no endpoint
 * generates buy/sell language.
 */
@UseGuards(ServiceTokenGuard)
@Controller('reasoning')
export class ReasoningController {
  constructor(
    private readonly retrieval: KnowledgeRetrievalService,
    private readonly psychology: PsychologyIntelligenceService,
    private readonly regime: RegimeIntelligenceService,
    private readonly similarity: SimilarityService,
    private readonly strategy: StrategyKnowledgeService,
    private readonly explanation: ExplanationEngineService,
    private readonly cache: KnowledgeCacheService,
  ) {}

  @Post('retrieve')
  retrieve(@Body() body: { query: string; namespaces?: string[]; limit?: number; boostTags?: string[]; userId?: string | null; bypassCache?: boolean }) {
    return this.retrieval.retrieve({
      query: body.query,
      namespaces: body.namespaces,
      limit: body.limit,
      hints: { boostTags: body.boostTags, userId: body.userId ?? null },
      bypassCache: body.bypassCache,
    });
  }

  @Post('similar')
  similar(@Body() body: { subject: 'strategy' | 'concept' | 'pattern' | 'psychology' | 'regime' | 'indicator'; query: string; limit?: number; sourceId?: string }) {
    return this.similarity.similar(body.subject, body.query, { limit: body.limit, sourceId: body.sourceId });
  }

  @Post('psychology/detect')
  psychologyDetect(@Body() body: { text: string; limit?: number }) {
    return this.psychology.detectAndFetch(body.text, { limit: body.limit });
  }

  @Post('regime/knowledge')
  regimeKnowledge(@Body() body: { regime: string; limit?: number; extraQuery?: string }) {
    const resolved = this.regime.classify(body.regime);
    return { regime: resolved, knowledge: this.regime.knowledgeFor(resolved, { limit: body.limit, extraQuery: body.extraQuery }) };
  }

  @Post('strategy/describe')
  strategyDescribe(@Body() body: { strategyId: string; strategyName: string; symbol?: string; regime?: string; bias?: 'bullish' | 'bearish' | 'neutral'; invalidations?: string[] }) {
    return this.strategy.describe({
      strategyId: body.strategyId,
      strategyName: body.strategyName,
      symbol: body.symbol,
      regime: this.regime.classify(body.regime ?? null),
      bias: body.bias,
      invalidations: body.invalidations,
    });
  }

  @Post('context')
  buildContext(@Body() body: ContextInput) {
    return this.explanation.explain(body);
  }

  @Post('explain')
  explain(@Body() body: ContextInput) {
    return this.explanation.explain(body);
  }

  @Post('explain/strategy')
  explainStrategy(@Body() body: { strategyId: string; strategyName: string; symbol?: string; regime?: string; bias?: 'bullish' | 'bearish' | 'neutral'; indicators?: string[] }) {
    return this.explanation.explainStrategy(body);
  }

  @Get('cache/stats')
  cacheStats() {
    return this.cache.stats();
  }

  @Post('cache/invalidate')
  cacheInvalidate() {
    const cleared = this.cache.invalidate();
    return { cleared };
  }
}

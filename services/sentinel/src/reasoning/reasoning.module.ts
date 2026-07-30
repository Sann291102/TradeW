import { Module } from '@nestjs/common';
import { ServiceTokenGuard } from '../app.controller';
import { ReasoningContextBuilderService } from './context-builder.service';
import { ExplanationEngineService } from './explanation-engine.service';
import { KnowledgeCacheService } from './knowledge-cache.service';
import { KnowledgeRankingService } from './knowledge-ranking.service';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import { PsychologyIntelligenceService } from './psychology-intelligence.service';
import { REASONING_CONFIG, loadReasoningConfig } from './reasoning.config';
import { ReasoningController } from './reasoning.controller';
import { RegimeIntelligenceService } from './regime-intelligence.service';
import { SimilarityService } from './similarity.service';
import { StrategyKnowledgeService } from './strategy-knowledge.service';
import { StrategyAdvisorService } from './strategy-advisor.service';
import { StrategyRegistryService } from '../learning/strategy-registry.service';

/**
 * Standalone module definition for the Reasoning stack.
 *
 * In production the providers are also registered flat in AppModule to
 * match Sentinel's convention and to keep DI simple, but this module lets
 * an isolated test spin up just the reasoning surface with mocked Brain
 * dependencies (MEMORY_STORE, MEMORY tokens) provided at the test-module
 * boundary. Nothing pre-existing needed a change.
 */
@Module({
  controllers: [ReasoningController],
  providers: [
    { provide: REASONING_CONFIG, useFactory: () => loadReasoningConfig() },
    ServiceTokenGuard,
    KnowledgeCacheService,
    KnowledgeRankingService,
    KnowledgeRetrievalService,
    SimilarityService,
    PsychologyIntelligenceService,
    RegimeIntelligenceService,
    StrategyKnowledgeService,
    ReasoningContextBuilderService,
    ExplanationEngineService,
    StrategyRegistryService,
    StrategyAdvisorService,
  ],
  exports: [
    KnowledgeCacheService,
    KnowledgeRankingService,
    KnowledgeRetrievalService,
    SimilarityService,
    PsychologyIntelligenceService,
    RegimeIntelligenceService,
    StrategyKnowledgeService,
    ReasoningContextBuilderService,
    ExplanationEngineService,
    StrategyAdvisorService,
  ],
})
export class ReasoningModule {}

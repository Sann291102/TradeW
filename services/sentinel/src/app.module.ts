import { Module } from '@nestjs/common';
import {
  DefaultLearningEngine,
  DefaultNeuralBrain,
  DefaultResearchEngine,
  DefaultRetriever,
  KnowledgeGraph,
  MemoryStore,
  NeuralBrain,
  ProviderManager,
  ResearchEngine,
  Retriever,
  SimpleContextManager,
  createProviderManager,
  loadProvidersConfigFromEnv,
} from '@tradew/ai-core';
import { AppController, ServiceTokenGuard } from './app.controller';
import { ConceptLearningEngine } from './brain/concept-learning.service';
import { HistoricalSimilarityService } from './brain/historical-similarity.service';
import { ConceptGraphService } from './brain/ontology/concept-graph.service';
import { ConceptReinforcementService } from './brain/ontology/concept-reinforcement.service';
import { OntologyLoaderService, resolveKnowledgeBaseDir } from './brain/ontology/ontology-loader.service';
import { KnowledgeCenterService } from './brain/knowledge-center.service';
import { MarketContextService } from './brain/market-context.service';
import { OutcomeLearningService } from './brain/outcome-learning.service';
import { PatternRecognitionService } from './brain/pattern-recognition.service';
import { PrismaKnowledgeGraph } from './brain/prisma-knowledge-graph';
import { PrismaMemoryStore } from './brain/prisma-memory-store';
import { ResearchTriggerService } from './brain/research-trigger.service';
import { StrategyIntelligenceService } from './brain/strategy-intelligence.service';
import {
  BASE_LEARNING_ENGINE,
  KNOWLEDGE_GRAPH,
  MEMORY_STORE,
  NEURAL_BRAIN,
  PROVIDER_MANAGER,
  RESEARCH_ENGINE,
  RETRIEVER,
} from './brain/tokens';
import { ComplianceService } from './compliance/compliance.service';
import { ConfidenceEngine } from './confidence/confidence.engine';
import { ExplainService } from './explain/explain.service';
import { AdaptiveCalibrationService } from './improvement/adaptive-calibration.service';
import { ContinuousImprovementService } from './improvement/continuous-improvement.service';
import { EmotionIntelligenceService } from './intelligence/emotion-intelligence.service';
import { MarketBehaviourService } from './intelligence/market-behaviour.service';
import { StrategyLifecycleService } from './strategy/strategy-lifecycle.service';
import { MARKET_DATA, MarketIntelligenceService } from './intelligence/market-intelligence.service';
import { MarketObservationService } from './intelligence/market-observation.service';
import { NewsIntelligenceService } from './intelligence/news-intelligence.service';
import { RiskIntelligenceService } from './intelligence/risk-intelligence.service';
import { StrategyEngineService } from './intelligence/strategy-engine.service';
import { TrapIntelligenceService } from './intelligence/trap-intelligence.service';
import { CandleMarketDataProvider } from './market-data/candle-market-data.provider';
import { MarketCloseAnalysisService } from './market-close/market-close-analysis.service';
import { ExecutionEvaluationService } from './execution/execution-evaluation.service';
import { SentinelOrchestratorService } from './orchestrator/sentinel-orchestrator.service';
import { PrismaService } from './prisma.service';
import { MarketStateMachineService } from './state-machine/state-machine.service';
import { MarketTimelineEngine } from './timeline/timeline.engine';
// ---- Learning module (books -> Brain) ----------------------------------
// Providers are registered flat in AppModule to match this service's
// convention and to give LearningModule's services direct access to the
// shared Brain providers (ConceptLearningEngine, OntologyLoaderService)
// without a separate module boundary. The standalone LearningModule
// definition is preserved for isolated tests but not imported here.
import { BookScannerService } from './learning/book-scanner.service';
import { BrainImportService } from './learning/brain-import.service';
import { ChunkingService } from './learning/chunking.service';
import { ConceptExtractionService } from './learning/concept-extraction.service';
import { DocumentParserService } from './learning/document-parser.service';
import { EmbeddingPipelineService } from './learning/embedding-pipeline.service';
import { IngestionQueueService } from './learning/ingestion-queue.service';
import { IngestionStateStore } from './learning/ingestion-state.store';
import { KnowledgeImportService } from './learning/knowledge-import.service';
import { LEARNING_CONFIG, loadLearningConfig } from './learning/learning.config';
import { LearningController } from './learning/learning.controller';
import { MetadataExtractionService } from './learning/metadata-extraction.service';
import { RelationshipExtractionService } from './learning/relationship-extraction.service';
import { StrategyRegistryService } from './learning/strategy-registry.service';
// ---- Learning Platform (Phase 4: generated courses/lessons/quizzes) ----
import { LearningPlatformController } from './learning/platform/learning-platform.controller';
import { ConceptSourceService } from './learning/platform/concept-source.service';
import { CourseGeneratorService } from './learning/platform/course-generator.service';
import { LessonGeneratorService } from './learning/platform/lesson-generator.service';
import { QuizGeneratorService } from './learning/platform/quiz-generator.service';
import { FlashcardGeneratorService } from './learning/platform/flashcard-generator.service';
import { LessonCacheService } from './learning/platform/lesson-cache.service';
import { AiTeacherService } from './learning/platform/ai-teacher.service';
// ---- Reasoning module (runtime knowledge use) --------------------------
// New in Phase 2. All services are pure composition on top of the Brain —
// no schema changes, no new persistence, no LLM calls. Registered flat
// alongside Learning to match the service's convention.
import { ReasoningContextBuilderService } from './reasoning/context-builder.service';
import { ExplanationEngineService } from './reasoning/explanation-engine.service';
import { KnowledgeCacheService } from './reasoning/knowledge-cache.service';
import { KnowledgeRankingService } from './reasoning/knowledge-ranking.service';
import { KnowledgeRetrievalService } from './reasoning/knowledge-retrieval.service';
import { PsychologyIntelligenceService } from './reasoning/psychology-intelligence.service';
import { REASONING_CONFIG, loadReasoningConfig } from './reasoning/reasoning.config';
import { ReasoningController } from './reasoning/reasoning.controller';
import { RegimeIntelligenceService } from './reasoning/regime-intelligence.service';
import { SimilarityService } from './reasoning/similarity.service';
import { StrategyKnowledgeService } from './reasoning/strategy-knowledge.service';
import { StrategyAdvisorService } from './reasoning/strategy-advisor.service';
// ---- SentinelIntelligence (new master reasoning engine) -----------------
// Strictly additive. It composes the same deterministic engines read-only and
// does NOT modify, wrap or replace SentinelOrchestratorService — /observe and
// its contract are untouched. Registered flat, like Learning and Reasoning
// above, so the whole process keeps one PrismaService and one market-data
// provider; the standalone SentinelIntelligenceModule exists for isolated
// tests and is deliberately not imported here.
import { SentinelIntelligenceController } from './sentinel-intelligence/sentinel-intelligence.controller';
import { SENTINEL_INTELLIGENCE_PROVIDERS } from './sentinel-intelligence/sentinel-intelligence.module';

const SENTINEL_BRAIN_SYSTEM_PROMPT =
  'You are the TradeW Sentinel Neural Brain — persistent market intelligence and trading-psychology memory. ' +
  'Answer from accumulated knowledge and say plainly when knowledge is missing or stale. ' +
  'Never give Buy, Sell, Entry, Exit, or Target advice — observations and education only.';

@Module({
  controllers: [
    AppController,
    LearningController,
    ReasoningController,
    LearningPlatformController,
    SentinelIntelligenceController,
  ],
  providers: [
    PrismaService,
    ServiceTokenGuard,
    // ---- Learning Pipeline (books → Brain) ----
    { provide: LEARNING_CONFIG, useFactory: () => loadLearningConfig() },
    BookScannerService,
    DocumentParserService,
    ChunkingService,
    MetadataExtractionService,
    ConceptExtractionService,
    RelationshipExtractionService,
    EmbeddingPipelineService,
    BrainImportService,
    KnowledgeImportService,
    IngestionStateStore,
    IngestionQueueService,
    StrategyRegistryService,
    // ---- Learning Platform (Phase 4) ----
    ConceptSourceService,
    CourseGeneratorService,
    LessonGeneratorService,
    QuizGeneratorService,
    FlashcardGeneratorService,
    LessonCacheService,
    AiTeacherService,
    // ---- Reasoning (runtime knowledge use) ----
    { provide: REASONING_CONFIG, useFactory: () => loadReasoningConfig() },
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
    // MarketDataProvider is injected by token — swapping simulation for
    // historical/NSE/BSE/Dhan later changes only this one binding (Q6).
    //
    // Bound to CandleMarketDataProvider, which is REAL DATA ONLY. Resolution
    // order is: the Dhan live-feed bridge (SENTINEL_LIVE_FEED_URL), then the
    // persisted `Candle` table, then nothing — it raises
    // MarketDataUnavailableError (HTTP 503) rather than substituting
    // simulated bars.
    //
    // NOTE: this comment previously described a simulator fallback. That tier
    // was REMOVED on 2026-07-26 because a complete, confident-looking
    // observation built on invented candles is worse than no observation, and
    // nothing in the response marked it as fabricated. The old standalone
    // simulator file is preserved at
    // archive/sentinel-sim-market-data.provider.ts.txt per CLAUDE.md Rule 1.
    { provide: MARKET_DATA, useClass: CandleMarketDataProvider },
    // ---- Sentinel Intelligence Core (SENTINEL_MASTER_PLAN.md §4) ----
    // Module 1 Market Intelligence, 2 Strategy Engine, 4 News, 6 Risk,
    // 7 Confidence, 8 Timeline, 9 State Machine, 11 Market Close,
    // 12 Continuous Improvement. Modules 3 (Historical) and 5 (Learning) are
    // served by the Brain providers below, and Module 10 (Vocabulary) is a
    // pure module applied by the orchestrator and explain service.
    MarketIntelligenceService,
    MarketObservationService,
    MarketBehaviourService,
    StrategyLifecycleService,
    EmotionIntelligenceService,
    TrapIntelligenceService,
    NewsIntelligenceService,
    StrategyEngineService,
    RiskIntelligenceService,
    ConfidenceEngine,
    MarketStateMachineService,
    MarketTimelineEngine,
    MarketCloseAnalysisService,
    ContinuousImprovementService,
    AdaptiveCalibrationService,
    ComplianceService,
    SentinelOrchestratorService,
    // Reads the orchestrator; never replaces or wraps it. Adds the three-strike
    // evaluation the paper-execution loop needs and the observe contract must
    // not carry — see execution/strike-candidates.ts.
    ExecutionEvaluationService,
    ExplainService,

    // ---- Persistent Knowledge Brain (Sentinel Brain Phase 1) ----
    // One shared ProviderManager instance for the Brain's dependents (the
    // orchestrator/news/explain services keep their own inline instances —
    // untouched, working code — this is deliberately scoped to new pieces).
    { provide: PROVIDER_MANAGER, useFactory: (): ProviderManager => createProviderManager(loadProvidersConfigFromEnv()) },
    { provide: MEMORY_STORE, useClass: PrismaMemoryStore },
    { provide: KNOWLEDGE_GRAPH, useClass: PrismaKnowledgeGraph },
    {
      provide: BASE_LEARNING_ENGINE,
      useFactory: (memory: MemoryStore, providers: ProviderManager, graph: KnowledgeGraph) =>
        new DefaultLearningEngine(memory, providers, graph),
      inject: [MEMORY_STORE, PROVIDER_MANAGER, KNOWLEDGE_GRAPH],
    },
    ConceptLearningEngine,
    {
      provide: RETRIEVER,
      useFactory: (memory: MemoryStore): Retriever => new DefaultRetriever(memory),
      inject: [MEMORY_STORE],
    },
    {
      provide: RESEARCH_ENGINE,
      useFactory: (providers: ProviderManager, learning: ConceptLearningEngine): ResearchEngine =>
        new DefaultResearchEngine(providers, learning),
      inject: [PROVIDER_MANAGER, ConceptLearningEngine],
    },
    {
      provide: NEURAL_BRAIN,
      useFactory: (
        providers: ProviderManager,
        retriever: Retriever,
        research: ResearchEngine,
        learning: ConceptLearningEngine,
      ): NeuralBrain =>
        new DefaultNeuralBrain({
          providers,
          retriever,
          research,
          learning,
          context: new SimpleContextManager(),
          systemPrompt: SENTINEL_BRAIN_SYSTEM_PROMPT,
        }),
      inject: [PROVIDER_MANAGER, RETRIEVER, RESEARCH_ENGINE, ConceptLearningEngine],
    },

    // ---- Sentinel Concept Knowledge Graph (the reasoning ontology) ----
    // Separate from the GraphNode/GraphEdge entity graph above: that one
    // records what co-occurred, this one records what things mean. See
    // docs/product-architecture/SENTINEL-KNOWLEDGE-GRAPH.md.
    ConceptGraphService,
    ConceptReinforcementService,
    {
      // The loader reads from disk and needs the knowledge-base path resolved
      // once at boot rather than on every call.
      provide: OntologyLoaderService,
      useFactory: () => new OntologyLoaderService(resolveKnowledgeBaseDir()),
    },

    KnowledgeCenterService,
    PatternRecognitionService,
    HistoricalSimilarityService,
    MarketContextService,
    ResearchTriggerService,
    OutcomeLearningService,
    StrategyIntelligenceService,

    // ---- SentinelIntelligence ----
    // The full provider set lives in sentinel-intelligence.module.ts so the
    // list has one owner; spreading it here keeps the shared infrastructure
    // above (PrismaService, MARKET_DATA, the intelligence engines) as the
    // single instances that module's services resolve against.
    ...SENTINEL_INTELLIGENCE_PROVIDERS,
  ],
})
export class AppModule {}

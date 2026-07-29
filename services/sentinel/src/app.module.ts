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
import { ContinuousImprovementService } from './improvement/continuous-improvement.service';
import { EmotionIntelligenceService } from './intelligence/emotion-intelligence.service';
import { MARKET_DATA, MarketIntelligenceService } from './intelligence/market-intelligence.service';
import { NewsIntelligenceService } from './intelligence/news-intelligence.service';
import { RiskIntelligenceService } from './intelligence/risk-intelligence.service';
import { StrategyEngineService } from './intelligence/strategy-engine.service';
import { TrapIntelligenceService } from './intelligence/trap-intelligence.service';
import { CandleMarketDataProvider } from './market-data/candle-market-data.provider';
import { MarketCloseAnalysisService } from './market-close/market-close-analysis.service';
import { SentinelOrchestratorService } from './orchestrator/sentinel-orchestrator.service';
import { PrismaService } from './prisma.service';
import { MarketStateMachineService } from './state-machine/state-machine.service';
import { MarketTimelineEngine } from './timeline/timeline.engine';

const SENTINEL_BRAIN_SYSTEM_PROMPT =
  'You are the TradeW Sentinel Neural Brain — persistent market intelligence and trading-psychology memory. ' +
  'Answer from accumulated knowledge and say plainly when knowledge is missing or stale. ' +
  'Never give Buy, Sell, Entry, Exit, or Target advice — observations and education only.';

@Module({
  controllers: [AppController],
  providers: [
    PrismaService,
    ServiceTokenGuard,
    // MarketDataProvider is injected by token — swapping simulation for
    // historical/NSE/BSE/Dhan later changes only this one binding (Q6).
    //
    // Now bound to CandleMarketDataProvider: real persisted `Candle` history
    // (backfilled from Dhan) for getCandles when rows exist, and the shared
    // @tradew/market-data simulator for everything else and as the fallback.
    // This is the seam finally carrying real data — Trap Detection and every
    // candle-derived signal run on real market history for backfilled symbols,
    // while an un-backfilled symbol or an absent Postgres degrades cleanly to
    // simulation so Sentinel never loses the ability to observe (PrismaService
    // fault-tolerance). The old standalone simulator file is preserved at
    // archive/sentinel-sim-market-data.provider.ts.txt per CLAUDE.md Rule 1.
    { provide: MARKET_DATA, useClass: CandleMarketDataProvider },
    // ---- Sentinel Intelligence Core (SENTINEL_MASTER_PLAN.md §4) ----
    // Module 1 Market Intelligence, 2 Strategy Engine, 4 News, 6 Risk,
    // 7 Confidence, 8 Timeline, 9 State Machine, 11 Market Close,
    // 12 Continuous Improvement. Modules 3 (Historical) and 5 (Learning) are
    // served by the Brain providers below, and Module 10 (Vocabulary) is a
    // pure module applied by the orchestrator and explain service.
    MarketIntelligenceService,
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
    ComplianceService,
    SentinelOrchestratorService,
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
  ],
})
export class AppModule {}

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
import { ExplainService } from './explain/explain.service';
import { EmotionIntelligenceService } from './intelligence/emotion-intelligence.service';
import { MARKET_DATA, MarketIntelligenceService } from './intelligence/market-intelligence.service';
import { NewsIntelligenceService } from './intelligence/news-intelligence.service';
import { TrapIntelligenceService } from './intelligence/trap-intelligence.service';
import { CandleMarketDataProvider } from './market-data/candle-market-data.provider';
import { SentinelOrchestratorService } from './orchestrator/sentinel-orchestrator.service';
import { PrismaService } from './prisma.service';

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
    MarketIntelligenceService,
    EmotionIntelligenceService,
    TrapIntelligenceService,
    NewsIntelligenceService,
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

import { Module, type Provider } from '@nestjs/common';
import { ServiceTokenGuard } from '../app.controller';
import { OntologyLoaderService, resolveKnowledgeBaseDir } from '../brain/ontology/ontology-loader.service';
import { DocumentParserService } from '../learning/document-parser.service';
import { MARKET_DATA, MarketIntelligenceService } from '../intelligence/market-intelligence.service';
import { EmotionIntelligenceService } from '../intelligence/emotion-intelligence.service';
import { NewsIntelligenceService } from '../intelligence/news-intelligence.service';
import { RiskIntelligenceService } from '../intelligence/risk-intelligence.service';
import { StrategyEngineService } from '../intelligence/strategy-engine.service';
import { TrapIntelligenceService } from '../intelligence/trap-intelligence.service';
import { CandleMarketDataProvider } from '../market-data/candle-market-data.provider';
import { PrismaService } from '../prisma.service';
import { AgentRegistryService } from './agents/agent-registry.service';
import { ComplianceIntelligenceAgent } from './agents/compliance-intelligence.agent';
import { EmotionIntelligenceAgent } from './agents/emotion-intelligence.agent';
import { HistoricalPatternIntelligenceAgent } from './agents/historical-pattern-intelligence.agent';
import { LearningIntelligenceAgent } from './agents/learning-intelligence.agent';
import { MarketIntelligenceAgent } from './agents/market-intelligence.agent';
import { NewsIntelligenceAgent } from './agents/news-intelligence.agent';
import { OptionsChainIntelligenceAgent } from './agents/options-chain-intelligence.agent';
import { RiskIntelligenceAgent } from './agents/risk-intelligence.agent';
import { StrategyIntelligenceAgent } from './agents/strategy-intelligence.agent';
import { TrapIntelligenceAgent } from './agents/trap-intelligence.agent';
import { CorpusIngestionService } from './knowledge/corpus-ingestion.service';
import { CorpusScannerService } from './knowledge/corpus-scanner.service';
import { KnowledgeIndexService } from './knowledge/knowledge-index.service';
import { ReasoningGraphService } from './knowledge/reasoning-graph.service';
import { SentinelIntelligenceController } from './sentinel-intelligence.controller';
import { SentinelIntelligenceService } from './sentinel-intelligence.service';
import { SI_CONFIG, loadSentinelIntelligenceConfig } from './si.config';
import { CrossCheckService } from './synthesis/cross-check.service';
import { SynthesisService } from './synthesis/synthesis.service';
import { RequestParserService } from './understanding/request-parser.service';
import { TaskDecomposerService } from './understanding/task-decomposer.service';
import { AnnotationEngineService } from './visual/annotation-engine.service';
import { TradingViewRuleService } from './visual/tradingview-rule.service';
import { WorkspaceService } from './visual/workspace.service';

/**
 * Injection token for this module's own ontology-loader instance.
 *
 * Declared before the provider array below, not after: the array references it
 * during module evaluation, and a `const` declared later sits in the temporal
 * dead zone at that moment.
 */
export const SI_ONTOLOGY_LOADER = 'SI_ONTOLOGY_LOADER';

/**
 * Every provider SentinelIntelligence owns.
 *
 * Exported as a plain array so `AppModule` can register them flat — the
 * convention this service already uses for the Learning and Reasoning modules
 * (see the comment block in `app.module.ts`). Registering flat matters here for
 * a concrete reason: it keeps ONE `PrismaService` and ONE market-data provider
 * across the whole process. A nested module with its own copies would open a
 * second Postgres pool and a second broker feed connection, and the market-data
 * feed is explicitly a per-account singleton resource
 * (`knowledge/Patterns/2026-07-21 - Market data Phase 1`).
 */
export const SENTINEL_INTELLIGENCE_PROVIDERS: Provider[] = [
  { provide: SI_CONFIG, useFactory: () => loadSentinelIntelligenceConfig() },

  // ---- knowledge substrate (corpus → index → grounded ontology) ----
  CorpusScannerService,
  KnowledgeIndexService,
  {
    // The loader reads YAML from disk and wants its root resolved once, at
    // construction, rather than on every ontology rebuild. Same factory shape
    // AppModule already uses for the Brain's own copy.
    provide: SI_ONTOLOGY_LOADER,
    useFactory: () => new OntologyLoaderService(resolveKnowledgeBaseDir()),
  },
  {
    provide: ReasoningGraphService,
    useFactory: (ontology: OntologyLoaderService, index: KnowledgeIndexService) =>
      new ReasoningGraphService(ontology, index),
    inject: [SI_ONTOLOGY_LOADER, KnowledgeIndexService],
  },
  CorpusIngestionService,

  // ---- understanding ----
  RequestParserService,
  TaskDecomposerService,

  // ---- the ten specialist agents ----
  MarketIntelligenceAgent,
  StrategyIntelligenceAgent,
  NewsIntelligenceAgent,
  OptionsChainIntelligenceAgent,
  RiskIntelligenceAgent,
  EmotionIntelligenceAgent,
  TrapIntelligenceAgent,
  HistoricalPatternIntelligenceAgent,
  ComplianceIntelligenceAgent,
  LearningIntelligenceAgent,
  AgentRegistryService,

  // ---- validation, conflict resolution, gating ----
  CrossCheckService,
  SynthesisService,

  // ---- visual strategy workspace ----
  TradingViewRuleService,
  AnnotationEngineService,
  WorkspaceService,

  SentinelIntelligenceService,
];

/**
 * Standalone module for isolated tests and for running SentinelIntelligence
 * without the rest of the Sentinel service.
 *
 * Mirrors the pattern `LearningModule` established: the standalone definition
 * exists so the module can be booted on its own in a test, while production
 * registers the providers flat in `AppModule`. Because this definition has to
 * stand alone, it declares the shared infrastructure (`PrismaService`, the
 * market-data binding, the reused intelligence engines) itself — which is
 * exactly why it must NOT also be imported by `AppModule`, or those become
 * duplicated.
 */
@Module({
  controllers: [SentinelIntelligenceController],
  providers: [
    PrismaService,
    ServiceTokenGuard,
    DocumentParserService,
    { provide: MARKET_DATA, useClass: CandleMarketDataProvider },
    MarketIntelligenceService,
    StrategyEngineService,
    TrapIntelligenceService,
    EmotionIntelligenceService,
    NewsIntelligenceService,
    RiskIntelligenceService,
    ...SENTINEL_INTELLIGENCE_PROVIDERS,
  ],
  exports: [SentinelIntelligenceService, WorkspaceService, TradingViewRuleService],
})
export class SentinelIntelligenceModule {}

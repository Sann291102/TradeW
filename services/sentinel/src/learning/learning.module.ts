import { Module } from '@nestjs/common';
import { ServiceTokenGuard } from '../app.controller';
import { BookScannerService } from './book-scanner.service';
import { BrainImportService } from './brain-import.service';
import { ChunkingService } from './chunking.service';
import { ConceptExtractionService } from './concept-extraction.service';
import { DocumentParserService } from './document-parser.service';
import { EmbeddingPipelineService } from './embedding-pipeline.service';
import { IngestionQueueService } from './ingestion-queue.service';
import { IngestionStateStore } from './ingestion-state.store';
import { KnowledgeImportService } from './knowledge-import.service';
import { LEARNING_CONFIG, loadLearningConfig } from './learning.config';
import { LearningController } from './learning.controller';
import { MetadataExtractionService } from './metadata-extraction.service';
import { RelationshipExtractionService } from './relationship-extraction.service';
import { StrategyRegistryService } from './strategy-registry.service';

/**
 * Learning Module — imported by AppModule.
 *
 * Brain dependencies (ConceptLearningEngine, OntologyLoaderService) are
 * NOT re-declared here — they must be resolvable from AppModule. This module
 * only owns pipeline services and the pipeline's own queue/state, which is
 * what enforces the "vault upstream, Brain runtime" separation at the DI
 * layer: nothing in this module can reach past the ConceptLearningEngine
 * facade to touch pgvector, GraphNode, or ConceptNode directly.
 *
 * ServiceTokenGuard is stateless (it reads SERVICE_TOKEN from env on every
 * call), so a per-module provider entry is functionally identical to reusing
 * the AppModule instance — no accidental shared-state hazard.
 */
@Module({
  controllers: [LearningController],
  providers: [
    { provide: LEARNING_CONFIG, useFactory: () => loadLearningConfig() },
    ServiceTokenGuard,
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
  ],
  exports: [
    BookScannerService,
    ChunkingService,
    ConceptExtractionService,
    RelationshipExtractionService,
    KnowledgeImportService,
    IngestionQueueService,
    StrategyRegistryService,
  ],
})
export class LearningModule {}

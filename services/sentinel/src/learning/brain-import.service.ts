import { Injectable, Logger } from '@nestjs/common';
import { EmbeddingPipelineService } from './embedding-pipeline.service';
import { Chunk, ExtractedConcept, IngestionMetrics, RelationshipProposal } from './types';

export interface BrainImportOutcome {
  chunksImported: number;
  memoryRecordsWritten: number;
  conceptsTagged: number;
  relationshipsRecorded: number;
  errors: string[];
}

/**
 * Brain Import Service — writes the outputs of the extraction stages into
 * the runtime Brain.
 *
 * Only two things reach the Brain here:
 *   1. MemoryRecords (via EmbeddingPipeline → ConceptLearningEngine.ingest)
 *   2. Structural graph edges (via ConceptLearningEngine, which already
 *      writes `mentions` + `co_occurs_with` for entities on ingest)
 *
 * What does NOT reach the Brain from this service:
 *   - New canonical concept nodes (`knowledge-base/` YAML promotion is a
 *     manual step)
 *   - Concept-graph relations (the 13-type reasoning vocabulary — those are
 *     surfaced as RelationshipProposals for review, never auto-applied)
 *   - Executable strategy rules (code changes only)
 *
 * That boundary is the whole point of the Learning module: books enrich the
 * Brain's retrieval and grounding, but they never rewrite its structured
 * knowledge without human review.
 */
@Injectable()
export class BrainImportService {
  private readonly logger = new Logger(BrainImportService.name);

  constructor(private readonly embedding: EmbeddingPipelineService) {}

  async importChunks(
    chunks: Chunk[],
    conceptsPerChunk: Map<string, ExtractedConcept[]>,
    _relationshipsPerChunk: Map<string, RelationshipProposal[]>,
    extraTags: string[] = [],
  ): Promise<BrainImportOutcome> {
    let memoryRecordsWritten = 0;
    let conceptsTagged = 0;
    let chunksImported = 0;
    let relationshipsRecorded = 0;
    const errors: string[] = [];

    for (const chunk of chunks) {
      const concepts = conceptsPerChunk.get(chunk.id) ?? [];
      try {
        const result = await this.embedding.embed(chunk, concepts, extraTags);
        chunksImported += 1;
        memoryRecordsWritten += result.records.length;
        conceptsTagged += result.taggedConcepts.length;
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        errors.push(`chunk ${chunk.id}: ${message}`);
        this.logger.warn(`failed to import chunk ${chunk.id}: ${message}`);
      }
    }

    // Proposals stay outside the Brain — we count them so operators see them
    // in the metrics, but no edge is written to the concept graph.
    for (const proposals of _relationshipsPerChunk.values()) {
      relationshipsRecorded += proposals.length;
    }

    return {
      chunksImported,
      memoryRecordsWritten,
      conceptsTagged,
      relationshipsRecorded,
      errors,
    };
  }
}

export function foldOutcomeIntoMetrics(outcome: BrainImportOutcome, metrics: IngestionMetrics): void {
  metrics.memoryRecordsWritten += outcome.memoryRecordsWritten;
  // graphNodes/graphEdges are written internally by ConceptLearningEngine.
  // We approximate their count from the concept tags for reporting; the
  // canonical counts live in the Brain itself and can be queried there.
  metrics.graphNodesWritten += outcome.conceptsTagged;
  metrics.graphEdgesWritten += outcome.conceptsTagged; // one `mentions` edge per tag
}

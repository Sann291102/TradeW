import { Inject, Injectable, Logger } from '@nestjs/common';
import { LearnInput, MemoryRecord } from '@tradew/ai-core';
import { ConceptLearningEngine } from '../brain/concept-learning.service';
import { LEARNING_CONFIG, LearningConfig } from './learning.config';
import { Chunk, ExtractedConcept } from './types';

export interface EmbeddingResult {
  chunkId: string;
  records: MemoryRecord[];
  /** Concept ids the chunk was tagged with (for graph linkage). */
  taggedConcepts: string[];
}

/**
 * Embedding Pipeline — turns a chunk into MemoryRecord(s) in the Brain.
 *
 * This service does NOT reimplement embedding. Embedding, summarisation and
 * storage are already the responsibility of the Brain's DefaultLearningEngine
 * (via a configured ProviderManager and the pgvector MemoryStore). This
 * pipeline is the thin composition layer that:
 *   1. Builds a LearnInput with the right namespace/tags/sourceReference
 *   2. Calls ConceptLearningEngine.ingest with concept hints, so the graph
 *      layer gets structured entities rather than regex-scraped tokens
 *   3. Returns the created records for the caller to sum into metrics
 *
 * The Brain's own de-dup + summarisation logic runs unchanged.
 */
@Injectable()
export class EmbeddingPipelineService {
  private readonly logger = new Logger(EmbeddingPipelineService.name);

  constructor(
    private readonly conceptLearning: ConceptLearningEngine,
    @Inject(LEARNING_CONFIG) private readonly config: LearningConfig,
  ) {}

  async embed(chunk: Chunk, concepts: ExtractedConcept[], extraTags: string[] = []): Promise<EmbeddingResult> {
    const sourceReference = this.buildSourceReference(chunk);
    const input: LearnInput = {
      kind: 'document_imported',
      content: chunk.text,
      namespace: this.config.namespace,
      sourceReference,
      tags: this.buildTags(chunk, concepts, extraTags),
      userId: null,
    };

    // Hints: patterns for extracted concept ids, sectors omitted (a book
    // usually names none), symbols omitted (a book is not about a symbol).
    const patterns = concepts.map((c) => c.conceptId);
    const records = await this.conceptLearning.ingest(input, { patterns });

    return {
      chunkId: chunk.id,
      records,
      taggedConcepts: concepts.map((c) => c.conceptId),
    };
  }

  private buildSourceReference(chunk: Chunk): string {
    const bookPath = chunk.book.relativePath;
    const section = chunk.section ? `#${slug(chunk.section.title)}` : '';
    return `book:${bookPath}${section}#chunk-${chunk.index}`;
  }

  private buildTags(chunk: Chunk, concepts: ExtractedConcept[], extraTags: string[]): string[] {
    const tags = new Set<string>();
    tags.add(`namespace:${this.config.namespace}`);
    tags.add(`source:book`);
    tags.add(`book:${chunk.book.relativePath}`);
    tags.add(`kind:${chunk.book.kind}`);
    if (chunk.section) tags.add(`section:${slug(chunk.section.title)}`);
    for (const c of concepts) {
      tags.add(`concept:${c.conceptId}`);
      tags.add(`domain:${c.domain}`);
    }
    for (const t of extraTags) tags.add(t);
    return [...tags];
  }
}

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

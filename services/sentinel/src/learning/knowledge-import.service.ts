import { Injectable, Logger } from '@nestjs/common';
import { BookScannerService } from './book-scanner.service';
import { BrainImportService, foldOutcomeIntoMetrics } from './brain-import.service';
import { ChunkingService } from './chunking.service';
import { ConceptExtractionService } from './concept-extraction.service';
import { DocumentParserService } from './document-parser.service';
import { MetadataExtractionService } from './metadata-extraction.service';
import { RelationshipExtractionService } from './relationship-extraction.service';
import {
  Chunk,
  EMPTY_METRICS,
  ExtractedConcept,
  IngestionJob,
  IngestionMetrics,
  RelationshipProposal,
} from './types';

export interface IngestionRunResult {
  metrics: IngestionMetrics;
  proposals: RelationshipProposal[];
  errors: string[];
}

/**
 * Knowledge Import Service — the end-to-end orchestrator for a single book.
 *
 * Sequences: parse → metadata → chunk → per-chunk concept extract → per-chunk
 * relationship extract → brain import. Every stage updates the job so a
 * consumer polling `/learning/jobs/<id>` sees progress in real time, and a
 * failure at any stage marks the job `failed` with the exact stage in the
 * error message rather than a generic "ingest failed".
 */
@Injectable()
export class KnowledgeImportService {
  private readonly logger = new Logger(KnowledgeImportService.name);

  constructor(
    private readonly scanner: BookScannerService,
    private readonly parser: DocumentParserService,
    private readonly chunker: ChunkingService,
    private readonly metadata: MetadataExtractionService,
    private readonly concepts: ConceptExtractionService,
    private readonly relationships: RelationshipExtractionService,
    private readonly brain: BrainImportService,
  ) {}

  async run(job: IngestionJob, onProgress?: (job: IngestionJob) => void): Promise<IngestionRunResult> {
    const started = Date.now();
    const metrics: IngestionMetrics = { ...EMPTY_METRICS };
    const errors: string[] = [];
    const proposals: RelationshipProposal[] = [];

    const book = this.scanner.find(job.bookRelativePath);
    if (!book) {
      throw new Error(`book not found in books directory: ${job.bookRelativePath}`);
    }
    if (book.checksum !== job.bookChecksum) {
      throw new Error(
        `book checksum changed since job was queued: expected ${job.bookChecksum}, found ${book.checksum}`,
      );
    }

    // --- parse ------------------------------------------------------------
    job.status = 'parsing';
    onProgress?.(job);
    const doc = await this.parser.parse(book);
    const meta = this.metadata.extract(doc);
    metrics.pagesParsed = doc.pageCount ?? 0;
    metrics.charactersExtracted = doc.text.length;

    if (!meta.hasText) {
      // Empty text is a legitimate outcome for image-only PDFs — still mark
      // the job done so it doesn't loop, and record zero metrics.
      metrics.durationMs = Date.now() - started;
      return { metrics, proposals, errors: [`no extractable text in ${book.relativePath} — likely a scanned/image PDF`] };
    }

    // --- chunk ------------------------------------------------------------
    job.status = 'chunking';
    onProgress?.(job);
    const chunks = this.chunker.chunk(doc);
    metrics.chunksCreated = chunks.length;
    if (chunks.length === 0) {
      metrics.durationMs = Date.now() - started;
      return { metrics, proposals, errors: [`text too short for any chunk to meet minChunkChars (${meta.wordCount} words)`] };
    }

    // --- extract concepts + relationships ---------------------------------
    job.status = 'extracting';
    onProgress?.(job);
    const conceptsPerChunk = new Map<string, ExtractedConcept[]>();
    const relationshipsPerChunk = new Map<string, RelationshipProposal[]>();

    for (const chunk of chunks) {
      const extracted = this.concepts.extract(chunk);
      conceptsPerChunk.set(chunk.id, extracted);
      metrics.conceptsExtracted += extracted.length;

      const rel = this.relationships.extract(chunk, extracted);
      relationshipsPerChunk.set(chunk.id, rel);
      metrics.relationshipsProposed += rel.length;
      proposals.push(...rel);
    }

    // --- import to brain --------------------------------------------------
    job.status = 'importing';
    onProgress?.(job);
    const extraTags = meta.derivedTags;
    const outcome = await this.brain.importChunks(chunks, conceptsPerChunk, relationshipsPerChunk, extraTags);
    foldOutcomeIntoMetrics(outcome, metrics);
    errors.push(...outcome.errors);

    metrics.durationMs = Date.now() - started;
    return { metrics, proposals, errors };
  }

  /** Convenience: build a fresh IngestionJob for a book path relative to the books dir. */
  buildJob(bookRelativePath: string): IngestionJob {
    const book = this.scanner.find(bookRelativePath);
    if (!book) throw new Error(`book not found: ${bookRelativePath}`);
    const jobId = `job_${book.checksum.slice(0, 10)}_${Date.now().toString(36)}`;
    return {
      jobId,
      bookRelativePath: book.relativePath,
      bookChecksum: book.checksum,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      metrics: { ...EMPTY_METRICS },
    };
  }

  /** Chunk a book in-memory without importing — used by the dry-run endpoint. */
  async previewChunks(bookRelativePath: string): Promise<{ chunks: Chunk[]; wordCount: number }> {
    const book = this.scanner.find(bookRelativePath);
    if (!book) throw new Error(`book not found: ${bookRelativePath}`);
    const doc = await this.parser.parse(book);
    const meta = this.metadata.extract(doc);
    const chunks = this.chunker.chunk(doc);
    return { chunks, wordCount: meta.wordCount };
  }
}

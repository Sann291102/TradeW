import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ServiceTokenGuard } from '../app.controller';
import { BookScannerService } from './book-scanner.service';
import { ConceptExtractionService } from './concept-extraction.service';
import { IngestionQueueService } from './ingestion-queue.service';
import { KnowledgeImportService } from './knowledge-import.service';
import { StrategyRegistryService } from './strategy-registry.service';

/**
 * HTTP surface for the Learning module. Every endpoint is behind the
 * ServiceTokenGuard so only services/api (holder of SENTINEL_SERVICE_TOKEN)
 * can trigger ingestion — no direct browser access.
 */
@UseGuards(ServiceTokenGuard)
@Controller('learning')
export class LearningController {
  constructor(
    private readonly scanner: BookScannerService,
    private readonly queue: IngestionQueueService,
    private readonly importer: KnowledgeImportService,
    private readonly concepts: ConceptExtractionService,
    private readonly registry: StrategyRegistryService,
  ) {}

  /**
   * Educational strategy registry — the catalogue that drives the Sentinel
   * strategy selector. `exposed=true` returns only the strategies enabled for
   * the UI today; the full set is available for tooling. Fields are trimmed to
   * what a selector needs plus the educational payload for a details view.
   */
  @Get('strategies')
  strategies(@Query('exposed') exposed?: string) {
    const exposedOnly = exposed === undefined ? true : exposed === 'true';
    const strategies = this.registry.list({ exposedOnly });
    return {
      count: strategies.length,
      strategies: strategies.map((s) => ({
        id: s.id,
        name: s.name,
        detectionStrategyId: s.detectionStrategyId,
        exposed: s.exposed,
        order: s.order,
        purpose: s.purpose,
        marketConditions: s.marketConditions,
        timeframes: s.timeframes,
        requiredIndicators: s.requiredIndicators,
        riskConsiderations: s.riskConsiderations,
        confidenceFactors: s.confidenceFactors,
        whenNotToUse: s.whenNotToUse,
        educational: s.educational,
        regimes: s.regimes,
      })),
    };
  }

  /** Books discovered on disk under SENTINEL_BOOKS_DIR (default docs/Trading Books). */
  @Get('books')
  listBooks() {
    const books = this.scanner.scan();
    return {
      count: books.length,
      books: books.map((b) => ({
        title: b.title,
        relativePath: b.relativePath,
        kind: b.kind,
        sizeBytes: b.sizeBytes,
        checksum: b.checksum,
      })),
    };
  }

  /** Every ingestion job the state file remembers, oldest first. */
  @Get('jobs')
  listJobs() {
    return { jobs: this.queue.listJobs(), depth: this.queue.queueDepth() };
  }

  @Get('jobs/:id')
  getJob(@Param('id') id: string) {
    const job = this.queue.getJob(id);
    if (!job) return { found: false };
    return { found: true, job };
  }

  /** Enqueue one book (relative path within the books dir). */
  @Post('ingest')
  @HttpCode(HttpStatus.ACCEPTED)
  enqueueOne(@Body() body: { bookRelativePath: string }) {
    const job = this.queue.enqueue(body.bookRelativePath);
    return { enqueued: true, jobId: job.jobId, status: job.status };
  }

  /** Enqueue every book with no completed job for its current checksum. */
  @Post('ingest-all')
  @HttpCode(HttpStatus.ACCEPTED)
  enqueueAll() {
    const jobs = this.queue.enqueueAll();
    return {
      enqueued: jobs.length,
      jobIds: jobs.map((j) => j.jobId),
      depth: this.queue.queueDepth(),
    };
  }

  /** Dry-run: parse + chunk a book without touching the Brain. Useful for tuning chunk size. */
  @Get('preview')
  async preview(@Query('bookRelativePath') bookRelativePath: string) {
    const { chunks, wordCount } = await this.importer.previewChunks(bookRelativePath);
    return {
      bookRelativePath,
      wordCount,
      chunkCount: chunks.length,
      firstChunk: chunks[0]
        ? {
            id: chunks[0].id,
            approxTokens: chunks[0].approxTokens,
            section: chunks[0].section?.title ?? null,
            preview: chunks[0].text.slice(0, 400),
          }
        : null,
    };
  }

  /** How many concepts the extraction index currently knows about. */
  @Get('index/stats')
  indexStats() {
    return { conceptCount: this.concepts.size() };
  }
}

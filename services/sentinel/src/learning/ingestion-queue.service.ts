import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BookScannerService } from './book-scanner.service';
import { IngestionStateStore } from './ingestion-state.store';
import { KnowledgeImportService } from './knowledge-import.service';
import { LEARNING_CONFIG, LearningConfig } from './learning.config';
import { EMPTY_METRICS, IngestionJob } from './types';

/**
 * Ingestion Queue — in-process FIFO with bounded concurrency and disk-backed
 * persistence.
 *
 * Redis/BullMQ was intentionally not adopted for Phase 1: books ingest at
 * human timescales (single-digit per hour, not per second) so a persistent
 * on-disk queue is honest about the shape of the workload without adding
 * another running dependency. The queue survives a restart because
 * IngestionStateStore rehydrates from JSON; anything in a running-but-not-
 * finished state on boot is treated as `failed` with an "interrupted"
 * message rather than silently retried, so operators see the truth.
 *
 * The background worker uses `setInterval`. `@nestjs/schedule` was not added
 * because it would bring a dep and a decorator ceremony for the same single
 * poll loop — the plain interval is smaller and directly cleaned up in
 * `onModuleDestroy`.
 */
@Injectable()
export class IngestionQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngestionQueueService.name);
  private queue: string[] = [];
  private inFlight = new Set<string>();
  private worker: NodeJS.Timeout | null = null;
  private autoScan: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    @Inject(LEARNING_CONFIG) private readonly config: LearningConfig,
    private readonly state: IngestionStateStore,
    private readonly scanner: BookScannerService,
    private readonly importer: KnowledgeImportService,
  ) {}

  onModuleInit(): void {
    this.state.load();
    this.reconcileOnBoot();
    this.worker = setInterval(() => this.tick(), this.config.workerIntervalMs);
    if (this.config.autoScanIntervalMs > 0) {
      this.autoScan = setInterval(() => this.autoEnqueueNewBooks(), this.config.autoScanIntervalMs);
    }
    this.logger.log(
      `learning queue ready — books=${this.config.booksDir}, concurrency=${this.config.maxConcurrentJobs}, autoScan=${this.config.autoScanIntervalMs}ms`,
    );
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.worker) clearInterval(this.worker);
    if (this.autoScan) clearInterval(this.autoScan);
    this.worker = null;
    this.autoScan = null;
  }

  /** Enqueue a specific book by its relative path under the books dir. */
  enqueue(bookRelativePath: string): IngestionJob {
    const existing = this.state.list().find(
      (j) => j.bookRelativePath === bookRelativePath && (j.status === 'queued' || this.isRunning(j.status)),
    );
    if (existing) return existing;

    const job = this.importer.buildJob(bookRelativePath);
    this.state.upsert(job);
    this.queue.push(job.jobId);
    this.logger.log(`enqueued ${job.jobId} for ${bookRelativePath}`);
    return job;
  }

  /** Enqueue every book in the scan that has no `done` job for its current checksum. */
  enqueueAll(): IngestionJob[] {
    const books = this.scanner.scan();
    const enqueued: IngestionJob[] = [];
    for (const book of books) {
      const done = this.state.findByBook(book.relativePath, book.checksum);
      if (done && done.status === 'done') continue;
      enqueued.push(this.enqueue(book.relativePath));
    }
    return enqueued;
  }

  listJobs(): IngestionJob[] {
    return this.state.list().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getJob(jobId: string): IngestionJob | null {
    return this.state.get(jobId);
  }

  queueDepth(): { queued: number; running: number } {
    return { queued: this.queue.length, running: this.inFlight.size };
  }

  private tick(): void {
    if (this.stopping) return;
    while (this.inFlight.size < this.config.maxConcurrentJobs && this.queue.length > 0) {
      const jobId = this.queue.shift()!;
      const job = this.state.get(jobId);
      if (!job) continue;
      if (this.isRunning(job.status) || job.status === 'done' || job.status === 'failed') continue;
      void this.runJob(job);
    }
  }

  private async runJob(job: IngestionJob): Promise<void> {
    this.inFlight.add(job.jobId);
    job.startedAt = new Date().toISOString();
    job.status = 'parsing';
    this.state.upsert(job);

    try {
      const result = await this.importer.run(job, (progress) => {
        this.state.upsert(progress);
      });
      job.metrics = result.metrics;
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      job.error = result.errors.length > 0 ? result.errors.join('\n') : null;
      this.state.upsert(job);
      this.logger.log(
        `job ${job.jobId} done in ${result.metrics.durationMs}ms — chunks=${result.metrics.chunksCreated}, concepts=${result.metrics.conceptsExtracted}, memoryRecords=${result.metrics.memoryRecordsWritten}`,
      );
    } catch (err) {
      const message = (err as Error).stack ?? (err as Error).message ?? String(err);
      job.status = 'failed';
      job.error = message;
      job.finishedAt = new Date().toISOString();
      this.state.upsert(job);
      this.logger.error(`job ${job.jobId} failed: ${message}`);
    } finally {
      this.inFlight.delete(job.jobId);
    }
  }

  private reconcileOnBoot(): void {
    const jobs = this.state.list();
    for (const job of jobs) {
      if (job.status === 'queued') {
        // Requeue anything that was waiting when the process died.
        this.queue.push(job.jobId);
      } else if (this.isRunning(job.status)) {
        // Anything mid-flight when the process died is truthfully failed.
        job.status = 'failed';
        job.error = 'process restarted while job was running';
        job.finishedAt = new Date().toISOString();
        this.state.upsert(job);
      }
    }
    this.logger.log(`reconciled ${this.queue.length} queued job(s) from state file`);
  }

  private autoEnqueueNewBooks(): void {
    if (this.stopping) return;
    try {
      const added = this.enqueueAll();
      if (added.length > 0) {
        this.logger.log(`auto-scan enqueued ${added.length} new/changed book(s)`);
      }
    } catch (err) {
      this.logger.warn(`auto-scan failed: ${(err as Error).message}`);
    }
  }

  private isRunning(status: IngestionJob['status']): boolean {
    return status === 'parsing' || status === 'chunking' || status === 'extracting' || status === 'importing';
  }
}

// Helper re-export so the controller can construct blank metrics without
// depending on the queue for that alone.
export { EMPTY_METRICS };

import { Inject, Injectable, Logger } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { LEARNING_CONFIG, LearningConfig } from './learning.config';
import { IngestionJob } from './types';

interface PersistedState {
  version: 1;
  jobs: IngestionJob[];
}

const EMPTY: PersistedState = { version: 1, jobs: [] };

/**
 * JSON-file persistence for ingestion jobs.
 *
 * A dedicated table was considered and rejected for Phase 1: adding a Prisma
 * migration for state that never leaves the sentinel process just to survive
 * restarts costs more than a durable file. Writes are atomic (temp + rename),
 * so a crash mid-write cannot leave the file half-written and unreadable.
 */
@Injectable()
export class IngestionStateStore {
  private readonly logger = new Logger(IngestionStateStore.name);
  private state: PersistedState = { ...EMPTY };
  private loaded = false;

  constructor(@Inject(LEARNING_CONFIG) private readonly config: LearningConfig) {}

  load(): void {
    if (this.loaded) return;
    const path = this.config.stateFile;
    if (!existsSync(path)) {
      this.state = { ...EMPTY };
      this.loaded = true;
      return;
    }
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.jobs)) {
        this.state = parsed;
      } else {
        this.logger.warn(`state file ${path} has unexpected shape — starting fresh`);
        this.state = { ...EMPTY };
      }
    } catch (err) {
      this.logger.warn(`could not read state file ${path}: ${(err as Error).message} — starting fresh`);
      this.state = { ...EMPTY };
    }
    this.loaded = true;
  }

  list(): IngestionJob[] {
    this.load();
    return this.state.jobs.map((j) => ({ ...j, metrics: { ...j.metrics } }));
  }

  get(jobId: string): IngestionJob | null {
    this.load();
    const found = this.state.jobs.find((j) => j.jobId === jobId);
    return found ? { ...found, metrics: { ...found.metrics } } : null;
  }

  findByBook(bookRelativePath: string, checksum: string): IngestionJob | null {
    this.load();
    const found = this.state.jobs.find((j) => j.bookRelativePath === bookRelativePath && j.bookChecksum === checksum);
    return found ? { ...found, metrics: { ...found.metrics } } : null;
  }

  upsert(job: IngestionJob): void {
    this.load();
    const idx = this.state.jobs.findIndex((j) => j.jobId === job.jobId);
    if (idx >= 0) this.state.jobs[idx] = job;
    else this.state.jobs.push(job);
    this.persist();
  }

  clearFinished(): number {
    this.load();
    const before = this.state.jobs.length;
    this.state.jobs = this.state.jobs.filter((j) => j.status !== 'done' && j.status !== 'failed');
    if (this.state.jobs.length !== before) this.persist();
    return before - this.state.jobs.length;
  }

  private persist(): void {
    const path = this.config.stateFile;
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    renameSync(tmp, path);
  }
}

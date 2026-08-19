import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { FILING_DATASETS, FILING_DATASET_IDS, FilingDatasetId } from '../catalogue/filing-datasets';
import { EquityListConnector } from '../connectors/equity-list.connector';
import { StatementsConnector } from '../connectors/statements.connector';

/**
 * Claims due ingestion jobs and runs them.
 *
 * ── WHY NOT THE JobLease LEADER ELECTION ───────────────────────────────────
 * The rest of this repo serialises background work with a service-wide lease
 * (`services/api/src/common/leader-election.ts`), and the reason it exists is a
 * real correctness bug: two replicas meant two matching engines filling the
 * same resting order twice.
 *
 * That property — never two writers on the same work — is preserved here. What
 * changes is its granularity. Ingestion jobs are mutually independent: fetching
 * RELIANCE's announcements has nothing to say to fetching TCS's. Serialising the
 * whole SERVICE would leave every replica but one idle, when the useful
 * behaviour is several replicas working different symbols at once. So the unit
 * of exclusion is the ROW, taken by an atomic conditional UPDATE.
 *
 * ── WHY THE CLAIM HAS AN EXPIRY AND NOT JUST A FLAG ────────────────────────
 * A worker that dies mid-run cannot reset its own row. If the claim were a
 * boolean, that job would read 'running' forever and never be picked up again —
 * a silent permanent stall, which is the worst failure shape for something
 * whose whole purpose is to keep data fresh. So the claim carries a deadline,
 * and a claim that has lapsed is reclaimable regardless of `state`.
 *
 * `FOR UPDATE SKIP LOCKED` does the rest: two workers claiming at the same
 * instant take DIFFERENT rows rather than blocking on each other.
 *
 * ── HANDLER COVERAGE ───────────────────────────────────────────────────────
 * `HANDLED_DATASETS` is the list of datasets that actually do something, and
 * only those get job rows. Registering the rest would fill the queue with work
 * that resolves to a no-op, and the dispatcher would spend its per-tick budget
 * claiming and releasing jobs that ingest nothing — starving the ones that do.
 *
 * Datasets are enabled one at a time, each with its own parser and tests,
 * rather than all at once behind an "ingest everything" switch.
 */

/**
 * Datasets with a real handler AND a scope the scheduler can enumerate.
 *
 * `nse.bhavcopy` is deliberately absent despite having a handler: it is
 * date-scoped, so its jobs are one per trading session rather than one per
 * company, and enumerating them belongs to a calendar-driven registration
 * rather than this symbol-driven one.
 */
const HANDLED_DATASETS: FilingDatasetId[] = [
  'nse.equity-list',
  'nse.financial-results',
  'nse.financial-results-annual',
];

/** How long a claim is held before it is considered abandoned. */
const CLAIM_TTL_MS = Number(process.env.COMPANY_DATA_CLAIM_TTL_MS ?? 120_000);

/** How often the dispatcher looks for due work. */
const TICK_MS = Number(process.env.COMPANY_DATA_TICK_MS ?? 60_000);

/** Most jobs claimed per tick — the politeness ceiling, not a throughput target. */
const BATCH = Number(process.env.COMPANY_DATA_BATCH ?? 5);

/** Backoff ceiling. A source that is down stays polled, just rarely. */
const MAX_BACKOFF_MS = 6 * 60 * 60_000;

interface ClaimedJob {
  id: string;
  jobKey: string;
  scope: string;
  cursor: string | null;
  lastSeenId: string | null;
  lastContentHash: string | null;
  intervalMs: number;
  consecutiveFailures: number;
}

@Injectable()
export class IngestionSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngestionSchedulerService.name);

  /**
   * Random per boot, deliberately NOT the hostname — a platform that gives two
   * containers the same hostname must not let them believe they share a claim.
   */
  private readonly workerId = randomUUID();

  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly equityList: EquityListConnector,
    private readonly statements: StatementsConnector,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.COMPANY_DATA_INGESTION_ENABLED !== 'true') {
      // Off by default. An ingestion loop that starts itself the moment the
      // service boots would begin calling an external exchange from any
      // developer's laptop and from every CI run.
      this.logger.log('Ingestion disabled (set COMPANY_DATA_INGESTION_ENABLED=true to run)');
      return;
    }
    // Plain setInterval under the lifecycle hooks, matching every other
    // background loop in this repo rather than introducing @nestjs/schedule.
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.logger.log(`Ingestion dispatcher started (worker ${this.workerId}, tick ${TICK_MS}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Ensure a job row exists for every (dataset, scope) pair we intend to run.
   *
   * Idempotent — safe to call on every boot. Does NOT reset scheduling state on
   * an existing row: a redeploy must not rewind every checkpoint and re-fetch
   * the market.
   */
  async registerJobs(scopes: string[]): Promise<number> {
    const rows = HANDLED_DATASETS.flatMap((id) => {
      const dataset = FILING_DATASETS[id];
      // Date-scoped datasets are not enumerable from a symbol list.
      if (dataset.scope === 'date') return [];
      const targets = dataset.scope === 'market' ? ['market'] : scopes;
      return targets.map((scope) => ({
        jobKey: id,
        scope,
        intervalMs: dataset.cadenceMs,
        nextRunAt: new Date(),
      }));
    });

    // createMany + skipDuplicates rather than a loop of upserts, because it
    // reports how many rows were ACTUALLY inserted. The upsert version could
    // not: an upsert whose update clause is empty leaves createdAt equal to
    // updatedAt, so "was this row new" could not be inferred from the returned
    // row, and the count reported every existing job as freshly created on
    // every boot.
    const { count } = await this.prisma.ingestionJob.createMany({ data: rows, skipDuplicates: true });
    return count;
  }

  /** One dispatch pass. Never throws — a failing tick must not kill the loop. */
  async tick(): Promise<void> {
    if (this.ticking) return; // A slow pass must not overlap itself.
    this.ticking = true;
    try {
      const jobs = await this.claim(BATCH);
      for (const job of jobs) {
        await this.runOne(job);
      }
    } catch (err) {
      this.logger.error(`Dispatch tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Atomically take up to `limit` due jobs.
   *
   * The WHERE clause has two arms, and both matter:
   *   - due and not claimed → the ordinary case;
   *   - claimed but the claim has EXPIRED → recovery from a dead worker.
   *
   * `NOW()` throughout, never the caller's clock: Postgres is the only clock
   * that decides, so replicas with skewed clocks cannot both consider a job due.
   */
  private async claim(limit: number): Promise<ClaimedJob[]> {
    const expiry = new Date(Date.now() + CLAIM_TTL_MS);
    return this.prisma.$queryRaw<ClaimedJob[]>`
      UPDATE "IngestionJob" j
         SET "state" = 'running',
             "claimedBy" = ${this.workerId},
             "claimExpiresAt" = ${expiry},
             "lastRunAt" = NOW()
       WHERE j."id" IN (
         SELECT c."id" FROM "IngestionJob" c
          WHERE c."state" <> 'disabled'
            AND c."nextRunAt" <= NOW()
            AND (c."claimExpiresAt" IS NULL OR c."claimExpiresAt" < NOW())
          ORDER BY c."nextRunAt" ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING j."id", j."jobKey", j."scope", j."cursor", j."lastSeenId",
                j."lastContentHash", j."intervalMs", j."consecutiveFailures";
    `;
  }

  private async runOne(job: ClaimedJob): Promise<void> {
    try {
      await this.handle(job);
      await this.prisma.ingestionJob.update({
        where: { id: job.id },
        data: {
          state: 'idle',
          claimedBy: null,
          claimExpiresAt: null,
          lastSuccessAt: new Date(),
          consecutiveFailures: 0,
          lastError: null,
          nextRunAt: new Date(Date.now() + job.intervalMs),
        },
      });
    } catch (err) {
      const failures = job.consecutiveFailures + 1;
      // Exponential backoff, capped. A source that is down is still polled —
      // just rarely enough that we are not part of its problem.
      const backoff = Math.min(job.intervalMs * 2 ** Math.min(failures, 10), MAX_BACKOFF_MS);
      await this.prisma.ingestionJob.update({
        where: { id: job.id },
        data: {
          state: 'failed',
          claimedBy: null,
          claimExpiresAt: null,
          consecutiveFailures: failures,
          lastError: (err as Error).message.slice(0, 500),
          nextRunAt: new Date(Date.now() + backoff),
        },
      });
      this.logger.warn(`Job ${job.jobKey}/${job.scope} failed (${failures}x): ${(err as Error).message}`);
    }
  }

  /**
   * Phase 1: no-op handler.
   *
   * Deliberately does not fetch. This phase's completion criterion is that the
   * dispatcher claims, runs, checkpoints and recovers correctly — proving that
   * against a handler that cannot fail for interesting reasons is the point.
   * Phase 2 replaces this with the connector registry.
   */
  private async handle(job: ClaimedJob): Promise<void> {
    if (!FILING_DATASET_IDS.includes(job.jobKey as FilingDatasetId)) {
      // A job row for a dataset that no longer exists in the catalogue. Not an
      // error to retry forever — disable it and say so.
      await this.prisma.ingestionJob.update({
        where: { id: job.id },
        data: { state: 'disabled', lastError: 'jobKey is not in the catalogue' },
      });
      this.logger.warn(`Disabled job ${job.jobKey}/${job.scope}: not in catalogue`);
      return;
    }

    if (job.jobKey === 'nse.equity-list') {
      const result = await this.equityList.sync(job.lastContentHash);
      if (result.status === 'failed') {
        // Thrown, not swallowed: runOne's catch is what records the failure,
        // applies backoff and leaves the previous checkpoint in place. A
        // handler that returned quietly here would mark the run successful and
        // advance nextRunAt as though the market had been read.
        throw new Error('EQUITY_L.csv fetch failed');
      }
      if (result.contentHash) {
        // Checkpoint AFTER a successful reconcile. Storing the hash before
        // would mean a crash mid-reconcile leaves a hash claiming the file is
        // processed, and the next run skips it.
        await this.prisma.ingestionJob.update({
          where: { id: job.id },
          data: { lastContentHash: result.contentHash },
        });
      }
      if (result.status === 'ok') {
        this.logger.log(
          `equity-list: parsed ${result.parsed} (${result.skipped} skipped), ` +
            `+${result.companiesCreated} companies, +${result.listingsCreated} listings, ` +
            `${result.listingsUpdated} updated, ${result.instrumentsLinked} instrument links, ` +
            `${result.aliasConflicts} alias conflicts`,
        );
      }
      return;
    }

    if (job.jobKey === 'nse.financial-results' || job.jobKey === 'nse.financial-results-annual') {
      const period = job.jobKey === 'nse.financial-results-annual' ? 'Annual' : 'Quarterly';
      // Only the most recent filings per run. Deep history is backfilled by a
      // dedicated sweep, not by making every scheduled tick fetch a decade of
      // documents for one company while every other company waits.
      const result = await this.statements.syncCompany(job.scope, period, 4);
      if (result.statementsWritten > 0 || result.filingsSeen > 0) {
        this.logger.log(
          `${job.scope} ${period}: ${result.statementsWritten} statements, ` +
            `${result.lineItemsWritten} lines, ${result.unmappedTags} unmapped, ` +
            `${result.reconciliationFailures} failed reconciliation`,
        );
      }
      return;
    }

    this.logger.debug(`(no-op) ${job.jobKey}/${job.scope}`);
  }
}

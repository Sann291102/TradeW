import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LeaderElectionService } from '../common/leader-election';
import { ExecutionLifecycleService } from './execution-lifecycle.service';
import { PaperExecutionService } from './paper-execution.service';

/**
 * The clock behind the paper-execution loop.
 *
 * ## Leader election is a correctness requirement here, not a nicety
 *
 * Exactly the argument `MatchingEngineService` records: two replicas ticking
 * the same profile can both evaluate, both decide, and — absent the leader
 * lease — both attempt an order. The `idempotencyKey` unique constraint would
 * still stop the second one, so this is defence in depth rather than the only
 * guard, but it also stops the second replica from spending a Sentinel
 * evaluation to discover that.
 *
 * ## Why the loop is OFF by default
 *
 * `PAPER_EXECUTION_ENABLED` must be explicitly `true`. A deployment that pulls
 * this code and happens to have an enabled profile row must not silently start
 * trading — enabling is two deliberate acts (the env flag AND the profile's own
 * `enabled` column), in two different places, by two different mechanisms.
 *
 * ## Cadence
 *
 * The evaluation tick is slow on purpose (default 60 s). A Sentinel evaluation
 * reads candles, an option chain and the strategy engine; running it every few
 * seconds would spend real upstream quota to re-derive a read that changes on
 * the bar, not on the tick. The reconcile tick is faster (15 s) because it only
 * reads local rows and its job is to notice a fill promptly.
 */

const EVALUATE_JOB = 'paper-execution-evaluate';
const RECONCILE_JOB = 'paper-execution-reconcile';

@Injectable()
export class ExecutionSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionSchedulerService.name);
  private evaluateTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private evaluating = false;
  private reconciling = false;

  constructor(
    private readonly execution: PaperExecutionService,
    private readonly lifecycle: ExecutionLifecycleService,
    private readonly leader: LeaderElectionService,
  ) {}

  private get enabled(): boolean {
    return (process.env.PAPER_EXECUTION_ENABLED ?? 'false').toLowerCase() === 'true';
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('paper execution loop is disabled (PAPER_EXECUTION_ENABLED is not "true") — no timers started.');
      return;
    }
    this.leader.register(EVALUATE_JOB);
    this.leader.register(RECONCILE_JOB);

    const evaluateMs = Number(process.env.PAPER_EXECUTION_INTERVAL_MS ?? 60_000);
    const reconcileMs = Number(process.env.PAPER_EXECUTION_RECONCILE_MS ?? 15_000);
    this.evaluateTimer = setInterval(() => void this.evaluateTick(), evaluateMs);
    this.reconcileTimer = setInterval(() => void this.reconcileTick(), reconcileMs);
    this.logger.log(`paper execution loop started — evaluate every ${evaluateMs}ms, reconcile every ${reconcileMs}ms.`);
  }

  onModuleDestroy(): void {
    if (this.evaluateTimer) clearInterval(this.evaluateTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
  }

  private async evaluateTick(): Promise<void> {
    if (!this.leader.isLeader(EVALUATE_JOB)) return;
    // A Sentinel evaluation can outlast the tick interval. Without this guard
    // the passes would overlap and the second would duplicate the first's work
    // — the idempotency key would collapse the result, but only after both had
    // paid for an evaluation.
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      const results = await this.execution.runAllEnabled();
      const acted = results.filter((r) => r.outcome === 'executed' || r.outcome === 'rejected' || r.outcome === 'failed');
      if (acted.length) {
        for (const r of acted) this.logger.log(`${r.profileName}: ${r.outcome} — ${r.reason}`);
      }
    } catch (err) {
      this.logger.error('evaluate tick failed', err as Error);
    } finally {
      this.evaluating = false;
    }
  }

  private async reconcileTick(): Promise<void> {
    if (!this.leader.isLeader(RECONCILE_JOB)) return;
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      // Square-off runs FIRST. Both passes read the same positions, and running
      // reconcile first would see a position still open, skip it, and leave the
      // outcome unrecorded for a whole extra tick after the exit filled.
      await this.lifecycle.squareOff();
      const result = await this.lifecycle.reconcile();
      if (result.filled || result.failed || result.closed) {
        this.logger.log(`reconcile: ${result.filled} filled, ${result.closed} closed, ${result.failed} failed.`);
      }
    } catch (err) {
      this.logger.error('reconcile tick failed', err as Error);
    } finally {
      this.reconciling = false;
    }
  }
}

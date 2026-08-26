import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LeaderElectionService } from '../common/leader-election';
import { ExecutionLifecycleService } from './execution-lifecycle.service';
import { classifyMarketSession, type MarketSession } from './market-session';
import { PaperExecutionService } from './paper-execution.service';
import { SystemExecutionControlService } from './system-execution-control.service';

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

/**
 * What the admin console reads to tell an ARMED profile from a TICKING loop.
 *
 * Every field is this process's own live state. Nothing is persisted: a status
 * row in the database would be a second copy of a fact the process already
 * holds, and it would keep asserting "running" after the process that wrote it
 * had gone.
 */
export interface ExecutionLoopStatus {
  /** `PAPER_EXECUTION_ENABLED` — the switch that decides whether timers exist. */
  enabled: boolean;
  intervalMs: number | null;
  reconcileMs: number | null;
  isEvaluateLeader: boolean;
  isReconcileLeader: boolean;
  /** A pass in flight right now. */
  evaluating: boolean;
  reconciling: boolean;
  /** When this process started its timers, and when each last fired. */
  startedAt: string | null;
  lastEvaluateAt: string | null;
  lastReconcileAt: string | null;
  /**
   * The current NSE session, so the console can tell "alive but the market is
   * shut" from "not ticking". Computed fresh, from the shared calendar.
   */
  session: MarketSession;
}

@Injectable()
export class ExecutionSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionSchedulerService.name);
  private evaluateTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private evaluating = false;
  private reconciling = false;
  private lastEvaluateAt: Date | null = null;
  private lastReconcileAt: Date | null = null;
  private startedAt: Date | null = null;

  constructor(
    private readonly execution: PaperExecutionService,
    private readonly lifecycle: ExecutionLifecycleService,
    private readonly leader: LeaderElectionService,
    private readonly systemControl: SystemExecutionControlService,
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
    this.startedAt = new Date();
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
    // Stamped before the work, not after: the console's question is "is this
    // loop alive", and a tick that started and then threw is still a live loop.
    this.lastEvaluateAt = new Date();
    try {
      // The evaluate tick only ever OPENS positions, and an entry may open only
      // in the active session. Outside it, skip the whole batch — no profile
      // read, no Sentinel evaluation — while the heartbeat above still records a
      // live loop. Reconcile and square-off run on their own tick regardless, so
      // an open position is never left untended just because entries are paused.
      const session = classifyMarketSession();
      if (!session.isOpen) return;
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
    this.lastReconcileAt = new Date();
    try {
      // The kill switch also drives lifecycle cleanup: under EMERGENCY_STOP the
      // gate reports `forceSquareOff`, and square-off flattens every open agent
      // position now rather than waiting for each profile's own square-off
      // minute. Read here, in the reconcile tick, because that is the tick that
      // owns exits — the evaluate tick only ever OPENS positions.
      const control = await this.systemControl.gate();
      // Square-off runs FIRST. Both passes read the same positions, and running
      // reconcile first would see a position still open, skip it, and leave the
      // outcome unrecorded for a whole extra tick after the exit filled.
      await this.lifecycle.squareOff(new Date(), { forceAll: control.forceSquareOff });
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

  /**
   * Is this loop actually running?
   *
   * ## Why the console cannot answer this from the database
   *
   * "Armed profiles" is a COUNT of `ExecutionProfile.enabled` — a database
   * fact. Whether anything ticks is `PAPER_EXECUTION_ENABLED` plus a leader
   * lease — a PROCESS fact, invisible to any query. So a console reading only
   * the database will report "1 armed" identically whether the loop is
   * evaluating that profile every minute or has never started, and the operator
   * has no way to tell those apart. That gap is what this exists to close.
   *
   * `isLeader` is the same local lease check the ticks themselves make, so what
   * the console displays is what the next tick will decide — not a second
   * opinion computed a different way.
   *
   * Deliberately read-only and side-effect free: nothing here starts, stops or
   * nudges a timer. An operator who wants a pass runs one explicitly.
   */
  status(): ExecutionLoopStatus {
    return {
      enabled: this.enabled,
      // Null when disabled rather than the default: reporting "60000ms" for a
      // loop that will never tick describes a schedule that does not exist.
      intervalMs: this.enabled ? Number(process.env.PAPER_EXECUTION_INTERVAL_MS ?? 60_000) : null,
      reconcileMs: this.enabled ? Number(process.env.PAPER_EXECUTION_RECONCILE_MS ?? 15_000) : null,
      // Both jobs are leased separately, so a replica can lead one and not the
      // other. Reported separately for the same reason.
      isEvaluateLeader: this.enabled && this.leader.isLeader(EVALUATE_JOB),
      isReconcileLeader: this.enabled && this.leader.isLeader(RECONCILE_JOB),
      evaluating: this.evaluating,
      reconciling: this.reconciling,
      startedAt: this.startedAt?.toISOString() ?? null,
      lastEvaluateAt: this.lastEvaluateAt?.toISOString() ?? null,
      lastReconcileAt: this.lastReconcileAt?.toISOString() ?? null,
      session: classifyMarketSession(),
    };
  }
}

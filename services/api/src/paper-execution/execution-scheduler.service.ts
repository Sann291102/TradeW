import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LeaderElectionService } from '../common/leader-election';
import { ExecutionLifecycleService } from './execution-lifecycle.service';
import { ExecutionQualificationService } from './execution-qualification.service';
import { PaperExecutionService } from './paper-execution.service';

/**
 * The clock behind the Sentinel execution loop.
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
 * ## THE LOOP NOW RUNS BY DEFAULT. Why that changed, on 2026-08-24
 *
 * It used to require `PAPER_EXECUTION_ENABLED=true`, so that arming was "two
 * deliberate acts in two different places". That was the right shape when
 * arming was a single boolean column an operator could flip with no audit and
 * no state machine behind it: the env flag was the second factor.
 *
 * It is the wrong shape now, and §4 says so directly — "Sentinel should
 * automatically run its trading process without requiring an administrator to
 * manually click 'Run pass'". The second factor has been replaced by something
 * strictly stronger, and there are now four of them:
 *
 *   1. an administrator's audited `ARM_PAPER` transition (ExecutionStateService),
 *   2. the account holder's own `autoTradeEnabled` switch (USER_PAPER only),
 *   3. `ExecutionAccountService`'s consent and account-shape gate,
 *   4. the risk policy, re-evaluated every pass.
 *
 * Keeping a fifth, invisible, deployment-wide flag ON TOP of those meant an
 * operator could arm a profile in the console, watch it report "armed", and
 * have nothing happen for a reason no query could reveal. That is the exact
 * failure §2 opens with: "ARM exists in the UI but does not provide the
 * complete execution capability."
 *
 * `PAPER_EXECUTION_ENABLED=false` is retained as an explicit KILL SWITCH — a
 * deployment that must never execute (a restored production dump on a staging
 * box, an incident) can still stop every profile with one variable. The default
 * is now on; the override is off. Live execution keeps its own separate
 * deployment gate (`LIVE_EXECUTION_ENABLED`), which is still off by default —
 * see ExecutionAdapterResolver.
 *
 * ## Cadence
 *
 * The evaluation tick is slow on purpose (default 60 s). A Sentinel evaluation
 * reads candles, an option chain and the strategy engine; running it every few
 * seconds would spend real upstream quota to re-derive a read that changes on
 * the bar, not on the tick. The reconcile tick is faster (15 s) because it only
 * reads local rows and its job is to notice a fill promptly. The qualification
 * sweep is slowest of all (default 15 min): its inputs are closed trades, which
 * arrive a few times a day at most.
 */

const EVALUATE_JOB = 'paper-execution-evaluate';
const RECONCILE_JOB = 'paper-execution-reconcile';
const QUALIFY_JOB = 'paper-execution-qualify';

/**
 * What the admin console reads to tell an ARMED profile from a TICKING loop.
 *
 * Every field is this process's own live state. Nothing is persisted: a status
 * row in the database would be a second copy of a fact the process already
 * holds, and it would keep asserting "running" after the process that wrote it
 * had gone.
 */
export interface ExecutionLoopStatus {
  /**
   * Whether timers exist on this process. True unless `PAPER_EXECUTION_ENABLED`
   * has been set to the string "false" — the kill switch, not the arm switch.
   */
  enabled: boolean;
  /** Whether the deployment permits the LIVE adapter at all. Off by default. */
  liveEnabled: boolean;
  intervalMs: number | null;
  reconcileMs: number | null;
  qualifyMs: number | null;
  isEvaluateLeader: boolean;
  isReconcileLeader: boolean;
  /** A pass in flight right now. */
  evaluating: boolean;
  reconciling: boolean;
  /** When this process started its timers, and when each last fired. */
  startedAt: string | null;
  lastEvaluateAt: string | null;
  lastReconcileAt: string | null;
  lastQualifyAt: string | null;
}

@Injectable()
export class ExecutionSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionSchedulerService.name);
  private evaluateTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private qualifyTimer: ReturnType<typeof setInterval> | null = null;
  private evaluating = false;
  private reconciling = false;
  private qualifying = false;
  private lastEvaluateAt: Date | null = null;
  private lastReconcileAt: Date | null = null;
  private lastQualifyAt: Date | null = null;
  private startedAt: Date | null = null;

  constructor(
    private readonly execution: PaperExecutionService,
    private readonly lifecycle: ExecutionLifecycleService,
    private readonly qualification: ExecutionQualificationService,
    private readonly leader: LeaderElectionService,
  ) {}

  /**
   * The KILL SWITCH, read as an opt-OUT.
   *
   * Note the inverted default against the old `?? 'false'`: an unset variable
   * now means the loop runs. See the class docstring for why the second
   * deployment-wide factor was removed and what replaced it. Only the literal
   * string "false" stops it, so a typo'd value fails safe in the direction of
   * "the state machine decides", which is the authority §2 requires.
   */
  private get enabled(): boolean {
    return (process.env.PAPER_EXECUTION_ENABLED ?? 'true').toLowerCase() !== 'false';
  }

  /** Reported so the console can say whether live is reachable on this deployment. */
  private get liveEnabled(): boolean {
    return (process.env.LIVE_EXECUTION_ENABLED ?? 'false').toLowerCase() === 'true';
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn(
        'Sentinel execution loop is STOPPED — PAPER_EXECUTION_ENABLED is "false". ' +
          'Armed profiles will not execute automatically until it is unset or set to anything else.',
      );
      return;
    }
    this.leader.register(EVALUATE_JOB);
    this.leader.register(RECONCILE_JOB);
    this.leader.register(QUALIFY_JOB);

    const evaluateMs = Number(process.env.PAPER_EXECUTION_INTERVAL_MS ?? 60_000);
    const reconcileMs = Number(process.env.PAPER_EXECUTION_RECONCILE_MS ?? 15_000);
    const qualifyMs = Number(process.env.PAPER_QUALIFICATION_INTERVAL_MS ?? 900_000);
    this.evaluateTimer = setInterval(() => void this.evaluateTick(), evaluateMs);
    this.reconcileTimer = setInterval(() => void this.reconcileTick(), reconcileMs);
    this.qualifyTimer = setInterval(() => void this.qualifyTick(), qualifyMs);
    this.startedAt = new Date();
    this.logger.log(
      `Sentinel execution loop started — evaluate every ${evaluateMs}ms, reconcile every ${reconcileMs}ms, ` +
        `qualify every ${qualifyMs}ms. Live adapter ${this.liveEnabled ? 'PERMITTED' : 'blocked'} on this deployment.`,
    );
  }

  onModuleDestroy(): void {
    if (this.evaluateTimer) clearInterval(this.evaluateTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.qualifyTimer) clearInterval(this.qualifyTimer);
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

  /**
   * Re-measure every paper-executing profile against its qualification criteria.
   *
   * Separate from the evaluate tick, and much slower, because its inputs are
   * CLOSED trades: running it every minute would recompute the same verdict
   * sixty times between two of them. It promotes and demotes through the state
   * machine (`MARK_QUALIFIED` / `MARK_UNQUALIFIED`) and can never reach a live
   * state — see execution-state.ts.
   */
  private async qualifyTick(): Promise<void> {
    if (!this.leader.isLeader(QUALIFY_JOB)) return;
    if (this.qualifying) return;
    this.qualifying = true;
    this.lastQualifyAt = new Date();
    try {
      await this.qualification.evaluateAll();
    } catch (err) {
      this.logger.error('qualification tick failed', err as Error);
    } finally {
      this.qualifying = false;
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
      liveEnabled: this.liveEnabled,
      // Null when disabled rather than the default: reporting "60000ms" for a
      // loop that will never tick describes a schedule that does not exist.
      intervalMs: this.enabled ? Number(process.env.PAPER_EXECUTION_INTERVAL_MS ?? 60_000) : null,
      reconcileMs: this.enabled ? Number(process.env.PAPER_EXECUTION_RECONCILE_MS ?? 15_000) : null,
      qualifyMs: this.enabled ? Number(process.env.PAPER_QUALIFICATION_INTERVAL_MS ?? 900_000) : null,
      // Both jobs are leased separately, so a replica can lead one and not the
      // other. Reported separately for the same reason.
      isEvaluateLeader: this.enabled && this.leader.isLeader(EVALUATE_JOB),
      isReconcileLeader: this.enabled && this.leader.isLeader(RECONCILE_JOB),
      evaluating: this.evaluating,
      reconciling: this.reconciling,
      startedAt: this.startedAt?.toISOString() ?? null,
      lastEvaluateAt: this.lastEvaluateAt?.toISOString() ?? null,
      lastReconcileAt: this.lastReconcileAt?.toISOString() ?? null,
      lastQualifyAt: this.lastQualifyAt?.toISOString() ?? null,
    };
  }
}

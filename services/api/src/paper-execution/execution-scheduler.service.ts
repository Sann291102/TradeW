import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LeaderElectionService } from '../common/leader-election';
import { ExecutionLifecycleService } from './execution-lifecycle.service';
import { PaperExecutionService } from './paper-execution.service';
import { PositionManagerService } from './position-manager.service';

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
 * ## Cadence — three loops, split by what each actually needs
 *
 * Every interval below is derived from what the market-data bridge supports,
 * not chosen for feel:
 *
 *   EVALUATE   30 s  ENTRY. One pass reads candles, an option chain and the
 *                    whole strategy engine. The bridge caches `/candles`
 *                    upstream for 60 s and the engine reads 15-minute bars, so
 *                    a faster cadence spends quota to re-derive a read that
 *                    has not changed. 30 s halves the worst-case lag against
 *                    that cache without crossing it. (Was 60 s; the agents now
 *                    also refresh open positions' thesis state on this tick,
 *                    which is worth the extra pass.)
 *
 *   MANAGE      2 s  EXIT. Needs one option premium and the feed's liveness,
 *                    nothing else. `GET /quotes` is served from the bridge's
 *                    in-memory tick map with no upstream call and no rate
 *                    limit; `GET /optionchain` caches for exactly 2 s and
 *                    overlays live WebSocket prices onto the cached body, so a
 *                    2-second poll is either a free cache hit with live prices
 *                    or one refresh — against Dhan's own ~3 s per-underlying
 *                    chain limit. This is the fastest cadence the existing
 *                    feed genuinely supports.
 *
 *   RECONCILE  15 s  OUTCOMES. Local rows only; its job is to notice a fill
 *                    and finalise a closed position's record.
 *
 * The split is the point. Running the heavy analysis at the fast cadence would
 * be both ruinous and pointless, and running the exit checks at the slow one
 * means a stop can be thirty seconds late.
 */

const EVALUATE_JOB = 'paper-execution-evaluate';
const RECONCILE_JOB = 'paper-execution-reconcile';
const MANAGE_JOB = 'paper-execution-manage';

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
  /** The fast position-management cadence. Null when the loop is off. */
  manageMs: number | null;
  isEvaluateLeader: boolean;
  isReconcileLeader: boolean;
  isManageLeader: boolean;
  /** A pass in flight right now. */
  evaluating: boolean;
  reconciling: boolean;
  managing: boolean;
  /** When this process started its timers, and when each last fired. */
  startedAt: string | null;
  lastEvaluateAt: string | null;
  lastReconcileAt: string | null;
  lastManageAt: string | null;
  /** What the last management pass did — the "is it cooking" signal. */
  lastManage: { evaluated: number; held: number; trailed: number; exited: number; errors: number } | null;
}

@Injectable()
export class ExecutionSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionSchedulerService.name);
  private evaluateTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private manageTimer: ReturnType<typeof setInterval> | null = null;
  private evaluating = false;
  private reconciling = false;
  private managing = false;
  private lastEvaluateAt: Date | null = null;
  private lastReconcileAt: Date | null = null;
  private lastManageAt: Date | null = null;
  private lastManage: ExecutionLoopStatus['lastManage'] = null;
  private startedAt: Date | null = null;

  constructor(
    private readonly execution: PaperExecutionService,
    private readonly lifecycle: ExecutionLifecycleService,
    private readonly positions: PositionManagerService,
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
    this.leader.register(MANAGE_JOB);

    const evaluateMs = Number(process.env.PAPER_EXECUTION_INTERVAL_MS ?? 30_000);
    const reconcileMs = Number(process.env.PAPER_EXECUTION_RECONCILE_MS ?? 15_000);
    const manageMs = Number(process.env.PAPER_EXECUTION_MANAGE_MS ?? 2_000);
    this.evaluateTimer = setInterval(() => void this.evaluateTick(), evaluateMs);
    this.reconcileTimer = setInterval(() => void this.reconcileTick(), reconcileMs);
    this.manageTimer = setInterval(() => void this.manageTick(), manageMs);
    this.startedAt = new Date();
    this.logger.log(
      `paper execution loop started — evaluate every ${evaluateMs}ms, manage every ${manageMs}ms, reconcile every ${reconcileMs}ms.`,
    );
  }

  onModuleDestroy(): void {
    if (this.evaluateTimer) clearInterval(this.evaluateTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.manageTimer) clearInterval(this.manageTimer);
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
   * The fast pass: every open position, against a live premium.
   *
   * Deliberately NOT gated on any profile's `enabled` column, at any level.
   * `PositionManagerService.manageAll` selects on position state alone, so a
   * DISARMED profile's open position keeps its stop, its target and its trail.
   * Disarming stops entries; it has never meant abandoning a live position.
   */
  private async manageTick(): Promise<void> {
    if (!this.leader.isLeader(MANAGE_JOB)) return;
    // At a 2-second cadence an overlapping pass is a real possibility whenever
    // the bridge is slow, and two passes over the same position would each
    // read it as OPEN. The atomic claim in `exit()` would still stop the
    // second exit order, but this avoids paying for the pass at all.
    if (this.managing) return;
    this.managing = true;
    this.lastManageAt = new Date();
    try {
      const summary = await this.positions.manageAll();
      this.lastManage = {
        evaluated: summary.evaluated,
        held: summary.held,
        trailed: summary.trailed,
        exited: summary.exited,
        errors: summary.errors,
      };
      // Only the events worth a line. A held position logging every two
      // seconds would bury the exits in its own noise.
      for (const exit of summary.exits) {
        this.logger.log(`exit ${exit.reason} — ${exit.contract}: ${exit.detail}`);
      }
    } catch (err) {
      this.logger.error('manage tick failed', err as Error);
    } finally {
      this.managing = false;
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
      intervalMs: this.enabled ? Number(process.env.PAPER_EXECUTION_INTERVAL_MS ?? 30_000) : null,
      reconcileMs: this.enabled ? Number(process.env.PAPER_EXECUTION_RECONCILE_MS ?? 15_000) : null,
      manageMs: this.enabled ? Number(process.env.PAPER_EXECUTION_MANAGE_MS ?? 2_000) : null,
      // Both jobs are leased separately, so a replica can lead one and not the
      // other. Reported separately for the same reason.
      isEvaluateLeader: this.enabled && this.leader.isLeader(EVALUATE_JOB),
      isReconcileLeader: this.enabled && this.leader.isLeader(RECONCILE_JOB),
      isManageLeader: this.enabled && this.leader.isLeader(MANAGE_JOB),
      evaluating: this.evaluating,
      reconciling: this.reconciling,
      managing: this.managing,
      startedAt: this.startedAt?.toISOString() ?? null,
      lastEvaluateAt: this.lastEvaluateAt?.toISOString() ?? null,
      lastReconcileAt: this.lastReconcileAt?.toISOString() ?? null,
      lastManageAt: this.lastManageAt?.toISOString() ?? null,
      lastManage: this.lastManage,
    };
  }
}

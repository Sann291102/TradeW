/**
 * The parallel brain's clock.
 *
 * Runs the autonomous brain beside Sentinel on the same live market, journals
 * every decision, and resolves what the market then did. It places no orders
 * and has no code path that could.
 *
 * ## Two switches, because they are two different questions
 *
 * The Phase 2 scanner gated SCANNING on `AUTONOMOUS_ENGINE_ENABLED`, which was
 * wrong for what this is. Observation and execution are separate powers:
 *
 *   AUTONOMOUS_OBSERVER_ENABLED   may it watch, decide and journal?
 *   AUTONOMOUS_ENGINE_ENABLED     may it place an order?      (still nothing reads this)
 *
 * With the engine switch off, the brain still observes → builds features →
 * decides → journals → evaluates → learns. That is the entire point: it must be
 * able to be wrong ten thousand times at no cost while the dataset that would
 * let it stop being wrong accumulates. Tying the two together would mean the
 * only way to collect that dataset is to let it trade, which is exactly
 * backwards.
 *
 * The observer switch still defaults OFF. Not out of caution about orders —
 * there are none — but because it writes rows continuously, and a deployment
 * that pulls this code must not silently start filling a database.
 *
 * ## Cadence
 *
 *   OBSERVE  60 s  The brain decides on 15-minute bars, so a faster poll
 *                  re-derives an identical decision the journal then dedupes.
 *                  60 s is fast enough that the first poll of a new bar lands
 *                  within a minute of its close — and it is that FIRST decision
 *                  the journal keeps, because it is the one that could actually
 *                  have been acted on.
 *
 *   RESOLVE 300 s  Outcomes move at the speed of bars, not of polls. Five
 *                  minutes keeps the dataset current without re-walking the
 *                  same unresolved rows twenty times per bar.
 *
 * ## Leader election
 *
 * Shared with the execution loop's lease table for the same reason it uses one:
 * two replicas observing would double every row's write attempt. The unique
 * constraints would hold, but the second replica would spend a full provider
 * fetch to discover that.
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { tradableSpec, TRADABLE_SPECS } from '@tradew/market-data';
import { LeaderElectionService } from '../common/leader-election';
import { BrainJournalService } from './brain-journal.service';
import { OutcomeResolverService } from './outcome-resolver.service';
import { SentinelBenchmarkService } from './sentinel-benchmark.service';
import { AutonomousExecutionService } from './autonomous-execution.service';
import { AutonomousPositionManagerService } from './autonomous-position-manager.service';
import { autonomousExecutionEnabled } from './setup-scanner.service';
import { SetupScannerService } from './setup-scanner.service';

const OBSERVE_JOB = 'autonomous-observe';
const RESOLVE_JOB = 'autonomous-resolve';

const OBSERVE_MS = 60_000;
const RESOLVE_MS = 300_000;

/** May the brain watch, decide and journal? Independent of execution. */
export function observerEnabled(): boolean {
  return process.env.AUTONOMOUS_OBSERVER_ENABLED === 'true';
}

/**
 * The instruments the brain watches.
 *
 * Every tradable spec in the registry, so adding a market to the universe adds
 * it to the brain rather than needing a second list to be remembered.
 */
export function observedSymbols(): string[] {
  return TRADABLE_SPECS.filter((s) => s.tradeable).map((s) => s.symbol);
}

export interface ObserverStatus {
  enabled: boolean;
  observeMs: number | null;
  resolveMs: number | null;
  isObserveLeader: boolean;
  isResolveLeader: boolean;
  observing: boolean;
  resolving: boolean;
  startedAt: string | null;
  lastObserveAt: string | null;
  lastResolveAt: string | null;
  lastObserve: { symbols: number; scanned: number; candidates: number; accepted: number } | null;
  lastResolve: { examined: number; resolved: number; stillOpen: number } | null;
  symbols: string[];
}

@Injectable()
export class BrainObserverService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BrainObserverService.name);

  private observeTimer: ReturnType<typeof setInterval> | null = null;
  private resolveTimer: ReturnType<typeof setInterval> | null = null;
  private observing = false;
  private resolving = false;
  private startedAt: Date | null = null;
  private lastObserveAt: Date | null = null;
  private lastResolveAt: Date | null = null;
  private lastObserve: ObserverStatus['lastObserve'] = null;
  private lastResolve: ObserverStatus['lastResolve'] = null;

  constructor(
    private readonly scanner: SetupScannerService,
    private readonly journal: BrainJournalService,
    private readonly resolver: OutcomeResolverService,
    private readonly benchmark: SentinelBenchmarkService,
    private readonly execution: AutonomousExecutionService,
    private readonly positions: AutonomousPositionManagerService,
    private readonly leader: LeaderElectionService,
  ) {}

  onModuleInit(): void {
    if (!observerEnabled()) {
      this.logger.log(
        'autonomous observer OFF — set AUTONOMOUS_OBSERVER_ENABLED=true to let the brain watch and journal. It still places no orders.',
      );
      return;
    }
    // Registering is what makes this process a CANDIDATE for the lease; the
    // service renews it in the background and `isLeader` is a local read
    // against the deadline it last confirmed. Asking the database per tick
    // would put a round trip on the critical path of every poll.
    this.leader.register(OBSERVE_JOB);
    this.leader.register(RESOLVE_JOB);

    this.startedAt = new Date();
    this.observeTimer = setInterval(() => void this.observeTick(), OBSERVE_MS);
    this.resolveTimer = setInterval(() => void this.resolveTick(), RESOLVE_MS);
    this.logger.log(
      `autonomous observer started — observe every ${OBSERVE_MS}ms, resolve every ${RESOLVE_MS}ms, ` +
        `watching ${observedSymbols().join(', ')}. Paper execution is ` +
        `${autonomousExecutionEnabled() ? 'ARMED (AUTONOMOUS_ENGINE_ENABLED=true)' : 'OFF'}.`,
    );
  }

  onModuleDestroy(): void {
    if (this.observeTimer) clearInterval(this.observeTimer);
    if (this.resolveTimer) clearInterval(this.resolveTimer);
  }

  status(): ObserverStatus {
    return {
      enabled: observerEnabled(),
      observeMs: this.observeTimer ? OBSERVE_MS : null,
      resolveMs: this.resolveTimer ? RESOLVE_MS : null,
      isObserveLeader: this.leader.isLeader(OBSERVE_JOB),
      isResolveLeader: this.leader.isLeader(RESOLVE_JOB),
      observing: this.observing,
      resolving: this.resolving,
      startedAt: this.startedAt?.toISOString() ?? null,
      lastObserveAt: this.lastObserveAt?.toISOString() ?? null,
      lastResolveAt: this.lastResolveAt?.toISOString() ?? null,
      lastObserve: this.lastObserve,
      lastResolve: this.lastResolve,
      symbols: observedSymbols(),
    };
  }

  /** One observation pass over every watched instrument. */
  async observeTick(now: Date = new Date()): Promise<void> {
    // A pass still running when the next fires means a provider is slow;
    // stacking them would multiply the load on exactly the thing struggling.
    if (this.observing) return;
    if (!this.leader.isLeader(OBSERVE_JOB)) return;

    this.observing = true;
    try {
      // Open positions first. A stop that needs advancing matters more than a
      // setup that has not happened yet, and a slow provider on the scan must
      // never delay management of money already committed.
      const managed = await this.positions.manageAll(now);
      if (managed.trailed || managed.exited) {
        this.logger.log(`managed ${managed.evaluated} position(s): ${managed.trailed} trailed, ${managed.exited} exited.`);
      }

      const symbols = observedSymbols();
      const results = await this.scanner.scanAll(symbols, now);

      let candidates = 0;
      let accepted = 0;
      let scanned = 0;

      for (const result of results) {
        const venue = tradableSpec(result.symbol)?.venue ?? 'UNKNOWN';
        const write = await this.journal.record(result, venue, now);
        // AFTER the decision is journalled, never before — a benchmark value
        // that reached the brain before it decided would make this a filter on
        // Sentinel rather than an independent brain.
        if (write.scanId) {
          await this.benchmark.attach(
            write.scanId,
            result.symbol,
            now,
            result.candidates.filter((c) => c.accepted).length,
          );
        }

        // Execution is attempted only for candidates that were both ACCEPTED
        // and journalled — the persisted row's id is what makes the attempt
        // idempotent, so an unjournalled decision is deliberately unexecutable.
        if (autonomousExecutionEnabled()) {
          for (const accepted of result.candidates.filter((c) => c.accepted)) {
            const row = await this.journal.findCandidateId(accepted);
            if (!row) continue;
            const outcome = await this.execution.execute(row, accepted, now);
            if (outcome.executed) {
              this.logger.log(`autonomous PAPER trade opened for ${accepted.symbol} (${accepted.setupId}).`);
            } else if (outcome.refusal && outcome.refusal !== 'already-executed') {
              this.logger.log(`execution refused for ${accepted.symbol}: [${outcome.refusal}] ${outcome.detail}`);
            }
          }
        }
        if (result.status === 'scanned') scanned += 1;
        candidates += result.candidates.length;
        accepted += result.candidates.filter((c) => c.accepted).length;
      }

      this.lastObserveAt = now;
      this.lastObserve = { symbols: symbols.length, scanned, candidates, accepted };
      if (accepted > 0) {
        this.logger.log(`brain accepted ${accepted} candidate(s) across ${scanned} scanned market(s) — journalled, not traded.`);
      }
    } catch (err) {
      this.logger.error(`observe tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.observing = false;
    }
  }

  /** One outcome-resolution pass. */
  async resolveTick(now: Date = new Date()): Promise<void> {
    if (this.resolving) return;
    if (!this.leader.isLeader(RESOLVE_JOB)) return;

    this.resolving = true;
    try {
      const summary = await this.resolver.resolvePending(200, now);
      this.lastResolveAt = now;
      this.lastResolve = {
        examined: summary.examined,
        resolved: summary.resolved,
        stillOpen: summary.stillOpen,
      };
      if (summary.resolved > 0) {
        this.logger.log(`resolved ${summary.resolved} shadow outcome(s), ${summary.stillOpen} still open.`);
      }
    } catch (err) {
      this.logger.error(`resolve tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.resolving = false;
    }
  }
}

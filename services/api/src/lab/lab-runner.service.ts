import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LeaderElectionService } from '../common/leader-election';
import { PrismaService } from '../prisma/prisma.service';
import { SentinelExecutionClient, type ExecutionEvaluationDto } from '../paper-execution/sentinel-execution.client';
import { buildAvailability, type SourceState } from './data-availability';
import { LabEventService } from './lab-event.service';
import { healthFingerprint, type LabHealth } from './lab-health';
import { LabHealthService } from './lab-health.service';

/**
 * The Agent Lab's observation loop — Phase 0.
 *
 * ## What it does, and what it deliberately cannot do
 *
 * Each tick it decides whether the Lab may run, and if so asks Sentinel what it
 * sees for every lab-enabled profile, then records that on the timeline. That
 * is the whole of Phase 0: the events an administrator watches are produced by
 * this loop actually running, against the real Sentinel, over real market data.
 *
 * It CANNOT trade. There is no `OrderService` in this file, no
 * `PaperExecutionService`, and no import that reaches either. `POST
 * /execution/evaluate` is a read — Sentinel has no Prisma binding to
 * Order/Trade/Position and no client to the OMS — so the strongest thing this
 * loop can do is write a row describing what it saw. Execution arrives in Phase
 * 1, through the existing paper-execution service, and adding it will mean
 * adding a dependency that is conspicuously absent here.
 *
 * ## Two switches, in two places, as everywhere else in this codebase
 *
 * `AGENT_LAB_ENABLED=true` in the environment AND `labEnabled` on the profile.
 * `ExecutionSchedulerService` records the reasoning: a deployment that pulls
 * this code and happens to have a profile row must not silently start.
 *
 * ## Leader election is a correctness requirement
 *
 * Two replicas ticking the same profile would both evaluate — spending two
 * Sentinel evaluations to produce one timeline entry, since the dedupe key
 * would collapse them anyway. The lease stops the second one from paying for
 * the discovery.
 *
 * ## Resume needs no code
 *
 * There is no start transition and no recovery path. Health is re-evaluated
 * every tick and the loop observes whenever it is allowed to, so a database
 * failover, a Sentinel restart or a deploy resumes the Lab on the next tick
 * with no operator action. That is the whole of "automatic resume behaviour" —
 * it is a property of re-deciding rather than a mechanism for restarting.
 */

const LAB_JOB = 'agent-lab-observation';

@Injectable()
export class LabRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LabRunnerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  /** Last health fingerprint, so a transition is written once, not per tick. */
  private lastHealthFingerprint: string | null = null;
  /** Last known session state, for SESSION_OPENED / SESSION_CLOSED. */
  private lastSessionOpen: boolean | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly health: LabHealthService,
    private readonly events: LabEventService,
    private readonly sentinel: SentinelExecutionClient,
    private readonly leader: LeaderElectionService,
  ) {}

  private get intervalMs(): number {
    // Slow on purpose. A Sentinel evaluation reads candles, an option chain and
    // the strategy engine; running it every few seconds would spend real
    // upstream quota re-deriving a read that changes on the bar, not on the
    // tick. Same reasoning as the paper-execution loop's 60s default.
    return Number(process.env.AGENT_LAB_INTERVAL_MS ?? 60_000);
  }

  onModuleInit(): void {
    this.leader.register(LAB_JOB);
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.logger.log(`agent lab observation loop registered — tick every ${this.intervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass. Public so the runtime harness can drive it deterministically. */
  async tick(): Promise<void> {
    if (!this.leader.isLeader(LAB_JOB)) return;
    // A Sentinel evaluation can outlast the tick interval. Without this the
    // passes would overlap and the second would duplicate the first's work —
    // the dedupe key collapses the result, but only after both had paid for it.
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.error(`lab tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  async runOnce(): Promise<LabHealth> {
    const profiles = await this.labProfiles();
    const symbols = Array.from(new Set(profiles.map((p) => p.symbol)));
    const health = await this.health.check(symbols);

    await this.recordHealthTransition(health);
    await this.recordSessionTransition(health);

    if (!health.canObserve) {
      // Recorded, not silently skipped. "The Lab did nothing" and "the Lab
      // could not see anything" are different facts and the timeline must
      // distinguish them.
      await this.events.emit({
        kind: 'OBSERVATION_SKIPPED',
        at: new Date(health.checkedAt),
        actor: 'lab-runner',
        summary:
          health.state === 'STOPPED'
            ? `Lab is stopped — ${health.blockedBy[0]}`
            : `Waiting: ${health.blockedBy.join('; ')}`,
        detail: { state: health.state, blockedBy: health.blockedBy },
        discriminator: healthFingerprint(health),
      });
      return health;
    }

    for (const profile of profiles) {
      await this.observeProfile(profile, health);
    }
    return health;
  }

  private async labProfiles() {
    return this.prisma.executionProfile.findMany({
      where: { labEnabled: true },
      select: {
        id: true,
        name: true,
        symbol: true,
        agent: true,
        strategyId: true,
        minConfidence: true,
        accountUserId: true,
        labTimeframe: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Ask Sentinel what it sees, and record it.
   *
   * The call is `POST /execution/evaluate` — the same read the paper-execution
   * loop makes. Reusing it rather than adding a lab-specific endpoint is the
   * point: the Lab must observe exactly what the execution path would observe,
   * or the timeline describes a different system from the one that will
   * eventually trade.
   */
  private async observeProfile(
    profile: {
      id: string;
      name: string;
      symbol: string;
      strategyId: string | null;
      minConfidence: number;
      accountUserId: string;
      labTimeframe: string | null;
    },
    health: LabHealth,
  ): Promise<void> {
    const startedAt = new Date();
    let evaluation: ExecutionEvaluationDto | null = null;
    let failure: string | null = null;

    try {
      evaluation = await this.sentinel.evaluate({
        symbol: profile.symbol,
        userId: profile.accountUserId,
        strategyId: profile.strategyId,
        minConfidence: profile.minConfidence,
      });
    } catch (err) {
      failure = (err as Error).message;
    }

    const sources: SourceState[] = [
      { name: 'database', status: 'ok', detail: 'reachable' },
      evaluation
        ? { name: 'sentinel', status: 'ok', detail: `verdict ${evaluation.verdict}` }
        : { name: 'sentinel', status: 'unavailable', detail: failure ?? 'no response' },
      { name: 'candles', status: evaluation ? 'ok' : 'unavailable', detail: marketDataDetail(health) },
      chainState(evaluation),
    ];

    // The market instant this observation is ABOUT. Sentinel reports the bar it
    // read; falling back to the wall clock only when it reports none, because a
    // poll clock says nothing about the market — the same distinction
    // `latestBarAt` and `StrategyMatch.detectedAt` exist to preserve.
    const observedAt = evaluation?.observedAt ? new Date(evaluation.observedAt) : startedAt;

    const availability = buildAvailability({
      checkedAt: startedAt,
      sources,
      newestBarAt: evaluation?.observedAt ? new Date(evaluation.observedAt) : null,
      sessionOpen: health.session.open,
      maxBarAgeSeconds: Number(process.env.AGENT_LAB_MAX_BAR_AGE_SEC ?? 900),
      requiredSources: ['database', 'sentinel', 'candles'],
    });

    if (!evaluation) {
      await this.events.emit({
        kind: 'OBSERVATION_SKIPPED',
        at: startedAt,
        actor: 'lab-runner',
        profileId: profile.id,
        symbol: profile.symbol,
        timeframe: profile.labTimeframe,
        severity: 'WARN',
        summary: `Could not observe ${profile.symbol}: ${failure}`,
        detail: { error: failure },
        dataAvailability: availability as unknown as Record<string, unknown>,
        discriminator: 'evaluate-failed',
      });
      return;
    }

    await this.events.emit({
      kind: 'OBSERVING',
      at: observedAt,
      actor: 'lab-runner',
      profileId: profile.id,
      symbol: profile.symbol,
      timeframe: profile.labTimeframe,
      summary:
        `${profile.symbol} @ ${evaluation.spot ?? 'unknown'} — ` +
        `${evaluation.verdict}${evaluation.strategyName ? ` · ${evaluation.strategyName}` : ''}`,
      detail: {
        verdict: evaluation.verdict,
        reason: evaluation.reason,
        confidence: evaluation.confidence,
        spot: evaluation.spot,
        strategyId: evaluation.strategyId,
        strategyName: evaluation.strategyName,
        sentinelRunId: evaluation.runId,
      },
      dataAvailability: availability as unknown as Record<string, unknown>,
    });

    // A candidate is a SETUP Sentinel published, not a trade. Phase 0 records
    // that one exists and stops there — there is no proposal, no risk
    // assessment and no order, because none of that machinery exists yet.
    if (evaluation.executable && evaluation.sideInFocus) {
      const selected = evaluation.strikes?.selected ?? null;
      await this.events.emit({
        kind: 'SETUP_CANDIDATE',
        at: observedAt,
        actor: 'sentinel',
        profileId: profile.id,
        symbol: profile.symbol,
        timeframe: profile.labTimeframe,
        summary:
          `Setup on ${profile.symbol}: ${evaluation.sideInFocus.bias} ` +
          `${evaluation.sideInFocus.side}${selected ? ` ${selected.strike}` : ''} ` +
          `at ${evaluation.confidence}% confidence`,
        detail: {
          bias: evaluation.sideInFocus.bias,
          side: evaluation.sideInFocus.side,
          confidence: evaluation.confidence,
          rationale: evaluation.sideInFocus.rationale,
          strategyId: evaluation.strategyId,
          strategyName: evaluation.strategyName,
          expiry: evaluation.expiry,
          selectedStrike: selected,
          // The two that lost, and why. Recorded from the first phase because
          // "why this strike" is only answerable if the alternatives survive.
          rejectedStrikes: (evaluation.strikes?.candidates ?? []).filter((c) => !c.selected),
          sentinelRunId: evaluation.runId,
        },
        dataAvailability: availability as unknown as Record<string, unknown>,
        discriminator: evaluation.strategyId ?? 'auto',
      });
      return;
    }

    await this.events.emit({
      kind: 'SETUP_REJECTED',
      at: observedAt,
      actor: 'sentinel',
      profileId: profile.id,
      symbol: profile.symbol,
      timeframe: profile.labTimeframe,
      summary: `No setup on ${profile.symbol}: ${evaluation.reason}`,
      detail: { verdict: evaluation.verdict, reason: evaluation.reason, confidence: evaluation.confidence },
      dataAvailability: availability as unknown as Record<string, unknown>,
      discriminator: evaluation.verdict,
    });
  }

  /** Written on CHANGE only — see `healthFingerprint`. */
  private async recordHealthTransition(health: LabHealth): Promise<void> {
    const fingerprint = healthFingerprint(health);
    if (fingerprint === this.lastHealthFingerprint) return;
    const previous = this.lastHealthFingerprint;
    this.lastHealthFingerprint = fingerprint;
    // First observation of the process is not a transition — there is nothing
    // it changed FROM, and reporting it as a degradation would put a
    // HEALTH_DEGRADED on the timeline every time the API restarts.
    if (previous === null) return;

    const recovered = health.canObserve;
    await this.events.emit({
      kind: recovered ? 'HEALTH_RECOVERED' : 'HEALTH_DEGRADED',
      at: new Date(health.checkedAt),
      actor: 'lab-runner',
      severity: recovered ? 'INFO' : 'WARN',
      summary: recovered
        ? 'Dependencies healthy — the Lab is observing again.'
        : `Lab paused: ${health.blockedBy.join('; ')}`,
      detail: { state: health.state, blockedBy: health.blockedBy, dependencies: health.dependencies },
      discriminator: fingerprint,
    });
  }

  private async recordSessionTransition(health: LabHealth): Promise<void> {
    const open = health.session.open;
    if (this.lastSessionOpen === open) return;
    const previous = this.lastSessionOpen;
    this.lastSessionOpen = open;
    if (previous === null) return;

    await this.events.emit({
      kind: open ? 'SESSION_OPENED' : 'SESSION_CLOSED',
      at: new Date(health.checkedAt),
      actor: 'lab-runner',
      summary: open ? 'Market session opened.' : `Market session ${health.session.reason}.`,
      detail: { session: health.session },
    });
  }
}

function marketDataDetail(health: LabHealth): string {
  return health.dependencies.find((d) => d.name === 'market-data')?.detail ?? 'unknown';
}

/**
 * The option chain is OPTIONAL evidence, so its absence is recorded rather than
 * treated as a fault. Sentinel already degrades a missing chain to "no data"
 * instead of failing the observation; this keeps that decision visible.
 */
function chainState(evaluation: ExecutionEvaluationDto | null): SourceState {
  if (!evaluation) return { name: 'option-chain', status: 'unavailable', detail: 'no evaluation' };
  const unavailable = evaluation.strikes?.unavailableReason;
  return unavailable
    ? { name: 'option-chain', status: 'unavailable', detail: unavailable }
    : { name: 'option-chain', status: 'ok', detail: `${evaluation.strikes?.candidates?.length ?? 0} candidates` };
}

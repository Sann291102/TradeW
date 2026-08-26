import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ExecutionIntentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { DhanAuthService } from '../broker/dhan-auth.service';
import { ExecutionAccountService } from './execution-account.service';
import { ExecutionQualificationService } from './execution-qualification.service';
import { istParts } from './execution-identity';
import { STATE_DESCRIPTIONS, STATE_LABELS, type ExecutionProfileState } from './execution-state';
import {
  type AutoTradeEligibility,
  evaluateAutoTradeEligibility,
} from './autotrade-eligibility';

/**
 * The user-facing half of Sentinel AutoTrade.
 *
 * ## What it does not do
 *
 * It does not arm anything. Arming is an administrative act with its own
 * audited endpoint, and a user calling anything on this service can never
 * change their own profile's state. The only column a user can write through
 * here is `autoTradeEnabled` — their own consent to an already-armed profile.
 *
 * ## Enforcement, not presentation
 *
 * `status()` and `setEnabled()` call the SAME `evaluateAutoTradeEligibility`.
 * §14 is explicit that hiding a button is not security, so activation goes
 * through the identical decision the read used, and the executor asks a third
 * time immediately before it submits.
 */
@Injectable()
export class AutoTradeService {
  private readonly logger = new Logger(AutoTradeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly accounts: ExecutionAccountService,
    private readonly broker: DhanAuthService,
    private readonly qualification: ExecutionQualificationService,
  ) {}

  /**
   * The profile bound to this user's account.
   *
   * A user has at most one in the seeded shape, and `findFirst` on the oldest
   * makes that deterministic if a deployment ever binds two — showing the user
   * a different profile on alternate requests would be worse than showing them
   * a stable, possibly-incomplete view.
   */
  private profileFor(userId: string) {
    return this.prisma.executionProfile.findFirst({
      where: { accountUserId: userId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** The eligibility decision. Used by the read, the write, and the executor. */
  async eligibility(userId: string): Promise<AutoTradeEligibility & { profileId: string | null }> {
    const [entitlement, profile] = await Promise.all([
      this.entitlements.check(userId, 'sentinel'),
      this.profileFor(userId),
    ]);

    const accountAuth = profile
      ? await this.accounts.authorize({
          environment: profile.environment,
          accountScope: profile.accountScope,
          accountUserId: profile.accountUserId,
          symbol: profile.symbol,
          agent: profile.agent,
        })
      : null;

    // Only read for a live-state profile. A paper user must never need a
    // brokerage connection, and querying for one anyway would put a credential
    // lookup on every paper status poll.
    const state = (profile?.state ?? 'DISABLED') as ExecutionProfileState;
    const needsBroker = state === 'LIVE_ARMED' || state === 'LIVE_RUNNING';
    const brokerReadiness = needsBroker ? await this.broker.liveExecutionReadiness(userId) : null;

    const decision = evaluateAutoTradeEligibility({
      hasSentinelEntitlement: entitlement.allowed,
      entitlementReason: entitlement.reason,
      profile: profile
        ? {
            id: profile.id,
            name: profile.name,
            state,
            accountScope: profile.accountScope,
            // A SYSTEM_PAPER profile has no account holder to activate
            // AutoTrade, so arming IS the activation for it. Reported as
            // enabled rather than requiring a switch nobody can reach.
            autoTradeEnabled: profile.accountScope === 'SYSTEM_PAPER' ? true : profile.autoTradeEnabled,
            symbol: profile.symbol,
            lots: profile.lots,
            minConfidence: profile.minConfidence,
            maxOpenPositions: profile.maxOpenPositions,
            maxOrdersPerDay: profile.maxOrdersPerDay,
            maxLossPerDay: Number(profile.maxLossPerDay),
            squareOffMinute: profile.squareOffMinute,
          }
        : null,
      accountAuthorized: accountAuth?.authorized ?? false,
      accountReason: accountAuth?.reason ?? null,
      broker: brokerReadiness ? { connected: brokerReadiness.connected, expired: brokerReadiness.expired } : null,
    });

    return { ...decision, profileId: profile?.id ?? null };
  }

  /**
   * Everything the AutoTrade panel renders: eligibility, live state, and the
   * account's real trading numbers.
   *
   * Every figure comes from the canonical tables the user's own Orders and
   * Portfolio pages read — §13's "do not build a completely separate fake
   * portfolio", enforced by there being nowhere else to read from.
   */
  async status(userId: string) {
    const eligibility = await this.eligibility(userId);

    if (!eligibility.profileId) {
      return {
        ...eligibility,
        profile: null,
        today: null,
        performance: null,
        qualification: null,
      };
    }

    const profileId = eligibility.profileId;
    const profile = await this.prisma.executionProfile.findUnique({ where: { id: profileId } });
    if (!profile) throw new NotFoundException('The bound execution profile disappeared mid-request.');

    const dayStart = istMidnight(new Date());

    const [intentsToday, ordersToday, closedToday, closedAll, qualification] = await Promise.all([
      this.prisma.executionIntent.count({ where: { profileId, decidedAt: { gte: dayStart } } }),
      this.prisma.executionIntent.count({
        where: {
          profileId,
          decidedAt: { gte: dayStart },
          status: { in: [ExecutionIntentStatus.SUBMITTED, ExecutionIntentStatus.FILLED, ExecutionIntentStatus.CLOSED] },
        },
      }),
      this.prisma.executionOutcome.findMany({
        where: { intent: { profileId }, result: { not: 'OPEN' }, exitAt: { gte: dayStart } },
        select: { result: true, realizedPnl: true },
      }),
      this.prisma.executionOutcome.findMany({
        where: { intent: { profileId }, result: { not: 'OPEN' } },
        select: { result: true, realizedPnl: true },
      }),
      this.qualification.current(profileId),
    ]);

    const summarise = (rows: { result: string; realizedPnl: unknown }[]) => {
      const wins = rows.filter((r) => r.result === 'WIN').length;
      const losses = rows.filter((r) => r.result === 'LOSS').length;
      const decided = wins + losses;
      return {
        trades: rows.length,
        wins,
        losses,
        // Null, never 0 — "no closed trades yet" is not "a 0% win rate".
        winRate: decided > 0 ? Math.round((wins / decided) * 100) : null,
        realizedPnl: rows.reduce((sum, r) => sum + Number(r.realizedPnl), 0),
      };
    };

    return {
      ...eligibility,
      profile: {
        id: profile.id,
        name: profile.name,
        agent: profile.agent,
        symbol: profile.symbol,
        strategyName: profile.strategyName,
        state: profile.state,
        stateLabel: STATE_LABELS[profile.state as ExecutionProfileState],
        stateDescription: STATE_DESCRIPTIONS[profile.state as ExecutionProfileState],
        environment: profile.environment,
        lots: profile.lots,
        maxOrdersPerDay: profile.maxOrdersPerDay,
        maxOpenPositions: profile.maxOpenPositions,
        lastRunAt: profile.lastRunAt?.toISOString() ?? null,
        lastDecisionAt: profile.lastDecisionAt?.toISOString() ?? null,
        lastOrderAt: profile.lastOrderAt?.toISOString() ?? null,
        lastFillAt: profile.lastFillAt?.toISOString() ?? null,
      },
      today: { decisions: intentsToday, orders: ordersToday, ...summarise(closedToday) },
      performance: summarise(closedAll),
      qualification,
    };
  }

  /**
   * Turn AutoTrade on or off for the caller's own profile.
   *
   * ## The refusal §14 requires
   *
   * Enabling re-runs the whole eligibility decision and throws 403 when it
   * fails — so a client that never rendered the button, or one that skipped the
   * UI entirely and posted straight to this endpoint, gets the same answer.
   * The body names the failed check so the client can say why rather than
   * showing a bare "forbidden".
   *
   * ## Disabling is never refused
   *
   * A user must always be able to stop an agent trading their account, whatever
   * state anything else is in. Requiring eligibility to DISABLE would mean that
   * the moment something broke, the off switch broke with it.
   */
  async setEnabled(userId: string, enabled: boolean) {
    const eligibility = await this.eligibility(userId);

    if (!eligibility.profileId) {
      throw new ForbiddenException({
        message: 'No Sentinel execution profile is bound to this account.',
        failedCheckId: 'profile-exists',
        checks: eligibility.checks,
      });
    }

    if (enabled && !eligibility.eligible) {
      throw new ForbiddenException({
        message: eligibility.reason ?? 'AutoTrade is not available for this account.',
        failedCheckId: eligibility.failedCheckId,
        checks: eligibility.checks,
      });
    }

    const profile = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.executionProfile.update({
        where: { id: eligibility.profileId! },
        data: {
          autoTradeEnabled: enabled,
          autoTradeEnabledAt: enabled ? new Date() : null,
        },
      });
      await tx.auditEvent.create({
        data: {
          userId,
          eventType: enabled ? 'execution.autotrade.enabled' : 'execution.autotrade.disabled',
          metadata: {
            profileId: saved.id,
            profileName: saved.name,
            state: saved.state,
            environment: saved.environment,
          },
        },
      });
      return saved;
    });

    this.logger.log(`${profile.name}: AutoTrade ${enabled ? 'enabled' : 'disabled'} by its account holder.`);
    return this.status(userId);
  }
}

function istMidnight(now: Date): Date {
  return new Date(`${istParts(now).dayKey}T00:00:00+05:30`);
}

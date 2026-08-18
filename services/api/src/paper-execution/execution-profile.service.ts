import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderType, ProductType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExecutionAccountService } from './execution-account.service';
import type { AccountScope } from './execution-account';

/**
 * Console-driven creation and rebinding of execution profiles.
 *
 * Split from `ExecutionQueryService` (which only reads) and from
 * `PaperExecutionService` (which only executes) so that the object able to
 * WRITE a profile is neither the one that lists them nor the one that places
 * orders. A console query should never be one refactor away from rebinding an
 * account, and the executor should never be able to widen its own permissions.
 *
 * ## Every write is validated by the same gate the executor uses
 *
 * `upsert` calls `ExecutionAccountService.authorize` before saving, so a
 * profile that could not legally execute cannot be SAVED either. Without that,
 * an operator could create a USER_PAPER profile against an unconsented account,
 * see it sitting in the table looking armed, and only discover at run time that
 * every pass is refused. Validating at write time means the table only ever
 * contains bindings the executor would honour.
 *
 * It is a check, not a replacement: `runProfile` re-authorizes on every pass,
 * because consent can be revoked after a profile is saved.
 */

export interface UpsertProfileInput {
  name: string;
  agent: string;
  symbol: string;
  accountUserId: string;
  accountScope: AccountScope;
  strategyId?: string | null;
  strategyName?: string | null;
  lots?: number;
  productType?: ProductType;
  orderType?: OrderType;
  minConfidence?: number;
  maxOpenPositions?: number;
  maxOrdersPerDay?: number;
  maxLossPerDay?: number;
  squareOffMinute?: number;
}

@Injectable()
export class ExecutionProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: ExecutionAccountService,
  ) {}

  async upsert(input: UpsertProfileInput, operator: string) {
    if (!input.name?.trim()) throw new BadRequestException('A profile name is required.');
    if (input.lots != null && (!Number.isInteger(input.lots) || input.lots < 1)) {
      throw new BadRequestException('lots must be a positive integer.');
    }
    if (input.minConfidence != null && (input.minConfidence < 70 || input.minConfidence > 100)) {
      // 70 is Sentinel's own floor for publishing a side at all
      // (StrategyAdvisorService.sideInFocus). A profile may be STRICTER than
      // Sentinel, never looser — a lower number here would be silently
      // unreachable and would read as if it loosened the gate.
      throw new BadRequestException('minConfidence must be between 70 and 100; Sentinel never publishes a side below 70.');
    }

    // The environment is set here, by the server, and is never taken from the
    // request. There is no input field for it and no code path that writes
    // anything but PAPER — see the ExecutionEnvironment enum, which has one
    // member. A caller supplying an environment is ignored rather than trusted.
    const environment = 'PAPER' as const;

    const auth = await this.accounts.authorize({
      environment,
      accountScope: input.accountScope,
      accountUserId: input.accountUserId,
      symbol: input.symbol,
      agent: input.agent,
    });
    if (!auth.authorized) {
      throw new BadRequestException(auth.reason ?? 'This account may not be bound to an execution profile.');
    }

    const data = {
      agent: input.agent,
      symbol: input.symbol.toUpperCase(),
      accountUserId: input.accountUserId,
      accountScope: input.accountScope,
      environment,
      strategyId: input.strategyId ?? null,
      strategyName: input.strategyName ?? null,
      ...(input.lots != null ? { lots: input.lots } : {}),
      ...(input.productType ? { productType: input.productType } : {}),
      ...(input.orderType ? { orderType: input.orderType } : {}),
      ...(input.minConfidence != null ? { minConfidence: input.minConfidence } : {}),
      ...(input.maxOpenPositions != null ? { maxOpenPositions: input.maxOpenPositions } : {}),
      ...(input.maxOrdersPerDay != null ? { maxOrdersPerDay: input.maxOrdersPerDay } : {}),
      ...(input.maxLossPerDay != null ? { maxLossPerDay: input.maxLossPerDay } : {}),
      ...(input.squareOffMinute != null ? { squareOffMinute: input.squareOffMinute } : {}),
    };

    const existing = await this.prisma.executionProfile.findUnique({
      where: { name: input.name },
      select: { id: true, enabled: true, accountUserId: true },
    });

    const profile = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.executionProfile.upsert({
        where: { name: input.name },
        // Never armed on creation. Arming stays a separate, separately-audited
        // act (`setExecutionProfileEnabled`) so "create" can never be the
        // moment an agent starts trading.
        create: { name: input.name, enabled: false, ...data },
        // An update deliberately does NOT touch `enabled`: editing sizing must
        // not silently arm or disarm a running profile.
        update: data,
        include: { account: { select: { email: true } } },
      });
      await tx.auditEvent.create({
        data: {
          eventType: existing ? 'execution.profile.rebound' : 'execution.profile.created',
          metadata: {
            profileId: saved.id,
            profileName: saved.name,
            agent: saved.agent,
            symbol: saved.symbol,
            environment: saved.environment,
            accountScope: saved.accountScope,
            accountEmail: saved.account.email,
            ...(existing && existing.accountUserId !== input.accountUserId
              ? { previousAccountUserId: existing.accountUserId }
              : {}),
            operator,
          },
        },
      });
      return saved;
    });

    return {
      id: profile.id,
      name: profile.name,
      agent: profile.agent,
      symbol: profile.symbol,
      environment: profile.environment,
      accountScope: profile.accountScope,
      accountEmail: profile.account.email,
      enabled: profile.enabled,
      created: !existing,
      checks: auth.checks,
    };
  }

  /**
   * Re-run the authorization gate for one saved profile, without executing.
   *
   * This is what the console calls to answer "would this profile be allowed to
   * trade right now?" — the same question `runProfile` asks, with none of the
   * side effects. It exists because a saved profile can become unauthorized
   * after the fact (consent revoked, market removed from the allowlist), and an
   * operator needs to see that before arming rather than after.
   */
  async authorization(profileId: string) {
    const profile = await this.prisma.executionProfile.findUnique({
      where: { id: profileId },
      select: { id: true, name: true, environment: true, accountScope: true, accountUserId: true, symbol: true, agent: true },
    });
    if (!profile) throw new NotFoundException(`No execution profile ${profileId}`);
    const auth = await this.accounts.authorize(profile);
    return { profileId: profile.id, profileName: profile.name, ...auth };
  }
}

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { LabEventKind } from '@prisma/client';
import { AdminAccessGuard } from '../admin/admin-access.guard';
import { SECURITY } from '../swagger/swagger.setup';
import { LabEventService } from './lab-event.service';
import { LabHealthService } from './lab-health.service';
import { LabRunnerService } from './lab-runner.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The Agent Lab's operator surface.
 *
 * ## Every route here is a READ
 *
 * There is no route that starts an experiment, places an order, or mutates a
 * profile — deliberately, and it is checked by the runtime harness. The control
 * room observes; the Lab decides. That is the same boundary the admin execution
 * surface already keeps ("the console observes and configures, it never
 * trades"), and it is why there is no path from a browser to `OrderService`:
 * this controller does not import it, and neither does the module.
 *
 * ## Why it lives under `/admin/lab`
 *
 * `AdminAccessGuard` — the operator token plus exactly one identity factor,
 * required on both paths and sufficient on neither. Mounting elsewhere would
 * mean a second authentication mechanism for the same privilege level, and the
 * standalone console's deny-by-default proxy allowlist is keyed on `/admin/*`,
 * so a route outside that prefix would be unreachable from the console anyway.
 *
 * Phase 1 adds the write surface — commands — and it will arrive as typed,
 * idempotent, TTL'd `LabCommand` rows, never as a direct mutation.
 */
@ApiTags('Admin')
@ApiSecurity({ [SECURITY.bearer]: [], [SECURITY.adminToken]: [] })
@Controller('admin/lab')
@UseGuards(AdminAccessGuard)
export class LabController {
  constructor(
    private readonly events: LabEventService,
    private readonly health: LabHealthService,
    private readonly runner: LabRunnerService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Current health and whether the Lab may run.
   *
   * Probes live on every call rather than serving a cached verdict: an operator
   * asking "why is nothing happening" needs the answer as of now, and a stale
   * "healthy" is worse than a slow response.
   */
  @Get('health')
  async labHealth() {
    const profiles = await this.prisma.executionProfile.findMany({
      where: { labEnabled: true },
      select: { symbol: true },
    });
    return this.health.check(Array.from(new Set(profiles.map((p) => p.symbol))));
  }

  /** The lab-enabled profiles and what each is watching. */
  @Get('profiles')
  profiles() {
    return this.prisma.executionProfile.findMany({
      where: { labEnabled: true },
      select: {
        id: true,
        name: true,
        symbol: true,
        agent: true,
        strategyId: true,
        strategyName: true,
        minConfidence: true,
        labTimeframe: true,
        // `enabled` is the ORDER-PLACING switch, distinct from `labEnabled`.
        // Surfaced so an operator can see that a profile is being observed
        // without being armed — which is every profile, in Phase 0.
        enabled: true,
        environment: true,
        accountScope: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  /** The timeline. Newest first; the UI reverses for display. */
  @ApiQuery({ name: 'profileId', required: false })
  @ApiQuery({ name: 'kind', required: false, enum: LabEventKind })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'sinceMinutes', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @Get('events')
  events_(
    @Query('profileId') profileId?: string,
    @Query('kind') kind?: string,
    @Query('symbol') symbol?: string,
    @Query('sinceMinutes') sinceMinutes?: string,
    @Query('limit') limit?: string,
  ) {
    const minutes = Number(sinceMinutes);
    return this.events.list({
      profileId: profileId || undefined,
      kind: kind && kind in LabEventKind ? (kind as LabEventKind) : undefined,
      symbol: symbol || undefined,
      since: Number.isFinite(minutes) && minutes > 0 ? new Date(Date.now() - minutes * 60_000) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /** Event counts by kind — the control room's activity summary. */
  @ApiQuery({ name: 'hours', required: false })
  @Get('events/summary')
  summary(@Query('hours') hours?: string) {
    return this.events.summary(Number(hours) || 24);
  }

  /**
   * Run one observation pass immediately, instead of waiting for the timer.
   *
   * A GET, and deliberately so: it is idempotent in the sense that matters
   * here. The pass writes at most one event per profile per bar because the
   * dedupe key is content-derived, so triggering it repeatedly during one bar
   * converges on the same timeline rather than growing it. It is also the same
   * `runOnce` the timer calls — not a test double and not a shortcut past any
   * gate, so an operator triggering it sees exactly what the loop would have
   * done, including refusing to observe when a dependency is down.
   */
  @Get('tick')
  tick() {
    return this.runner.runOnce();
  }
}

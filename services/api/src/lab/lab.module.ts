import { Module } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard';
import { AdminAccessGuard } from '../admin/admin-access.guard';
import { OperatorService } from '../admin/operator/operator.service';
import { SentinelExecutionClient } from '../paper-execution/sentinel-execution.client';
import { LabController } from './lab.controller';
import { LabEventService } from './lab-event.service';
import { LabHealthService } from './lab-health.service';
import { LabRunnerService } from './lab-runner.service';

/**
 * The Agent Trading Laboratory — Phase 0.
 *
 * ## What this module cannot reach
 *
 * `SimModule`, `OrderService`, `PaperExecutionService`. None of them is
 * imported, and that absence is the structural claim: the Lab cannot place a
 * paper order in Phase 0 because there is no object here that could. When Phase
 * 1 grants it the ability to act it will do so by depending on
 * `PaperExecutionService` — an addition a reviewer will see — never by writing
 * an Order row directly.
 *
 * The one thing it borrows is `SentinelExecutionClient`, provided here rather
 * than exported from `PaperExecutionModule` so the Lab does not pull that whole
 * module's lifecycle (its scheduler included) into its own. The client is a
 * stateless HTTP caller with no dependencies; two instances cost nothing and
 * neither can do anything but read.
 *
 * `AdminAccessGuard` and its dependency chain are provided DIRECTLY rather than
 * imported from `AdminModule`, which deliberately exports nothing to keep its
 * boundary one-way. `ControlModule` already does exactly this with
 * `AdminService`, for the same reason: these are stateless collections of
 * checks over a `@Global` Prisma, so a second instance costs nothing and the
 * operator console stays independent of this surface.
 *
 * `AdminGuard` must be listed even though no controller names it — Nest has to
 * construct it in order to inject it into `AdminAccessGuard`, which delegates
 * the product-admin path to it unchanged. The standing invariant holds: every
 * admin sub-surface uses `AdminAccessGuard`, never `AdminGuard` directly.
 *
 * `PrismaModule` and `CommonModule` (which provides `LeaderElectionService`)
 * are both `@Global`.
 */
@Module({
  controllers: [LabController],
  providers: [
    LabEventService,
    LabHealthService,
    LabRunnerService,
    SentinelExecutionClient,
    AdminAccessGuard,
    AdminGuard,
    OperatorService,
  ],
  exports: [LabEventService, LabHealthService],
})
export class LabModule {}

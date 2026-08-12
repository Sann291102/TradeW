import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminService } from './admin.service';
import { OperatorController } from './operator/operator.controller';
import { OperatorService } from './operator/operator.service';
import { CognitionModule } from '../cognition/cognition.module';

/**
 * The admin portal's backend.
 *
 * Nothing is exported. No other module should depend on admin reads — if a
 * feature needs one of these queries, that is a sign the query belongs in the
 * feature's own module, not that it should reach across into the operator
 * surface. Keeping the boundary one-way also means the admin module can be
 * dropped from a deployment entirely (omit it from `AppModule`) and the
 * platform still builds.
 *
 * `PrismaModule` and `TelemetryModule` are both `@Global`, so neither is
 * imported here.
 *
 * `CognitionModule` is the one exception to the no-inbound-dependency rule
 * above, and it points the correct way: the console *reads* the network, the
 * network does not read the console. The import is here rather than the
 * cognition module being made global, so the dependency is visible in one file
 * instead of being ambient everywhere.
 *
 * Two guards are provided because there are two admin identities. `AdminGuard`
 * is the product-admin path (a signed-in TradeW user with `isAdmin`);
 * `AdminAccessGuard` is what `AdminController` actually uses, and it delegates
 * to `AdminGuard` unchanged when no operator assertion is present. `AdminGuard`
 * MUST stay in `providers` even though the controller no longer names it — Nest
 * has to be able to construct it to inject it into `AdminAccessGuard`.
 * `OperatorController`/`OperatorService` are the standalone-console path;
 * `OperatorService` is also injected into `AdminAccessGuard`, so it belongs to
 * this module rather than a separate one.
 */
@Module({
  imports: [CognitionModule],
  controllers: [AdminController, OperatorController],
  providers: [AdminService, AdminGuard, AdminAccessGuard, OperatorService],
})
export class AdminModule {}

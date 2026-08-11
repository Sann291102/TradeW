import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
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
 */
@Module({
  imports: [CognitionModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}

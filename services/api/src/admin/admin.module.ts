import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';

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
 */
@Module({
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}

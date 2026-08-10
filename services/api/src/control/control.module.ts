import { Module } from '@nestjs/common';
import { ControlController } from './control.controller';
import { ControlGuard } from './control.guard';
import { AdminService } from '../admin/admin.service';

/**
 * The Admin Control Plane boundary inside TradeW Core.
 *
 * `AdminService` is provided directly rather than imported from `AdminModule`,
 * because that module deliberately exports nothing and its one-way boundary is
 * worth preserving. `AdminService` is a stateless collection of Prisma reads
 * and `PrismaModule` is `@Global`, so a second instance costs nothing and keeps
 * the existing operator console independent of this one.
 *
 * Dropping this module from `AppModule` removes the control surface entirely —
 * useful for a deployment that should not be remotely controllable at all.
 */
@Module({
  controllers: [ControlController],
  providers: [ControlGuard, AdminService],
})
export class ControlModule {}

import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DisciplineController } from './discipline.controller';
import { DisciplineService } from './discipline.service';

/**
 * Discipline sessions. Exports `DisciplineService` because `SimModule` calls
 * it on the order-placement path — the limit checks live in the OMS, not in
 * the UI layer, so a client that talks to `/sim/orders` directly is bound by
 * them exactly as the web app is.
 */
@Module({
  imports: [PrismaModule],
  controllers: [DisciplineController],
  providers: [DisciplineService],
  exports: [DisciplineService],
})
export class DisciplineModule {}

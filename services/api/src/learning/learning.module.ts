import { Module } from '@nestjs/common';
import { LearningController } from './learning.controller';
import { LearningApiService } from './learning.service';
import { LearningProgressService } from './learning-progress.service';

/**
 * Learning Platform module (services/api side). Mirrors SentinelModule: the
 * global JwtModule (AuthGuard), the global EntitlementsModule
 * (EntitlementsService) and the global PrismaModule (PrismaService) supply the
 * cross-cutting dependencies, so nothing extra is imported here.
 */
@Module({
  controllers: [LearningController],
  providers: [LearningApiService, LearningProgressService],
})
export class LearningModule {}

import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { NseModule } from '../nse/nse.module';
import { ResearchController } from './research.controller';
import { ResearchService } from './research.service';
import { ResearchCacheService } from './research-cache.service';
import { ResearchAnalysisService } from './research-analysis.service';

/**
 * Fundamental research.
 *
 * `EntitlementsModule` is imported for `CapabilityGuard`, which gates the single
 * premium route (`/research/:symbol/analysis`) — see the controller for why the
 * statements themselves are deliberately not gated.
 *
 * `PrismaModule` backs the statement cache. No provider is registered for
 * `FINANCIAL_DATA_PROVIDER` here: `ResearchService` resolves the configured
 * vendor itself, and the token exists so tests can inject a fake without an
 * environment variable being able to do the same in production.
 */
@Module({
  imports: [PrismaModule, EntitlementsModule, NseModule],
  controllers: [ResearchController],
  providers: [ResearchService, ResearchCacheService, ResearchAnalysisService],
  exports: [ResearchService],
})
export class ResearchModule {}

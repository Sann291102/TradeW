import { Module } from '@nestjs/common';
import { SentinelIntelligenceController } from './sentinel-intelligence.controller';
import { SentinelIntelligenceApiService } from './sentinel-intelligence.service';

/**
 * Proxy module for the SentinelIntelligence surface.
 *
 * Deliberately separate from `SentinelModule`, which owns the orchestrator's
 * `/sentinel/*` routes that `apps/web`'s existing workspace depends on. Two
 * modules, two route prefixes, no shared state — adding this one cannot change
 * the behaviour of the other.
 *
 * Mirrors `SentinelModule`'s shape exactly, including relying on the globally
 * available `PrismaService` and `EntitlementsService` rather than re-importing
 * their modules.
 */
@Module({
  controllers: [SentinelIntelligenceController],
  providers: [SentinelIntelligenceApiService],
})
export class SentinelIntelligenceModule {}

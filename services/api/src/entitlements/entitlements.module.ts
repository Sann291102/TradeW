import { Global, Module } from '@nestjs/common';
import { EntitlementsController } from './entitlements.controller';
import { EntitlementsService } from './entitlements.service';
import { CapabilityGuard } from './capability.guard';

/**
 * Global so any feature module can use CapabilityGuard/@RequiresCapability
 * without re-importing — the centralized entitlement chokepoint (decision Q7).
 */
@Global()
@Module({
  controllers: [EntitlementsController],
  providers: [EntitlementsService, CapabilityGuard],
  exports: [EntitlementsService, CapabilityGuard],
})
export class EntitlementsModule {}

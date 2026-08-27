import { Module } from '@nestjs/common';
import { MarketDataModule } from '../market-data/market-data.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AiController } from './ai.controller';
import { ComplianceGate } from './compliance/compliance.gate';
import { ConversationService } from './conversation/conversation.service';
import { MarketContextService } from './market/market-context.service';
import { OrchestratorService } from './orchestrator/orchestrator.service';
import { PersonaService } from './persona/persona.service';

/**
 * TradeW AI — the assistant's runtime inside `services/api`.
 *
 * Not `services/tradew-ai`: that folder is still a README, and the doc
 * (`services/tradew-ai/README.md`) already says to treat `packages/ai-core` as
 * the real implementation location until it is extracted. This module composes
 * ai-core's primitives with the api layer's user identity, conversation store
 * and market reads — which is exactly where `TRADEW-OS.md` §2.4 puts
 * orchestration. Extracting the reasoning half into its own service later is a
 * transport change, not a redesign: `OrchestratorService` is the seam.
 *
 * `PersonaService` is exported because `AuthModule` needs it to carry a
 * pre-signup name onto a new account.
 */
@Module({
  imports: [PrismaModule, MarketDataModule],
  controllers: [AiController],
  providers: [
    ComplianceGate,
    PersonaService,
    ConversationService,
    MarketContextService,
    OrchestratorService,
  ],
  exports: [PersonaService, ComplianceGate],
})
export class AiModule {}

import { Module } from '@nestjs/common';
import { AssistantController } from './assistant/assistant.controller';
import { AssistantService } from './assistant/assistant.service';

/**
 * TradeW AI (Research) runtime.
 *
 * Deliberately small: this service owns no database, no user session and no
 * scheduled work. It composes `@tradew/ai-core` and answers one question —
 * "what does this person want the application to do?" Everything about who is
 * asking, whether they are entitled to ask, and what gets recorded about it
 * lives in `services/api`.
 */
@Module({
  controllers: [AssistantController],
  providers: [AssistantService],
})
export class AppModule {}

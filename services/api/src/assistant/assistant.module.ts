import { Module } from '@nestjs/common';
import { AssistantController } from './assistant.controller';
import { AssistantApiService } from './assistant.service';

@Module({
  controllers: [AssistantController],
  providers: [AssistantApiService],
})
export class AssistantModule {}

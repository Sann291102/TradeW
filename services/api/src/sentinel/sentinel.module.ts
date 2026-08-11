import { Module } from '@nestjs/common';
import { SentinelController } from './sentinel.controller';
import { SentinelEventDispatcher } from './sentinel-event-dispatcher.service';
import { SentinelApiService } from './sentinel.service';

@Module({
  controllers: [SentinelController],
  providers: [SentinelApiService, SentinelEventDispatcher],
})
export class SentinelModule {}

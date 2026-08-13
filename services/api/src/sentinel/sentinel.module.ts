import { Module } from '@nestjs/common';
import { SentinelController } from './sentinel.controller';
import { SentinelPyController } from './sentinel-py.controller';
import { SentinelEventDispatcher } from './sentinel-event-dispatcher.service';
import { SentinelApiService } from './sentinel.service';

@Module({
  controllers: [SentinelController, SentinelPyController],
  providers: [SentinelApiService, SentinelEventDispatcher],
})
export class SentinelModule {}

import { Module } from '@nestjs/common';
import { SentinelController } from './sentinel.controller';
import { SentinelPyController } from './sentinel-py.controller';
import { SentinelPyProxyController } from './sentinel-py.proxy.controller';
import { SentinelEventDispatcher } from './sentinel-event-dispatcher.service';
import { SentinelApiService } from './sentinel.service';
import { SentinelPyService } from './sentinel-py.service';

@Module({
  controllers: [SentinelController, SentinelPyController, SentinelPyProxyController],
  providers: [SentinelApiService, SentinelEventDispatcher, SentinelPyService],
})
export class SentinelModule {}

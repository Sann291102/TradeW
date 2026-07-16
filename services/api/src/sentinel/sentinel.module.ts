import { Module } from '@nestjs/common';
import { SentinelController } from './sentinel.controller';
import { SentinelApiService } from './sentinel.service';

@Module({
  controllers: [SentinelController],
  providers: [SentinelApiService],
})
export class SentinelModule {}

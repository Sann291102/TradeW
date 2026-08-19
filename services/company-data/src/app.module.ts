import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PrismaService } from './prisma.service';
import { SourceFetcherService } from './ingestion/source-fetcher.service';
import { IngestionSchedulerService } from './ingestion/ingestion-scheduler.service';
import { EquityListConnector } from './connectors/equity-list.connector';
import { BhavcopyConnector } from './connectors/bhavcopy.connector';

@Module({
  controllers: [HealthController],
  providers: [PrismaService, SourceFetcherService, IngestionSchedulerService, EquityListConnector, BhavcopyConnector],
})
export class AppModule {}

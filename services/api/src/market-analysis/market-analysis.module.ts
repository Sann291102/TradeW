import { Module } from '@nestjs/common';
import { MarketAnalysisController } from './market-analysis.controller';
import { MarketAnalysisApiService } from './market-analysis.service';

@Module({
  controllers: [MarketAnalysisController],
  providers: [MarketAnalysisApiService],
})
export class MarketAnalysisModule {}

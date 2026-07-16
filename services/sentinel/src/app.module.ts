import { Module } from '@nestjs/common';
import { AppController, ServiceTokenGuard } from './app.controller';
import { ComplianceService } from './compliance/compliance.service';
import { EmotionIntelligenceService } from './intelligence/emotion-intelligence.service';
import { MARKET_DATA, MarketIntelligenceService } from './intelligence/market-intelligence.service';
import { NewsIntelligenceService } from './intelligence/news-intelligence.service';
import { TrapIntelligenceService } from './intelligence/trap-intelligence.service';
import { SimMarketDataProvider } from './market-data/sim-market-data.provider';
import { SentinelOrchestratorService } from './orchestrator/sentinel-orchestrator.service';
import { PrismaService } from './prisma.service';

@Module({
  controllers: [AppController],
  providers: [
    PrismaService,
    ServiceTokenGuard,
    // MarketDataProvider is injected by token — swapping simulation for
    // historical/NSE/BSE/Dhan later changes only this one binding (Q6).
    { provide: MARKET_DATA, useClass: SimMarketDataProvider },
    MarketIntelligenceService,
    EmotionIntelligenceService,
    TrapIntelligenceService,
    NewsIntelligenceService,
    ComplianceService,
    SentinelOrchestratorService,
  ],
})
export class AppModule {}

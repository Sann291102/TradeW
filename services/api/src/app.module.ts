import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { EntitlementsModule } from './entitlements/entitlements.module';
import { InstrumentsModule } from './instruments/instruments.module';
import { MarketDataModule } from './market-data/market-data.module';
import { SimModule } from './sim/sim.module';
import { DisciplineModule } from './discipline/discipline.module';
import { CryptoModule } from './crypto/crypto.module';
import { NewsModule } from './news/news.module';
import { BrokerModule } from './broker/broker.module';
import { MailModule } from './mail/mail.module';
import { SentinelModule } from './sentinel/sentinel.module';
import { SentinelIntelligenceModule } from './sentinel-intelligence/sentinel-intelligence.module';
import { LearningModule } from './learning/learning.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { NotificationModule } from './notification/notification.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    PrismaModule,
    JwtModule.register({ global: true, secret: process.env.JWT_SECRET || 'dev-secret-change-me', signOptions: { expiresIn: '7d' } }),
    AuthModule,
    EntitlementsModule,
    InstrumentsModule,
    MarketDataModule,
    CryptoModule,
    NewsModule,
    BrokerModule,
    MailModule,
    DisciplineModule,
    SimModule,
    SentinelModule,
    SentinelIntelligenceModule,
    LearningModule,
    KnowledgeModule,
    NotificationModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

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
import { SmsModule } from './sms/sms.module';
import { SentinelModule } from './sentinel/sentinel.module';
import { SentinelIntelligenceModule } from './sentinel-intelligence/sentinel-intelligence.module';
import { LearningModule } from './learning/learning.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { NotificationModule } from './notification/notification.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { AdminModule } from './admin/admin.module';
import { AiModule } from './ai/ai.module';
import { ControlModule } from './control/control.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    PrismaModule,
    // Before every feature module: it registers the global interceptor that
    // records requests, and installs the ai-core telemetry sink at init. Later
    // in the list and the first requests of a boot would go unrecorded.
    TelemetryModule,
    JwtModule.register({ global: true, secret: process.env.JWT_SECRET || 'dev-secret-change-me', signOptions: { expiresIn: '7d' } }),
    AuthModule,
    EntitlementsModule,
    InstrumentsModule,
    MarketDataModule,
    CryptoModule,
    NewsModule,
    BrokerModule,
    MailModule,
    SmsModule,
    DisciplineModule,
    SimModule,
    SentinelModule,
    SentinelIntelligenceModule,
    LearningModule,
    KnowledgeModule,
    NotificationModule,
    // TradeW AI. After MarketDataModule (it reads quotes through that service)
    // and after AuthModule (its routes are bearer-guarded).
    AiModule,
    AdminModule,
    // The Admin Control Plane boundary. Signed, replay-protected, narrow.
    // Remove this line to disable remote control of this deployment entirely.
    ControlModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

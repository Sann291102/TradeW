import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { EntitlementsModule } from './entitlements/entitlements.module';
import { InstrumentsModule } from './instruments/instruments.module';
import { MarketDataModule } from './market-data/market-data.module';
import { SimModule } from './sim/sim.module';
import { SentinelModule } from './sentinel/sentinel.module';
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
    SimModule,
    SentinelModule,
    KnowledgeModule,
    NotificationModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

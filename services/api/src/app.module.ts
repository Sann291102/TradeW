import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { resolveSecret } from './common/secret-validation';
import { CommonModule } from './common/common.module';
import { GLOBAL_PER_MIN, ROUTE_DEFAULT_PER_MIN, TradewThrottlerGuard } from './common/throttling';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { EntitlementsModule } from './entitlements/entitlements.module';
import { InstrumentsModule } from './instruments/instruments.module';
import { UniverseModule } from './universe/universe.module';
import { CompanyModule } from './company/company.module';
import { MarketDataModule } from './market-data/market-data.module';
import { SimModule } from './sim/sim.module';
import { DisciplineModule } from './discipline/discipline.module';
import { CryptoModule } from './crypto/crypto.module';
import { NewsModule } from './news/news.module';
import { ResearchModule } from './research/research.module';
import { NseModule } from './nse/nse.module';
import { BrokerModule } from './broker/broker.module';
import { MailModule } from './mail/mail.module';
import { SmsModule } from './sms/sms.module';
import { SentinelModule } from './sentinel/sentinel.module';
import { AssistantModule } from './assistant/assistant.module';
import { PricingModule } from './pricing/pricing.module';
import { PaymentModule } from './payments/payment.module';
import { SentinelIntelligenceModule } from './sentinel-intelligence/sentinel-intelligence.module';
import { LearningModule } from './learning/learning.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { NotificationModule } from './notification/notification.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { AdminModule } from './admin/admin.module';
import { BacktestModule } from './backtest/backtest.module';
import { LabModule } from './lab/lab.module';
import { PaperExecutionModule } from './paper-execution/paper-execution.module';
import { CognitionModule } from './cognition/cognition.module';
import { ControlModule } from './control/control.module';
import { GraphModule } from './graph/graph.module';
import { AiModule } from './ai/ai.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    PrismaModule,
    // Leader election, so the background loops below (matching engine, T+1
    // settlement, performance sweep, telemetry retention) run on exactly one
    // instance no matter how many replicas serve HTTP. Global; imported here
    // right after Prisma because it needs the database and nothing else.
    CommonModule,
    // Before every feature module: it registers the global interceptor that
    // records requests, and installs the ai-core telemetry sink at init. Later
    // in the list and the first requests of a boot would go unrecorded.
    TelemetryModule,
    // JWT_SECRET is the token-signing boundary: with it, anyone can mint a
    // valid session for any user. It therefore has NO fallback — `resolveSecret`
    // aborts boot on a missing, placeholder, too-short, or vendor-key value
    // rather than silently signing with a public default (the 2026-08-10
    // finding: the old `|| 'dev-secret-change-me'` let a forged admin token
    // through). Vendor-key prefixes are allowed here only because a long random
    // base64url secret can coincidentally start with 'sk-'; length + placeholder
    // checks are what matter for the signing key.
    JwtModule.register({
      global: true,
      secret: resolveSecret('JWT_SECRET', process.env.JWT_SECRET, { rejectVendorKeys: false }),
      signOptions: { expiresIn: '7d' },
    }),
    // Rate limiting. Two buckets per caller — one spanning the whole API, one
    // per route — see common/throttling.ts for why both are needed and why the
    // in-memory store is correct only while a single API replica runs.
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'global', ttl: 60_000, limit: GLOBAL_PER_MIN },
        { name: 'route', ttl: 60_000, limit: ROUTE_DEFAULT_PER_MIN },
      ],
      errorMessage: 'Too many requests. Slow down and try again shortly.',
    }),
    AuthModule,
    EntitlementsModule,
    InstrumentsModule,
    UniverseModule,
    CompanyModule,
    MarketDataModule,
    CryptoModule,
    NewsModule,
    // Fundamental research. Statements are free on every plan; only the AI
    // synthesis inside it is capability-gated. See research.controller.ts.
    ResearchModule,
    NseModule,
    BrokerModule,
    MailModule,
    SmsModule,
    DisciplineModule,
    SimModule,
    SentinelModule,
    AssistantModule,
    PricingModule,
    PaymentModule,
    SentinelIntelligenceModule,
    LearningModule,
    KnowledgeModule,
    NotificationModule,
    // TradeW AI. After MarketDataModule (it reads quotes through that service)
    // and after AuthModule (its routes are bearer-guarded).
    AiModule,
    // The four-layer perceptor network. Registers its sensors at init but runs
    // no passes unless COGNITION_ENABLED=true — so importing it costs a roster
    // and nothing else. Placed before AdminModule because the console reads it.
    CognitionModule,
    // Sentinel's paper-execution capability. Like CognitionModule, importing it
    // costs a roster and nothing else: the scheduler starts no timers unless
    // PAPER_EXECUTION_ENABLED=true, and even then only profiles explicitly
    // armed by an operator can trade. Placed before AdminModule because the
    // console reads it. Removing this line disables agent execution entirely
    // and changes no trader-facing behaviour.
    PaperExecutionModule,
    // Historical simulation. Separate from PaperExecutionModule on purpose:
    // a backtest replays stored bars and can never place an order.
    BacktestModule,
    // Agent Trading Laboratory. Phase 0 observes and records; it imports no
    // OMS service, so it cannot place an order.
    LabModule,
    AdminModule,
    // The Admin Control Plane boundary. Signed, replay-protected, narrow.
    // Remove this line to disable remote control of this deployment entirely.
    ControlModule,
    // The system graph. MUST STAY LAST: it reads the container's own module
    // registry to discover routes and controllers, so any module registered
    // after it would be missing from the graph — silently, which is the worst
    // way for an operations map to be wrong. See graph/graph.module.ts.
    GraphModule,
  ],
  controllers: [HealthController],
  providers: [
    // The ONLY global guard in this application. Authentication deliberately
    // stays decorator-driven per route (see auth/auth.guard.spec.ts) — rate
    // limiting is the opposite case: a route that is accidentally left off the
    // list should still be metered, so this one is registered globally and
    // opted *out* of, not into.
    { provide: APP_GUARD, useClass: TradewThrottlerGuard },
  ],
})
export class AppModule {}

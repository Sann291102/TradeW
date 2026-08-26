import { Module } from '@nestjs/common';
import { BrokerModule } from '../broker/broker.module';
import { SimModule } from '../sim/sim.module';
import { AutoTradeController } from './autotrade.controller';
import { AutoTradeService } from './autotrade.service';
import { BrokerExecutionAdapter } from './broker-execution.adapter';
import { ExecutionAccountService } from './execution-account.service';
import { ExecutionAdapterResolver } from './execution-adapter.resolver';
import { ExecutionLifecycleService } from './execution-lifecycle.service';
import { ExecutionProfileService } from './execution-profile.service';
import { ExecutionQualificationService } from './execution-qualification.service';
import { ExecutionQueryService } from './execution-query.service';
import { ExecutionSchedulerService } from './execution-scheduler.service';
import { ExecutionStateService } from './execution-state.service';
import { ExecutionTraceService } from './execution-trace.service';
import { PaperExecutionAdapter } from './paper-execution.adapter';
import { PaperExecutionService } from './paper-execution.service';
import { SentinelExecutionClient } from './sentinel-execution.client';

/**
 * The Sentinel execution capability — decisions, arming, paper execution, the
 * paper→live qualification, and the guarded live boundary.
 *
 * ## It imports SimModule; SimModule does not import it
 *
 * That direction is the whole architectural claim of this feature. The paper
 * OMS knows nothing about Sentinel, execution profiles or intents — it is the
 * same order engine it was before this module existed, and a deployment that
 * omits this module from `AppModule` loses agent execution and keeps every
 * trader-facing behaviour untouched. If the arrow ever reverses, the OMS has
 * become Sentinel-aware and Rule 2's "never a gate in the order flow" is no
 * longer structurally true, only conventionally.
 *
 * ## It imports BrokerModule for exactly one thing
 *
 * `BrokerExecutionAdapter` needs `DhanAuthService.accessTokenForUser`, and that
 * is the ONLY reason this module knows the broker module exists. Nothing else
 * in this folder injects it, and the arrow again runs one way: the broker
 * module has no idea Sentinel exists.
 *
 * ## One controller, and it cannot arm anything
 *
 * `AutoTradeController` is the account holder's own surface — the switch §3
 * describes and the refusal §14 requires. Every ADMINISTRATIVE surface stays on
 * `AdminController` behind `AdminAccessGuard`, reached through the console's
 * deny-by-default proxy allowlist, for the same reason it always did: a second
 * controller would mean a second guard to keep correct on the one surface that
 * least deserves a bespoke auth path.
 *
 * The split is not cosmetic. A user can reach `/autotrade/*` and cannot reach a
 * single route that writes `ExecutionProfile.state`; an operator reaches the
 * state machine and never touches a user's AutoTrade switch. Two principals,
 * two surfaces, no overlap.
 */
@Module({
  imports: [SimModule, BrokerModule],
  controllers: [AutoTradeController],
  providers: [
    SentinelExecutionClient,
    ExecutionAccountService,
    ExecutionProfileService,
    ExecutionStateService,
    ExecutionQualificationService,
    // The two engines and the object that chooses between them. See
    // execution-adapter.ts: nothing outside this trio holds an adapter.
    PaperExecutionAdapter,
    BrokerExecutionAdapter,
    ExecutionAdapterResolver,
    PaperExecutionService,
    ExecutionLifecycleService,
    ExecutionTraceService,
    ExecutionQueryService,
    ExecutionSchedulerService,
    AutoTradeService,
  ],
  exports: [
    PaperExecutionService,
    ExecutionLifecycleService,
    ExecutionTraceService,
    ExecutionQueryService,
    // Exported so the admin console can list eligible accounts and grant/revoke
    // consent. It is the only way to set `User.agentPaperTradingEnabledAt`, and
    // it audits every change — see setAgentPaperTrading.
    ExecutionAccountService,
    // Exported so the console can ask whether the loop is actually ticking.
    // A read of this process's own state — the one question the database
    // cannot answer, and the reason `execution/status` exists.
    ExecutionSchedulerService,
    // Exported for the console's create/rebind route. Omitting this while
    // `AdminController` injected it took the ENTIRE API down at boot on
    // 2026-08-18 with "Nest can't resolve dependencies of the AdminController
    // … ExecutionProfileService at index [7]" — a provider is visible to its
    // own module whether or not it is exported, so nothing local complains,
    // and `tsc` plus 912 unit tests all passed. Only starting the process
    // catches it, exactly as
    // knowledge/Gotchas/2026-08-12 - Nest DTOs must be declared above the
    // controller records for the same class of failure.
    ExecutionProfileService,
    // The console's arm/disarm/pause/live-arm surface, and the qualification it
    // must read before arming live.
    ExecutionStateService,
    ExecutionQualificationService,
    // Exported so the console can answer "would this user see AutoTrade, and
    // why not" without reimplementing the eligibility rule a second time.
    AutoTradeService,
  ],
})
export class PaperExecutionModule {}

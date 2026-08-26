import { Module } from '@nestjs/common';
import { SimModule } from '../sim/sim.module';
import { ExecutionAccountService } from './execution-account.service';
import { ExecutionLifecycleService } from './execution-lifecycle.service';
import { ExecutionProfileService } from './execution-profile.service';
import { ExecutionQueryService } from './execution-query.service';
import { ExecutionSchedulerService } from './execution-scheduler.service';
import { ExecutionTraceService } from './execution-trace.service';
import { PaperExecutionService } from './paper-execution.service';
import { SentinelExecutionClient } from './sentinel-execution.client';
import { SystemExecutionControlService } from './system-execution-control.service';

/**
 * The Sentinel paper-execution capability.
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
 * ## No controller of its own
 *
 * The operator surface for this lives on `AdminController`, behind
 * `AdminAccessGuard`, reached through the console's deny-by-default proxy
 * allowlist. Exposing a second controller would mean a second guard to keep
 * correct on the one surface that least deserves a bespoke auth path.
 * `AdminModule` imports this module and reads it, exactly as it already does
 * with `CognitionModule` — the console reads the feature, never the reverse.
 */
@Module({
  imports: [SimModule],
  providers: [
    SentinelExecutionClient,
    ExecutionAccountService,
    ExecutionProfileService,
    PaperExecutionService,
    ExecutionLifecycleService,
    ExecutionTraceService,
    ExecutionQueryService,
    ExecutionSchedulerService,
    SystemExecutionControlService,
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
    // Exported so the console can read and flip the global kill switch, and so
    // the scheduler/health surface can report the current mode. It is the only
    // way to set `SystemExecutionControl.mode`, and it audits every change.
    SystemExecutionControlService,
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
  ],
})
export class PaperExecutionModule {}

import { Module } from '@nestjs/common';
import { SimModule } from '../sim/sim.module';
import { ExecutionAccountService } from './execution-account.service';
import { ChartAnnotationsService } from './chart-annotations.service';
import { CrossMarketPerformanceService } from './cross-market-performance.service';
import { ExecutionCalibrationService } from './execution-calibration.service';
import { ExecutionControlService } from './execution-control.service';
import { ExecutionJournalService } from './execution-journal.service';
import { ExecutionLearningService } from './execution-learning.service';
import { ExecutionLifecycleService } from './execution-lifecycle.service';
import { ExecutionProfileService } from './execution-profile.service';
import { ExecutionQueryService } from './execution-query.service';
import { ExecutionSchedulerService } from './execution-scheduler.service';
import { ExecutionTraceService } from './execution-trace.service';
import { PaperExecutionService } from './paper-execution.service';
import { PositionManagerService } from './position-manager.service';
import { SentinelExecutionClient } from './sentinel-execution.client';

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
    // The fast loop's actor, the bounded-learning store, and the journal
    // writer. All three are providers of THIS module rather than of
    // `SimModule`, which keeps the dependency arrow pointing
    // `PaperExecutionModule → SimModule` and never back — the structural claim
    // that Sentinel is not a gate in the order flow.
    PositionManagerService,
    ExecutionCalibrationService,
    ExecutionJournalService,
    // The operator kill switch. A provider of THIS module for the same reason
    // as the three above — `PaperExecutionService` reads it in the execution
    // path, and the arrow stays PaperExecutionModule → SimModule.
    ExecutionControlService,
    // The staged learning pipeline. A provider here rather than a module of its
    // own: it reads the journal this module writes, and nothing outside the
    // console needs it.
    ExecutionLearningService,
    // The chart's strategy-annotation reader. A pure read over the evaluation
    // log, the intents and their outcomes — it writes nothing, and it is in
    // THIS module rather than the console's because the records it reads are
    // this module's own.
    ChartAnnotationsService,
    // The experiment's output — which strategies work in which markets. A pure
    // read over `ExecutionJournal`; it computes nothing that is not already a
    // closed trade.
    CrossMarketPerformanceService,
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
    PositionManagerService,
    ExecutionJournalService,
    ExecutionCalibrationService,
    // Exported so the console can read the halt state and set it. This is the
    // ONLY way `ExecutionControl` is written — nothing in the strategy,
    // calibration or learning path can reach it, which is what makes it a kill
    // switch rather than a suggestion.
    ExecutionControlService,
    // Exported for the console's learning pages and the promotion endpoint.
    // `promote()` is the only writer of PROMOTED anywhere in the codebase.
    ExecutionLearningService,
    // Exported because `AdminController` injects it. See the ExecutionProfileService
    // note above: a provider missing from this list is invisible to tsc and to
    // every unit test, and only takes the API down at boot.
    ChartAnnotationsService,
    CrossMarketPerformanceService,
  ],
})
export class PaperExecutionModule {}

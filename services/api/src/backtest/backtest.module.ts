import { Module } from '@nestjs/common';
import { BacktestAnalysisService } from './backtest-analysis.service';
import { BacktestController } from './backtest.controller';
import { BacktestRunnerService } from './backtest-runner.service';
import { BacktestService } from './backtest.service';
import { SentinelBacktestClient } from './sentinel-backtest.client';

/**
 * Backtesting — historical simulation, and nothing else.
 *
 * ## What this module deliberately does NOT import
 *
 * `SimModule`. Not the order service, not the matching engine, not the paper
 * wallet. A backtest cannot place a paper order because there is no object here
 * that could place one, which is the same structural argument
 * `PaperExecutionModule` makes in the other direction (its arrow runs into
 * `SimModule` and never back out).
 *
 * The one thing it borrows from `sim` is arithmetic: `applyFill` and
 * `computeMargin` are imported as pure functions by `execution-simulator.ts`.
 * Functions, not services — no provider, no lifecycle, no shared state, and no
 * way for a backtest to reach a wallet through them.
 *
 * ## Three separate systems, and this is one of them
 *
 *   Backtest        → this module. Historical replay over stored bars.
 *   Paper execution → `PaperExecutionModule`. Live-market simulation.
 *   Live execution  → does not exist, and `ExecutionEnvironment` has no value
 *                     that could route to it.
 *
 * Nothing here is a gate in anyone's order flow (CLAUDE.md Rule 2). Deleting
 * this module removes backtesting and changes nothing a trader can otherwise
 * do.
 */
@Module({
  // No imports. `PrismaModule` and `CommonModule` (which provides
  // `LeaderElectionService`) are both @Global, and this module deliberately
  // pulls in nothing else — see the note above.
  controllers: [BacktestController],
  providers: [BacktestService, BacktestRunnerService, BacktestAnalysisService, SentinelBacktestClient],
  exports: [BacktestService],
})
export class BacktestModule {}

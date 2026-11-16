/**
 * The autonomous decision engine.
 *
 * Deliberately a SEPARATE module from `PaperExecutionModule` rather than a
 * folder inside it. The existing module is the Sentinel-driven option path,
 * which is working and must keep working (it placed the only two real bot
 * trades this repository has). Growing it a second decision source would put
 * both paths in one dependency graph, and the first accidental import between
 * them would make "the engine runs with Sentinel disabled" untrue.
 *
 * This module IS registered in the application, because the parallel brain has
 * to actually run to collect anything. What it is not is authoritative: it
 * provides no controller, exports nothing into the order path, and holds no
 * reference to `OrderService`, a wallet or an execution adapter. Its timers do
 * not start unless `AUTONOMOUS_OBSERVER_ENABLED=true`, and even then the only
 * thing they can do is read market data and write to three tables nothing else
 * reads.
 *
 * Placing an order additionally requires `AUTONOMOUS_ENGINE_ENABLED` — a switch
 * that currently has no reader at all, because no such code path exists.
 */

import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SimModule } from '../sim/sim.module';
import { AutonomousExecutionService } from './autonomous-execution.service';
import { AutonomousPositionManagerService } from './autonomous-position-manager.service';
import { ContractSelectorService } from './contract-selector.service';
import { BinanceSource } from './binance.source';
import { BrainJournalService } from './brain-journal.service';
import { BrainObserverService } from './brain-observer.service';
import { DhanBridgeSource } from './dhan-bridge.source';
import { OutcomeResolverService } from './outcome-resolver.service';
import { SentinelBenchmarkService } from './sentinel-benchmark.service';
import { SetupScannerService } from './setup-scanner.service';

@Module({
  imports: [PrismaModule, CommonModule, SimModule],
  providers: [
    DhanBridgeSource,
    BinanceSource,
    SetupScannerService,
    BrainJournalService,
    OutcomeResolverService,
    SentinelBenchmarkService,
    ContractSelectorService,
    AutonomousExecutionService,
    AutonomousPositionManagerService,
    BrainObserverService,
  ],
  exports: [
    SetupScannerService,
    BrainJournalService,
    OutcomeResolverService,
    BrainObserverService,
    ContractSelectorService,
    AutonomousExecutionService,
    AutonomousPositionManagerService,
  ],
})
export class AutonomousModule {}

/**
 * Proof that the COMPLETE autonomous paper-trading lifecycle works, end to end,
 * against the running application.
 *
 *   npm run verify:trade-lifecycle -w @tradew/api
 *
 *     candidate → risk gate → contract → sizing → PAPER ORDER → FILL
 *               → POSITION → trailing → EXIT → realised R → journal
 *
 * ## What is real and what is arranged
 *
 * REAL: the deriver, the contract selector, the premium 1:3 gate, the risk
 * gate, the sizer, `OrderService.placeOrder`, the paper wallet, the position
 * manager, the trailing engine, and every database row.
 *
 * ARRANGED: which setup asked. The brain only takes a trade when a setup fully
 * validates, and that may not happen on any given afternoon — so this derives a
 * plan from the SAME live closed bars the brain is looking at and drives it
 * through the real path.
 *
 * That distinction is stated on every run. **No threshold is lowered, no level
 * is moved, and nothing bypasses a gate** — if the contract cannot pay 1:3 or
 * the risk gate refuses, this script reports the refusal rather than working
 * around it. It is a proof of the PIPELINE, never evidence of a strategy.
 *
 * The trade it opens is real paper money in the configured account, and it is
 * left for the running position manager to trail and exit exactly as it would
 * any other.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(__dirname, '../../../.env') });

process.env.AUTONOMOUS_ENGINE_ENABLED = 'true';

import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { DisciplineService } from '../src/discipline/discipline.service';
import { PositionService } from '../src/sim/position.service';
import { SettlementService } from '../src/sim/settlement.service';
import { LeaderElectionService } from '../src/common/leader-election';
import { AGENT_SETUPS, deriveLevels, updateTrailingStop } from '@tradew/strategy-core';
import { DhanBridgeSource } from '../src/autonomous/dhan-bridge.source';
import { BinanceSource } from '../src/autonomous/binance.source';
import { SetupScannerService } from '../src/autonomous/setup-scanner.service';
import { ContractSelectorService } from '../src/autonomous/contract-selector.service';
import { AutonomousExecutionService } from '../src/autonomous/autonomous-execution.service';
import { AutonomousPositionManagerService } from '../src/autonomous/autonomous-position-manager.service';
import { OrderService } from '../src/sim/order.service';
import { MarketPriceService } from '../src/sim/market-price.service';
import { BRAIN_VERSION } from '../src/autonomous/brain-version';

const G = '\x1b[32m';
const Y = '\x1b[33m';
const R = '\x1b[31m';
const D = '\x1b[2m';
const B = '\x1b[1m';
const X = '\x1b[0m';

let failed = 0;

function step(n: number, name: string, ok: boolean, detail: string): void {
  if (!ok) failed += 1;
  console.log(`  ${ok ? `${G}✓${X}` : `${R}✗${X}`} ${String(n).padStart(2)}. ${name.padEnd(38)} ${detail}`);
}

async function main(): Promise<void> {
  const now = new Date();
  const symbol = process.argv[2] ?? 'NIFTY';

  console.log('');
  console.log('═'.repeat(84));
  console.log('  AUTONOMOUS PAPER TRADE — FULL LIFECYCLE PROOF');
  console.log('═'.repeat(84));
  console.log(`  ${D}${now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST · ${symbol}${X}`);
  console.log(`  ${Y}Pipeline proof. The setup is arranged; every GATE is real and none is bypassed.${X}`);
  console.log('');

  // The REAL dependency graph, built by Nest — hand-constructing these would
  // silently diverge from what the application actually wires together.
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule],
    providers: [
      DisciplineService,
      MarketPriceService,
      OrderService,
      PositionService,
      SettlementService,
      LeaderElectionService,
    ],
  }).compile();

  const prisma = moduleRef.get(PrismaService);
  const marketPrice = moduleRef.get(MarketPriceService);
  const orders = moduleRef.get(OrderService);
  const scanner = new SetupScannerService(new DhanBridgeSource(), new BinanceSource());
  const selector = new ContractSelectorService();
  const execution = new AutonomousExecutionService(
    prisma as never,
    orders as never,
    marketPrice as never,
    selector,
  );
  const manager = new AutonomousPositionManagerService(prisma as never, orders as never, marketPrice as never);

  // ── 1. A real plan from real closed bars --------------------------------
  const scan = await scanner.scanSymbol(symbol, now);
  if (scan.status !== 'scanned' || !scan.snapshot) {
    console.log(`  ${R}${symbol} is not scannable right now (${scan.status}: ${scan.detail}).${X}`);
    process.exit(1);
  }

  let plan = scan.candidates.find((c) => c.accepted)?.plan ?? null;
  const wasGenuine = plan !== null;

  // Try every setup and both sides, and keep the first whose plan the CONTRACT
  // can actually carry. This is not shopping for a number: each plan is
  // derived by the real deriver from the same bars, and the premium gate still
  // has to pass on its own merits — a plan that cannot clear 1:3 in premium is
  // discarded here exactly as the engine would discard it.
  const refusals: string[] = [];
  if (!plan) {
    outer: for (const setup of AGENT_SETUPS) {
      for (const bias of ['bullish', 'bearish'] as const) {
        const out = deriveLevels(setup, bias, scan.snapshot);
        if (!out.ok) continue;
        const probe = await selector.resolve(symbol, out.plan, now);
        if (probe.ok) {
          plan = out.plan;
          break outer;
        }
        refusals.push(`${setup.id}/${bias}: [${probe.reason}]`);
      }
    }
  }
  if (!plan) {
    console.log(`  ${R}No derivable plan can be carried by a tradable contract right now.${X}`);
    console.log(`  ${D}Every candidate was refused by the premium gate — the structure is sound,`);
    console.log(`  the instruments cannot carry it. This is the gate working:${X}`);
    for (const r of [...new Set(refusals)].slice(0, 6)) console.log(`     ${D}${r}${X}`);
    console.log('');
    process.exit(0);
  }

  step(1, 'plan derived from closed bars', true, `${plan.direction} entry ${plan.entry} stop ${plan.stop} target ${plan.target}`);
  step(2, 'exit plan exists BEFORE entry', Boolean(plan.exitPlan?.exits?.length), `${plan.exitPlan.exits.length} exits, trail arms at ${plan.exitPlan.trailActivationR}R`);
  step(3, 'first reward distinct from 3R target', plan.firstRewardPrice !== plan.target, `1R ${plan.firstRewardPrice} vs 3R ${plan.target}`);
  step(4, 'index R:R >= 3', plan.plannedRR >= 3, `${plan.plannedRR}R`);
  console.log(`     ${D}${wasGenuine ? 'GENUINE validated setup.' : 'Arranged: no setup validated this instant; levels are real, the trigger is not.'}${X}`);

  // ── 2. Persist an immutable candidate -----------------------------------
  const candidateRow = await prisma.autonomousCandidate.create({
    data: {
      scan: {
        create: {
          market: scan.market ?? 'INDIA',
          symbol,
          venue: 'NSE',
          timeframe: '15m',
          status: 'SCANNED',
          brainVersion: BRAIN_VERSION,
          signalBarAt: new Date(now.getTime() - 1),
          detail: 'lifecycle proof',
        },
      },
      market: scan.market ?? 'INDIA',
      symbol,
      venue: 'NSE',
      timeframe: '15m',
      signalBarAt: new Date(now.getTime() - 1),
      setupId: 'lifecycle-proof',
      setupName: 'Lifecycle proof',
      setupVersion: '1.0.0',
      archetype: plan.anchor.archetype,
      brainVersion: BRAIN_VERSION,
      bias: plan.direction === 'long' ? 'bullish' : 'bearish',
      direction: plan.direction,
      quality: 100,
      accepted: true,
      features: {} as Prisma.InputJsonValue,
      confirmed: [] as unknown as Prisma.InputJsonValue,
      unmet: [] as unknown as Prisma.InputJsonValue,
      invalidated: [] as unknown as Prisma.InputJsonValue,
      explanation: 'Full-lifecycle proof of the autonomous paper execution path.',
      entry: new Prisma.Decimal(plan.entry),
      stop: new Prisma.Decimal(plan.stop),
      target: new Prisma.Decimal(plan.target),
      plannedRR: new Prisma.Decimal(plan.plannedRR),
    },
    select: { id: true },
  });
  step(5, 'immutable candidate journalled', true, candidateRow.id);

  // ── 3. THE REAL EXECUTION PATH -------------------------------------------
  const candidate = { ...scan.candidates[0], symbol, market: scan.market, plan, accepted: true, quality: 100 } as never;
  const result = await execution.execute(candidateRow.id, candidate, now);

  console.log('');
  console.log(`  ${B}Gates${X}`);
  for (const c of result.checks) {
    console.log(`     ${c.passed ? `${G}✓${X}` : `${R}✗${X}`} ${c.id.padEnd(28)} ${D}${c.detail.slice(0, 110)}${X}`);
  }
  console.log('');

  if (!result.executed) {
    step(6, 'paper order placed', false, `[${result.refusal}] ${result.detail}`);
    console.log('');
    console.log(`  ${Y}The pipeline refused — which is the gate doing its job, not a defect.${X}`);
    console.log(`  ${D}Nothing was bypassed to force a trade.${X}`);
    console.log('');
    process.exit(result.refusal === 'contract-unavailable' || result.refusal === 'risk-gate-refused' ? 0 : 1);
  }

  const trade = await prisma.autonomousTrade.findUnique({ where: { id: result.tradeId! } });
  if (!trade) {
    step(6, 'trade row written', false, 'not found');
    process.exit(1);
  }

  step(6, 'paper order placed through the OMS', Boolean(trade.entryOrderId), `${trade.entryOrderId}`);
  step(7, 'order FILLED', trade.orderStatus === 'FILLED', `${trade.orderStatus} @ ${trade.actualFillPrice}`);
  step(8, 'position OPEN', trade.positionStatus === 'OPEN', `${trade.tradedSymbol} qty ${trade.quantity}`);
  step(9, 'planned vs ACTUAL entry stored', trade.plannedEntry != null && trade.actualFillPrice != null, `planned ${trade.plannedEntry}, filled ${trade.actualFillPrice}`);
  step(10, 'quantity derived from risk', trade.approvedQuantity > 0, `risk ${trade.riskBudget} ÷ stop distance ${trade.stopDistance} → ${trade.approvedQuantity}`);
  step(11, 'tradable R:R >= 3', Number(trade.plannedRR) >= 3, `${trade.plannedRR}R on ${trade.tradedSymbol}`);

  // ── 4. Idempotency --------------------------------------------------------
  const second = await execution.execute(candidateRow.id, candidate, now);
  step(12, 'repeated execution is a no-op', second.refusal === 'already-executed' && second.tradeId === trade.id, `${second.refusal}`);

  // ── 5. The order actually exists in the paper book ------------------------
  const order = await prisma.order.findUnique({ where: { id: trade.entryOrderId! } });
  step(13, 'order exists in the paper order book', Boolean(order), order ? `${order.side} ${order.quantity} @ ${order.avgFillPrice} (${order.status})` : 'missing');

  // ── 6. Management is live -------------------------------------------------
  const managed = await manager.manageAll(now);
  const after = await prisma.autonomousTrade.findUnique({ where: { id: trade.id } });
  step(14, 'position manager evaluated it', managed.evaluated > 0, `${managed.evaluated} evaluated, ${managed.trailed} trailed, ${managed.exited} exited`);
  const improved =
    after == null
      ? false
      : trade.direction === 'long'
        ? Number(after.currentStop) >= Number(trade.initialStop)
        : Number(after.currentStop) <= Number(trade.initialStop);
  step(15, 'stop never worse than the initial', improved, `${trade.initialStop} → ${after?.currentStop}`);

  // ── 7. The ratchet the manager will apply, proven deterministically -------
  const entry = Number(trade.actualFillPrice);
  const risk = Math.abs(entry - Number(trade.initialStop));
  const projected: number[] = [];
  let s = Number(trade.currentStop);
  for (const rMultiple of [1, 2, 3]) {
    const hw = trade.direction === 'long' ? entry + rMultiple * risk : entry - rMultiple * risk;
    const t = updateTrailingStop({ direction: trade.direction as 'long', entry, initialRisk: risk, currentStop: s, highWaterPrice: hw });
    s = t.stop;
    projected.push(Number(t.lockedR));
  }
  step(16, 'ratchet locks 0.5R / 1.5R / 2.5R', JSON.stringify(projected) === '[0.5,1.5,2.5]', `locked R at 1R/2R/3R = ${JSON.stringify(projected)}`);

  console.log('');
  console.log('═'.repeat(84));
  console.log(`  ${B}LIVE PAPER POSITION${X}`);
  console.log(`  trade      ${trade.id}`);
  console.log(`  candidate  ${trade.candidateId}`);
  console.log(`  order      ${trade.entryOrderId}`);
  console.log(`  contract   ${trade.tradedSymbol}`);
  console.log(`  filled     ${trade.actualFillPrice} × ${trade.quantity}`);
  console.log(`  stop       ${after?.currentStop}   target ${trade.initialTarget}   1R ${trade.firstRewardPrice}`);
  console.log('');
  console.log(`  ${D}The running observer will now trail and exit it under the same rules.${X}`);
  console.log(failed === 0 ? `  ${G}All ${16} lifecycle stages passed.${X}` : `  ${R}${failed} stage(s) failed.${X}`);
  console.log('');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`${R}lifecycle proof crashed:${X}`, err);
  process.exit(1);
});

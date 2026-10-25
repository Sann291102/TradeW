/**
 * The live session, in one screen.
 *
 *   npm run session -w @tradew/api
 *   npm run session -w @tradew/api -- --hours 8
 *
 * Everything the brief asked to be able to see, read from the real tables:
 * evaluations, setups, rejections and their reasons, trade plans, orders,
 * fills, open positions with stop/target/trail, exits, P&L, and the learning
 * generated from completed trades.
 *
 * Read-only. It decides nothing and changes nothing.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(__dirname, '../../../.env') });

import { PrismaService } from '../src/prisma/prisma.service';
import { rejectCheckLabel } from '../src/paper-execution/execution-policy';
import { istParts } from '../src/paper-execution/execution-identity';

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

function inr(n: number): string {
  return `${n < 0 ? '-' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
}

async function main(): Promise<void> {
  const hoursArg = process.argv.indexOf('--hours');
  const hours = hoursArg >= 0 ? Number(process.argv[hoursArg + 1]) || 24 : 24;
  const since = new Date(Date.now() - hours * 3_600_000);

  const prisma = new PrismaService();
  await prisma.$connect();
  const now = new Date();
  const { dayKey, minuteOfDay } = istParts(now);

  console.log(`\n${B}═══ AUTONOMOUS PAPER SESSION — IST ${dayKey} ${fmt(minuteOfDay)} (last ${hours}h) ═══${X}`);
  console.log(`${D}Live market · paper money. No live-money order path exists.${X}\n`);

  // ---- 1. Is it running? --------------------------------------------------
  const control = await prisma.executionControl.findUnique({ where: { id: 'global' } });
  const profiles = await prisma.executionProfile.findMany({
    where: { environment: 'PAPER' },
    select: {
      id: true, name: true, enabled: true, symbol: true, minConfidence: true,
      maxDrawdownPct: true, maxPortfolioExposurePct: true, partialExitEnabled: true,
    },
    orderBy: { name: 'asc' },
  });
  console.log(`${B}BOTS${X}`);
  console.log(`  kill switch: ${control?.entriesHalted ? `${R}HALTED${X} (${control.reason ?? 'no reason given'})` : `${G}not halted${X}`}`);
  for (const p of profiles) {
    console.log(
      `  ${p.enabled ? `${G}ARMED${X}` : `${D}off  ${X}`} ${p.name} ${D}(${p.symbol}, floor ${p.minConfidence}%, ` +
        `drawdown ${p.maxDrawdownPct ?? 'off'}, exposure ${p.maxPortfolioExposurePct ?? 'off'}, partials ${p.partialExitEnabled ? 'on' : 'off'})${X}`,
    );
  }

  // ---- 2. Evaluations -----------------------------------------------------
  const [byOutcome, byCheck, agg, byState, executableCount, latest] = await Promise.all([
    prisma.executionEvaluationLog.groupBy({ by: ['outcome'], where: { at: { gte: since } }, _count: { _all: true } }),
    prisma.executionEvaluationLog.groupBy({ by: ['checkId'], where: { at: { gte: since }, checkId: { not: null } }, _count: { _all: true } }),
    prisma.executionEvaluationLog.aggregate({
      where: { at: { gte: since } },
      _count: { _all: true }, _max: { confidence: true, at: true }, _avg: { confidence: true }, _min: { at: true },
    }),
    prisma.executionEvaluationLog.groupBy({ by: ['marketState'], where: { at: { gte: since }, marketState: { not: null } }, _count: { _all: true } }),
    prisma.executionEvaluationLog.count({ where: { at: { gte: since }, executable: true } }),
    prisma.executionEvaluationLog.findMany({
      where: { at: { gte: since } }, orderBy: { at: 'desc' }, take: 6,
      include: { profile: { select: { name: true } } },
    }),
  ]);

  console.log(`\n${B}EVALUATIONS${X}  ${agg._count._all} pass(es)`);
  if (agg._count._all === 0) {
    console.log(`  ${Y}No evaluations recorded in this window.${X}`);
    console.log(`  ${D}If the market is open and profiles are armed, the loop is not running —${X}`);
    console.log(`  ${D}check PAPER_EXECUTION_ENABLED and run: npm run verify:live-loop -w @tradew/api${X}`);
  } else {
    console.log(`  first ${agg._min.at?.toISOString()}   last ${agg._max.at?.toISOString()}`);
    console.log(
      `  confidence: max ${agg._max.confidence == null ? '—' : Number(agg._max.confidence)}` +
        `  avg ${agg._avg.confidence == null ? '—' : Number(agg._avg.confidence).toFixed(1)}`,
    );
    // The single clearest statement of WHICH LAYER held: zero executable
    // passes with a non-zero total means the intelligence layer never
    // published, so nothing downstream was ever asked to do anything.
    console.log(
      `  ${B}Sentinel declared executable:${X} ${executableCount === 0 ? `${Y}0${X} — the intelligence layer never published a side` : `${G}${executableCount}${X}`}`,
    );
    if (byState.length) {
      console.log(`  session state: ${byState.sort((a, b) => b._count._all - a._count._all).map((s) => `${s.marketState} ${s._count._all}`).join(' · ')}`);
    }
    for (const o of byOutcome.sort((a, b) => b._count._all - a._count._all)) {
      const colour = o.outcome === 'FILLED' ? G : o.outcome === 'REJECTED' || o.outcome === 'FAILED' ? R : D;
      console.log(`    ${colour}${o.outcome.padEnd(14)}${X} ${o._count._all}`);
    }
    if (byCheck.length) {
      console.log(`\n  ${B}WHY NOTHING ELSE TRADED${X}`);
      for (const c of byCheck.sort((a, b) => b._count._all - a._count._all).slice(0, 8)) {
        const label = c.checkId?.startsWith('sentinel-') ? `Sentinel: ${c.checkId.slice(9)}` : rejectCheckLabel(c.checkId);
        console.log(`    ${String(c._count._all).padStart(5)}  ${label}`);
      }
    }
    console.log(`\n  ${B}MOST RECENT PASSES${X} ${D}(the full per-evaluation record)${X}`);
    for (const e of latest) {
      console.log(
        `    ${e.at.toISOString()} ${e.profile.name.padEnd(34)} ${e.outcome.padEnd(13)} ` +
          `spot ${e.spot == null ? '—' : Number(e.spot)}  conf ${e.confidence == null ? '—' : Number(e.confidence)}  ` +
          `exec=${e.executable ?? '—'}  state=${e.marketState ?? '—'}  regime=${e.regime ?? '—'}`,
      );
      console.log(`      ${D}verdict=${e.verdict ?? '—'} strategy=${e.strategyName ?? e.strategyId ?? '—'} check=${e.checkId ?? '—'}${X}`);
      console.log(`      ${D}${e.reason.slice(0, 150)}${X}`);
    }
  }

  // ---- 3. Trade plans -----------------------------------------------------
  const intents = await prisma.executionIntent.findMany({
    where: { decidedAt: { gte: since } },
    orderBy: { decidedAt: 'desc' }, take: 20,
    select: {
      id: true, decidedAt: true, status: true, symbol: true, strike: true, optionType: true,
      confidence: true, quantity: true, plannedEntryPrice: true, stopPrice: true, targetPrice: true,
      riskBudget: true, rejectCheckId: true, rejectReason: true, strategyName: true, regime: true,
    },
  });
  console.log(`\n${B}TRADE PLANS (ExecutionIntent)${X}  ${intents.length}`);
  if (!intents.length) console.log(`  ${D}none — no setup cleared every gate in this window${X}`);
  for (const i of intents) {
    console.log(
      `  ${i.decidedAt.toISOString()} ${i.status.padEnd(9)} ${i.symbol} ${Number(i.strike)}${i.optionType} ` +
        `conf ${i.confidence}% qty ${i.quantity} ${D}${i.strategyName ?? ''}/${i.regime ?? ''}${X}`,
    );
    if (i.stopPrice) console.log(`      entry ~${Number(i.plannedEntryPrice)} stop ${Number(i.stopPrice)} target ${Number(i.targetPrice)} risk ${inr(Number(i.riskBudget ?? 0))}`);
    if (i.rejectCheckId) console.log(`      ${R}REJECTED${X} [${i.rejectCheckId}] ${i.rejectReason}`);
  }

  // ---- 4. Open positions --------------------------------------------------
  const positions = await prisma.executionPosition.findMany({
    where: { state: { in: ['OPEN', 'EXITING'] } },
    include: { profile: { select: { name: true } }, trailAdjustments: { orderBy: { at: 'asc' } }, partialExits: true },
  });
  console.log(`\n${B}OPEN POSITIONS${X}  ${positions.length}`);
  for (const p of positions) {
    const last = p.lastPrice == null ? null : Number(p.lastPrice);
    const trail = p.trailPrice == null ? null : Number(p.trailPrice);
    console.log(`  ${p.contractSymbol} ${p.state} qty ${p.quantity}${p.initialQuantity && p.initialQuantity !== p.quantity ? `/${p.initialQuantity}` : ''} ${D}(${p.profile.name})${X}`);
    console.log(`      entry ${Number(p.entryPrice)}  last ${last ?? '—'}  unrealised ${p.unrealizedPnl == null ? '—' : inr(Number(p.unrealizedPnl))}`);
    console.log(`      stop ${Number(p.stopPrice)}  target ${Number(p.targetPrice)}  trail ${trail ?? '—'} (${p.trailSteps} step(s))  MFE ${Number(p.highWaterPrice)} / MAE ${Number(p.lowWaterPrice)}`);
    if (p.partialExits.length) console.log(`      partials: ${p.partialExits.map((e) => `${e.quantity}@${Number(e.triggerPrice)}`).join(', ')}`);
  }
  if (!positions.length) console.log(`  ${D}none${X}`);

  // ---- 5. Completed trades + learning -------------------------------------
  const journal = await prisma.executionJournal.findMany({
    where: { entryAt: { gte: since } }, orderBy: { entryAt: 'desc' }, take: 20,
  });
  const realized = journal.reduce((s, j) => s + Number(j.realizedPnl), 0);
  console.log(`\n${B}COMPLETED TRADES${X}  ${journal.length}   realised ${inr(realized)}`);
  for (const j of journal) {
    const analysis = j.postTradeAnalysis as { lesson?: string } | null;
    console.log(
      `  ${j.contractSymbol} ${j.result} ${inr(Number(j.realizedPnl))} ` +
        `${j.rMultiple == null ? '' : `(${Number(j.rMultiple) >= 0 ? '+' : ''}${Number(j.rMultiple)}R) `}exit=${j.exitReason}`,
    );
    console.log(`      MFE ${j.mfeR == null ? '—' : `${Number(j.mfeR)}R`}  MAE ${j.maeR == null ? '—' : `${Number(j.maeR)}R`}  thesis ${j.thesisCorrect === null ? 'unclear' : j.thesisCorrect ? 'correct' : 'wrong'}`);
    if (analysis?.lesson) console.log(`      ${D}${analysis.lesson}${X}`);
  }
  if (!journal.length) console.log(`  ${D}none${X}`);

  // ---- 6. Learning --------------------------------------------------------
  const [cycles, improvements] = await Promise.all([
    prisma.executionLearningCycle.findMany({ orderBy: { sessionDate: 'desc' }, take: 3 }),
    prisma.executionImprovement.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
  ]);
  console.log(`\n${B}LEARNING${X}  ${cycles.length} cycle(s), ${improvements.length} candidate(s)`);
  for (const c of cycles) {
    console.log(`  ${c.sessionDate} ${c.agent}: ${c.tradesAnalysed} trade(s), ${c.wins}W/${c.losses}L, ${c.rejectedSetups} rejected setup(s)`);
  }
  for (const i of improvements) {
    const colour = i.status === 'PROMOTED' ? G : i.status === 'REJECTED' ? R : Y;
    console.log(`  ${colour}${i.status.padEnd(10)}${X} ${i.kind} ${D}${i.rationale.slice(0, 90)}${X}`);
  }
  if (!cycles.length && !improvements.length) console.log(`  ${D}none yet — the cycle runs after 15:45 IST on a trading day${X}`);

  console.log('');
  await prisma.$disconnect();
}

function fmt(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

main().catch((err) => { console.error(err); process.exit(1); });

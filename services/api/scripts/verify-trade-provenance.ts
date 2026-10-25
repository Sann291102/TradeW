/**
 * The complete audit chain for a genuine autonomous paper trade — and the proof
 * that it WAS one.
 *
 *   npm run verify:trade -w @tradew/api              # the most recent agent trade
 *   npm run verify:trade -w @tradew/api -- <intentId>
 *
 * ## Two jobs
 *
 * 1. Print the whole lifecycle in order: evaluation → intent (trade plan) →
 *    order → fill → position → trail/partials → exit → journal → post-trade
 *    analysis → learning.
 *
 * 2. PROVE it was produced by the autonomous loop and not by a test, a script,
 *    a manual order, a seeded fixture or a synthetic price. That is the part
 *    that matters: a lifecycle printout is worthless if the trade behind it was
 *    typed in by hand.
 *
 * ## How provenance is established
 *
 * Each of these is something only the real loop can produce:
 *
 *   · `Order.executionIntentId` is set — written in the same transaction as the
 *     intent's advance, by `PaperExecutionService` and nothing else. A manual
 *     order placed through `/sim/orders` has it null, always.
 *   · `ExecutionIntent.sentinelRunId` is present — the decision came from a
 *     Sentinel run, not from a constructed DTO.
 *   · The instrument's `securityId` is a real broker id, NOT `stub-…` — the
 *     lifecycle spec's `StubMarketPrice` upserts instruments with a
 *     `stub-<symbol>` security id, so that prefix is the fingerprint of a
 *     fixture and its absence is the fingerprint of the scrip master.
 *   · An `ExecutionEvaluationLog` row exists for the same profile at the same
 *     moment, carrying a live spot — the pass that produced it is on record.
 *   · The database is the production one, not `tradew_lifecycle_test`.
 *   · `environment` is PAPER on the intent — the only representable value.
 *
 * Read-only.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(__dirname, '../../../.env') });

import { PrismaService } from '../src/prisma/prisma.service';

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';
let pass = 0, fail = 0;

function check(ok: boolean, label: string, detail = ''): void {
  console.log(`   ${ok ? `${G}✓${X}` : `${R}✗${X}`} ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
}
function inr(n: number): string {
  return `${n < 0 ? '-' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
}

async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.$connect();

  const explicitId = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const intent = explicitId
    ? await loadIntent(prisma, { id: explicitId })
    : await loadIntent(prisma, { order: { isNot: null } });

  if (!intent) {
    console.log(`\n${Y}No autonomous trade has been recorded yet.${X}`);
    console.log(`${D}An agent order is one whose Order.executionIntentId is set — nothing else counts.${X}`);
    console.log(`${D}Run "npm run session -w @tradew/api" to see what the loop is currently deciding.${X}\n`);
    await prisma.$disconnect();
    return;
  }

  console.log(`\n${B}═══ TRADE PROVENANCE & LIFECYCLE — intent ${intent.id} ═══${X}\n`);

  // ---- 0. PROVENANCE ------------------------------------------------------
  console.log(`${B}[0] PROVENANCE — was this genuinely autonomous?${X}`);
  const dbUrl = process.env.DATABASE_URL ?? '';
  const dbName = dbUrl.split('/').pop()?.split('?')[0] ?? 'unknown';
  check(!dbName.includes('test'), 'production database (not a test DB)', dbName);
  check(intent.environment === 'PAPER', 'environment is PAPER', intent.environment);
  check(!!intent.order?.id, 'an Order exists and is linked to this intent', intent.order?.id ?? 'none');
  check(
    intent.order?.executionIntentId === intent.id,
    'Order.executionIntentId points back — only the loop writes this link',
    `a manual /sim/orders order always has it null`,
  );
  check(!!intent.sentinelRunId, 'carries a Sentinel run id', intent.sentinelRunId ?? 'none');
  const securityId = intent.order?.instrument?.securityId ?? '';
  check(
    securityId.length > 0 && !securityId.startsWith('stub-'),
    'instrument came from the real scrip master, not a fixture',
    `securityId ${securityId || 'missing'}${securityId.startsWith('stub-') ? ' — THIS IS A TEST FIXTURE' : ''}`,
  );

  // The evaluation pass that produced it.
  const evaluation = await prisma.executionEvaluationLog.findFirst({
    where: { profileId: intent.profileId, at: { gte: new Date(intent.decidedAt.getTime() - 120_000), lte: new Date(intent.decidedAt.getTime() + 120_000) } },
    orderBy: { at: 'desc' },
  });
  check(!!evaluation, 'the evaluation pass is on record in the ledger', evaluation ? `${evaluation.outcome} @ ${evaluation.at.toISOString()}` : 'no ledger row found');
  if (evaluation) {
    check(evaluation.spot != null && Number(evaluation.spot) > 0, 'the pass recorded a live spot', `${Number(evaluation.spot)}`);
    check(evaluation.executable === true, 'Sentinel declared it executable', String(evaluation.executable));
  }

  // ---- 1. THE EVALUATION --------------------------------------------------
  if (evaluation) {
    console.log(`\n${B}[1] LIVE EVALUATION${X}`);
    console.log(`   at        ${evaluation.at.toISOString()}`);
    console.log(`   bot       ${evaluation.agent}  (profile ${evaluation.profileId})`);
    console.log(`   spot      ${evaluation.spot == null ? '—' : Number(evaluation.spot)}`);
    console.log(`   state     ${evaluation.marketState ?? '—'}   regime ${evaluation.regime ?? '—'}`);
    console.log(`   verdict   ${evaluation.verdict ?? '—'}   executable=${evaluation.executable}   confidence ${evaluation.confidence == null ? '—' : Number(evaluation.confidence)}`);
    console.log(`   strategy  ${evaluation.strategyName ?? evaluation.strategyId ?? '—'}`);
  }

  // ---- 2. THE TRADE PLAN --------------------------------------------------
  console.log(`\n${B}[2] TRADE PLAN (ExecutionIntent)${X}`);
  console.log(`   decidedAt ${intent.decidedAt.toISOString()}   status ${intent.status}`);
  console.log(`   contract  ${intent.contractSymbol}   ${intent.side} qty ${intent.quantity} (${intent.lots} lot(s))`);
  console.log(`   bias      ${intent.bias}   confidence ${intent.confidence}%   strategy ${intent.strategyName ?? '—'} v${intent.strategyVersion ?? '—'} regime ${intent.regime ?? '—'}`);
  console.log(`   plan      entry ~${num(intent.plannedEntryPrice)}  stop ${num(intent.stopPrice)}  target ${num(intent.targetPrice)}`);
  console.log(`   risk      budget ${inr(Number(intent.riskBudget ?? 0))}  reward ${inr(Number(intent.rewardTarget ?? 0))}  equity ${inr(Number(intent.walletEquity ?? 0))}`);
  console.log(`   learned   calibration v${intent.calibrationVersion ?? '—'} (adjustment ${intent.calibrationAdjustment ?? 0})`);
  if (intent.rejectCheckId) console.log(`   ${R}rejected  [${intent.rejectCheckId}] ${intent.rejectReason}${X}`);

  // ---- 3. ORDER & FILL ----------------------------------------------------
  console.log(`\n${B}[3] PAPER ORDER & FILL${X}`);
  const order = intent.order;
  if (order) {
    console.log(`   order     ${order.id}  ${order.side} ${order.type} qty ${order.quantity}  status ${order.status}`);
    console.log(`   fill      avg ${num(order.avgFillPrice)}  filled ${order.filledQuantity}  charges ${inr(Number(order.charges))}  margin ${inr(Number(order.marginBlocked))}`);
    console.log(`   placedAt  ${order.placedAt.toISOString()}`);
    const trades = await prisma.trade.findMany({ where: { orderId: order.id }, orderBy: { executedAt: 'asc' } });
    for (const t of trades) console.log(`   trade     ${t.executedAt.toISOString()} qty ${t.quantity} @ ${num(t.fillPrice)}  realised ${inr(Number(t.realizedPnl))}`);
  }

  // ---- 4. POSITION & MANAGEMENT -------------------------------------------
  console.log(`\n${B}[4] POSITION & DYNAMIC MANAGEMENT${X}`);
  const position = intent.position;
  if (!position) {
    console.log(`   ${Y}no ExecutionPosition — the order did not fill${X}`);
  } else {
    console.log(`   state     ${position.state}   qty ${position.quantity}${position.initialQuantity && position.initialQuantity !== position.quantity ? ` of ${position.initialQuantity}` : ''}`);
    console.log(`   entry     ${num(position.entryPrice)} @ ${position.entryAt.toISOString()}`);
    console.log(`   levels    stop ${num(position.stopPrice)}  target ${num(position.targetPrice)}  trail ${num(position.trailPrice)} (${position.trailSteps} step(s))`);
    console.log(`   excursion MFE ${num(position.highWaterPrice)}  MAE ${num(position.lowWaterPrice)}`);
    console.log(`   last      ${num(position.lastPrice)} @ ${position.lastPriceAt?.toISOString() ?? '—'}   unrealised ${position.unrealizedPnl == null ? '—' : inr(Number(position.unrealizedPnl))}`);
    if (position.exitReason) console.log(`   exit      ${position.exitReason} — ${position.exitDetail ?? ''}`);

    console.log(`\n   ${B}trail adjustments (${position.trailAdjustments.length})${X} ${D}— evidence of dynamic management${X}`);
    for (const t of position.trailAdjustments) {
      console.log(`     ${t.at.toISOString()}  ${num(t.fromPrice)} → ${num(t.toPrice)}  (high ${num(t.highWaterPrice)}, step ${t.totalSteps})`);
      console.log(`       ${D}${t.reason}${X}`);
    }
    if (!position.trailAdjustments.length) console.log(`     ${D}none — price never advanced a full trail step${X}`);

    console.log(`\n   ${B}partial exits (${position.partialExits.length})${X}`);
    for (const e of position.partialExits) {
      console.log(`     ${e.at.toISOString()}  closed ${e.quantity} @ ${num(e.triggerPrice)} (${num(e.rMultiple)}R), ${e.remaining} left`);
    }
    if (!position.partialExits.length) console.log(`     ${D}none — not configured, or the trigger was never reached${X}`);
  }

  // ---- 5. OUTCOME ---------------------------------------------------------
  console.log(`\n${B}[5] OUTCOME${X}`);
  const outcome = intent.outcome;
  if (outcome) {
    console.log(`   result    ${outcome.result}   exit ${outcome.exitReason}`);
    console.log(`   prices    entry ${num(outcome.entryPrice)} → exit ${num(outcome.exitPrice)}`);
    console.log(`   P&L       ${inr(Number(outcome.realizedPnl))}   charges ${inr(Number(outcome.charges))}   held ${outcome.holdingSeconds ?? '—'}s`);
  } else console.log(`   ${D}still open — no outcome recorded yet${X}`);

  // ---- 6. JOURNAL, POST-TRADE ANALYSIS, LEARNING --------------------------
  console.log(`\n${B}[6] JOURNAL · POST-TRADE ANALYSIS · LEARNING${X}`);
  const journal = await prisma.executionJournal.findUnique({ where: { intentId: intent.id } });
  if (!journal) {
    console.log(`   ${D}no journal entry yet — written when the position closes and reconciles${X}`);
  } else {
    console.log(`   result    ${journal.result}  ${inr(Number(journal.realizedPnl))}  ${journal.rMultiple == null ? '' : `${Number(journal.rMultiple)}R`}`);
    console.log(`   excursion MFE ${num(journal.mfeR)}R / MAE ${num(journal.maeR)}R   slippage ${num(journal.entrySlippage)}`);
    console.log(`   thesis    ${journal.thesisCorrect === null ? 'unclear' : journal.thesisCorrect ? 'CORRECT' : 'WRONG'}   confidenceError ${num(journal.confidenceError)}`);
    const a = journal.postTradeAnalysis as { why?: string[]; lesson?: string; difference?: Record<string, unknown> } | null;
    if (a) {
      console.log(`\n   ${B}EXPECTED → ACTUAL → DIFFERENCE${X}`);
      console.log(`     ${JSON.stringify(a.difference)}`);
      console.log(`   ${B}WHY${X}`);
      for (const w of a.why ?? []) console.log(`     · ${w}`);
      console.log(`   ${B}LESSON${X}\n     ${a.lesson}`);
    }
    console.log(`\n   calibration bucket ${journal.calibrationKey ?? '—'} → v${journal.calibrationVersion ?? '—'}`);
    if (journal.calibrationKey) {
      const bucket = await prisma.strategyCalibration.findUnique({ where: { key: journal.calibrationKey } });
      if (bucket) {
        console.log(`   ${G}LEARNING RECORDED${X}: ${bucket.trades} trade(s), avg ${Number(bucket.avgRMultiple ?? 0)}R, confidence adjustment +${bucket.confidenceAdjustment}`);
        console.log(`   ${D}A later intent recording calibrationVersion >= ${bucket.version} is the proof this outcome reached a decision.${X}`);
      }
    }
  }

  console.log(`\n${B}PROVENANCE: ${fail === 0 ? `${G}${pass} checks passed — genuinely autonomous${X}` : `${R}${fail} check(s) FAILED — do not treat this as an autonomous trade${X}`}\n`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

function num(v: unknown): string {
  return v == null ? '—' : String(Number(v as number));
}

async function loadIntent(prisma: PrismaService, where: Record<string, unknown>) {
  return prisma.executionIntent.findFirst({
    where: where as never,
    orderBy: { decidedAt: 'desc' },
    include: {
      order: { include: { instrument: { select: { securityId: true, symbol: true, lotSize: true } } } },
      outcome: true,
      position: { include: { trailAdjustments: { orderBy: { at: 'asc' } }, partialExits: { orderBy: { at: 'asc' } } } },
    },
  });
}

main().catch((err) => { console.error(err); process.exit(1); });

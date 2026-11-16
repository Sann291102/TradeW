/**
 * Unattended watcher: capture the first genuine autonomous paper trade the
 * moment it happens, and every one after it.
 *
 *   npm run watch:trades -w @tradew/api
 *
 * ## Why this exists
 *
 * "Immediately verify when executable=true occurs" needs something present at
 * the moment it occurs. A person is not reliably watching a 6¼-hour session,
 * and neither is an assistant. This is: it polls the same tables the loop
 * writes and, on any new decision, appends the full provenance chain to
 * `.logs/trade-evidence.log` and prints it.
 *
 * It is a READER. It places no order, triggers nothing, and touches no
 * execution state — if it crashes, the bots carry on exactly as before and the
 * evidence is still in the database to be read afterwards. Nothing here is
 * load-bearing for trading; it only shortens the time between a trade
 * happening and a human seeing the proof.
 *
 * ## What it reports
 *
 *   · every new ExecutionIntent (the trade plan), with its provenance
 *   · every new Order/fill linked to one
 *   · position open → management → exit transitions
 *   · the journal + post-trade analysis when it lands
 *   · the FIRST `executable=true` evaluation, even if policy then refused it —
 *     that is the moment the intelligence layer finally published, and it is
 *     worth capturing separately from whether a trade followed
 *   · a heartbeat every 5 minutes so a quiet session is visibly ALIVE rather
 *     than ambiguously silent
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
loadEnv({ path: resolve(__dirname, '../../../.env') });

import { PrismaService } from '../src/prisma/prisma.service';

const LOG_DIR = resolve(__dirname, '../../../.logs');
const LOG_FILE = resolve(LOG_DIR, 'trade-evidence.log');
const POLL_MS = Number(process.env.WATCH_TRADES_POLL_MS ?? 15_000);
const HEARTBEAT_MS = 5 * 60_000;

function emit(line: string): void {
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    /* the console line is still the record */
  }
}

function inr(n: number): string {
  return `${n < 0 ? '-' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
}
function num(v: unknown): string {
  return v == null ? '—' : String(Number(v as number));
}

async function main(): Promise<void> {
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* exists */ }
  const prisma = new PrismaService();
  await prisma.$connect();

  emit(`\n════ WATCHER STARTED ${new Date().toISOString()} ════`);
  emit('Reader only. Places no order, triggers nothing.');

  // Seed from what already exists, so a restart does not re-report history.
  const seenIntents = new Set<string>(
    (await prisma.executionIntent.findMany({ select: { id: true } })).map((r) => r.id),
  );
  const seenJournals = new Set<string>(
    (await prisma.executionJournal.findMany({ select: { id: true } })).map((r) => r.id),
  );
  const positionState = new Map<string, string>();
  for (const p of await prisma.executionPosition.findMany({ select: { id: true, state: true } })) {
    positionState.set(p.id, p.state);
  }
  let executableSeen =
    (await prisma.executionEvaluationLog.count({ where: { executable: true } })) > 0;
  let lastHeartbeat = 0;

  emit(`Baseline: ${seenIntents.size} intent(s), ${seenJournals.size} journal(s), ${positionState.size} position(s).`);

  for (;;) {
    try {
      // ---- The moment the intelligence layer first publishes --------------
      if (!executableSeen) {
        const first = await prisma.executionEvaluationLog.findFirst({
          where: { executable: true }, orderBy: { at: 'asc' },
          include: { profile: { select: { name: true } } },
        });
        if (first) {
          executableSeen = true;
          emit(`\n★★★ FIRST executable=true ${first.at.toISOString()} ★★★`);
          emit(`    bot ${first.profile.name}  spot ${num(first.spot)}  confidence ${num(first.confidence)}`);
          emit(`    state ${first.marketState ?? '—'}  regime ${first.regime ?? '—'}  strategy ${first.strategyName ?? first.strategyId ?? '—'}`);
          emit(`    verdict ${first.verdict ?? '—'}  outcome ${first.outcome}`);
          emit(`    ${first.reason}`);
        }
      }

      // ---- New trade plans -------------------------------------------------
      const intents = await prisma.executionIntent.findMany({
        orderBy: { decidedAt: 'asc' },
        include: {
          order: { include: { instrument: { select: { securityId: true } } } },
          profile: { select: { name: true } },
        },
      });
      for (const i of intents) {
        if (seenIntents.has(i.id)) continue;
        seenIntents.add(i.id);
        emit(`\n═══ NEW TRADE PLAN ${i.decidedAt.toISOString()} — ${i.profile.name} ═══`);
        emit(`    intent    ${i.id}   status ${i.status}`);
        emit(`    contract  ${i.contractSymbol}  ${i.side} qty ${i.quantity}  conf ${i.confidence}%`);
        emit(`    plan      entry ~${num(i.plannedEntryPrice)}  stop ${num(i.stopPrice)}  target ${num(i.targetPrice)}  risk ${inr(Number(i.riskBudget ?? 0))}`);
        emit(`    strategy  ${i.strategyName ?? '—'} v${i.strategyVersion ?? '—'}  regime ${i.regime ?? '—'}  calibration v${i.calibrationVersion ?? '—'}`);
        if (i.rejectCheckId) {
          emit(`    REJECTED  [${i.rejectCheckId}] ${i.rejectReason}`);
        }
        if (i.order) {
          const sec = i.order.instrument?.securityId ?? '';
          emit(`    ORDER     ${i.order.id}  ${i.order.status}  avg ${num(i.order.avgFillPrice)}  filled ${i.order.filledQuantity}`);
          emit(`    PROVENANCE  executionIntentId linked=${i.order.executionIntentId === i.id}  sentinelRunId=${!!i.sentinelRunId}  securityId=${sec}${sec.startsWith('stub-') ? '  *** FIXTURE ***' : '  (real scrip master)'}`);
          emit(`    → run: npm run verify:trade -w @tradew/api -- ${i.id}`);
        }
      }

      // ---- Position transitions -------------------------------------------
      const positions = await prisma.executionPosition.findMany({
        include: { profile: { select: { name: true } }, partialExits: true, trailAdjustments: { orderBy: { at: 'desc' }, take: 1 } },
      });
      for (const p of positions) {
        const prev = positionState.get(p.id);
        if (prev === p.state) continue;
        positionState.set(p.id, p.state);
        if (!prev) {
          emit(`\n▶ POSITION OPEN ${p.contractSymbol} qty ${p.quantity} entry ${num(p.entryPrice)} stop ${num(p.stopPrice)} target ${num(p.targetPrice)}  (${p.profile.name})`);
        } else {
          emit(`\n■ POSITION ${prev} → ${p.state}  ${p.contractSymbol}  exit=${p.exitReason ?? '—'}`);
          emit(`    ${p.exitDetail ?? ''}`);
          emit(`    MFE ${num(p.highWaterPrice)}  MAE ${num(p.lowWaterPrice)}  trailSteps ${p.trailSteps}  partials ${p.partialExits.length}`);
        }
      }

      // ---- Completed trades: journal + learning ----------------------------
      const journals = await prisma.executionJournal.findMany({ orderBy: { createdAt: 'asc' } });
      for (const j of journals) {
        if (seenJournals.has(j.id)) continue;
        seenJournals.add(j.id);
        const a = j.postTradeAnalysis as { lesson?: string; why?: string[] } | null;
        emit(`\n✔ TRADE COMPLETE ${j.contractSymbol}  ${j.result}  ${inr(Number(j.realizedPnl))}  ${j.rMultiple == null ? '' : `${Number(j.rMultiple)}R`}  exit=${j.exitReason}`);
        emit(`    MFE ${num(j.mfeR)}R  MAE ${num(j.maeR)}R  slippage ${num(j.entrySlippage)}  thesis ${j.thesisCorrect === null ? 'unclear' : j.thesisCorrect ? 'CORRECT' : 'WRONG'}`);
        for (const w of a?.why ?? []) emit(`    why: ${w}`);
        if (a?.lesson) emit(`    LESSON: ${a.lesson}`);
        emit(`    LEARNING → calibration ${j.calibrationKey ?? '—'} v${j.calibrationVersion ?? '—'}`);
      }

      // ---- Heartbeat -------------------------------------------------------
      if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
        lastHeartbeat = Date.now();
        const since = new Date(Date.now() - 60 * 60_000);
        const [evals, execCount, byOutcome] = await Promise.all([
          prisma.executionEvaluationLog.count({ where: { at: { gte: since } } }),
          prisma.executionEvaluationLog.count({ where: { at: { gte: since }, executable: true } }),
          prisma.executionEvaluationLog.groupBy({ by: ['outcome'], where: { at: { gte: since } }, _count: { _all: true } }),
        ]);
        const agg = await prisma.executionEvaluationLog.aggregate({
          where: { at: { gte: since } }, _max: { confidence: true },
        });
        emit(
          `· ${new Date().toISOString()} alive — last hour: ${evals} evaluation(s), ${execCount} executable, ` +
            `max confidence ${agg._max.confidence == null ? '—' : Number(agg._max.confidence)} ` +
            `[${byOutcome.map((o) => `${o.outcome}:${o._count._all}`).join(' ')}]`,
        );
      }
    } catch (err) {
      emit(`! watcher poll failed (non-fatal): ${(err as Error).message}`);
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

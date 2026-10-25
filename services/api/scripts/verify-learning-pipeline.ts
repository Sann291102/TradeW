/**
 * Runtime verification of the staged learning pipeline.
 *
 *   TEST_DATABASE_URL=postgresql://… npm run verify:learning -w @tradew/api
 *
 * ## What this proves that the unit tests cannot
 *
 * `learning-cycle.spec.ts` proves the pure decisions — what is proposed, and
 * that nothing loosening is representable. This proves the SERVICE behaviour
 * around them, which is where the safety property actually lives:
 *
 *   · a cycle and its candidates persist, and the candidates change nothing;
 *   · a PROPOSED candidate CANNOT be promoted, however much an operator wants
 *     to — the refusal is the whole pipeline;
 *   · validation moves it to VALIDATED or REJECTED on out-of-sample evidence;
 *   · promotion applies it, records the operator, and only ever tightens;
 *   · re-running the cycle does not re-propose what is already open.
 *
 * ## It refuses to run against a database it was not given
 *
 * `TEST_DATABASE_URL` is required and must NOT be the dev database: the script
 * creates and deletes a profile, an account and journal rows, and a cleanup
 * scoped by name is one rename away from touching real data.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(__dirname, '../../../.env') });

import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { ExecutionLearningService } from '../src/paper-execution/execution-learning.service';

const TEST_URL = process.env.TEST_DATABASE_URL ?? '';
if (!TEST_URL) {
  console.error('TEST_DATABASE_URL is required — this script writes and deletes rows.');
  process.exit(1);
}
if (TEST_URL === process.env.DATABASE_URL) {
  console.error('Refusing to run: TEST_DATABASE_URL is the same as DATABASE_URL.');
  process.exit(1);
}

const PROFILE = 'learning-verify-profile';
const ACCOUNT = 'learning-verify@example.invalid';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  [32m✓[0m ${label}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`  [31m✗[0m ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function main(): Promise<void> {
  process.env.DATABASE_URL = TEST_URL;
  const prisma = new PrismaService();
  await prisma.$connect();
  const learning = new ExecutionLearningService(prisma);

  const cleanup = async () => {
    const p = await prisma.executionProfile.findFirst({ where: { name: PROFILE }, select: { id: true, accountUserId: true } });
    if (p) {
      await prisma.executionImprovement.deleteMany({ where: { profileId: p.id } });
      await prisma.executionLearningCycle.deleteMany({ where: { profileId: p.id } });
      await prisma.executionJournal.deleteMany({ where: { profileId: p.id } });
      await prisma.executionIntent.deleteMany({ where: { profileId: p.id } });
      await prisma.executionProfile.deleteMany({ where: { id: p.id } });
      await prisma.paperWallet.deleteMany({ where: { userId: p.accountUserId } });
      await prisma.user.deleteMany({ where: { id: p.accountUserId } });
    }
    await prisma.user.deleteMany({ where: { email: ACCOUNT } });
  };

  await cleanup();

  try {
    const user = await prisma.user.create({
      // No password hash: this scratch account must not be loginable, the same
      // rule the seeded machine accounts follow.
      data: { email: ACCOUNT, passwordHash: null },
      select: { id: true },
    });
    const profile = await prisma.executionProfile.create({
      data: {
        name: PROFILE, agent: 'verify-agent', symbol: 'NIFTY',
        accountUserId: user.id, environment: 'PAPER', enabled: false,
        minConfidence: 70, trailStepPoints: 3, strategyIds: ['strat-a'],
      },
      select: { id: true, minConfidence: true },
    });

    // ---- History: 'ranging' loses consistently, 'trending' wins -----------
    //
    // Chronologically interleaved so the 30% holdout contains both regimes;
    // a block layout would put every 'ranging' trade in the training half and
    // the validation would be structurally inconclusive.
    const base = Date.parse('2026-08-01T04:00:00.000Z');
    const rows: any[] = [];
    // `ExecutionJournal.intentId` is a real foreign key — a journal entry
    // cannot exist without the decision that produced it, which is the point of
    // the constraint. So the fixture creates the intents too.
    const intentIds: string[] = [];
    // 40 trades so the 30% holdout is 12 — comfortably above the 8-trade floor.
    // At 20 the holdout was 6 and validation correctly refused to judge, which
    // is the right behaviour but leaves the promotion path unexercised.
    for (let i = 0; i < 40; i++) {
      const ranging = i % 2 === 0;
      const intent = await prisma.executionIntent.create({
        data: {
          profileId: profile.id,
          idempotencyKey: `learning-verify-${i}`,
          agent: 'verify-agent', symbol: 'NIFTY',
          side: 'BUY', optionType: 'CE', bias: 'bullish',
          strike: 24500, expiry: new Date(base), contractSymbol: 'NIFTY:20260911:24500:CE',
          lots: 1, quantity: 75, productType: 'NRML', orderType: 'MARKET',
          confidence: 80, environment: 'PAPER', status: 'CLOSED',
          strategyId: 'strat-a', strategyVersion: '1.0.0',
          regime: ranging ? 'ranging' : 'trending',
          riskBudget: 10_000,
          decidedAt: new Date(base + i * 86_400_000),
        },
        select: { id: true },
      });
      intentIds.push(intent.id);
      rows.push({
        intentId: intent.id,
        profileId: profile.id, userId: user.id, agent: 'verify-agent', symbol: 'NIFTY',
        strategyId: 'strat-a', strategyName: 'Strategy A', strategyVersion: '1.0.0',
        regime: ranging ? 'ranging' : 'trending',
        underlying: 'NIFTY', expiry: new Date(base), strike: 24500, optionType: 'CE',
        contractSymbol: 'NIFTY:20260911:24500:CE', lots: 1, quantity: 75,
        confidence: 80,
        entryAt: new Date(base + i * 86_400_000),
        exitAt: new Date(base + i * 86_400_000 + 3_600_000),
        entryPrice: 100, exitPrice: ranging ? 90 : 120,
        exitReason: ranging ? 'STOP' : 'TARGET',
        realizedPnl: ranging ? -10_000 : 20_000,
        charges: 0,
        rMultiple: ranging ? -1 : 2,
        result: ranging ? 'LOSS' : 'WIN',
        riskBudget: 10_000,
        thesisCorrect: !ranging,
        mfeR: ranging ? 0.1 : 2.5, maeR: ranging ? 1 : 0.3,
      });
    }
    await prisma.executionJournal.createMany({ data: rows });

    console.log('\n1. The cycle runs, persists, and applies NOTHING');
    const run = await learning.runDailyCycle({ sessionDate: '2026-09-07', profileId: profile.id });
    const cycle = await prisma.executionLearningCycle.findFirst({ where: { profileId: profile.id } });
    check('a learning cycle was written', cycle !== null);
    check('the report names the agent', (cycle?.report ?? '').includes('verify-agent'));
    check('the run reported the profile', run.cycles.length === 1);

    const candidates = await prisma.executionImprovement.findMany({ where: { profileId: profile.id } });
    check('at least one candidate was proposed', candidates.length > 0, `${candidates.length} candidate(s)`);
    check('every candidate starts PROPOSED', candidates.every((c) => c.status === 'PROPOSED'));

    const afterCycle = await prisma.executionProfile.findUniqueOrThrow({
      where: { id: profile.id }, select: { minConfidence: true, trailStepPoints: true, strategyIds: true },
    });
    check(
      'the profile is UNCHANGED by the cycle',
      afterCycle.minConfidence === 70 && Number(afterCycle.trailStepPoints) === 3 && afterCycle.strategyIds.length === 1,
      `minConfidence=${afterCycle.minConfidence}, trailStep=${afterCycle.trailStepPoints}`,
    );

    console.log('\n2. A PROPOSED candidate CANNOT be promoted');
    const proposed = candidates[0];
    let refused = false;
    let refusal = '';
    try {
      await learning.promote(proposed.id, 'verify-operator');
    } catch (err) {
      refused = true;
      refusal = (err as Error).message;
    }
    check('promotion of an unvalidated candidate is refused', refused, refusal.slice(0, 90));
    check('the refusal names the required state', refusal.includes('VALIDATED'));
    const stillProposed = await prisma.executionImprovement.findUniqueOrThrow({ where: { id: proposed.id } });
    check('the candidate is still PROPOSED after the refusal', stillProposed.status === 'PROPOSED');
    check('nothing was recorded as promoted', stillProposed.promotedAt === null && stillProposed.promotedBy === null);

    console.log('\n3. Validation judges on OUT-OF-SAMPLE evidence');
    const validation = await learning.validatePending();
    check(
      'validation classified every pending candidate',
      validation.validated + validation.rejected + validation.inconclusive === candidates.length,
      `validated=${validation.validated} rejected=${validation.rejected} inconclusive=${validation.inconclusive}`,
    );

    const all = await prisma.executionImprovement.findMany({ where: { profileId: profile.id } });
    for (const c of all) {
      const v = c.validation as { conclusive?: boolean; method?: string } | null;
      check(`candidate ${c.kind} carries its validation record`, v !== null && typeof v.method === 'string', v?.method ?? 'none');
    }
    const trailCandidate = all.find((c) => c.kind === 'TRAIL_STEP_TIGHTEN');
    if (trailCandidate) {
      check(
        'a trail-step proposal is NOT validated from the journal (no fabricated evidence)',
        trailCandidate.status === 'PROPOSED',
        `status=${trailCandidate.status}`,
      );
    }

    console.log('\n4. A VALIDATED candidate can be promoted, and only tightens');
    const validated = all.find((c) => c.status === 'VALIDATED');
    if (!validated) {
      console.log('  (no candidate reached VALIDATED on this fixture; promotion path not exercised)');
    } else {
      const before = await prisma.executionProfile.findUniqueOrThrow({
        where: { id: profile.id }, select: { minConfidence: true, trailStepPoints: true },
      });
      const result = await learning.promote(validated.id, 'verify-operator');
      const after = await prisma.executionProfile.findUniqueOrThrow({
        where: { id: profile.id }, select: { minConfidence: true, trailStepPoints: true },
      });
      const row = await prisma.executionImprovement.findUniqueOrThrow({ where: { id: validated.id } });

      check('the candidate is now PROMOTED', row.status === 'PROMOTED');
      check('the operator is recorded', row.promotedBy === 'verify-operator');
      check('the promotion is timestamped', row.promotedAt !== null);
      check('the applied change is described', typeof result.applied === 'string' && result.applied.length > 0, result.applied);
      // Whatever was applied, it may never loosen.
      check(
        'the confidence floor never went DOWN',
        after.minConfidence >= before.minConfidence,
        `${before.minConfidence} → ${after.minConfidence}`,
      );
      check(
        'the trail step never got WIDER',
        Number(after.trailStepPoints) <= Number(before.trailStepPoints),
        `${Number(before.trailStepPoints)} → ${Number(after.trailStepPoints)}`,
      );
    }

    console.log('\n5. Re-running the cycle does not re-propose what is already open');
    const countBefore = await prisma.executionImprovement.count({ where: { profileId: profile.id } });
    await learning.runDailyCycle({ sessionDate: '2026-09-07', profileId: profile.id });
    const countAfter = await prisma.executionImprovement.count({ where: { profileId: profile.id } });
    check('no duplicate candidates were created', countAfter === countBefore, `${countBefore} → ${countAfter}`);

    const cycles = await prisma.executionLearningCycle.count({ where: { profileId: profile.id } });
    check('the cycle is idempotent per (sessionDate, profile)', cycles === 1, `${cycles} cycle row(s)`);
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

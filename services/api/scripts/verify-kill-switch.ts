/**
 * Runtime verification for the operator kill switch.
 *
 *   npm run verify:kill-switch -w @tradew/api
 *
 * ## What this proves, and why unit tests could not
 *
 * `execution-drawdown.spec.ts` and `execution-policy.spec.ts` prove the pure
 * decisions. They cannot prove the two things that actually make this a kill
 * switch:
 *
 *   1. The halt is DURABLE — it survives in Postgres, not in a process that a
 *      restart or a leader failover would clear.
 *   2. The halt is read IN THE EXECUTION PATH — `runProfile` genuinely
 *      short-circuits before it evaluates anything, including on the operator
 *      hand-run route, so a halt cannot be stepped around by forcing a pass.
 *
 * Both are properties of the real service against the real database, so both
 * are asserted here against `PaperExecutionService` itself — not a stub of it.
 *
 * ## It restores whatever it found
 *
 * The halt row is global state an operator may legitimately have set, so the
 * script records the state on entry and puts it back at the end, whether it
 * passed or threw. It creates no profiles, places no orders and closes no
 * positions — `flatten` is exercised in its safe empty form only, because
 * flattening a real position is not something a verification script may decide
 * to do.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
// The monorepo keeps one .env at the root; this script runs from services/api.
loadEnv({ path: resolve(__dirname, '../../../.env') });

import { PrismaService } from '../src/prisma/prisma.service';
import { ExecutionControlService } from '../src/paper-execution/execution-control.service';
import { PositionManagerService } from '../src/paper-execution/position-manager.service';
import { PaperExecutionService } from '../src/paper-execution/paper-execution.service';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  [32m✓[0m ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  [31m✗[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.$connect();

  const control = new ExecutionControlService(prisma);

  // ---- Record what we found, so we can put it back ------------------------
  const entry = await control.state();
  console.log(
    `\nEntry state: ${entry.entriesHalted ? 'HALTED' : 'running'}` +
      (entry.haltedBy ? ` (by ${entry.haltedBy})` : '') +
      '\n',
  );

  try {
    console.log('1. The halt state is durable and round-trips through Postgres');
    await control.setHalt({ halted: false, reason: null, operator: 'verify-kill-switch' });
    const clear = await control.state();
    check('starts from a running state', clear.entriesHalted === false);
    check('a running state reports no haltedAt', clear.haltedAt === null);

    const halted = await control.setHalt({
      halted: true,
      reason: 'verification run',
      operator: 'verify-kill-switch',
    });
    check('setHalt(true) reports halted', halted.entriesHalted === true);
    check('records the operator', halted.haltedBy === 'verify-kill-switch');
    check('records the reason', halted.reason === 'verification run');
    check('stamps haltedAt', halted.haltedAt !== null);

    // Re-read through a SECOND service instance: this is the property that
    // matters. A halt held in one process's memory would not be visible here.
    const reread = await new ExecutionControlService(prisma).state();
    check(
      'a second service instance sees the halt (durable, not process-local)',
      reread.entriesHalted === true,
      `haltedAt=${reread.haltedAt}`,
    );

    const row = await prisma.executionControl.findUnique({ where: { id: 'global' } });
    check('is exactly one row, keyed "global"', row !== null && row.id === 'global');
    check('the row itself carries the halt', row?.entriesHalted === true);

    console.log('\n2. The halt is enforced IN THE EXECUTION PATH');
    // An ARMED profile by preference. The point of the assertion below is that
    // the halt outranks `enabled`, and a disabled profile would satisfy it
    // vacuously — it would return `skipped-disabled` for an entirely different
    // reason and the check would pass without testing anything.
    const profile =
      (await prisma.executionProfile.findFirst({
        where: { environment: 'PAPER', enabled: true },
        select: { id: true, name: true, enabled: true },
      })) ??
      (await prisma.executionProfile.findFirst({
        where: { environment: 'PAPER' },
        select: { id: true, name: true, enabled: true },
      }));

    if (!profile) {
      console.log('  (no execution profile exists; skipping the runProfile assertions)');
    } else {
      // The PRODUCTION service, with its real collaborators left null: if the
      // halt gate works, `runProfile` returns before it touches any of them.
      // That is exactly the assertion — a gate that ran late would throw here
      // instead of returning, and the null collaborators are what proves it
      // short-circuited rather than merely produced the right string.
      const execution = new PaperExecutionService(
        prisma,
        null as never,
        null as never,
        null as never,
        null as never,
        null as never,
        null as never,
        control,
      );

      const result = await execution.runProfile(profile.id);
      check(
        'runProfile short-circuits to skipped-halted',
        result.outcome === 'skipped-halted',
        `outcome=${result.outcome}`,
      );
      check('names the operator who halted it', result.reason.includes('verify-kill-switch'));
      check('carries the entries-halted check for the console breakdown',
        result.checks.some((c) => c.id === 'entries-halted' && !c.passed));
      // Only meaningful on an armed profile — see the selection above. Stated
      // as SKIPPED rather than passed when no armed profile exists, because a
      // check that cannot fail is not evidence.
      if (profile.enabled) {
        check(
          'halts even an ARMED profile (the halt outranks `enabled`)',
          // The gate sits above the `enabled` check, so an armed profile reports
          // halted rather than falling through to the Sentinel call — which
          // would throw on the null client if the ordering ever regressed.
          result.outcome === 'skipped-halted',
          `profile "${profile.name}" is armed`,
        );
      } else {
        console.log(
          `  [33m-[0m halts even an ARMED profile — SKIPPED, no armed profile exists ` +
            `(only "${profile.name}", which is disabled)`,
        );
      }

      console.log('\n3. Resuming lets the execution path proceed past the gate');
      await control.setHalt({ halted: false, reason: null, operator: 'verify-kill-switch' });
      const resumed = await execution.runProfile(profile.id).catch((err: Error) => err);
      const proceeded =
        resumed instanceof Error || (resumed as { outcome: string }).outcome !== 'skipped-halted';
      check(
        'no longer returns skipped-halted once resumed',
        proceeded,
        resumed instanceof Error
          ? 'proceeded past the gate and failed downstream on the null collaborators, as expected'
          : `outcome=${(resumed as { outcome: string }).outcome}`,
      );
    }

    console.log('\n4. Flatten is safe when there is nothing to flatten');
    const manager = new PositionManagerService(prisma, null as never, null as never);
    const openBefore = await prisma.executionPosition.count({ where: { state: 'OPEN' } });
    if (openBefore === 0) {
      const flat = await manager.flatten({ operator: 'verify-kill-switch', reason: 'verification run' });
      check('reports nothing requested', flat.requested === 0);
      check('reports nothing flattened', flat.flattened === 0);
      check('returns an empty position list rather than throwing', flat.positions.length === 0);
    } else {
      // Never flatten real open positions from a verification script.
      console.log(`  (${openBefore} position(s) are open — refusing to flatten them from a verification run)`);
    }
  } finally {
    // ---- Put back exactly what we found ----------------------------------
    await control.setHalt({
      halted: entry.entriesHalted,
      reason: entry.reason,
      operator: entry.haltedBy ?? 'verify-kill-switch',
    });
    const restored = await control.state();
    console.log(
      `\nRestored entry state: ${restored.entriesHalted ? 'HALTED' : 'running'}` +
        (restored.haltedBy ? ` (by ${restored.haltedBy})` : ''),
    );
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

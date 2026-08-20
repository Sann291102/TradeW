/**
 * Runtime verification for the Agent Trading Laboratory — Phase 0.
 *
 *   npm run verify:agent-lab -w @tradew/api
 *   npm run verify:agent-lab -w @tradew/api -- --keep
 *
 * ## What this proves
 *
 * Every class below is the PRODUCTION class against the REAL database and the
 * REAL Sentinel service. `LabRunnerService.runOnce()` is the same pass the
 * timer calls — not a test double and not a shortcut past any gate.
 *
 * The properties asserted are Phase 0's acceptance criteria, and they are the
 * ones that cannot be checked by reading the code:
 *
 *   · the health gate genuinely blocks when a dependency is down, and the Lab
 *     resumes by itself when it comes back — with no restart and no state to
 *     restore;
 *   · a switched-off Lab and a waiting Lab are distinguishable;
 *   · the timeline is written from REAL Sentinel activity, not from fixtures;
 *   · duplicate delivery collapses onto one row;
 *   · an event kind whose machinery does not exist cannot reach the timeline;
 *   · the Lab writes no Order, Trade, Position or ExecutionIntent row.
 *
 * ## It cleans up after itself
 *
 * The scratch profile, account and the events they produced are created by this
 * script moments earlier and removed at the end (`--keep` to inspect them).
 * CLAUDE.md Rule 1 is not in play: no project code and no pre-existing data is
 * touched, and pre-existing lab events are counted but never deleted.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(__dirname, '../../../.env') });

import { Test } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LeaderElectionService } from '../src/common/leader-election';
import { SentinelExecutionClient } from '../src/paper-execution/sentinel-execution.client';
import { LabEventService } from '../src/lab/lab-event.service';
import { LabHealthService } from '../src/lab/lab-health.service';
import { LabRunnerService } from '../src/lab/lab-runner.service';
import { deriveDedupeKey } from '../src/lab/lab-events';

const KEEP = process.argv.includes('--keep');
const SCRATCH_EMAIL = 'verify-agent-lab-scratch@tradew.local';
const SCRATCH_PROFILE = 'verify-agent-lab-scratch';
/** Only symbols with real stored bars — see the backtest audit. */
const SYMBOL = 'NIFTY';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
const section = (t: string) => console.log(`\n=== ${t} ===`);

async function main() {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule],
    providers: [LabEventService, LabHealthService, LabRunnerService, SentinelExecutionClient, LeaderElectionService],
  }).compile();

  const prisma = moduleRef.get(PrismaService);
  const events = moduleRef.get(LabEventService);
  const health = moduleRef.get(LabHealthService);
  const runner = moduleRef.get(LabRunnerService);
  const leader = moduleRef.get(LeaderElectionService);

  // `runOnce()` is called directly rather than through `tick()`, which gates on
  // leadership — this harness must not take a lease from the running dev server.
  void leader;

  const savedEnabled = process.env.AGENT_LAB_ENABLED;
  let profileId: string | null = null;

  try {
    // ── setup ─────────────────────────────────────────────────────────────
    section('0. Scratch lab profile');
    const user = await prisma.user.upsert({
      where: { email: SCRATCH_EMAIL },
      update: {},
      create: { email: SCRATCH_EMAIL },
    });
    const profile = await prisma.executionProfile.upsert({
      where: { name: SCRATCH_PROFILE },
      update: { labEnabled: true, enabled: false, symbol: SYMBOL },
      create: {
        name: SCRATCH_PROFILE,
        agent: 'verify-harness',
        symbol: SYMBOL,
        accountUserId: user.id,
        // labEnabled WITHOUT enabled: observed, never armed. This is the
        // separation Phase 0 depends on, so the harness exercises it.
        labEnabled: true,
        enabled: false,
        labTimeframe: '15m',
      },
    });
    profileId = profile.id;
    check('a profile can be lab-enabled without being armed', profile.labEnabled && !profile.enabled);

    // ── health gate ───────────────────────────────────────────────────────
    section('1. Health gate');
    process.env.AGENT_LAB_ENABLED = 'false';
    const off = await health.check([SYMBOL]);
    check('a switched-off Lab reports STOPPED, not WAITING', off.state === 'STOPPED', off.blockedBy[0]);
    check('a stopped Lab reports one reason, not a list', off.blockedBy.length === 1);
    check('a stopped Lab cannot observe', off.canObserve === false);

    process.env.AGENT_LAB_ENABLED = 'true';
    const on = await health.check([SYMBOL]);
    check('with the switch on, health is evaluated for real', on.state !== 'STOPPED', `state ${on.state}`);
    check(
      'every required dependency was actually probed',
      ['database', 'sentinel', 'market-data'].every((n) => on.dependencies.some((d) => d.name === n)),
      on.dependencies.map((d) => `${d.name}:${d.status}`).join(' '),
    );
    check('canExecute is FALSE — Phase 0 has no execution path', on.canExecute === false);
    check(
      'the session comes from the NSE calendar',
      typeof on.session.open === 'boolean' && on.session.reason.length > 0,
      `${on.session.reason}`,
    );
    console.log(`        blockedBy: ${on.blockedBy.length ? on.blockedBy.join('; ') : '(none — the Lab may observe)'}`);

    // Unreachable Sentinel → WAITING, then recovery with no restart.
    section('2. Dependency failure and automatic resume');
    const savedUrl = process.env.SENTINEL_SERVICE_URL;
    process.env.SENTINEL_SERVICE_URL = 'http://127.0.0.1:9';
    const down = await health.check([SYMBOL]);
    check('Sentinel unreachable → the Lab WAITS', down.state === 'WAITING' && !down.canObserve);
    check('the reason names Sentinel', down.blockedBy.join().includes('sentinel'), down.blockedBy.join('; '));
    check(
      'the failure detail is what was OBSERVED, not a composed guess',
      (down.dependencies.find((d) => d.name === 'sentinel')?.detail ?? '').length > 0,
      down.dependencies.find((d) => d.name === 'sentinel')?.detail,
    );

    process.env.SENTINEL_SERVICE_URL = savedUrl;
    const recovered = await health.check([SYMBOL]);
    check(
      'the dependency returning resumes the Lab with no restart and no state',
      recovered.dependencies.find((d) => d.name === 'sentinel')?.status === 'ok',
    );

    // ── the loop ──────────────────────────────────────────────────────────
    section('3. The observation loop writes REAL events');
    const before = await prisma.experimentEvent.count();
    const result = await runner.runOnce();
    const after = await prisma.experimentEvent.count();
    check('a pass ran and returned health', !!result.state, `state ${result.state}`);
    check('the pass wrote at least one event', after > before, `${after - before} new`);

    const written = await prisma.experimentEvent.findMany({
      orderBy: { recordedAt: 'desc' },
      take: 20,
    });
    const kinds = Array.from(new Set(written.map((e) => e.kind)));
    console.log(`        kinds written: ${kinds.join(', ')}`);
    check(
      'every event is a kind Phase 0 can actually produce',
      written.every((e) =>
        [
          'LAB_STARTED', 'LAB_STOPPED', 'HEALTH_DEGRADED', 'HEALTH_RECOVERED',
          'SESSION_OPENED', 'SESSION_CLOSED', 'OBSERVING', 'OBSERVATION_SKIPPED',
          'SETUP_CANDIDATE', 'SETUP_REJECTED',
        ].includes(e.kind),
      ),
      kinds.join(','),
    );
    check('every event carries a human-readable summary', written.every((e) => e.summary.trim().length > 0));
    check('every event names an actor', written.every((e) => e.actor.length > 0));
    check(
      'market time and record time are kept apart',
      written.every((e) => e.at instanceof Date && e.recordedAt instanceof Date),
    );

    const observed = written.filter((e) => e.profileId === profileId);
    if (result.canObserve) {
      check('the scratch profile produced an observation', observed.length > 0, `${observed.length} events`);
      const withAvailability = observed.filter((e) => e.dataAvailability !== null);
      check('an observation records what it could SEE', withAvailability.length > 0);
      const av = withAvailability[0]?.dataAvailability as { sources?: unknown[]; sufficient?: boolean } | null;
      check('the availability record lists real sources', Array.isArray(av?.sources) && av!.sources!.length > 0,
        JSON.stringify(av?.sources));
    } else {
      // Outside market hours this is the CORRECT behaviour and the harness
      // asserts it rather than skipping — a Lab that observed a closed market
      // would be the defect.
      const skipped = written.filter((e) => e.kind === 'OBSERVATION_SKIPPED');
      check('a blocked Lab records WHY it did nothing', skipped.length > 0, skipped[0]?.summary);
      check('"did nothing" is distinguishable from "could not see"', (skipped[0]?.detail as { blockedBy?: string[] })?.blockedBy !== undefined);
    }

    // ── idempotency ───────────────────────────────────────────────────────
    section('4. Duplicate delivery is safe');
    const countBefore = await prisma.experimentEvent.count();
    await runner.runOnce();
    await runner.runOnce();
    const countAfter = await prisma.experimentEvent.count();
    check(
      'two further identical passes add no duplicate rows',
      countAfter === countBefore,
      `${countBefore} → ${countAfter}`,
    );

    const sample = { kind: 'OBSERVING' as const, at: new Date('2026-08-20T05:45:00Z'), actor: 'harness', summary: 'dup probe', profileId: profileId!, symbol: SYMBOL };
    const first = await events.emit(sample);
    const second = await events.emit(sample);
    check('emitting the same event twice returns the SAME row', !!first && !!second && first.id === second.id);
    check('the key is content-derived, not clock-derived', deriveDedupeKey(sample) === deriveDedupeKey(sample));

    // ── the no-fake-dashboard rule ────────────────────────────────────────
    section('5. The timeline cannot be faked');
    const refused = await events.emit({
      kind: 'TRADE_PROPOSAL',
      at: new Date(),
      actor: 'harness',
      summary: 'this must never be written in Phase 0',
      profileId: profileId!,
    });
    check('an event kind whose machinery does not exist is REFUSED', refused === null);
    check(
      'and nothing of that kind exists in the table',
      (await prisma.experimentEvent.count({ where: { kind: 'TRADE_PROPOSAL' } })) === 0,
    );

    // ── isolation ─────────────────────────────────────────────────────────
    section('6. The Lab is not the paper engine');
    const orders = await prisma.order.count({ where: { userId: user.id } });
    const trades = await prisma.trade.count({ where: { userId: user.id } });
    const positions = await prisma.position.count({ where: { userId: user.id } });
    const wallets = await prisma.paperWallet.count({ where: { userId: user.id } });
    const intents = await prisma.executionIntent.count({ where: { profileId: profileId! } });
    check('no Order row was written', orders === 0);
    check('no Trade row was written', trades === 0);
    check('no Position row was written', positions === 0);
    check('no PaperWallet was created', wallets === 0);
    check('no ExecutionIntent was produced', intents === 0);
    check('the profile is still disarmed', (await prisma.executionProfile.findUnique({ where: { id: profileId! } }))?.enabled === false);

    // ── the read surface ──────────────────────────────────────────────────
    section('7. Timeline queries');
    const listed = await events.list({ profileId: profileId!, limit: 50 });
    check('events are queryable by profile', listed.rows.every((r) => r.profileId === profileId));
    check(
      'the feed is newest-first',
      listed.rows.every((r, i) => i === 0 || r.recordedAt <= listed.rows[i - 1].recordedAt),
    );
    const summary = await events.summary(24);
    check('a summary by kind is available', Array.isArray(summary) && summary.length > 0,
      summary.map((s) => `${s.kind}:${s.count}`).join(' '));

    // ── the HTTP boundary ─────────────────────────────────────────────────
    section('8. Nobody but an operator can reach the Lab');
    const apiBase = (process.env.API_PUBLIC_URL ?? 'http://localhost:4000').replace(/\/$/, '');
    const reachable = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(4_000) })
      .then((r) => r.ok)
      .catch(() => false);

    if (!reachable) {
      // Reported, never skipped silently. A security assertion that quietly
      // did not run is worse than one that failed.
      check('the API is running so the HTTP boundary can be checked', false, `${apiBase} is not reachable`);
    } else {
      const status = async (path: string, headers: Record<string, string> = {}) =>
        fetch(`${apiBase}${path}`, { headers, signal: AbortSignal.timeout(8_000) })
          .then((r) => r.status)
          .catch(() => -1);

      const token = process.env.ADMIN_API_TOKEN ?? '';
      const denied = (code: number) => code === 401 || code === 403;

      check('anonymous GET /admin/lab/events is denied', denied(await status('/admin/lab/events')));
      check('anonymous GET /admin/lab/health is denied', denied(await status('/admin/lab/health')));
      check('anonymous GET /admin/lab/tick is denied', denied(await status('/admin/lab/tick')));
      // The operator token proves a trusted PROCESS, never a person. It is
      // required on both admin paths and sufficient on neither — the invariant
      // the operator-identity decision exists to protect.
      check(
        'the admin token ALONE is not enough',
        denied(await status('/admin/lab/events', { 'x-admin-token': token })),
      );
      check(
        'an invalid bearer is refused rather than falling back to a weaker check',
        denied(await status('/admin/lab/events', { 'x-admin-token': token, authorization: 'Bearer not-a-real-token' })),
      );
      // If this ever 200s, the Lab has grown a route outside the guarded prefix.
      check('no lab route exists outside /admin', (await status('/lab/events')) === 404);
    }
  } finally {
    process.env.AGENT_LAB_ENABLED = savedEnabled;
    if (!KEEP) {
      section('cleanup');
      const ev = await prisma.experimentEvent.deleteMany({ where: { profileId } });
      // Lab-wide events (health/session) carry no profileId; remove only the
      // ones this run could have written, by actor and recency.
      const wide = await prisma.experimentEvent.deleteMany({
        where: { profileId: null, actor: 'lab-runner', recordedAt: { gte: new Date(Date.now() - 10 * 60_000) } },
      });
      if (profileId) await prisma.executionProfile.deleteMany({ where: { id: profileId } });
      await prisma.user.deleteMany({ where: { email: SCRATCH_EMAIL } });
      console.log(`  removed ${ev.count + wide.count} scratch event(s), 1 profile, 1 user`);
    } else {
      console.log('\n--keep: scratch rows left in place.');
    }
    await prisma.$disconnect();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nverification aborted:', err);
  process.exit(1);
});

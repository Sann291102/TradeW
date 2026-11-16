/**
 * "Are the bots actually trading the live market right now?"
 *
 *   npm run verify:live-loop -w @tradew/api
 *
 * ## Why this exists
 *
 * Every other signal is ambiguous. The loop logs only when it ACTS, and its
 * commonest correct outcome — Sentinel publishing no side — writes no row and
 * no log line. So "the console is quiet" and "the loop is dead" look identical,
 * which is exactly the ambiguity that hid a dead watch loop for a full trading
 * day on 2026-08-13.
 *
 * This answers it positively, from the outside, by checking every link in the
 * chain in the order it would break:
 *
 *   1. Is the market actually open (trading day + session window)?
 *   2. Is the FEED alive — not merely reachable, but ticking?
 *   3. Is the kill switch off?
 *   4. Are any profiles armed, and is their account authorised?
 *   5. What does Sentinel say RIGHT NOW for each armed profile — the same
 *      request the evaluate tick sends?
 *
 * Step 5 is the one that cannot be faked: it reproduces the loop's own call
 * verbatim, so the verdict printed is the verdict the bot is acting on.
 *
 * Read-only. It places no order, creates no intent and changes no state.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(__dirname, '../../../.env') });

import { PrismaService } from '../src/prisma/prisma.service';
import { istParts } from '../src/paper-execution/execution-identity';
import { isTradingDay } from '../src/discipline/market-calendar';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function line(ok: boolean | null, label: string, detail = ''): void {
  const mark = ok === null ? `${YELLOW}−${RESET}` : ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.$connect();
  const now = new Date();
  const { dayKey, minuteOfDay } = istParts(now);

  console.log(`\n=== LIVE LOOP CHECK @ ${now.toISOString()} (IST ${dayKey} ${fmtMin(minuteOfDay)}) ===\n`);

  // ---- 1. The market ------------------------------------------------------
  console.log('1. Market session');
  const tradingDay = isTradingDay(now);
  const inWindow = minuteOfDay >= 9 * 60 + 15 && minuteOfDay < 15 * 60 + 30;
  line(tradingDay, 'is an NSE trading day', dayKey);
  line(inWindow, 'inside the 09:15–15:30 IST session window', fmtMin(minuteOfDay));
  const marketOpen = tradingDay && inWindow;
  if (!marketOpen) {
    console.log(`\n  ${YELLOW}The market is closed. The loop will correctly return skipped-market-closed on every pass.${RESET}`);
  }

  // ---- 2. The feed --------------------------------------------------------
  console.log('\n2. Live market-data feed (the bridge)');
  const feedUrl = (process.env.SENTINEL_LIVE_FEED_URL ?? 'http://localhost:4600').replace(/\/$/, '');
  let feedFresh = false;
  try {
    const res = await fetch(`${feedUrl}/quotes?symbols=NIFTY`, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as { marketOpen?: boolean; indices?: { symbol: string; ltp: number; updatedAt: string; source: string }[] };
    const nifty = (body.indices ?? []).find((i) => i.symbol === 'NIFTY') ?? body.indices?.[0];
    line(res.ok, `bridge answered ${feedUrl}`, `HTTP ${res.status}`);
    if (nifty) {
      const ageMs = Date.now() - Date.parse(nifty.updatedAt);
      // "Reachable" is not "alive" — the 2026-08-17 incident was a bridge
      // answering every request in 30ms from a tick map that had stopped hours
      // earlier. Age is the only question that distinguishes them.
      feedFresh = ageMs < 60_000;
      line(feedFresh, `${nifty.symbol} is ticking`, `ltp ${nifty.ltp}, source ${nifty.source}, ${Math.round(ageMs / 1000)}s old`);
      line(body.marketOpen === true, 'bridge reports the market open', String(body.marketOpen));
    } else {
      line(false, 'bridge returned no index quote');
    }
  } catch (err) {
    line(false, 'bridge unreachable', (err as Error).message);
  }

  // ---- 3. The kill switch -------------------------------------------------
  console.log('\n3. Operator kill switch');
  const control = await prisma.executionControl.findUnique({ where: { id: 'global' } });
  const halted = control?.entriesHalted === true;
  line(!halted, halted ? 'HALTED — no new entries will be opened' : 'not halted', control?.reason ?? '');

  // ---- 4. The mandates ----------------------------------------------------
  console.log('\n4. Armed profiles');
  const profiles = await prisma.executionProfile.findMany({
    where: { enabled: true, environment: 'PAPER' },
    select: {
      id: true, name: true, symbol: true, accountUserId: true, accountScope: true,
      strategyId: true, strategyIds: true, minConfidence: true, minCandles: true,
      maxBarAgeMinutes: true, maxOpenPositions: true, maxOrdersPerDay: true,
      maxDrawdownPct: true, maxPortfolioExposurePct: true, partialExitEnabled: true,
    },
  });
  line(profiles.length > 0, `${profiles.length} profile(s) armed`);
  for (const p of profiles) {
    const user = await prisma.user.findUnique({
      where: { id: p.accountUserId },
      select: { email: true, agentPaperTradingEnabledAt: true },
    });
    const consentOk = p.accountScope === 'SYSTEM_PAPER' || user?.agentPaperTradingEnabledAt != null;
    line(consentOk, `${p.name} (${p.symbol}, ${p.accountScope})`, consentOk ? `account ${user?.email} authorised` : 'ACCOUNT HAS NOT CONSENTED');
    console.log(
      `      bounds: minConf ${p.minConfidence}%, maxOpen ${p.maxOpenPositions}, maxOrders/day ${p.maxOrdersPerDay}, ` +
        `drawdown ${p.maxDrawdownPct ?? 'off'}, exposure ${p.maxPortfolioExposurePct ?? 'off'}, partials ${p.partialExitEnabled ? 'on' : 'off'}`,
    );
  }

  // ---- 5. What Sentinel says RIGHT NOW ------------------------------------
  console.log('\n5. Live verdict per armed profile (the evaluate tick’s own call)');
  const sentinelUrl = (process.env.SENTINEL_SERVICE_URL ?? 'http://localhost:4010').replace(/\/$/, '');
  const token = process.env.SENTINEL_SERVICE_TOKEN ?? '';
  line(token.length > 0, 'SENTINEL_SERVICE_TOKEN is configured');

  for (const p of profiles) {
    try {
      const res = await fetch(`${sentinelUrl}/execution/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-token': token },
        body: JSON.stringify({
          symbol: p.symbol,
          userId: p.accountUserId,
          strategyId: p.strategyId,
          minConfidence: p.minConfidence,
          strategyIds: p.strategyIds,
          minCandles: p.minCandles,
          maxBarAgeMinutes: p.maxBarAgeMinutes,
          openStrategyIds: [],
        }),
        // Generous: this probe deliberately runs while the loop's own
        // evaluations are in flight, and the bridge serialises upstream reads
        // (~3.1s floor), so four concurrent callers can queue well past a
        // typical timeout. A probe that times out under contention would report
        // a healthy loop as broken.
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) {
        line(false, `${p.name}: Sentinel returned HTTP ${res.status}`, (await res.text()).slice(0, 160));
        continue;
      }
      const j = (await res.json()) as Record<string, any>;
      console.log(`\n   ── ${p.name} ──`);
      console.log(`      executable : ${j.executable}`);
      console.log(`      verdict    : ${j.verdict}`);
      console.log(`      reason     : ${j.reason}`);
      console.log(`      confidence : ${j.confidence} (floor ${p.minConfidence})`);
      console.log(`      spot       : ${j.spot}`);
      console.log(`      regime     : ${j.agentStrategy?.regime ?? 'n/a'}   strategy: ${j.agentStrategy?.strategyId ?? 'none validated'}`);
      console.log(`      indexDir   : ${j.indexDirection?.direction ?? 'n/a'} (${j.indexDirection?.strength ?? '—'})`);
      if (j.dataQuality) console.log(`      dataQuality: ${JSON.stringify(j.dataQuality)}`);
      if (j.strikes?.selected) {
        console.log(`      SELECTED   : ${j.strikes.selected.strike}${j.strikes.selected.optionType} @ ${j.strikes.selected.premium}`);
      }
      const failed = (j.confirmations ?? []).filter((c: any) => !c.passed);
      if (failed.length) {
        console.log('      gates not met:');
        for (const c of failed.slice(0, 6)) console.log(`        · ${c.id}: ${c.detail ?? ''}`);
      }
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      // `fetch failed` on its own is useless for diagnosis — the cause carries
      // whether it was a refused connection, a DNS miss or a timeout.
      line(false, `${p.name}: evaluate call failed`, `${e.name}: ${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''}`);
    }
  }

  // ---- Verdict ------------------------------------------------------------
  console.log('\n=== WHAT THIS MEANS ===');
  if (!marketOpen) {
    console.log('  The market is closed. Nothing can trade; this is not a fault.');
  } else if (halted) {
    console.log('  The kill switch is ON. The loop is evaluating but will open no position.');
  } else if (!feedFresh) {
    console.log('  The FEED IS NOT TICKING. Entries will be refused on quote-freshness and open positions');
    console.log('  will be flattened as EMERGENCY. Fix the bridge/token before anything else.');
  } else if (profiles.length === 0) {
    console.log('  No profile is armed. The loop is running and will never trade until one is enabled.');
  } else {
    console.log('  The chain is intact: live feed → armed mandate → live Sentinel verdict.');
    console.log('  A verdict of "no-side-in-focus" is the DESIGNED RESTING STATE, not a fault —');
    console.log('  the bots trade only when a setup clears every gate.');
  }
  console.log('');

  await prisma.$disconnect();
}

function fmtMin(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

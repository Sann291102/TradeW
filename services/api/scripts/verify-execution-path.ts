/**
 * "If Sentinel published a side RIGHT NOW, would the trade actually reach the
 * paper OMS — or is something downstream silently blocking it?"
 *
 *   npm run verify:execution-path -w @tradew/api
 *
 * ## The question this exists to answer
 *
 * The loop's commonest outcome is `no-side-in-focus`, which is correct and
 * writes nothing. But that silence also hides every downstream fault: an
 * unresolvable contract, a dead scrip master, an empty wallet, a risk plan that
 * cannot size one lot, a discipline session that would 409, a bound set so
 * tight nothing fits. None of those surface until the day a genuine setup
 * finally appears — and then the agent misses it and the log says only that the
 * order "failed".
 *
 * So this walks the ENTIRE path after Sentinel, for every armed profile,
 * against LIVE data, and reports each gate individually.
 *
 * ## It never places an order
 *
 * Every call here is a read or a pure computation. `placeOrder` is never
 * invoked; `evaluatePlacement` is the discipline layer's read-only half
 * (`recordPlacement` is what writes, and is not called). The contract is
 * resolved and priced for real, the risk plan and the policy are the real
 * functions with real live inputs — but the last step is deliberately absent.
 *
 * ## The confidence substitution, stated plainly
 *
 * Sentinel's own confidence is usually below the floor — that IS the resting
 * state. To isolate everything downstream of it, the policy is evaluated with
 * confidence set to the profile's own floor: the question being asked is "if a
 * setup arrived at exactly the minimum publishable confidence, would anything
 * ELSE refuse it?". That substitution is reported on every run so a passing
 * audit can never be mistaken for a real signal.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(__dirname, '../../../.env') });

import { Test } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { DisciplineService } from '../src/discipline/discipline.service';
import { MarketPriceService } from '../src/sim/market-price.service';
import { OrderService } from '../src/sim/order.service';
import { PositionService } from '../src/sim/position.service';
import { SettlementService } from '../src/sim/settlement.service';
import { LeaderElectionService } from '../src/common/leader-election';
import { ExecutionAccountService } from '../src/paper-execution/execution-account.service';
import { ExecutionControlService } from '../src/paper-execution/execution-control.service';
import { contractSymbol, istParts } from '../src/paper-execution/execution-identity';
import { assessFreshness } from '../src/paper-execution/execution-freshness';
import { modelPaperFill } from '../src/paper-execution/execution-fill';
import { planRisk } from '../src/paper-execution/execution-risk';
import { countProfileOpenPositions } from '../src/paper-execution/execution-open-positions';
import { evaluatePolicy } from '../src/paper-execution/execution-policy';
import { computeDailyDrawdown, computeExposure } from '../src/paper-execution/execution-drawdown';

const FEED = (process.env.SENTINEL_LIVE_FEED_URL ?? 'http://localhost:4600').replace(/\/$/, '');
const SENTINEL = (process.env.SENTINEL_SERVICE_URL ?? 'http://localhost:4010').replace(/\/$/, '');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', X = '\x1b[0m';
let blockers: string[] = [];

function check(ok: boolean, label: string, detail = '', blockerId?: string): void {
  console.log(`   ${ok ? `${G}✓${X}` : `${R}✗${X}`} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok && blockerId) blockers.push(blockerId);
}

async function main(): Promise<void> {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule],
    providers: [
      DisciplineService, MarketPriceService, OrderService, PositionService,
      SettlementService, LeaderElectionService, ExecutionAccountService, ExecutionControlService,
    ],
  }).compile();

  const prisma = moduleRef.get(PrismaService);
  const marketPrice = moduleRef.get(MarketPriceService);
  const discipline = moduleRef.get(DisciplineService);
  const accounts = moduleRef.get(ExecutionAccountService);
  const control = moduleRef.get(ExecutionControlService);

  const now = new Date();
  const { dayKey, minuteOfDay } = istParts(now);
  console.log(`\n=== EXECUTION-PATH AUDIT @ ${now.toISOString()} (IST ${dayKey} ${fmt(minuteOfDay)}) ===`);
  console.log('No order is placed by this script. `placeOrder` is never called.\n');

  // ---- Shared preconditions ----------------------------------------------
  const ctl = await control.state();
  console.log('GLOBAL');
  check(!ctl.entriesHalted, 'kill switch is not halting entries', ctl.reason ?? '', 'kill-switch');

  // The live chain, from the same bridge Sentinel reads.
  const expiryRes = await fetch(`${FEED}/optionchain/expirylist?symbol=NIFTY`, { signal: AbortSignal.timeout(20_000) });
  const expiryBody = (await expiryRes.json()) as { resolvedExpiry?: string; expiries?: string[] };
  const expiry = expiryBody.resolvedExpiry ?? expiryBody.expiries?.[0] ?? null;
  check(!!expiry, 'a front expiry resolves from the live chain', String(expiry), 'expiry');

  const chainRes = await fetch(`${FEED}/optionchain?symbol=NIFTY&expiry=${expiry}`, { signal: AbortSignal.timeout(25_000) });
  const chain = (await chainRes.json()) as {
    spot?: number;
    strikes?: { strike: number; ce?: { ltp: number; bid: number; ask: number; oi: number }; pe?: { ltp: number; bid: number; ask: number; oi: number } }[];
  };
  const spot = chain.spot ?? 0;
  const strikes = chain.strikes ?? [];
  check(strikes.length > 0 && spot > 0, 'live option chain has strikes and a spot', `${strikes.length} strikes, spot ${spot}`, 'chain');
  if (!expiry || !strikes.length || !spot) {
    console.log(`\n${R}Cannot continue: the live chain is unavailable.${X}\n`);
    await prisma.$disconnect();
    process.exit(1);
  }

  // ATM by nearest strike to spot — the same anchor `strike-candidates.ts` uses.
  const atm = strikes.reduce((best, s) => (Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best), strikes[0]);
  const feed = await marketPrice.feedFreshness();
  console.log(`   ${G}✓${X} ATM anchor — strike ${atm.strike} (spot ${spot}), expiry ${expiry}`);

  // ---- Per profile --------------------------------------------------------
  const profiles = await prisma.executionProfile.findMany({
    where: { enabled: true, environment: 'PAPER' },
    orderBy: { name: 'asc' },
  });
  console.log(`\n${profiles.length} armed profile(s) to audit independently.`);

  for (const profile of profiles) {
    blockers = [];
    console.log(`\n────────────────────────────────────────────────────────`);
    console.log(`PROFILE  ${profile.name}   (${profile.symbol}, ${profile.accountScope})`);
    console.log(`────────────────────────────────────────────────────────`);

    // 1. Sentinel's REAL verdict right now.
    let liveVerdict = 'unknown';
    let liveConfidence: number | null = null;
    let liveExecutable = false;
    try {
      const res = await fetch(`${SENTINEL}/execution/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-token': process.env.SENTINEL_SERVICE_TOKEN ?? '' },
        body: JSON.stringify({
          symbol: profile.symbol, userId: profile.accountUserId, strategyId: profile.strategyId,
          minConfidence: profile.minConfidence, strategyIds: profile.strategyIds,
          minCandles: profile.minCandles, maxBarAgeMinutes: profile.maxBarAgeMinutes, openStrategyIds: [],
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const j = (await res.json()) as Record<string, any>;
      liveVerdict = j.verdict; liveConfidence = j.confidence; liveExecutable = j.executable === true;
      console.log(`\n  [1] SENTINEL (real, live)`);
      check(res.ok, 'Sentinel answered', `HTTP ${res.status}`, 'sentinel-unreachable');
      console.log(`       verdict=${liveVerdict} executable=${liveExecutable} confidence=${liveConfidence}/${profile.minConfidence}`);
      check(j.dataQuality?.ok === true, 'data quality passes', j.dataQuality?.reason ?? 'all checks passed', 'data-quality');
    } catch (err) {
      check(false, 'Sentinel evaluate call', (err as Error).message, 'sentinel-unreachable');
    }

    // 2. Account authorization — the gate BEFORE the market is even consulted.
    console.log(`\n  [2] ACCOUNT AUTHORIZATION`);
    const auth = await accounts.authorize({
      environment: profile.environment, accountScope: profile.accountScope,
      accountUserId: profile.accountUserId, symbol: profile.symbol, agent: profile.agent,
    });
    check(auth.authorized, 'account may be traded by this agent', auth.reason ?? 'authorised', 'account-auth');

    // 3. The contract must become a real, priceable instrument.
    console.log(`\n  [3] CONTRACT RESOLUTION & LIVE PRICE`);
    // Side follows the live chain's own ATM pair; CE is used purely as a
    // representative tradable contract for the plumbing test.
    const symbol = contractSymbol({
      underlying: profile.symbol, expiry: new Date(`${expiry}T00:00:00.000Z`),
      strike: atm.strike, optionType: 'CE',
    });
    let instrument: any = null;
    let price: any = null;
    try {
      instrument = await marketPrice.resolveInstrument(symbol);
      check(!!instrument, `contract resolves through the scrip master`, symbol, 'resolve-instrument');
      check(instrument.lotSize > 0, 'lot size known', `lotSize ${instrument.lotSize}`, 'lot-size');
      price = await marketPrice.getPrice(instrument);
      check(price.ltp > 0, 'live premium readable', `ltp ${price.ltp} bid ${price.bid} ask ${price.ask}`, 'price');
      check(price.marketOpen === true, 'venue reports market open', String(price.marketOpen), 'market-open');
    } catch (err) {
      check(false, 'contract resolution / pricing', (err as Error).message, 'resolve-instrument');
    }
    if (!instrument || !price) { report(profile.name, liveExecutable, liveVerdict); continue; }

    // 4. Feed liveness — reachable is not alive.
    console.log(`\n  [4] FEED FRESHNESS`);
    const freshness = assessFreshness({
      now, quotedAt: feed.quotedAt, marketOpen: feed.marketOpen, maxQuoteAgeMs: profile.maxQuoteAgeMs,
    });
    const quoteCheck = freshness.checks.find((c) => c.id === 'quote-age');
    check(quoteCheck?.passed === true, 'quote is current', quoteCheck?.detail ?? '', 'quote-freshness');

    // 5. The account's live money facts.
    console.log(`\n  [5] ACCOUNT STATE (live)`);
    const dayStart = new Date(`${dayKey}T00:00:00+05:30`);
    const [openPositions, ordersToday, trades, wallet, openRows] = await Promise.all([
      countProfileOpenPositions(prisma, profile.id, profile.accountUserId),
      prisma.executionIntent.count({ where: { profileId: profile.id, decidedAt: { gte: dayStart }, status: { in: ['SUBMITTED', 'FILLED', 'CLOSED'] } } }),
      prisma.trade.findMany({ where: { userId: profile.accountUserId, executedAt: { gte: dayStart } }, select: { executedAt: true, realizedPnl: true }, orderBy: { executedAt: 'asc' } }),
      prisma.paperWallet.findUnique({ where: { userId: profile.accountUserId }, select: { cashBalance: true, marginUsed: true } }),
      prisma.executionPosition.findMany({ where: { profileId: profile.id, state: { in: ['OPEN', 'EXITING'] } }, select: { entryPrice: true, quantity: true } }),
    ]);
    const realizedPnlToday = trades.reduce((s, t) => s + Number(t.realizedPnl), 0);
    const availableCash = wallet ? Number(wallet.cashBalance) : 1_000_000;
    const walletEquity = wallet ? Number(wallet.cashBalance) + Number(wallet.marginUsed) : 1_000_000;
    check(!!wallet, 'paper wallet exists', wallet ? `cash ₹${availableCash.toLocaleString('en-IN')}` : 'none yet — created on first order (1,000,000 assumed)');
    check(walletEquity > 0, 'wallet equity is positive', `₹${walletEquity.toLocaleString('en-IN')}`, 'equity');
    check(openPositions < profile.maxOpenPositions, 'open-position budget available', `${openPositions}/${profile.maxOpenPositions}`, 'max-open-positions');
    check(ordersToday < profile.maxOrdersPerDay, 'daily order budget available', `${ordersToday}/${profile.maxOrdersPerDay}`, 'max-orders-per-day');

    // 6. The risk plan must be able to size a position.
    console.log(`\n  [6] RISK PLAN`);
    const provisional = modelPaperFill({
      side: 'BUY', ltp: price.ltp, bid: price.bid, ask: price.ask,
      quantity: instrument.lotSize, quoteAgeMs: freshness.ageMs, marketOpen: price.marketOpen, orderType: profile.orderType,
    });
    const plan = planRisk({
      walletEquity, entryPrice: provisional.fillPrice, lotSize: instrument.lotSize,
      maxLots: profile.lots, capitalAllocationPct: Number(profile.capitalAllocationPct),
      riskPerTradePct: Number(profile.riskPerTradePct), rewardPerTradePct: Number(profile.rewardPerTradePct),
    });
    check(plan.ok, 'a position can be sized inside the limits', plan.ok
      ? `qty ${plan.quantity} @ ~${plan.entryPrice}, stop ${plan.stopPrice}, target ${plan.targetPrice}, risk ₹${plan.riskAtStop}`
      : `${plan.failedCheckId}: ${plan.reason}`, 'risk-plan');

    const quantity = plan.ok ? plan.quantity : profile.lots * instrument.lotSize;
    const sized = modelPaperFill({
      side: 'BUY', ltp: price.ltp, bid: price.bid, ask: price.ask,
      quantity, quoteAgeMs: freshness.ageMs, marketOpen: price.marketOpen, orderType: profile.orderType,
    });
    const estimatedCost = sized.fillPrice * quantity;
    check(estimatedCost <= availableCash, 'position is affordable', `₹${Math.round(estimatedCost).toLocaleString('en-IN')} vs ₹${Math.round(availableCash).toLocaleString('en-IN')}`, 'affordable');

    // 7. The portfolio bounds.
    console.log(`\n  [7] PORTFOLIO BOUNDS`);
    const drawdown = computeDailyDrawdown(
      trades.map((t) => ({ executedAt: t.executedAt, realizedPnl: Number(t.realizedPnl) })),
      walletEquity - realizedPnlToday,
    );
    const exposure = computeExposure({
      openPremiumAtRisk: openRows.reduce((s, p) => s + Number(p.entryPrice) * p.quantity, 0),
      proposedCost: estimatedCost, walletEquity,
    });
    console.log(`       drawdown: peak ₹${drawdown.peak}, now ₹${drawdown.current}, given back ₹${drawdown.drawdown} (${drawdown.drawdownPct ?? '—'}%) vs limit ${profile.maxDrawdownPct ?? 'off'}`);
    console.log(`       exposure: ${exposure.totalExposure} = ${exposure.openExposure} open + ${exposure.proposedExposure} proposed → ${exposure.exposurePct ?? '—'}% vs limit ${profile.maxPortfolioExposurePct ?? 'off'}`);

    // 8. THE POLICY — every gate, with confidence held at the profile's floor.
    console.log(`\n  [8] EXECUTION POLICY  ${Y}(confidence substituted = ${profile.minConfidence}, the profile's own floor)${X}`);
    const policy = evaluatePolicy({
      enabled: profile.enabled, environment: profile.environment, minConfidence: profile.minConfidence,
      maxOpenPositions: profile.maxOpenPositions, maxOrdersPerDay: profile.maxOrdersPerDay,
      maxLossPerDay: Number(profile.maxLossPerDay), squareOffMinute: profile.squareOffMinute,
      confidence: profile.minConfidence,
      openPositions, ordersToday, realizedPnlToday, minuteOfDay,
      marketOpen: price.marketOpen, availableCash, estimatedCost,
      quoteFresh: quoteCheck?.passed ?? false, quoteFreshnessDetail: quoteCheck?.detail ?? '',
      // Held to agree, so the audit isolates everything OTHER than direction.
      indexDirection: 'bullish', optionSide: 'CE',
      calibrationAdjustment: 0,
      riskPlanOk: plan.ok, riskPlanReason: plan.reason, riskPlanCheckId: plan.failedCheckId,
      drawdown, maxDrawdownPct: profile.maxDrawdownPct == null ? null : Number(profile.maxDrawdownPct),
      exposure, maxPortfolioExposurePct: profile.maxPortfolioExposurePct == null ? null : Number(profile.maxPortfolioExposurePct),
    });
    for (const c of policy.checks) check(c.passed, c.label, c.detail, c.passed ? undefined : c.id);
    check(policy.allowed, 'POLICY WOULD ALLOW THE ORDER', policy.reason ?? '', 'policy');

    // 9. The discipline layer inside placeOrder (read-only half).
    console.log(`\n  [9] TRADER DISCIPLINE (the gate inside placeOrder)`);
    try {
      await discipline.evaluatePlacement(profile.accountUserId, 'open', { token: null, reason: null }, now);
      check(true, 'discipline would not block a new position');
    } catch (err) {
      check(false, 'discipline would BLOCK this order', (err as Error).message, 'discipline');
    }

    report(profile.name, liveExecutable, liveVerdict);
  }

  await prisma.$disconnect();
}

function report(name: string, executable: boolean, verdict: string): void {
  console.log(`\n  ${'─'.repeat(52)}`);
  if (blockers.length === 0) {
    console.log(`  ${G}DOWNSTREAM PATH IS CLEAR${X} for ${name}.`);
    console.log(`  Every gate after Sentinel would admit an order today.`);
    console.log(`  The ONLY thing not satisfied is Sentinel's own publication gate`);
    console.log(`  (currently ${verdict}, executable=${executable}) — which is the strategy`);
    console.log(`  logic doing its job, not a fault.`);
  } else {
    console.log(`  ${R}BLOCKED${X} for ${name} by: ${blockers.join(', ')}`);
    console.log(`  A genuine setup would NOT reach the OMS until these are fixed.`);
  }
}

function fmt(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

main().catch((err) => { console.error(err); process.exit(1); });

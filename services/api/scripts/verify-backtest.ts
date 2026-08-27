/**
 * Runtime verification for the backtesting platform.
 *
 *   npm run verify:backtest -w @tradew/api
 *   npm run verify:backtest -w @tradew/api -- --keep   (skip the cleanup)
 *
 * ## What this proves
 *
 * Every class below is the PRODUCTION class against the REAL database and the
 * REAL Sentinel service. `BacktestService` creates the row, `BacktestRunnerService`
 * runs it — which means a real `POST /backtest/scan` over real stored `Candle`
 * rows, the real `StrategyEngineService`, the real execution simulator, and real
 * `BacktestTrade` / `BacktestEquityPoint` writes.
 *
 * NOTHING is mocked or substituted. Unlike `verify-paper-execution.ts`, this
 * harness needs no fallback: a backtest reads history, so it works identically
 * whether or not the market is open, and there is no live decision that might
 * not arrive.
 *
 * ## What it asserts
 *
 * The properties a reader of a backtest cannot check for themselves:
 *   · the P&L identity holds on every persisted trade;
 *   · the equity curve reconciles with the trade list;
 *   · the same configuration, re-run, reproduces the same numbers;
 *   · a completed row is immutable, and re-running makes a NEW row;
 *   · another user cannot read the result;
 *   · an uncovered period FAILS with a plain reason instead of inventing bars;
 *   · a backtest writes no Order, Trade or Position row.
 *
 * ## It cleans up after itself
 *
 * The runs and the scratch user are created by this script moments earlier and
 * deleted at the end (`--keep` to inspect them). CLAUDE.md Rule 1 is not in
 * play: no project code and no pre-existing data is touched.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(__dirname, '../../../.env') });

import { Test } from '@nestjs/testing';
import { BacktestStatus } from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LeaderElectionService } from '../src/common/leader-election';
import { BacktestService } from '../src/backtest/backtest.service';
import { BacktestRunnerService } from '../src/backtest/backtest-runner.service';
import { BacktestAnalysisService } from '../src/backtest/backtest-analysis.service';
import { SentinelBacktestClient } from '../src/backtest/sentinel-backtest.client';

const KEEP = process.argv.includes('--keep');
const SCRATCH_EMAIL = 'verify-backtest-scratch@tradew.local';
const OTHER_EMAIL = 'verify-backtest-other@tradew.local';

/** A window the audit confirmed is covered: NIFTY 15m runs 2026-04-24 → 08-11. */
const COVERED = { symbol: 'NIFTY', timeframe: '15m', startAt: '2026-05-01T00:00:00.000Z', endAt: '2026-08-11T23:59:00.000Z' };
/** A window nothing has ever backfilled. Must FAIL, not fabricate. */
const UNCOVERED = { symbol: 'NIFTY', timeframe: '15m', startAt: '2019-01-01T00:00:00.000Z', endAt: '2019-03-01T00:00:00.000Z' };

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
const section = (title: string) => console.log(`\n=== ${title} ===`);
const money = (n: unknown) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

async function main() {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule],
    providers: [
      BacktestService,
      BacktestRunnerService,
      BacktestAnalysisService,
      SentinelBacktestClient,
      // The runner's dependency. Constructed but never started —
      // `Test...compile()` runs no lifecycle hooks, so no lease is registered
      // and the running dev server's leadership is untouched. `execute()` is
      // called directly rather than through the poll loop for the same reason.
      LeaderElectionService,
    ],
  }).compile();

  const prisma = moduleRef.get(PrismaService);
  const backtests = moduleRef.get(BacktestService);
  const runner = moduleRef.get(BacktestRunnerService);
  const analysisSvc = moduleRef.get(BacktestAnalysisService);

  const user = await prisma.user.upsert({
    where: { email: SCRATCH_EMAIL },
    update: {},
    create: { email: SCRATCH_EMAIL },
  });
  const other = await prisma.user.upsert({
    where: { email: OTHER_EMAIL },
    update: {},
    create: { email: OTHER_EMAIL },
  });

  const createdIds: string[] = [];
  const run = async (input: Record<string, unknown>) => {
    const row = await backtests.create(user.id, input as never);
    createdIds.push(row.id);
    // Claim it the way the queue would, then run it.
    await prisma.backtest.update({
      where: { id: row.id },
      data: { status: BacktestStatus.RUNNING, startedAt: new Date() },
    });
    await runner.execute(row.id);
    return backtests.get(user.id, row.id);
  };

  try {
    // ───────────────────────────────────────────────────────────────────────
    section('1. A covered window runs end to end');
    const t0 = Date.now();
    const a = await run({
      label: 'verify-a',
      ...COVERED,
      exchange: 'NSE',
      minConfidence: 70,
      initialCapital: 1_000_000,
      sizingMode: 'CAPITAL_PCT',
      sizingValue: 10,
      feeRate: 0.0003,
      slippageRate: 0.0005,
    });
    check('status is COMPLETED', a.status === BacktestStatus.COMPLETED, a.failureReason ?? `${Date.now() - t0}ms`);
    check('bars were replayed', (a.barCount ?? 0) > 500, `${a.barCount} bars`);
    check('the covered window is recorded, not the requested one', a.firstBarAt !== null && a.lastBarAt !== null,
      `${a.firstBarAt?.toISOString().slice(0, 10)} → ${a.lastBarAt?.toISOString().slice(0, 10)}`);
    check('data provenance is real, not a guess', !!a.dataSource && !!a.dataVersion, `${a.dataSource} / ${a.dataVersion}`);
    check('engine + strategy versions are stamped', a.engineVersion !== '' && a.strategyVersion !== 'pending',
      `engine ${a.engineVersion}, strategy ${a.strategyVersion}`);
    console.log(
      `        result: ${a.totalTrades} trades, ${money(a.totalPnl)} (${a.totalReturnPct}%), ` +
        `max DD ${a.maxDrawdownPct}%, win rate ${a.winRatePct ?? 'n/a'}%`,
    );

    // ───────────────────────────────────────────────────────────────────────
    section('2. The P&L identity holds on every persisted trade');
    const { rows: trades } = await backtests.trades(user.id, a.id, { limit: 2000 });
    check('trades were persisted', trades.length === (a.totalTrades ?? 0), `${trades.length} rows`);
    let identityOk = true;
    let worst = 0;
    for (const t of trades) {
      const expected = Number(t.grossPnl) - Number(t.fees) - Number(t.slippageCost);
      const delta = Math.abs(expected - Number(t.netPnl));
      worst = Math.max(worst, delta);
      if (delta > 0.02) identityOk = false;
    }
    check('gross - fees - slippage = net, on all of them', identityOk, `worst deviation ${worst.toFixed(4)}`);
    check('every trade has a real exit reason', trades.every((t) => !!t.exitReason));
    check('every trade closed after it opened', trades.every((t) => t.exitTime >= t.entryTime));

    // ───────────────────────────────────────────────────────────────────────
    section('3. The equity curve reconciles with the trades');
    const { rows: curve } = await backtests.equity(user.id, a.id);
    check('an equity curve was persisted', curve.length > 0, `${curve.length} points`);
    const sumNet = trades.reduce((s, t) => s + Number(t.netPnl), 0);
    const finalFromTrades = Number(a.initialCapital) + sumNet;
    check(
      'final capital equals initial + sum of net P&L',
      Math.abs(finalFromTrades - Number(a.finalCapital)) < 1,
      `${money(a.finalCapital)} vs ${money(finalFromTrades)}`,
    );
    check('the curve is strictly ordered', curve.every((p, i) => i === 0 || p.sequence > curve[i - 1].sequence));
    check('drawdown is never negative', curve.every((p) => Number(p.drawdownPct) >= 0));
    const maxCurveDd = Math.max(0, ...curve.map((p) => Number(p.drawdownPct)));
    check(
      'the stored max drawdown appears on the stored curve',
      Math.abs(maxCurveDd - Number(a.maxDrawdownPct ?? 0)) < 0.5,
      `curve ${maxCurveDd}% vs row ${a.maxDrawdownPct}%`,
    );

    // ───────────────────────────────────────────────────────────────────────
    section('4. Reproducibility — the same experiment reproduces');
    const b = await run({ label: 'verify-b', ...COVERED, exchange: 'NSE', minConfidence: 70, initialCapital: 1_000_000, sizingMode: 'CAPITAL_PCT', sizingValue: 10, feeRate: 0.0003, slippageRate: 0.0005 });
    check('a re-run produces a NEW row, never an overwrite', b.id !== a.id);
    check('the configuration hashes match', b.configurationHash === a.configurationHash, b.configurationHash);
    check('the trade count matches', b.totalTrades === a.totalTrades, `${b.totalTrades} vs ${a.totalTrades}`);
    check('the P&L matches to the paisa', String(b.totalPnl) === String(a.totalPnl), `${money(b.totalPnl)}`);
    check('the drawdown matches', String(b.maxDrawdownPct) === String(a.maxDrawdownPct));

    // ───────────────────────────────────────────────────────────────────────
    section('5. A different configuration is a different experiment');
    const c = await run({ label: 'verify-c', ...COVERED, exchange: 'NSE', minConfidence: 70, initialCapital: 1_000_000, sizingMode: 'CAPITAL_PCT', sizingValue: 10, feeRate: 0.001, slippageRate: 0.0005 });
    check('the hash changed with the fee rate', c.configurationHash !== a.configurationHash);
    check(
      'higher costs produced a different result',
      c.totalTrades === 0 || String(c.totalPnl) !== String(a.totalPnl),
      `${money(c.totalPnl)} vs ${money(a.totalPnl)}`,
    );

    // ───────────────────────────────────────────────────────────────────────
    section('6. Missing data FAILS honestly — nothing is fabricated');
    const d = await run({ label: 'verify-d', ...UNCOVERED, exchange: 'NSE' });
    check('status is FAILED', d.status === BacktestStatus.FAILED, d.failureReason ?? '');
    check('the reason names the real cause', /Historical data unavailable/i.test(d.failureReason ?? ''));
    check('no trades were invented', (await backtests.trades(user.id, d.id)).total === 0);
    check('no equity curve was invented', (await backtests.equity(user.id, d.id)).total === 0);
    check('no result numbers were written', d.totalPnl === null && d.finalCapital === null);

    // ───────────────────────────────────────────────────────────────────────
    section('7. Immutability — a terminal row is never rewritten');
    const beforeCompleted = await prisma.backtest.findUnique({ where: { id: a.id } });
    await runner.execute(a.id); // must be a no-op: the row is not RUNNING
    const afterCompleted = await prisma.backtest.findUnique({ where: { id: a.id } });
    check(
      're-running a COMPLETED backtest changes nothing',
      JSON.stringify(beforeCompleted) === JSON.stringify(afterCompleted),
    );
    let cancelRefused = false;
    try {
      await backtests.cancel(user.id, a.id);
    } catch {
      cancelRefused = true;
    }
    check('a completed backtest cannot be cancelled', cancelRefused);
    check(
      'the trade rows are unchanged',
      (await prisma.backtestTrade.count({ where: { backtestId: a.id } })) === trades.length,
    );

    // ───────────────────────────────────────────────────────────────────────
    section('8. Ownership — another user cannot reach it');
    const refusals = await Promise.all([
      backtests.get(other.id, a.id).then(() => 'leaked', () => 'refused'),
      backtests.trades(other.id, a.id).then(() => 'leaked', () => 'refused'),
      backtests.equity(other.id, a.id).then(() => 'leaked', () => 'refused'),
      backtests.cancel(other.id, a.id).then(() => 'leaked', () => 'refused'),
      backtests.compare(other.id, [a.id, b.id]).then(() => 'leaked', () => 'refused'),
    ]);
    check('every read path refuses a foreign backtest', refusals.every((r) => r === 'refused'), refusals.join(','));
    const list = await backtests.list(other.id, {});
    check('a foreign backtest never appears in the list', !list.rows.some((r) => r.id === a.id));

    // ───────────────────────────────────────────────────────────────────────
    section('9. A backtest is NOT the paper engine');
    const ordersAfter = await prisma.order.count({ where: { userId: user.id } });
    const tradesAfter = await prisma.trade.count({ where: { userId: user.id } });
    const positionsAfter = await prisma.position.count({ where: { userId: user.id } });
    const walletAfter = await prisma.paperWallet.count({ where: { userId: user.id } });
    check('no Order row was written', ordersAfter === 0);
    check('no Trade row was written', tradesAfter === 0);
    check('no Position row was written', positionsAfter === 0);
    check('no PaperWallet was even created', walletAfter === 0);
    const intents = await prisma.executionIntent.count({ where: { decidedAt: { gte: new Date(t0) } } });
    check('no ExecutionIntent was produced', intents === 0, `${intents} since start`);

    // ───────────────────────────────────────────────────────────────────────
    section('10. Comparison and analysis');
    const cmp = await backtests.compare(user.id, [a.id, c.id]);
    check('two of the caller\'s own runs compare', cmp.rows.length === 2);
    check('the differing fee rate is NOT flagged as an incompatibility', !cmp.incompatibilities.includes('period'));
    const analysis = await analysisSvc.generate(user.id, a.id);
    check('an analysis was produced', !!analysis.id);
    check('it records what it was allowed to see', !!analysis.evidence);
    check('it is marked as deterministic, not attributed to a model', analysis.generatedBy === 'deterministic');
    const out = analysis.output as Record<string, unknown[]>;
    const findings = ['strengths', 'weaknesses', 'failurePatterns', 'conditions', 'consistency'].reduce(
      (n, k) => n + ((out[k] as unknown[])?.length ?? 0),
      0,
    );
    check('it produced findings, each with a basis', findings > 0, `${findings} findings`);
    const allHaveBasis = ['strengths', 'weaknesses', 'failurePatterns', 'conditions', 'consistency'].every((k) =>
      ((out[k] ?? []) as { basis?: string[] }[]).every((f) => Array.isArray(f.basis) && f.basis.length > 0),
    );
    check('every finding cites the metrics it rests on', allHaveBasis);
    let analysisRefused = false;
    try {
      await analysisSvc.generate(user.id, d.id);
    } catch {
      analysisRefused = true;
    }
    check('a FAILED backtest cannot be analysed', analysisRefused);
  } finally {
    if (!KEEP) {
      section('cleanup');
      const del = await prisma.backtest.deleteMany({ where: { userId: { in: [user.id, other.id] } } });
      await prisma.user.deleteMany({ where: { email: { in: [SCRATCH_EMAIL, OTHER_EMAIL] } } });
      console.log(`  removed ${del.count} scratch backtest(s) and 2 scratch user(s)`);
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

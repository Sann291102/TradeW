/**
 * "What has the autonomous brain learned so far?"
 *
 *   npm run brain:report -w @tradew/api
 *
 * Reads the learning dataset and answers the questions it was built for:
 * which setups work, in which regimes, on which markets — and, just as
 * importantly, whether its refusals were right.
 *
 * ## It proposes nothing and changes nothing
 *
 * Read-only, deliberately. The learning loop's job at this stage is to make the
 * dataset legible, not to act on it: the existing `learning-cycle.ts` already
 * establishes that improvements must come from accumulated history, be
 * risk-neutral-or-reducing, survive a chronological holdout, and be promoted by
 * an operator. Nothing here shortcuts that, and nothing here writes.
 *
 * ## Small samples are labelled, never quietly averaged
 *
 * A win rate over four trades is not a win rate. Every aggregate below carries
 * its n, and anything under `MIN_SAMPLE` is marked rather than printed as if it
 * meant something — the same discipline `backtest-metrics.ts` applies.
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(__dirname, '../../../.env') });

import { PrismaClient } from '@prisma/client';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

/** Below this, an aggregate is reported as indicative rather than as a result. */
const MIN_SAMPLE = 20;

const prisma = new PrismaClient();

function line(char = '─', n = 78): string {
  return char.repeat(n);
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`;
}

function sampleNote(n: number): string {
  return n < MIN_SAMPLE ? `${YELLOW} (n=${n}, below ${MIN_SAMPLE} — indicative only)${RESET}` : `${DIM} (n=${n})${RESET}`;
}

async function main(): Promise<void> {
  console.log('');
  console.log(line('═'));
  console.log('  AUTONOMOUS BRAIN — LEARNING DATASET');
  console.log(line('═'));

  const [scans, candidates, outcomes] = await Promise.all([
    prisma.autonomousScan.count(),
    prisma.autonomousCandidate.count(),
    prisma.autonomousOutcome.count(),
  ]);
  console.log(`  scans ${scans}   candidates ${candidates}   outcomes ${outcomes}`);

  if (candidates === 0) {
    console.log('');
    console.log(`  ${DIM}Nothing journalled yet. The observer writes one row per BAR per symbol,`);
    console.log(`  so a freshly enabled brain has nothing until the next bar closes.${RESET}`);
    console.log('');
    return;
  }

  // ── coverage ──────────────────────────────────────────────────────────────
  console.log('');
  console.log(`${BOLD}Coverage${RESET}`);
  console.log(line());
  const byMarket = await prisma.autonomousCandidate.groupBy({
    by: ['market', 'accepted'],
    _count: { _all: true },
  });
  const markets = [...new Set(byMarket.map((r) => r.market))].sort();
  for (const m of markets) {
    const acc = byMarket.find((r) => r.market === m && r.accepted)?._count._all ?? 0;
    const rej = byMarket.find((r) => r.market === m && !r.accepted)?._count._all ?? 0;
    console.log(`  ${m.padEnd(8)} ${String(acc + rej).padStart(5)} candidates   ${acc} accepted, ${rej} refused`);
  }

  // ── why it refuses ────────────────────────────────────────────────────────
  console.log('');
  console.log(`${BOLD}Why it refused${RESET}  ${DIM}— the closed-set reasons, which is what makes them countable${RESET}`);
  console.log(line());
  const reasons = await prisma.autonomousCandidate.groupBy({
    by: ['rejectionReason'],
    where: { accepted: false },
    _count: { _all: true },
    orderBy: { _count: { rejectionReason: 'desc' } },
  });
  for (const r of reasons) {
    console.log(`  ${String(r._count._all).padStart(5)}  ${r.rejectionReason ?? '(none)'}`);
  }

  // ── did the predictions pay? ──────────────────────────────────────────────
  console.log('');
  console.log(`${BOLD}Did the predictions pay?${RESET}  ${DIM}— shadow outcomes, pessimistically resolved${RESET}`);
  console.log(line());

  const resolved = await prisma.autonomousCandidate.findMany({
    where: { outcome: { status: { in: ['TARGET_HIT', 'STOP_HIT', 'EXPIRED'] } } },
    select: {
      setupId: true,
      market: true,
      regime: true,
      accepted: true,
      rejectionReason: true,
      outcome: { select: { status: true, actualR: true, mfeR: true, maeR: true, wouldHaveHitTarget: true } },
    },
  });

  if (resolved.length === 0) {
    console.log(`  ${DIM}No outcome has resolved yet. A 15m shadow position needs bars to`);
    console.log(`  print before it can hit anything — the first results appear within`);
    console.log(`  hours, not minutes.${RESET}`);
  } else {
    const group = <K extends string>(rows: typeof resolved, key: (r: (typeof resolved)[number]) => K) => {
      const out = new Map<K, typeof resolved>();
      for (const r of rows) {
        const k = key(r);
        out.set(k, [...(out.get(k) ?? []), r]);
      }
      return out;
    };

    const report = (title: string, buckets: Map<string, typeof resolved>) => {
      console.log('');
      console.log(`  ${BOLD}${title}${RESET}`);
      for (const [name, rows] of [...buckets].sort((a, b) => b[1].length - a[1].length)) {
        const wins = rows.filter((r) => r.outcome!.status === 'TARGET_HIT').length;
        const rs = rows.map((r) => Number(r.outcome!.actualR ?? 0));
        const expectancy = rs.reduce((a, b) => a + b, 0) / rs.length;
        console.log(
          `    ${name.padEnd(32)} win ${pct(wins, rows.length).padStart(6)}   ` +
            `expectancy ${expectancy >= 0 ? GREEN : YELLOW}${expectancy.toFixed(2)}R${RESET}` +
            sampleNote(rows.length),
        );
      }
    };

    const taken = resolved.filter((r) => r.accepted);
    if (taken.length) {
      report('By setup (accepted only)', group(taken, (r) => r.setupId));
      report('By market (accepted only)', group(taken, (r) => r.market));
      report('By regime (accepted only)', group(taken, (r) => r.regime ?? 'unknown'));
    }

    // ── the counterfactual: were the refusals right? ────────────────────────
    const refused = resolved.filter((r) => !r.accepted && r.rejectionReason);
    if (refused.length) {
      console.log('');
      console.log(`  ${BOLD}Were the refusals right?${RESET}  ${DIM}— what the refused levels would have done${RESET}`);
      for (const [reason, rows] of [...group(refused, (r) => r.rejectionReason!)].sort(
        (a, b) => b[1].length - a[1].length,
      )) {
        const wins = rows.filter((r) => r.outcome!.status === 'TARGET_HIT').length;
        const rs = rows.map((r) => Number(r.outcome!.actualR ?? 0));
        const expectancy = rs.reduce((a, b) => a + b, 0) / rs.length;
        // A refusal whose levels would reliably have PAID is evidence the gate
        // is too strict; one whose levels lost is evidence it earns its place.
        const verdict = expectancy > 0.3 ? `${YELLOW}gate may be too strict${RESET}` : `${GREEN}gate earning its place${RESET}`;
        console.log(
          `    ${reason.padEnd(32)} would-have-won ${pct(wins, rows.length).padStart(6)}   ` +
            `${expectancy.toFixed(2)}R   ${verdict}${sampleNote(rows.length)}`,
        );
      }
    }

    // ── right thesis, wrong stop ────────────────────────────────────────────
    const stopped = resolved.filter((r) => r.outcome!.status === 'STOP_HIT');
    const rescued = stopped.filter((r) => r.outcome!.wouldHaveHitTarget === true);
    if (stopped.length) {
      console.log('');
      console.log(`  ${BOLD}Right thesis, wrong stop${RESET}`);
      console.log(
        `    ${rescued.length}/${stopped.length} stopped trades later reached their original target ` +
          `${DIM}— a high ratio means the levels are right and the stops are too tight${RESET}`,
      );
    }
  }

  // ── EXECUTED PAPER TRADES ────────────────────────────────────────────────
  //
  // Stronger evidence than a shadow outcome: these went through the real paper
  // OMS, so they carry a real fill, real slippage and a realised R measured
  // from what was actually paid.
  console.log('');
  console.log(`${BOLD}Executed paper trades${RESET}  ${DIM}— realised R measured from the ACTUAL fill${RESET}`);
  console.log(line());

  const trades = await prisma.autonomousTrade.findMany({
    include: { candidate: { select: { setupId: true, regime: true } } },
    orderBy: { createdAt: 'desc' },
  });

  if (trades.length === 0) {
    console.log(`  ${DIM}No paper trade has been executed yet.${RESET}`);
  } else {
    const open = trades.filter((t) => t.positionStatus === 'OPEN');
    const closed = trades.filter((t) => t.positionStatus === 'CLOSED');
    console.log(`  ${trades.length} trade(s): ${open.length} open, ${closed.length} closed`);

    for (const t of open) {
      console.log(
        `    ${YELLOW}OPEN${RESET}  ${t.tradedSymbol.padEnd(26)} filled ${t.actualFillPrice} × ${t.quantity}  ` +
          `stop ${t.currentStop}${t.trailActivated ? ` ${GREEN}(trailing, ${t.trailSteps} step)${RESET}` : ''}  target ${t.initialTarget}`,
      );
    }

    if (closed.length) {
      const rs = closed.map((t) => Number(t.realizedR ?? 0));
      const wins = closed.filter((t) => Number(t.realizedR ?? 0) > 0).length;
      const expectancy = rs.reduce((a, b) => a + b, 0) / rs.length;
      const sorted = [...rs].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const grossWin = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
      const grossLoss = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));

      console.log('');
      console.log(
        `  win ${pct(wins, closed.length)}   expectancy ${expectancy >= 0 ? GREEN : YELLOW}${expectancy.toFixed(2)}R${RESET}   ` +
          `median ${median?.toFixed(2)}R   profit factor ${grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : '—'}` +
          sampleNote(closed.length),
      );

      // Slippage: planned versus what the OMS actually filled at. This is the
      // number a backtest cannot produce and the reason paper trades are
      // better evidence than shadow outcomes.
      const slip = closed
        .filter((t) => t.actualFillPrice != null)
        .map((t) => Number(t.actualFillPrice) - Number(t.plannedEntry));
      if (slip.length) {
        const avg = slip.reduce((a, b) => a + b, 0) / slip.length;
        console.log(`  ${DIM}execution quality: mean entry slippage ${avg.toFixed(3)} points over ${slip.length} fill(s)${RESET}`);
      }

      // Grouped evidence — by setup, by market, by exit reason.
      const bucket = <K extends string>(key: (t: (typeof closed)[number]) => K) => {
        const m = new Map<K, number[]>();
        for (const t of closed) {
          const k = key(t);
          m.set(k, [...(m.get(k) ?? []), Number(t.realizedR ?? 0)]);
        }
        return m;
      };
      const show = (title: string, m: Map<string, number[]>) => {
        console.log('');
        console.log(`  ${BOLD}${title}${RESET}`);
        for (const [name, values] of [...m].sort((a, b) => b[1].length - a[1].length)) {
          const e = values.reduce((a, b) => a + b, 0) / values.length;
          const w = values.filter((v) => v > 0).length;
          const verdict =
            values.length < MIN_SAMPLE
              ? `${YELLOW}INSUFFICIENT EVIDENCE${RESET}`
              : e > 0.2
                ? `${GREEN}PROMISING${RESET}`
                : `${YELLOW}WEAK${RESET}`;
          console.log(
            `    ${name.padEnd(30)} ${String(values.length).padStart(3)} trades  win ${pct(w, values.length).padStart(6)}  ` +
              `${e.toFixed(2)}R  ${verdict}`,
          );
        }
      };
      show('By setup', bucket((t) => t.candidate?.setupId ?? 'unknown'));
      show('By market', bucket((t) => t.market));
      show('By exit reason', bucket((t) => t.exitReason ?? 'unknown'));
      show('By regime', bucket((t) => t.candidate?.regime ?? 'unknown'));

      console.log('');
      console.log(
        `  ${DIM}Nothing above is promoted automatically. A setup marked PROMISING is a`,
      );
      console.log(`  candidate for REVIEW → backtest → paper validation → human approval.${RESET}`);
    }
  }

  // ── the benchmark ─────────────────────────────────────────────────────────
  console.log('');
  console.log(`${BOLD}Against Sentinel${RESET}  ${DIM}— benchmark only; Sentinel never authorises anything here${RESET}`);
  console.log(line());
  const agreement = await prisma.autonomousScan.groupBy({
    by: ['agreement'],
    where: { agreement: { not: null } },
    _count: { _all: true },
  });
  if (agreement.length === 0) {
    console.log(`  ${DIM}No paired observations yet.${RESET}`);
  } else {
    for (const a of agreement) console.log(`  ${String(a._count._all).padStart(5)}  ${a.agreement}`);
  }

  console.log('');
}

main()
  .catch((err) => {
    console.error('brain report failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

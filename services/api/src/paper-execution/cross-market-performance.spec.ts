/**
 * Cross-market comparison — the rules that keep it evidence rather than an
 * argument.
 *
 * Three classes of failure are asserted here, and all three produce a table
 * that looks entirely reasonable:
 *
 *  1. A cross-currency total. INR and USD P&L summed into one number reads as
 *     a portfolio result and is meaningless — there is no FX conversion
 *     anywhere in the paper-wallet path.
 *  2. A small sample presented as a finding. 100% over two trades beside 54%
 *     over two hundred is how a fluke gets promoted.
 *  3. A confound left to be inferred. Spot crypto cannot short; if that is not
 *     stated beside the win rate, "BTC suits this strategy" is unfalsifiable.
 *
 * Driven through a stub Prisma so the arithmetic is asserted without a
 * database, matching how every other pure suite in this module runs.
 */

import { describe, expect, it } from 'vitest';
import {
  CrossMarketPerformanceService,
  MIN_SAMPLE,
} from './cross-market-performance.service';

interface JournalRow {
  symbol: string;
  strategyId: string | null;
  strategyName: string | null;
  realizedPnl: number;
  rMultiple: number | null;
  result: string;
}

function serviceWith(rows: JournalRow[]): CrossMarketPerformanceService {
  const prisma = {
    executionJournal: { findMany: async () => rows },
  } as never;
  return new CrossMarketPerformanceService(prisma);
}

/** `count` trades on `symbol`, alternating win/loss by `winEvery`. */
function trades(
  symbol: string,
  count: number,
  opts: { win: number; loss: number; winEvery?: number; strategyId?: string } = {
    win: 1000,
    loss: -500,
  },
): JournalRow[] {
  const winEvery = opts.winEvery ?? 2;
  return Array.from({ length: count }, (_, i) => {
    const isWin = i % winEvery === 0;
    return {
      symbol,
      strategyId: opts.strategyId ?? 'orb',
      strategyName: 'Opening Range Breakout',
      realizedPnl: isWin ? opts.win : opts.loss,
      rMultiple: isWin ? 2 : -1,
      result: isWin ? 'WIN' : 'LOSS',
    };
  });
}

describe('the currency rule', () => {
  it('reports P&L per row with its own currency and NO cross-market total', async () => {
    const svc = serviceWith([
      ...trades('NIFTY', 30),
      ...trades('BTCUSDT', 30, { win: 200, loss: -100 }),
    ]);
    const report = await svc.report(30);

    const india = report.rows.find((r) => r.market === 'INDIA')!;
    const crypto = report.rows.find((r) => r.market === 'CRYPTO')!;
    expect(india.currency).toBe('INR');
    expect(crypto.currency).toBe('USD');

    // THE STRUCTURAL DEFENCE: a caller cannot sum what is not there. If a
    // total field is ever added, this fails and the reviewer has to argue for
    // an FX rate that does not exist in this system.
    expect(report).not.toHaveProperty('totalPnl');
    expect(report).not.toHaveProperty('netPnl');
    for (const key of Object.keys(report)) {
      expect(key.toLowerCase()).not.toContain('totalpnl');
    }
  });

  it('ranks on mean R, which is dimensionless and therefore comparable', async () => {
    // Crypto's absolute P&L is a fifth of India's, but its R is better. A
    // ranking that used P&L would put the rupee row on top purely because a
    // rupee is worth less than a dollar.
    const svc = serviceWith([
      ...trades('NIFTY', 30, { win: 1000, loss: -900, winEvery: 2 }),
      ...trades('BTCUSDT', 30, { win: 200, loss: -100, winEvery: 1 }),
    ]);
    const report = await svc.report(30);
    expect(report.rows[0].market).toBe('CRYPTO');
    expect(report.rows[0].avgR).toBeGreaterThan(report.rows[1].avgR!);
  });
});

describe('sample suppression', () => {
  it('withholds derived metrics below the floor but still reports the count', async () => {
    const svc = serviceWith(trades('NIFTY', 3));
    const [row] = (await svc.report(30)).rows;

    expect(row.trades).toBe(3);
    expect(row.sampleSufficient).toBe(false);
    // Withheld, not zeroed. A zero win rate would read as "this strategy never
    // wins" rather than "we do not know yet".
    expect(row.winRate).toBeNull();
    expect(row.profitFactor).toBeNull();
    expect(row.avgR).toBeNull();
    expect(row.maxDrawdownR).toBeNull();
    // The absolute P&L is a fact regardless of sample size and is still shown.
    expect(row.netPnl).not.toBeNull();
  });

  it('reports metrics once the floor is met', async () => {
    const svc = serviceWith(trades('NIFTY', MIN_SAMPLE));
    const [row] = (await svc.report(30)).rows;
    expect(row.sampleSufficient).toBe(true);
    expect(row.winRate).toBeCloseTo(0.5, 5);
    expect(row.avgR).toBeCloseTo(0.5, 5);
  });

  it('sorts insufficient-sample rows below sufficient ones regardless of value', async () => {
    // A two-trade perfect record must never head the table.
    const svc = serviceWith([
      ...trades('BTCUSDT', 2, { win: 10_000, loss: -1, winEvery: 1 }),
      ...trades('NIFTY', 30),
    ]);
    const report = await svc.report(30);
    expect(report.rows[0].market).toBe('INDIA');
    expect(report.rows[0].sampleSufficient).toBe(true);
    expect(report.rows[1].sampleSufficient).toBe(false);
  });
});

describe('honest absences', () => {
  it('names markets with no data instead of omitting them', async () => {
    const svc = serviceWith(trades('NIFTY', 25));
    const report = await svc.report(30);
    // An empty market must be visibly empty. Omitting it makes "we have not run
    // this experiment yet" look like "this market has nothing to show".
    expect(report.marketsWithNoData).toContain('CRYPTO');
    expect(report.marketsWithNoData).toContain('GOLD');
    expect(report.marketsWithNoData).not.toContain('INDIA');
  });

  it('returns null profit factor when there are no losses at all', async () => {
    // An undefined ratio is not a very good one; printing a big number for it
    // would rank a lucky streak above a robust strategy.
    const svc = serviceWith(trades('NIFTY', 25, { win: 100, loss: 100, winEvery: 1 }));
    const [row] = (await svc.report(30)).rows;
    expect(row.profitFactor).toBeNull();
  });

  it('excludes a symbol outside the experiment registry rather than bucketing it', async () => {
    const svc = serviceWith([
      ...trades('NIFTY', 25),
      ...trades('SOMEUNKNOWNTICKER', 25),
    ]);
    const report = await svc.report(30);
    // Silently attributing a stray symbol to INDIA would corrupt the very
    // comparison this table exists to make.
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].symbols).toEqual(['NIFTY']);
  });

  it('does not treat a missing R multiple as zero', async () => {
    // "A missing measurement is not a zero" — the rule post-trade-analysis
    // already pins. Averaging nulls as 0 would drag mean R toward the middle
    // and make every strategy look mediocre.
    const rows: JournalRow[] = [
      ...trades('NIFTY', MIN_SAMPLE, { win: 100, loss: -100, winEvery: 1 }),
    ].map((r, i) => (i % 2 === 0 ? { ...r, rMultiple: null } : r));

    const [row] = (await serviceWith(rows).report(30)).rows;
    // Every surviving R is +2, so the mean must be exactly 2 — not 1, which is
    // what folding the nulls in as zeros would give.
    expect(row.avgR).toBeCloseTo(2, 5);
  });
});

describe('confounds are stated, not inferred', () => {
  it('marks spot crypto long-only and says so in the caveats', async () => {
    const svc = serviceWith(trades('BTCUSDT', 25));
    const report = await svc.report(30);
    expect(report.rows[0].longOnly).toBe(true);
    expect(report.caveats.join(' ')).toMatch(/long-only/i);
  });

  it('marks the Indian option path as neither long-only nor continuous', async () => {
    const svc = serviceWith(trades('NIFTY', 25));
    const [row] = (await svc.report(30)).rows;
    expect(row.longOnly).toBe(false);
    expect(row.sessionKind).toBe('session');
    expect(row.eodFlatten).toBe(true);
  });

  it('flags the clock mismatch only when both kinds are present', async () => {
    const oneKind = await serviceWith(trades('NIFTY', 25)).report(30);
    expect(oneKind.caveats.join(' ')).not.toMatch(/do not share a clock/i);

    const both = await serviceWith([
      ...trades('NIFTY', 25),
      ...trades('BTCUSDT', 25),
    ]).report(30);
    expect(both.caveats.join(' ')).toMatch(/do not share a clock/i);
    expect(both.rows.find((r) => r.market === 'CRYPTO')!.sessionKind).toBe('continuous');
    expect(both.rows.find((r) => r.market === 'CRYPTO')!.eodFlatten).toBe(false);
  });
});

describe('drawdown', () => {
  it('reports a drawdown on a curve that is negative throughout', async () => {
    // Seeding the peak at the first point instead of 0 reports NO drawdown for
    // a strategy that lost from its first trade — the exact defect
    // `execution-drawdown.ts` records for the daily equity curve.
    const losing: JournalRow[] = Array.from({ length: MIN_SAMPLE }, () => ({
      symbol: 'NIFTY',
      strategyId: 'orb',
      strategyName: 'Opening Range Breakout',
      realizedPnl: -100,
      rMultiple: -1,
      result: 'LOSS',
    }));
    const [row] = (await serviceWith(losing).report(30)).rows;
    expect(row.maxDrawdownR).toBeCloseTo(MIN_SAMPLE, 5);
  });
});

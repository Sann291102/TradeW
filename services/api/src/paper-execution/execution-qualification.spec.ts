import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUALIFICATION_CRITERIA,
  computeMetrics,
  deploymentCriteriaFromEnv,
  evaluateQualification,
  resolveCriteria,
  type ClosedTrade,
} from './execution-qualification';

const dayKeyOf = (d: Date) => d.toISOString().slice(0, 10);
const at = (iso: string) => new Date(`${iso}T10:00:00Z`);

function trade(pnl: number, day: string): ClosedTrade {
  return {
    realizedPnl: pnl,
    result: pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'SCRATCH',
    exitAt: at(day),
  };
}

describe('paper qualification', () => {
  describe('configuration resolution', () => {
    it('prefers the profile over the deployment over the default', () => {
      const resolved = resolveCriteria(
        { qualMinTrades: 10 },
        { minTrades: 30, minWinRate: 60 },
      );
      expect(resolved.minTrades).toBe(10); // profile wins
      expect(resolved.minWinRate).toBe(60); // deployment wins over default
      expect(resolved.maxDrawdownPct).toBe(DEFAULT_QUALIFICATION_CRITERIA.maxDrawdownPct); // default
    });

    it('falls through a null profile override rather than treating it as zero', () => {
      // A null column means "not overridden". Coercing it to 0 would set the
      // bar to zero trades — a qualification that passes instantly.
      expect(resolveCriteria({ qualMinTrades: null }).minTrades).toBe(DEFAULT_QUALIFICATION_CRITERIA.minTrades);
    });

    it('ignores an unparseable environment value instead of producing NaN', () => {
      // A NaN threshold compares false against everything, which silently makes
      // the criterion unpassable — the worst failure mode for a config typo.
      const dep = deploymentCriteriaFromEnv({ PAPER_QUALIFICATION_MIN_TRADES: 'fifty' } as NodeJS.ProcessEnv);
      expect(dep.minTrades).toBeUndefined();
      expect(resolveCriteria({}, dep).minTrades).toBe(DEFAULT_QUALIFICATION_CRITERIA.minTrades);
    });

    it('honours a zero from the environment', () => {
      // 0 is a legitimate floor for minNetPnl and must not be swallowed by a
      // falsy check.
      const dep = deploymentCriteriaFromEnv({ PAPER_QUALIFICATION_MIN_NET_PNL: '0' } as NodeJS.ProcessEnv);
      expect(dep.minNetPnl).toBe(0);
    });
  });

  describe('metrics', () => {
    it('measures drawdown against the account equity, not against cumulative P&L', () => {
      // The classic version of this bug reports an ₹8,000 dip on a ₹10L account
      // as an "80% drawdown" because the running P&L peaked at ₹10,000 — and
      // then fires the criterion on a profitable strategy.
      const metrics = computeMetrics({
        trades: [trade(10_000, '2026-08-01'), trade(-8_000, '2026-08-02')],
        startingEquity: 1_000_000,
        criticalErrors: 0,
        dayKeyOf,
      });
      // Peak 1,010,000 → trough 1,002,000 = 0.79%, not 80%.
      expect(metrics.maxDrawdownPct).toBeCloseTo(0.79, 1);
    });

    it('reports a null win rate when nothing has closed, never 0', () => {
      const metrics = computeMetrics({ trades: [], startingEquity: 1_000_000, criticalErrors: 0, dayKeyOf });
      expect(metrics.winRate).toBeNull();
      expect(metrics.trades).toBe(0);
    });

    it('excludes scratches from the win rate denominator', () => {
      const metrics = computeMetrics({
        trades: [trade(100, '2026-08-01'), trade(-100, '2026-08-01'), trade(0, '2026-08-01')],
        startingEquity: 1_000_000,
        criticalErrors: 0,
        dayKeyOf,
      });
      expect(metrics.trades).toBe(3);
      expect(metrics.scratches).toBe(1);
      expect(metrics.winRate).toBe(50); // 1W / (1W + 1L)
    });

    it('breaks a losing streak on a scratch', () => {
      // A scratch is flat, not a loss. Counting it as one would fire the streak
      // criterion on a strategy that merely went nowhere.
      const metrics = computeMetrics({
        trades: [trade(-1, '2026-08-01'), trade(-1, '2026-08-01'), trade(0, '2026-08-01'), trade(-1, '2026-08-01')],
        startingEquity: 1_000_000,
        criticalErrors: 0,
        dayKeyOf,
      });
      expect(metrics.maxLosingStreak).toBe(2);
    });

    it('counts distinct trading days, not trades', () => {
      const metrics = computeMetrics({
        trades: [trade(1, '2026-08-01'), trade(1, '2026-08-01'), trade(1, '2026-08-02')],
        startingEquity: 1_000_000,
        criticalErrors: 0,
        dayKeyOf,
      });
      expect(metrics.tradingDays).toBe(2);
    });

    it('orders trades by exit time before walking the equity curve', () => {
      // Drawdown and streak both depend on sequence. A caller handing them in
      // insertion order would otherwise produce a different verdict for the
      // same set of trades.
      const shuffled = [trade(-5_000, '2026-08-03'), trade(20_000, '2026-08-01'), trade(-5_000, '2026-08-02')];
      const metrics = computeMetrics({ trades: shuffled, startingEquity: 1_000_000, criticalErrors: 0, dayKeyOf });
      expect(metrics.firstTradeAt).toEqual(at('2026-08-01'));
      expect(metrics.lastTradeAt).toEqual(at('2026-08-03'));
      // Peak is after the win, so the drawdown is the two losses off 1,020,000.
      expect(metrics.maxDrawdownPct).toBeCloseTo(0.98, 1);
    });
  });

  describe('the verdict', () => {
    const criteria = {
      minTrades: 3,
      minTradingDays: 2,
      minWinRate: 50,
      maxDrawdownPct: 10,
      minNetPnl: 0,
      maxLosingStreak: 2,
      maxCriticalErrors: 0,
    };

    it('passes when every criterion is met', () => {
      const metrics = computeMetrics({
        trades: [trade(5_000, '2026-08-01'), trade(-1_000, '2026-08-02'), trade(3_000, '2026-08-02')],
        startingEquity: 1_000_000,
        criticalErrors: 0,
        dayKeyOf,
      });
      const verdict = evaluateQualification(metrics, criteria);
      expect(verdict.passed).toBe(true);
      expect(verdict.unmet).toHaveLength(0);
    });

    it('evaluates every criterion rather than stopping at the first failure', () => {
      // §10's example output lists what is still missing. An operator who fixes
      // the first thing only to discover the second has been told half the truth.
      const metrics = computeMetrics({ trades: [], startingEquity: 1_000_000, criticalErrors: 1, dayKeyOf });
      const verdict = evaluateQualification(metrics, criteria);
      expect(verdict.passed).toBe(false);
      expect(verdict.results).toHaveLength(7);
      expect(verdict.unmet.map((u) => u.id)).toContain('min-trades');
      expect(verdict.unmet.map((u) => u.id)).toContain('min-win-rate');
      expect(verdict.unmet.map((u) => u.id)).toContain('no-critical-errors');
    });

    it('carries the numbers in the detail, so the console does not have to restate them', () => {
      const metrics = computeMetrics({
        trades: [trade(1_000, '2026-08-01')],
        startingEquity: 1_000_000,
        criticalErrors: 0,
        dayKeyOf,
      });
      const verdict = evaluateQualification(metrics, criteria);
      const trades = verdict.results.find((r) => r.id === 'min-trades')!;
      expect(trades.detail).toBe('1 closed against a minimum of 3.');
    });

    it('fails a null win rate rather than treating "not measured" as zero', () => {
      const metrics = computeMetrics({ trades: [], startingEquity: 1_000_000, criticalErrors: 0, dayKeyOf });
      const winRate = evaluateQualification(metrics, criteria).results.find((r) => r.id === 'min-win-rate')!;
      expect(winRate.met).toBe(false);
      expect(winRate.actual).toBeNull();
      expect(winRate.detail).toMatch(/no decided trade yet/i);
    });

    it('refuses a profitable strategy that lost money net', () => {
      // Win rate and profitability are different questions, and a high win rate
      // with a few large losses is exactly the shape this criterion catches.
      const metrics = computeMetrics({
        trades: [trade(100, '2026-08-01'), trade(100, '2026-08-02'), trade(-5_000, '2026-08-02')],
        startingEquity: 1_000_000,
        criticalErrors: 0,
        dayKeyOf,
      });
      const verdict = evaluateQualification(metrics, { ...criteria, maxLosingStreak: 5, maxDrawdownPct: 50 });
      expect(verdict.unmet.map((u) => u.id)).toContain('min-net-pnl');
      expect(verdict.passed).toBe(false);
    });
  });
});

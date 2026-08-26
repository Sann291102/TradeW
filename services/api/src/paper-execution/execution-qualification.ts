/**
 * Paper-trading qualification — the measurement that stands between an agent
 * that has been trading paper and an administrator willing to consider it for
 * live money.
 *
 * Pure and dependency-free, like every other decision module in this folder.
 * The caller reads the closed outcomes; this computes the record and compares
 * it to the bar.
 *
 * ## WHAT PASSING DOES, PRECISELY
 *
 * Nothing. It sets a boolean on a snapshot row. It does not change what the
 * profile may do, it does not enable live execution, and it cannot: the only
 * transition that reaches a live state is `ARM_LIVE`, which is an administrator
 * pressing a button. §10's requirement — "do NOT automatically switch a user to
 * live trading simply because paper trading succeeded" — is enforced by that
 * separation, not by a caveat in a comment.
 *
 * ## Thresholds are configuration, not constants
 *
 * §10 asks for configurable criteria. They resolve in three layers, most
 * specific first:
 *
 *   1. the profile's own `qual*` columns (per-experiment overrides),
 *   2. environment variables (per-deployment policy),
 *   3. the defaults below (a documented starting position, not a magic number).
 *
 * No threshold is read from anywhere else in the codebase.
 */

export interface QualificationCriteria {
  minTrades: number;
  minTradingDays: number;
  /** Percent, 0–100. */
  minWinRate: number;
  /** Percent, 0–100. Peak-to-trough of the equity curve. */
  maxDrawdownPct: number;
  /** Rupees. Net of charges. May be negative if a deployment wants to allow it. */
  minNetPnl: number;
  maxLosingStreak: number;
  /** FAILED intents tolerated. Zero by default: an execution fault is not noise. */
  maxCriticalErrors: number;
}

/**
 * The default bar.
 *
 * Chosen to be defensible rather than arbitrary, and every one of them is
 * overridable:
 *
 *  · 50 trades / 10 trading days — enough that a win rate is not one lucky
 *    week. Below roughly this, the confidence interval on a 60% win rate still
 *    contains 40%.
 *  · 55% win rate — above break-even for a long-option strategy that must also
 *    pay charges, without demanding a number that only overfitting produces.
 *  · 20% max drawdown — the capital-preservation bound. A strategy that has
 *    already given back a fifth of its peak has shown what a bad run looks like.
 *  · net P&L above zero — paper trading that lost money does not get to trade
 *    real money, whatever its win rate says.
 *  · 6 consecutive losses — the shape of a strategy whose edge has stopped
 *    working, which a win-rate average hides.
 *  · zero critical errors — a FAILED intent means policy passed and the world
 *    still refused. Promoting through one is promoting a known fault.
 */
export const DEFAULT_QUALIFICATION_CRITERIA: QualificationCriteria = {
  minTrades: 50,
  minTradingDays: 10,
  minWinRate: 55,
  maxDrawdownPct: 20,
  minNetPnl: 0,
  maxLosingStreak: 6,
  maxCriticalErrors: 0,
};

/** Per-profile overrides, any of which may be absent. */
export interface ProfileCriteriaOverrides {
  qualMinTrades?: number | null;
  qualMinTradingDays?: number | null;
  qualMinWinRate?: number | null;
  qualMaxDrawdownPct?: number | null;
  qualMinNetPnl?: number | null;
  qualMaxLosingStreak?: number | null;
  qualMaxCriticalErrors?: number | null;
}

/** Deployment-level overrides, already parsed out of the environment. */
export interface DeploymentCriteriaOverrides extends Partial<QualificationCriteria> {}

/**
 * Resolve the bar for one profile: profile override → deployment → default.
 *
 * A null or undefined at a layer falls through to the next, so setting one
 * column on one profile does not require restating the other six.
 */
export function resolveCriteria(
  profile: ProfileCriteriaOverrides = {},
  deployment: DeploymentCriteriaOverrides = {},
): QualificationCriteria {
  const pick = <K extends keyof QualificationCriteria>(
    profileValue: number | null | undefined,
    key: K,
  ): number => {
    if (profileValue != null && Number.isFinite(profileValue)) return profileValue;
    const dep = deployment[key];
    if (dep != null && Number.isFinite(dep)) return dep;
    return DEFAULT_QUALIFICATION_CRITERIA[key];
  };

  return {
    minTrades: pick(profile.qualMinTrades, 'minTrades'),
    minTradingDays: pick(profile.qualMinTradingDays, 'minTradingDays'),
    minWinRate: pick(profile.qualMinWinRate, 'minWinRate'),
    maxDrawdownPct: pick(profile.qualMaxDrawdownPct, 'maxDrawdownPct'),
    minNetPnl: pick(profile.qualMinNetPnl, 'minNetPnl'),
    maxLosingStreak: pick(profile.qualMaxLosingStreak, 'maxLosingStreak'),
    maxCriticalErrors: pick(profile.qualMaxCriticalErrors, 'maxCriticalErrors'),
  };
}

/** Read the deployment layer out of the process environment. */
export function deploymentCriteriaFromEnv(env: NodeJS.ProcessEnv = process.env): DeploymentCriteriaOverrides {
  const num = (raw: string | undefined): number | undefined => {
    if (raw == null || raw.trim() === '') return undefined;
    const n = Number(raw);
    // An unparseable value falls through to the default rather than becoming
    // NaN — a NaN threshold compares false against everything, which would
    // silently make a criterion unpassable.
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    minTrades: num(env.PAPER_QUALIFICATION_MIN_TRADES),
    minTradingDays: num(env.PAPER_QUALIFICATION_MIN_TRADING_DAYS),
    minWinRate: num(env.PAPER_QUALIFICATION_MIN_WIN_RATE),
    maxDrawdownPct: num(env.PAPER_QUALIFICATION_MAX_DRAWDOWN_PCT),
    minNetPnl: num(env.PAPER_QUALIFICATION_MIN_NET_PNL),
    maxLosingStreak: num(env.PAPER_QUALIFICATION_MAX_LOSING_STREAK),
    maxCriticalErrors: num(env.PAPER_QUALIFICATION_MAX_CRITICAL_ERRORS),
  };
}

/** One closed paper trade, as this module needs it. */
export interface ClosedTrade {
  /** Net of charges — the same number the wallet booked. */
  realizedPnl: number;
  /** 'WIN' | 'LOSS' | 'SCRATCH'. Derived at close time, not re-derived here. */
  result: string;
  /** When the position was flattened. */
  exitAt: Date;
}

export interface QualificationMetrics {
  trades: number;
  wins: number;
  losses: number;
  scratches: number;
  /** Null when nothing has closed — never 0, which asserts a losing agent. */
  winRate: number | null;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  maxDrawdownPct: number;
  maxLosingStreak: number;
  tradingDays: number;
  criticalErrors: number;
  firstTradeAt: Date | null;
  lastTradeAt: Date | null;
}

/**
 * Compute the record from closed trades.
 *
 * `startingEquity` is the paper wallet's starting balance, and drawdown is
 * measured against the equity curve it anchors — not against cumulative P&L
 * alone. Measuring a peak-to-trough of ₹8,000 on a ₹10,00,000 account as an
 * "80% drawdown" because the running P&L happened to peak at ₹10,000 is the
 * classic version of this bug, and it makes the criterion fire on a profitable
 * strategy.
 *
 * `trades` must be supplied in exit order; `criticalErrors` is counted by the
 * caller from FAILED intents.
 */
export function computeMetrics(input: {
  trades: ClosedTrade[];
  startingEquity: number;
  criticalErrors: number;
  /** IST day key extractor, injected so this module stays free of a timezone dependency. */
  dayKeyOf: (d: Date) => string;
}): QualificationMetrics {
  const { trades, startingEquity, criticalErrors, dayKeyOf } = input;

  const ordered = [...trades].sort((a, b) => a.exitAt.getTime() - b.exitAt.getTime());

  let wins = 0;
  let losses = 0;
  let scratches = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let equity = startingEquity;
  // The peak starts at the starting equity, not at zero: an account that has
  // never been above its opening balance has a drawdown measured from that
  // balance.
  let peak = startingEquity;
  let maxDrawdownPct = 0;
  let streak = 0;
  let maxLosingStreak = 0;
  const days = new Set<string>();

  for (const t of ordered) {
    if (t.result === 'WIN') wins++;
    else if (t.result === 'LOSS') losses++;
    else scratches++;

    if (t.realizedPnl > 0) grossProfit += t.realizedPnl;
    else grossLoss += Math.abs(t.realizedPnl);

    // A SCRATCH breaks a losing streak as surely as a win does — it is not a
    // loss, and counting it as one would make the streak criterion fire on a
    // strategy that was merely flat.
    if (t.result === 'LOSS') {
      streak++;
      if (streak > maxLosingStreak) maxLosingStreak = streak;
    } else {
      streak = 0;
    }

    equity += t.realizedPnl;
    if (equity > peak) peak = equity;
    if (peak > 0) {
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }

    days.add(dayKeyOf(t.exitAt));
  }

  const decided = wins + losses;

  return {
    trades: ordered.length,
    wins,
    losses,
    scratches,
    winRate: decided > 0 ? (wins / decided) * 100 : null,
    netPnl: ordered.reduce((sum, t) => sum + t.realizedPnl, 0),
    grossProfit,
    grossLoss,
    maxDrawdownPct: round2(maxDrawdownPct),
    maxLosingStreak,
    tradingDays: days.size,
    criticalErrors,
    firstTradeAt: ordered.length ? ordered[0].exitAt : null,
    lastTradeAt: ordered.length ? ordered[ordered.length - 1].exitAt : null,
  };
}

export interface CriterionResult {
  id: string;
  label: string;
  met: boolean;
  /** The bar, as a number. */
  required: number;
  /** What was measured. Null where nothing has been measured yet. */
  actual: number | null;
  /** A sentence carrying both, for the console's "why not yet" list. */
  detail: string;
}

export interface QualificationVerdict {
  passed: boolean;
  criteria: QualificationCriteria;
  metrics: QualificationMetrics;
  results: CriterionResult[];
  /** Only the unmet ones, in the order they are evaluated. */
  unmet: CriterionResult[];
}

/**
 * Compare the record to the bar.
 *
 * EVERY criterion is evaluated, not short-circuited at the first failure. §10's
 * example output lists what is still missing, and an operator who fixes the
 * first thing only to discover the second one exists has been told half the
 * truth. The list is the answer.
 */
export function evaluateQualification(
  metrics: QualificationMetrics,
  criteria: QualificationCriteria,
): QualificationVerdict {
  const results: CriterionResult[] = [];
  const push = (r: CriterionResult) => results.push(r);

  push({
    id: 'min-trades',
    label: 'Minimum closed trades',
    met: metrics.trades >= criteria.minTrades,
    required: criteria.minTrades,
    actual: metrics.trades,
    detail: `${metrics.trades} closed against a minimum of ${criteria.minTrades}.`,
  });

  push({
    id: 'min-trading-days',
    label: 'Minimum trading period',
    met: metrics.tradingDays >= criteria.minTradingDays,
    required: criteria.minTradingDays,
    actual: metrics.tradingDays,
    detail: `${metrics.tradingDays} trading day${metrics.tradingDays === 1 ? '' : 's'} against a minimum of ${criteria.minTradingDays}.`,
  });

  push({
    id: 'min-win-rate',
    label: 'Minimum win rate',
    // A null win rate is "not measured yet", which cannot meet a bar. Treating
    // it as 0 would be the same verdict for the wrong reason, and the detail
    // line has to say which.
    met: metrics.winRate != null && metrics.winRate >= criteria.minWinRate,
    required: criteria.minWinRate,
    actual: metrics.winRate == null ? null : round2(metrics.winRate),
    detail:
      metrics.winRate == null
        ? `No decided trade yet; a minimum of ${criteria.minWinRate}% is required.`
        : `${round2(metrics.winRate)}% against a minimum of ${criteria.minWinRate}%.`,
  });

  push({
    id: 'max-drawdown',
    label: 'Maximum drawdown',
    met: metrics.maxDrawdownPct <= criteria.maxDrawdownPct,
    required: criteria.maxDrawdownPct,
    actual: metrics.maxDrawdownPct,
    detail: `${metrics.maxDrawdownPct}% peak-to-trough against a ${criteria.maxDrawdownPct}% ceiling.`,
  });

  push({
    id: 'min-net-pnl',
    label: 'Minimum net P&L',
    met: metrics.netPnl >= criteria.minNetPnl,
    required: criteria.minNetPnl,
    actual: round2(metrics.netPnl),
    detail: `${formatInr(metrics.netPnl)} net against a floor of ${formatInr(criteria.minNetPnl)}.`,
  });

  push({
    id: 'max-losing-streak',
    label: 'Maximum losing streak',
    met: metrics.maxLosingStreak <= criteria.maxLosingStreak,
    required: criteria.maxLosingStreak,
    actual: metrics.maxLosingStreak,
    detail: `${metrics.maxLosingStreak} consecutive losses against a ceiling of ${criteria.maxLosingStreak}.`,
  });

  push({
    id: 'no-critical-errors',
    label: 'No critical execution errors',
    met: metrics.criticalErrors <= criteria.maxCriticalErrors,
    required: criteria.maxCriticalErrors,
    actual: metrics.criticalErrors,
    detail:
      metrics.criticalErrors === 0
        ? 'No execution failed after passing policy.'
        : `${metrics.criticalErrors} execution${metrics.criticalErrors === 1 ? '' : 's'} failed after passing policy; ${criteria.maxCriticalErrors} tolerated.`,
  });

  const unmet = results.filter((r) => !r.met);
  return { passed: unmet.length === 0, criteria, metrics, results, unmet };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatInr(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
}

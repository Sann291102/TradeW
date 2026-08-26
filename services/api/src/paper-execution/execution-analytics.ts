/**
 * The measurement layer over closed paper executions.
 *
 * ## What this is, and firmly is not
 *
 * This is the READ side — it turns recorded `ExecutionOutcome` rows into the
 * numbers an operator (and, later, a calibration pass) needs to ask "which
 * strategies, confidence ranges, strikes and regimes actually make money on
 * paper?". It is deliberately the FIRST phase of the outcome→intelligence
 * foundation: measurement and calibration, never self-modification. Nothing here
 * changes a Sentinel weight, a strike rule or a policy — it only counts what
 * already happened.
 *
 * ## Pure by construction
 *
 * Every function here takes rows and returns numbers. No database, no clock, no
 * Nest — the service half (`ExecutionAnalyticsService`) does the fetching and
 * the IST hour derivation, then hands normalized rows in. That split is what
 * lets expectancy, profit factor and drawdown be asserted directly against
 * hand-built rows rather than a seeded database.
 */

export interface AnalyticsOutcomeRow {
  /** Realized P&L net of charges, as the paper engine booked it. */
  realizedPnl: number;
  result: 'WIN' | 'LOSS' | 'SCRATCH';
  holdingSeconds: number | null;
  strategyId: string | null;
  strategyName: string | null;
  symbol: string;
  /** 'CE' | 'PE' — the option side that expressed the read. */
  side: string;
  /** Sentinel's confidence for the decision, 0–100. */
  confidence: number;
  /** Which of the three candidates was traded, when recorded. */
  strikeRole: 'ITM' | 'ATM' | 'OTM' | null;
  /** Market regime / profile at decision time, when recorded. */
  regime: string | null;
  /** How the position ended: TARGET | STOP | SQUARE_OFF | MANUAL | … */
  exitReason: string;
  /** IST hour-of-day (0–23) the position opened, for time-of-day performance. */
  entryHourIst: number | null;
  /** Exit instant (epoch ms), used only to order the drawdown walk. */
  exitAtMs: number | null;
}

export interface GroupPerformance {
  key: string;
  count: number;
  wins: number;
  losses: number;
  scratches: number;
  /** % over DECIDED trades (wins + losses); null when none has decided. */
  winRate: number | null;
  netPnl: number;
  avgPnl: number;
  /** Per-trade expectancy for this group — netPnl / count. */
  expectancy: number;
}

export interface AnalyticsSummary {
  count: number;
  wins: number;
  losses: number;
  scratches: number;
  winRate: number | null;
  netPnl: number;
  grossProfit: number;
  /** Negative or zero — the sum of losing trades. */
  grossLoss: number;
  avgWin: number | null;
  avgLoss: number | null;
  /** Per-trade expectancy — netPnl / count; null with no trades. */
  expectancy: number | null;
  /** grossProfit / |grossLoss|; null when there are no losses to divide by. */
  profitFactor: number | null;
  avgHoldingSeconds: number | null;
  largestWin: number;
  largestLoss: number;
  /**
   * Largest peak-to-trough decline in CUMULATIVE realized P&L, ordered by exit
   * time — reported as a non-negative magnitude. 0 when the equity curve only
   * ever rose (or there are no trades).
   */
  maxDrawdown: number;
}

export interface ExecutionAnalytics {
  summary: AnalyticsSummary;
  byStrategy: GroupPerformance[];
  byConfidenceBand: GroupPerformance[];
  byInstrument: GroupPerformance[];
  byStrikeRole: GroupPerformance[];
  byRegime: GroupPerformance[];
  byHourOfDay: GroupPerformance[];
  byExitReason: GroupPerformance[];
  bySide: GroupPerformance[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The confidence band a 0–100 score falls in. Below 70 should not occur
 *  (Sentinel's own floor), but is bucketed rather than dropped if it does. */
export function confidenceBand(confidence: number): string {
  if (confidence < 70) return 'below-70';
  if (confidence < 75) return '70-74';
  if (confidence < 80) return '75-79';
  if (confidence < 85) return '80-84';
  if (confidence < 90) return '85-89';
  return '90-100';
}

function groupBy(rows: AnalyticsOutcomeRow[], key: (r: AnalyticsOutcomeRow) => string | null): GroupPerformance[] {
  const buckets = new Map<string, AnalyticsOutcomeRow[]>();
  for (const row of rows) {
    const k = key(row);
    if (k == null) continue; // a row that cannot answer this dimension is skipped, not bucketed as "null"
    const list = buckets.get(k) ?? [];
    list.push(row);
    buckets.set(k, list);
  }
  return [...buckets.entries()]
    .map(([k, list]) => groupPerformance(k, list))
    .sort((a, b) => b.netPnl - a.netPnl);
}

function groupPerformance(key: string, rows: AnalyticsOutcomeRow[]): GroupPerformance {
  const wins = rows.filter((r) => r.result === 'WIN').length;
  const losses = rows.filter((r) => r.result === 'LOSS').length;
  const scratches = rows.filter((r) => r.result === 'SCRATCH').length;
  const decided = wins + losses;
  const netPnl = rows.reduce((s, r) => s + r.realizedPnl, 0);
  return {
    key,
    count: rows.length,
    wins,
    losses,
    scratches,
    winRate: decided > 0 ? Math.round((wins / decided) * 100) : null,
    netPnl: round2(netPnl),
    avgPnl: round2(netPnl / rows.length),
    expectancy: round2(netPnl / rows.length),
  };
}

/** The largest peak-to-trough decline in cumulative P&L, as a magnitude. */
function maxDrawdown(rows: AnalyticsOutcomeRow[]): number {
  const ordered = [...rows].sort((a, b) => (a.exitAtMs ?? 0) - (b.exitAtMs ?? 0));
  let cumulative = 0;
  let peak = 0;
  let worst = 0; // most-negative (cumulative - peak)
  for (const r of ordered) {
    cumulative += r.realizedPnl;
    if (cumulative > peak) peak = cumulative;
    const dip = cumulative - peak;
    if (dip < worst) worst = dip;
  }
  return round2(Math.abs(worst));
}

export function computeExecutionAnalytics(rows: AnalyticsOutcomeRow[]): ExecutionAnalytics {
  const wins = rows.filter((r) => r.result === 'WIN');
  const losses = rows.filter((r) => r.result === 'LOSS');
  const scratches = rows.filter((r) => r.result === 'SCRATCH');
  const decided = wins.length + losses.length;

  const grossProfit = wins.reduce((s, r) => s + r.realizedPnl, 0);
  const grossLoss = losses.reduce((s, r) => s + r.realizedPnl, 0); // <= 0
  const netPnl = rows.reduce((s, r) => s + r.realizedPnl, 0);
  const holdRows = rows.filter((r) => r.holdingSeconds != null);

  const summary: AnalyticsSummary = {
    count: rows.length,
    wins: wins.length,
    losses: losses.length,
    scratches: scratches.length,
    winRate: decided > 0 ? Math.round((wins.length / decided) * 100) : null,
    netPnl: round2(netPnl),
    grossProfit: round2(grossProfit),
    grossLoss: round2(grossLoss),
    avgWin: wins.length ? round2(grossProfit / wins.length) : null,
    avgLoss: losses.length ? round2(grossLoss / losses.length) : null,
    expectancy: rows.length ? round2(netPnl / rows.length) : null,
    // Null — not Infinity — when there are no losses: "profitable with no losing
    // trades" is a real state the console must render, and Infinity is not a
    // number a UI can format.
    profitFactor: grossLoss < 0 ? round2(grossProfit / Math.abs(grossLoss)) : null,
    avgHoldingSeconds: holdRows.length
      ? Math.round(holdRows.reduce((s, r) => s + (r.holdingSeconds ?? 0), 0) / holdRows.length)
      : null,
    largestWin: wins.length ? round2(Math.max(...wins.map((r) => r.realizedPnl))) : 0,
    largestLoss: losses.length ? round2(Math.min(...losses.map((r) => r.realizedPnl))) : 0,
    maxDrawdown: maxDrawdown(rows),
  };

  return {
    summary,
    byStrategy: groupBy(rows, (r) => r.strategyName ?? r.strategyId ?? 'auto (Sentinel chose)'),
    byConfidenceBand: groupBy(rows, (r) => confidenceBand(r.confidence)).sort((a, b) => a.key.localeCompare(b.key)),
    byInstrument: groupBy(rows, (r) => r.symbol),
    byStrikeRole: groupBy(rows, (r) => r.strikeRole),
    byRegime: groupBy(rows, (r) => r.regime),
    byHourOfDay: groupBy(rows, (r) => (r.entryHourIst != null ? String(r.entryHourIst).padStart(2, '0') + ':00 IST' : null)).sort(
      (a, b) => a.key.localeCompare(b.key),
    ),
    byExitReason: groupBy(rows, (r) => r.exitReason),
    bySide: groupBy(rows, (r) => r.side),
  };
}

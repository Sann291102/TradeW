/**
 * Backtest domain types.
 *
 * OBSERVATION / EDUCATION ONLY (ARCHITECTURE.md §3–4, CLAUDE.md Rule 2).
 * A backtest measures how a *user-defined* rule WOULD have behaved on historical
 * bars. It is retrospective analysis — it produces statistics, never a live
 * Buy/Sell/Entry/Target signal, and it is never wired into the order flow.
 * `BacktestTrade` is a record of a hypothetical past trade, not an instruction.
 */

/** One hypothetical trade produced by walking a rule over historical candles.
 *  `points` and `rMultiple` are NET of costs (config.costPct). */
export interface BacktestTrade {
  signalTime: Date; // close of the bar that triggered the setup
  entryTime: Date; // bar we assume the fill on (next bar's open — no look-ahead)
  entryPrice: number;
  stop: number;
  target: number;
  exitTime: Date;
  exitPrice: number;
  outcome: 'target' | 'stop' | 'timeout' | 'eod'; // 'eod' = forced out at the last bar before a session gap
  costPoints: number; // round-trip cost charged to this trade, in price points
  rMultiple: number; // net realized reward in units of initial risk (R)
  points: number; // net realized move in price points
  barsHeld: number;
}

/** Parameters of the EMA-cross scalp rule. Every field is a knob the user can tune. */
export interface EmaCrossConfig {
  emaPeriod: number; // the "EMA length 7"
  rewardRisk: number; // target = entry + rr * risk (1:2 -> 2, 1:3 -> 3)
  stopBufferPct: number; // stop = signalLow * (1 - buffer); 0 = exactly the signal low
  timeoutBars: number; // force-exit after N bars if neither level is hit
  cooldownBars: number; // bars to stay flat after a trade closes (models "consolidate, then re-enter")
  requireFreshCross: boolean; // true = only fire when the prior bar was at/below its EMA (a genuine cross, not mid-trend)
  // --- costs & fake-spike filters (all default to off/zero = the bare rule) ---
  costPct: number; // round-trip cost as % of entry (spread+slippage+brokerage). 0 = gross.
  trendEmaPeriod: number; // 0 = off; else only take longs when close > EMA(this) — a trend filter
  minBodyPct: number; // 0 = off; else require |close-open|/open >= this — rejects tiny "indecision" candles
  requireVolumeConfirm: boolean; // require signal-bar volume >= its trailing 20-bar average
}

export const DEFAULT_EMA_CROSS_CONFIG: EmaCrossConfig = {
  emaPeriod: 7,
  rewardRisk: 2,
  stopBufferPct: 0,
  timeoutBars: 24,
  cooldownBars: 0,
  requireFreshCross: false,
  costPct: 0,
  trendEmaPeriod: 0,
  minBodyPct: 0,
  requireVolumeConfirm: false,
};

/** Aggregate performance of one backtest run. */
export interface BacktestStats {
  symbol: string;
  interval: string; // display label — may be a derived timeframe like '3m' (resampled from 1m)
  barCount: number;
  from: Date;
  to: Date;
  trades: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRatePct: number;
  avgWinR: number;
  avgLossR: number;
  expectancyR: number; // average R per trade — the single most important number
  totalR: number;
  totalPoints: number;
  profitFactor: number; // gross win points / gross loss points (Infinity if no losses)
  maxConsecutiveLosses: number;
  maxDrawdownR: number;
}

export interface BacktestResult {
  stats: BacktestStats;
  trades: BacktestTrade[];
  config: EmaCrossConfig;
  dataSource: string; // which MarketDataProvider fed the bars (e.g. 'simulated', 'live-feed+db-candle+simulated')
}

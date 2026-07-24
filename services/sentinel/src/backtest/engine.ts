import type { Candle } from '@tradew/types';
import { ema } from '../intelligence/indicators';
import { isEmaCrossLong } from './ema-cross-strategy';
import type { BacktestResult, BacktestStats, BacktestTrade, EmaCrossConfig } from './types';

/**
 * Walk-forward backtest for the EMA-cross scalp rule.
 *
 * OBSERVATION / EDUCATION ONLY. This replays a rule over historical bars and
 * reports how it behaved. It places nothing and instructs nothing.
 *
 * Execution model (long-only, matching the described setup):
 *   - Trigger is evaluated at the *close* of the signal bar; optional fake-spike
 *     filters (trend / body / volume) must also pass.
 *   - Fill is at the *next bar's open* — you cannot trade the close you are still
 *     using to detect the signal, so this avoids look-ahead.
 *   - Stop = signalLow * (1 - stopBufferPct). Risk = entry - stop.
 *   - Target = entry + rewardRisk * risk.
 *   - Each subsequent bar is checked stop-first (the conservative assumption when
 *     one bar's range spans both levels).
 *   - Timeout exits at the close after `timeoutBars` bars.
 *   - Session-aware: a scalp is intraday, so a position is force-closed at the
 *     last bar before an overnight/weekend gap ('eod'), and a signal on the last
 *     bar of a session is skipped (no same-session next-bar fill). The session
 *     gap is inferred from the data (a jump > 4x the median bar spacing).
 *   - costPct is charged round-trip against every trade's realized points.
 */
export function runEmaCrossBacktest(
  symbol: string,
  interval: string,
  candles: Candle[],
  cfg: EmaCrossConfig,
  dataSource: string,
): BacktestResult {
  const closes = candles.map((c) => c.close);
  const emaSeries = ema(closes, cfg.emaPeriod);
  const trendSeries = cfg.trendEmaPeriod > 0 ? ema(closes, cfg.trendEmaPeriod) : null;
  const sessionGapMs = inferSessionGapMs(candles);
  const trades: BacktestTrade[] = [];

  // Don't arm until the slower of the two EMAs has enough history to be meaningful.
  const warmup = Math.max(cfg.emaPeriod, cfg.trendEmaPeriod, 1);

  let i = 1;
  while (i < candles.length - 1) {
    if (i < warmup) {
      i++;
      continue;
    }
    if (!isEmaCrossLong(candles, emaSeries, i, cfg) || !passesFilters(candles, emaSeries, trendSeries, i, cfg)) {
      i++;
      continue;
    }

    const signal = candles[i];
    const entryBarIdx = i + 1;
    const entryBar = candles[entryBarIdx];

    // Skip a signal on the last bar of a session — the "next bar" is a gapped
    // new session, not a fill we could realistically get.
    if (entryBar.timestamp.getTime() - signal.timestamp.getTime() > sessionGapMs) {
      i++;
      continue;
    }

    const entry = entryBar.open;
    const stop = signal.low * (1 - cfg.stopBufferPct);
    const risk = entry - stop;
    if (risk <= 0) {
      i++; // gap opened at/below the stop — setup invalid
      continue;
    }
    const target = entry + cfg.rewardRisk * risk;

    const trade = manageTrade(candles, entryBarIdx, signal.timestamp, entry, stop, target, risk, sessionGapMs, cfg);
    trades.push(trade);

    const exitIdx = candles.findIndex((c, idx) => idx >= entryBarIdx && c.timestamp === trade.exitTime);
    i = (exitIdx === -1 ? entryBarIdx : exitIdx) + 1 + cfg.cooldownBars;
  }

  return { stats: summarize(symbol, interval, candles, trades), trades, config: cfg, dataSource };
}

/** The median bar spacing tells us the normal step; a gap > 4x that is a session break. */
function inferSessionGapMs(candles: Candle[]): number {
  if (candles.length < 3) return Number.POSITIVE_INFINITY;
  const diffs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    diffs.push(candles[i].timestamp.getTime() - candles[i - 1].timestamp.getTime());
  }
  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)] || 60_000;
  return median * 4;
}

/** Optional fake-spike filters. All default off, so the bare rule is unchanged. */
function passesFilters(
  candles: Candle[],
  emaSeries: number[],
  trendSeries: number[] | null,
  i: number,
  cfg: EmaCrossConfig,
): boolean {
  const c = candles[i];

  if (trendSeries && c.close <= trendSeries[i]) return false; // only long with the higher-timeframe trend

  if (cfg.minBodyPct > 0) {
    const bodyPct = Math.abs(c.close - c.open) / c.open;
    if (bodyPct < cfg.minBodyPct) return false; // reject indecision candles
  }

  if (cfg.requireVolumeConfirm) {
    const win = candles.slice(Math.max(0, i - 20), i);
    const avg = win.length ? win.reduce((s, x) => s + x.volume, 0) / win.length : 0;
    if (avg > 0 && c.volume < avg) return false; // need participation behind the move
  }

  return true;
}

function manageTrade(
  candles: Candle[],
  entryBarIdx: number,
  signalTime: Date,
  entry: number,
  stop: number,
  target: number,
  risk: number,
  sessionGapMs: number,
  cfg: EmaCrossConfig,
): BacktestTrade {
  const entryBar = candles[entryBarIdx];
  const lastManageable = Math.min(candles.length - 1, entryBarIdx + cfg.timeoutBars);

  for (let j = entryBarIdx; j <= lastManageable; j++) {
    // Force-exit at the previous bar's close if this bar is across a session gap.
    if (j > entryBarIdx && candles[j].timestamp.getTime() - candles[j - 1].timestamp.getTime() > sessionGapMs) {
      const eod = candles[j - 1];
      return close(signalTime, entryBar, entry, stop, target, eod, eod.close, 'eod', risk, j - 1 - entryBarIdx, cfg);
    }
    const bar = candles[j];
    if (bar.low <= stop) {
      return close(signalTime, entryBar, entry, stop, target, bar, stop, 'stop', risk, j - entryBarIdx, cfg);
    }
    if (bar.high >= target) {
      return close(signalTime, entryBar, entry, stop, target, bar, target, 'target', risk, j - entryBarIdx, cfg);
    }
  }
  const exitBar = candles[lastManageable];
  return close(signalTime, entryBar, entry, stop, target, exitBar, exitBar.close, 'timeout', risk, lastManageable - entryBarIdx, cfg);
}

function close(
  signalTime: Date,
  entryBar: Candle,
  entry: number,
  stop: number,
  target: number,
  exitBar: Candle,
  exitPrice: number,
  outcome: BacktestTrade['outcome'],
  risk: number,
  barsHeld: number,
  cfg: EmaCrossConfig,
): BacktestTrade {
  const costPoints = entry * cfg.costPct; // round-trip cost
  const points = exitPrice - entry - costPoints;
  return {
    signalTime,
    entryTime: entryBar.timestamp,
    entryPrice: entry,
    stop,
    target,
    exitTime: exitBar.timestamp,
    exitPrice,
    outcome,
    costPoints,
    rMultiple: points / risk,
    points,
    barsHeld,
  };
}

function summarize(symbol: string, interval: string, candles: Candle[], trades: BacktestTrade[]): BacktestStats {
  const wins = trades.filter((t) => t.rMultiple > 0);
  const losses = trades.filter((t) => t.rMultiple < 0);
  const timeouts = trades.filter((t) => t.outcome === 'timeout' || t.outcome === 'eod');

  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const grossWinPts = sum(wins.map((t) => t.points));
  const grossLossPts = Math.abs(sum(losses.map((t) => t.points)));

  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  let run = 0;
  let maxRun = 0;
  for (const t of trades) {
    equity += t.rMultiple;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    if (t.rMultiple < 0) {
      run++;
      maxRun = Math.max(maxRun, run);
    } else {
      run = 0;
    }
  }

  const n = trades.length;
  return {
    symbol,
    interval,
    barCount: candles.length,
    from: candles[0]?.timestamp ?? new Date(0),
    to: candles[candles.length - 1]?.timestamp ?? new Date(0),
    trades: n,
    wins: wins.length,
    losses: losses.length,
    timeouts: timeouts.length,
    winRatePct: n ? (wins.length / n) * 100 : 0,
    avgWinR: wins.length ? sum(wins.map((t) => t.rMultiple)) / wins.length : 0,
    avgLossR: losses.length ? sum(losses.map((t) => t.rMultiple)) / losses.length : 0,
    expectancyR: n ? sum(trades.map((t) => t.rMultiple)) / n : 0,
    totalR: sum(trades.map((t) => t.rMultiple)),
    totalPoints: sum(trades.map((t) => t.points)),
    profitFactor: grossLossPts === 0 ? Infinity : grossWinPts / grossLossPts,
    maxConsecutiveLosses: maxRun,
    maxDrawdownR: maxDd,
  };
}

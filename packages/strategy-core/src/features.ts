/**
 * The Feature/Context Builder — bars in, `MarketSnapshot` out.
 *
 *     Market Data  →  [ Feature Core ]  →  Setup Engine  →  Level Deriver
 *
 * MOVED here verbatim from `services/sentinel/src/intelligence/
 * market-intelligence.service.ts`. Sentinel re-exports every symbol below, so
 * nothing that imported them had to change and its behaviour is unchanged.
 *
 * ## Why it had to leave Sentinel
 *
 * The autonomous engine must decide with Sentinel switched off. Everything
 * downstream of this file was already portable — the rules, the setups, the
 * level deriver — but they all read a `MarketSnapshot`, and the only code that
 * could BUILD one lived inside a Nest service in another process. That single
 * dependency would have made "Sentinel is optional" false in practice while
 * looking true in the architecture diagram.
 *
 * ## What it does and does not know
 *
 * It is pure: candles and two external scalars in, computed indicators and a
 * regime classification out. It performs no I/O, so it does not know whether
 * its bars came from Dhan's bridge, Binance's REST API or a backtest replay —
 * which is exactly what lets one snapshot shape serve all three.
 *
 * The option chain is an INPUT (`external.optionChain`), never something this
 * file fetches. A venue that has no options passes null and every rule that
 * reads the chain simply declines, rather than the builder needing to know
 * which markets have one.
 */

import type { Candle, CandleInterval, OptionChainEntry } from '@tradew/types';
import {
  averageVolume,
  cpr,
  ema,
  macd,
  oiTrend,
  realizedVolatilityPct,
  rsi,
  swingLevels,
  vwap,
} from './indicators';
import type {
  MarketProfile,
  MarketProfileType,
  MarketSnapshot,
  OptionChainRead,
  TrendAnalysis,
} from './snapshot';


/**
 * The bars every Sentinel observation is computed on.
 *
 * Named because it is now read in two places — the underlying snapshot and the
 * CE/PE legs beside it — and because the workspace captions its charts with
 * it. It had been an inline `'15m'` while the browser drew a 5m index and 1m
 * contracts, so the user and the engine were looking at different bars with
 * nothing on screen saying so. One constant, exported, is what keeps the chart
 * and the verdict describing the same market.
 */
export const SNAPSHOT_INTERVAL: CandleInterval = '15m';

/** How far back a snapshot reaches. Enough bars for a 50-period EMA at 15m. */
export const SNAPSHOT_LOOKBACK_MS = 5 * 86_400_000;

/**
 * How much market time one bar of each interval covers.
 *
 * Needed because a candle carries only its OPEN timestamp (Dhan's intraday
 * chart API, and therefore the whole bridge, timestamps bars at their start —
 * see `computeOpeningRange`, whose 30-minute window works only under that
 * reading). A bar that opened at T is finished once the clock passes
 * `T + INTERVAL_MS[interval]`, and not before.
 */
export const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '1d': 86_400_000,
};

/**
 * Split a bar series into the bars that have FINISHED and the one still forming.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * The market-data bridge returns the in-progress bar as the final element
 * during market hours. A partially-formed 15m bar has a smaller range and a
 * lower volume than the finished bar will have, so any rule that measures the
 * newest bar — `displacement_bar` against the previous five ranges,
 * `volume_supports_move` against the 20-bar average, `rejection_bar`'s
 * wick-to-body, `detectSweep`'s 20-bar extreme — systematically under-fires in
 * the first minutes of a bar and can flip from true to false as the same bar
 * fills in. The agent's read then depends on where in the 15-minute window the
 * 30-second evaluation tick happened to land, which is not a market fact.
 *
 * `services/sentinel-py/app/watch/evaluator.py` has answered this since it was
 * written (`closed_candles`, "confirmation before notification"). This is the
 * same rule for the TypeScript agent path.
 *
 * ── WHY IT IS NOT AN UNCONDITIONAL `slice(0, -1)` ─────────────────────────
 * The Python version slices unconditionally because its poller only ever runs
 * live. That assumption does not hold here: `composeSnapshot` is also the
 * Module 12 backtest replay's entry point, and `snapshot()` is polled out of
 * hours and against stored history. In both of those the trailing bar is a
 * real, closed bar, and dropping it would silently throw away the most recent
 * thing the market did. So the test is against the clock, not against the
 * position in the array.
 */
export function splitClosedAndForming(
  candles: Candle[],
  interval: CandleInterval = SNAPSHOT_INTERVAL,
  now: Date = new Date(),
): { closed: Candle[]; forming: Candle | null } {
  const last = candles[candles.length - 1];
  if (!last) return { closed: candles, forming: null };

  // Same normalisation as `latestBarAt`: declared a Date, but the provider
  // chain includes JSON hops where it arrives as an ISO string or epoch ms.
  const openedAt = last.timestamp instanceof Date ? last.timestamp : new Date(last.timestamp);
  const openedMs = openedAt.getTime();
  if (Number.isNaN(openedMs)) return { closed: candles, forming: null };

  // Strictly before its own close: at exactly `open + interval` the bar is
  // done. An unparseable interval would be `undefined` here and make every
  // comparison false, which is the safe direction — keep the bar.
  const stillForming = now.getTime() < openedMs + INTERVAL_MS[interval];
  return stillForming
    ? { closed: candles.slice(0, -1), forming: last }
    : { closed: candles, forming: null };
}

/**
 * Everything a snapshot can be derived from the bars alone. The live
 * `snapshot()` above and the Module 12 backtest replay both call this, so a
 * strategy is replayed against exactly the structure it was detected on —
 * there is no second, drifting copy of the indicator wiring.
 *
 * ── THE FORMING BAR IS DROPPED HERE, ONCE ─────────────────────────────────
 * `candles` arrives from the bridge with the in-progress bar on the end during
 * market hours. It comes off here rather than in each of the dozen rules that
 * read the newest bar, because a per-rule fix is a fix that the next rule
 * forgets. Everything below this line — indicators, swing levels, the session
 * slice, the profile, the trend read, and therefore every rule, signal and
 * agent that consumes them — sees only finished bars.
 *
 * `lastPrice` is the deliberate exception; see its doc on `MarketSnapshot`.
 */
export function composeSnapshot(
  symbol: string,
  rawCandles: Candle[],
  priorDay: Candle | null,
  external: {
    vix: number | null;
    breadthRatio: number | null;
    optionChain: OptionChainRead | null;
  },
  /**
   * How to tell whether the trailing bar is still forming. Defaults match the
   * live path; the backtest replay leaves them alone because its `now` is the
   * real clock, long past every bar it replays, so nothing is dropped.
   */
  clock: { interval?: CandleInterval; now?: Date } = {},
): MarketSnapshot {
  const { closed: candles, forming } = splitClosedAndForming(
    rawCandles,
    clock.interval ?? SNAPSHOT_INTERVAL,
    clock.now ?? new Date(),
  );

  const closes = candles.map((c) => c.close);
  const last = candles[candles.length - 1];
  const ema20Series = ema(closes, 20);
  const ema50Series = ema(closes, 50);
  const levels = swingLevels(candles);
  const sessionCandles = sessionSlice(candles);
  const trendAnalysis = analyseTrend(sessionCandles, candles);

  return {
    symbol,
    // The live price, from the forming bar when there is one — the ONE thing
    // here that reads it, and only because a spot that lagged a full bar would
    // pick a stale strike and price a stale contract.
    lastPrice: forming?.close ?? last?.close ?? 0,
    rsi14: rsi(closes),
    ema20: ema20Series[ema20Series.length - 1] ?? null,
    ema50: ema50Series[ema50Series.length - 1] ?? null,
    vwap: vwap(candles.slice(-26)),
    macdHistogram: macd(closes)?.histogram ?? null,
    cpr: priorDay ? cpr(priorDay) : null,
    volumeVsAvg: last ? last.volume / Math.max(1, averageVolume(candles)) : null,
    oiTrend: oiTrend(candles),
    realizedVolPct: realizedVolatilityPct(closes),
    vix: external.vix,
    breadthRatio: external.breadthRatio,
    support: levels?.support ?? null,
    resistance: levels?.resistance ?? null,
    candles,
    sessionCandles,
    formingCandle: forming,
    priorDay,
    marketProfile: classifyProfile(sessionCandles, priorDay, trendAnalysis),
    trendAnalysis,
    openingRange: computeOpeningRange(sessionCandles),
    optionChain: external.optionChain,
  };
}

/** Bars belonging to the most recent calendar day present in `candles`. */
export function sessionSlice(candles: Candle[]): Candle[] {
  const last = candles[candles.length - 1];
  if (!last) return [];
  const day = last.timestamp.toDateString();
  return candles.filter((c) => c.timestamp.toDateString() === day);
}

/** Opening range from the first 30 minutes of the session. */
export function computeOpeningRange(
  sessionCandles: Candle[],
): { high: number; low: number; establishedAt: Date } | null {
  if (sessionCandles.length === 0) return null;
  const start = sessionCandles[0].timestamp.getTime();
  const window = sessionCandles.filter((c) => c.timestamp.getTime() - start < 30 * 60_000);
  if (window.length === 0) return null;
  return {
    high: Math.max(...window.map((c) => c.high)),
    low: Math.min(...window.map((c) => c.low)),
    establishedAt: window[window.length - 1].timestamp,
  };
}

/**
 * Put-Call Ratio, max pain and the nearest OI walls, from the front expiry.
 * Max pain is the strike at which option writers' aggregate payout is
 * smallest — the classic pin level. Returns null when there is no chain.
 */
export function readOptionChain(chain: OptionChainEntry[], spot: number): OptionChainRead | null {
  if (chain.length === 0) return null;

  // Front expiry only — mixing expiries makes both PCR and max pain meaningless.
  const frontExpiry = chain.reduce(
    (earliest, e) => (e.expiry.getTime() < earliest.getTime() ? e.expiry : earliest),
    chain[0].expiry,
  );
  const strikes = chain
    .filter((e) => e.expiry.getTime() === frontExpiry.getTime())
    .sort((a, b) => a.strike - b.strike);
  if (strikes.length === 0) return null;

  const totalCallOI = strikes.reduce((s, e) => s + e.callOI, 0);
  const totalPutOI = strikes.reduce((s, e) => s + e.putOI, 0);
  if (totalCallOI <= 0) return null;

  let maxPain = strikes[0].strike;
  let minLoss = Number.POSITIVE_INFINITY;
  for (const candidate of strikes) {
    const loss = strikes.reduce(
      (sum, e) =>
        sum +
        e.callOI * Math.max(0, candidate.strike - e.strike) +
        e.putOI * Math.max(0, e.strike - candidate.strike),
      0,
    );
    if (loss < minLoss) {
      minLoss = loss;
      maxPain = candidate.strike;
    }
  }

  const above = strikes.filter((e) => e.strike >= spot);
  const below = strikes.filter((e) => e.strike <= spot);
  const callOIWall = above.length
    ? above.reduce((a, b) => (b.callOI > a.callOI ? b : a)).strike
    : null;
  const putOIWall = below.length ? below.reduce((a, b) => (b.putOI > a.putOI ? b : a)).strike : null;

  return {
    pcr: totalPutOI / totalCallOI,
    maxPain,
    callOIWall,
    putOIWall,
    strikesAnalysed: strikes.length,
    frontExpiry,
    entries: strikes,
  };
}

export function analyseTrend(sessionCandles: Candle[], allCandles: Candle[]): TrendAnalysis | null {
  if (sessionCandles.length < 2) return null;
  const open = sessionCandles[0].open;
  const close = sessionCandles[sessionCandles.length - 1].close;
  const sessionChangePct = open !== 0 ? ((close - open) / open) * 100 : 0;

  // Momentum: the session's net directional travel as a fraction of its total
  // absolute travel — 1 = perfectly one-directional, 0 = pure chop.
  let net = 0;
  let gross = 0;
  for (let i = 1; i < sessionCandles.length; i++) {
    const step = sessionCandles[i].close - sessionCandles[i - 1].close;
    net += step;
    gross += Math.abs(step);
  }
  const momentumScore = gross > 0 ? Math.abs(net) / gross : 0;

  const avgVol = averageVolume(allCandles);
  const lastVol = sessionCandles[sessionCandles.length - 1].volume;

  return {
    sessionChangePct,
    momentumScore,
    volumeStrength: avgVol > 0 ? lastVol / avgVol : 1,
    direction: sessionChangePct > 0.15 ? 'bullish' : sessionChangePct < -0.15 ? 'bearish' : 'neutral',
  };
}

const PROFILE_META: Record<
  MarketProfileType,
  Pick<MarketProfile, 'description' | 'trend' | 'volatility' | 'structure'>
> = {
  'Bullish Trend Day': {
    description: 'Sustained directional advance with the close holding near the session high',
    trend: 'bullish',
    volatility: 'normal',
    structure: 'trending',
  },
  'Bearish Trend Day': {
    description: 'Sustained directional decline with the close holding near the session low',
    trend: 'bearish',
    volatility: 'normal',
    structure: 'trending',
  },
  'High Volatility Range': {
    description: 'Wide two-sided swings with no net directional resolution',
    trend: 'choppy',
    volatility: 'high',
    structure: 'ranging',
  },
  'Low Volatility Compression': {
    description: 'Range materially narrower than the prior session — energy coiling',
    trend: 'neutral',
    volatility: 'low',
    structure: 'consolidating',
  },
  'Gap & Go': {
    description: 'Opened away from the prior close and extended in the gap direction',
    trend: 'neutral',
    volatility: 'high',
    structure: 'breaking-out',
  },
  'Gap Fill / Mean Reversion': {
    description: 'Opened away from the prior close and traded back through it',
    trend: 'neutral',
    volatility: 'normal',
    structure: 'ranging',
  },
  'Inside Day': {
    description: "Entire session range contained inside the prior session's range",
    trend: 'neutral',
    volatility: 'low',
    structure: 'consolidating',
  },
  'Outside Day / Expansion': {
    description: "Session traded beyond both sides of the prior session's range",
    trend: 'choppy',
    volatility: 'high',
    structure: 'breaking-out',
  },
  'Rally Continuation': {
    description: 'Constructive drift higher without the conviction of a full trend day',
    trend: 'bullish',
    volatility: 'normal',
    structure: 'trending',
  },
  'Descent Continuation': {
    description: 'Constructive drift lower without the conviction of a full trend day',
    trend: 'bearish',
    volatility: 'normal',
    structure: 'trending',
  },
};

/**
 * Classify the session into one of the ten Master Plan market profiles.
 * First match wins; the ordering encodes specificity — structural containment
 * beats gap behaviour, which beats trend strength, which beats residual
 * range character.
 */
export function classifyProfile(
  sessionCandles: Candle[],
  priorDay: Candle | null,
  trend: TrendAnalysis | null,
): MarketProfile | null {
  if (sessionCandles.length < 2 || !trend) return null;

  const open = sessionCandles[0].open;
  const close = sessionCandles[sessionCandles.length - 1].close;
  const high = Math.max(...sessionCandles.map((c) => c.high));
  const low = Math.min(...sessionCandles.map((c) => c.low));
  const range = high - low;
  const rangePct = open !== 0 ? (range / open) * 100 : 0;
  const closePosition = range > 0 ? (close - low) / range : 0.5;
  const changePct = trend.sessionChangePct;

  const evidence: string[] = [
    `Session range ${low.toFixed(1)}–${high.toFixed(1)} (${rangePct.toFixed(2)}%), change ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`,
    `Close sits at ${(closePosition * 100).toFixed(0)}% of the session range`,
    `Directional persistence ${(trend.momentumScore * 100).toFixed(0)}%`,
  ];

  const build = (type: MarketProfileType, extra: string[] = []): MarketProfile => ({
    type,
    ...PROFILE_META[type],
    evidence: [...evidence, ...extra],
  });

  if (priorDay) {
    const priorRange = priorDay.high - priorDay.low;
    const gapPct = priorDay.close !== 0 ? ((open - priorDay.close) / priorDay.close) * 100 : 0;

    if (high <= priorDay.high && low >= priorDay.low) {
      return build('Inside Day', [
        `Contained inside the prior session's ${priorDay.low.toFixed(1)}–${priorDay.high.toFixed(1)} range`,
      ]);
    }
    if (high > priorDay.high && low < priorDay.low) {
      return build('Outside Day / Expansion', [
        `Traded beyond both sides of the prior session's ${priorDay.low.toFixed(1)}–${priorDay.high.toFixed(1)} range`,
      ]);
    }
    if (Math.abs(gapPct) >= 0.3) {
      const filled = low <= priorDay.close && high >= priorDay.close;
      const extended = Math.sign(changePct) === Math.sign(gapPct) && Math.abs(changePct) >= 0.2;
      if (filled && !extended) {
        return build('Gap Fill / Mean Reversion', [
          `Opened ${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(2)}% from the prior close and traded back through ${priorDay.close.toFixed(1)}`,
        ]);
      }
      if (extended && trend.volumeStrength >= 1) {
        return build('Gap & Go', [
          `Opened ${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(2)}% from the prior close and extended in the same direction on ${trend.volumeStrength.toFixed(1)}x average volume`,
        ]);
      }
    }
    if (priorRange > 0 && range < priorRange * 0.6) {
      return build('Low Volatility Compression', [
        `Range is ${((range / priorRange) * 100).toFixed(0)}% of the prior session's`,
      ]);
    }
    if (priorRange > 0 && range > priorRange * 1.2 && Math.abs(changePct) < 0.4) {
      return build('High Volatility Range', [
        `Range is ${((range / priorRange) * 100).toFixed(0)}% of the prior session's with no net resolution`,
      ]);
    }
  }

  if (changePct >= 0.5 && closePosition >= 0.7 && trend.momentumScore >= 0.4) {
    return build('Bullish Trend Day');
  }
  if (changePct <= -0.5 && closePosition <= 0.3 && trend.momentumScore >= 0.4) {
    return build('Bearish Trend Day');
  }
  if (changePct > 0.15) return build('Rally Continuation');
  if (changePct < -0.15) return build('Descent Continuation');
  return build('High Volatility Range');
}

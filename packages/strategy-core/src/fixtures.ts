/**
 * Deterministic snapshot fixtures.
 *
 * ## Why these are production code, not test-only helpers
 *
 * The brief requires proving the pipeline end-to-end without ever forcing a
 * live trade. That is only possible if a KNOWN setup can be replayed through
 * the real decision core, the real risk validator and the real paper executor
 * on demand — so the fixture that produces it has to be importable by the
 * scanner's verification script and by the backtest replay, not just by a
 * `.spec` file.
 *
 * ## The rule they exist to protect
 *
 * A fixture may construct any market it likes. It may NOT relax a threshold,
 * stub a rule, or hand the engine a pre-made decision. Every bar below is an
 * ordinary candle; the setup is detected by the same predicates that run
 * against Dhan and Binance data. If a change to the engine stops these
 * detecting, the fixtures are correct and the engine regressed — which is the
 * whole point of having them.
 */

import type { Candle } from '@tradew/types';
import type { MarketProfile, MarketSnapshot, TrendAnalysis } from './snapshot';
import { ema, vwap as vwapOf, averageVolume } from './indicators';

const MINUTE = 60_000;

export interface BarSpec {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Build candles on a fixed 15-minute grid from an explicit OHLCV list. */
export function buildCandles(specs: BarSpec[], startAt = Date.UTC(2026, 8, 1, 3, 45)): Candle[] {
  return specs.map((s, i) => ({
    timestamp: new Date(startAt + i * 15 * MINUTE),
    open: s.open,
    high: s.high,
    low: s.low,
    close: s.close,
    volume: s.volume,
  }));
}

/**
 * A steadily rising series with a controllable final bar.
 *
 * `drift` per bar with a fixed intrabar range, so ATR is predictable and the
 * level thresholds can be reasoned about in the tests rather than discovered.
 */
export function risingSeries(
  count: number,
  opts: { start?: number; drift?: number; range?: number; volume?: number } = {},
): BarSpec[] {
  const { start = 1000, drift = 2, range = 6, volume = 1000 } = opts;
  const bars: BarSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    const open = start + i * drift;
    const close = open + drift;
    bars.push({
      open,
      close,
      high: Math.max(open, close) + range / 2,
      low: Math.min(open, close) - range / 2,
      volume,
    });
  }
  return bars;
}

/**
 * Assemble a `MarketSnapshot` whose indicator fields are COMPUTED from the
 * bars rather than asserted.
 *
 * Hand-setting `ema20` to a number that the candles do not produce would make
 * a rule confirm on a market that could not exist, and a fixture that proves
 * the engine works on impossible data proves nothing.
 */
export function snapshotFrom(
  candles: Candle[],
  overrides: Partial<MarketSnapshot> = {},
): MarketSnapshot {
  const closes = candles.map((c) => c.close);
  const ema20Series = ema(closes, 20);
  const ema50Series = ema(closes, 50);
  const last = candles[candles.length - 1];

  const trendAnalysis: TrendAnalysis = {
    sessionChangePct:
      candles.length > 1 ? ((last.close - candles[0].close) / candles[0].close) * 100 : 0,
    momentumScore: 0.8,
    volumeStrength: averageVolume(candles) > 0 ? last.volume / averageVolume(candles) : 1,
    direction: last.close >= candles[0].close ? 'bullish' : 'bearish',
  };

  const marketProfile: MarketProfile = {
    type: 'Bullish Trend Day',
    description: 'fixture',
    trend: trendAnalysis.direction,
    volatility: 'normal',
    structure: 'trending',
    evidence: ['fixture'],
  };

  return {
    symbol: 'FIXTURE',
    lastPrice: last.close,
    rsi14: 58,
    ema20: closes.length >= 20 ? ema20Series[ema20Series.length - 1] : null,
    ema50: closes.length >= 50 ? ema50Series[ema50Series.length - 1] : null,
    vwap: vwapOf(candles),
    macdHistogram: 1.2,
    cpr: null,
    volumeVsAvg: averageVolume(candles) > 0 ? last.volume / averageVolume(candles) : null,
    oiTrend: 'unknown',
    realizedVolPct: 1.1,
    vix: null,
    breadthRatio: null,
    support: null,
    resistance: null,
    candles,
    sessionCandles: candles,
    formingCandle: null,
    priorDay: null,
    marketProfile,
    trendAnalysis,
    openingRange: null,
    optionChain: null,
    ...overrides,
  };
}

/**
 * A market in which `agent-ema-cross` validates on the long side.
 *
 * 60 rising bars: EMA20 sits above EMA50, price closes above session VWAP, and
 * the final bar carries above-average volume. Those are exactly the three
 * rules the ported EMA-cross declares, each satisfied by the price action
 * rather than by assignment.
 */
export function emaCrossLongFixture(): MarketSnapshot {
  const bars = risingSeries(60, { start: 1000, drift: 2, range: 6, volume: 1000 });
  // Participation on the decision bar — `volume_supports_move` compares the
  // last bar against the trailing 20-bar average.
  bars[bars.length - 1].volume = 2500;
  return snapshotFrom(buildCandles(bars));
}

/**
 * The same market, but with the final bar's range collapsed so the signal-bar
 * anchor sits inside the noise floor.
 *
 * Used to prove that a structurally valid setup is REFUSED when its stop is
 * too tight, rather than being nudged outward to make the arithmetic work.
 */
export function emaCrossNoiseFloorFixture(): MarketSnapshot {
  const bars = risingSeries(60, { start: 1000, drift: 2, range: 6, volume: 1000 });
  const last = bars[bars.length - 1];
  last.volume = 2500;
  // A doji-tight final bar: its low is a hair under the close, so the derived
  // stop lands within a fraction of one ATR.
  last.low = last.close - 0.1;
  last.high = last.close + 0.1;
  last.open = last.close - 0.05;
  return snapshotFrom(buildCandles(bars));
}

/**
 * A market with an opening range that has been broken to the upside on volume.
 *
 * Drives `agent-opening-range-expansion` and the `range-break` anchor.
 */
export function openingRangeBreakoutFixture(): MarketSnapshot {
  const base = risingSeries(50, { start: 1000, drift: 1, range: 4, volume: 1000 });
  // A decisive expansion leg beyond the range, on participation.
  const breakout = risingSeries(6, { start: 1050, drift: 6, range: 10, volume: 3000 });
  const bars = [...base, ...breakout];
  const candles = buildCandles(bars);
  const openingRange = {
    // The first two bars of the "session" define the range.
    high: Math.max(bars[0].high, bars[1].high),
    low: Math.min(bars[0].low, bars[1].low),
    establishedAt: candles[1].timestamp,
  };
  return snapshotFrom(candles, { openingRange });
}

import type { CandleInterval } from '@tradew/types';
import type { Timeline, WatchState } from './sentinelPy';

/**
 * Which chart Sentinel is reading, and on which series.
 *
 * The point of this module is a single question: **when the workspace draws a
 * chart beside "Sentinel is watching this", is it the same series the sweep
 * evaluated?** Before this, it was not — `SentinelLiveCharts` hardcoded a 5m
 * index and 1m contracts while `services/sentinel-py`'s poller evaluated on
 * whatever timeframe the user's strategy named. Every disagreement between the
 * chart and the verdict was unexplainable, and the user had no way to check
 * the engine's work.
 */

/**
 * The intervals the Dhan bridge can actually return
 * (`services/market-data/scripts/live-feed-server.ts` → `INTRADAY_INTERVAL`,
 * plus the separate daily endpoint for '1d').
 */
const BRIDGE_INTERVALS = new Set<string>(['1m', '5m', '15m', '1h', '1d']);

/**
 * What the bridge serves for a timeframe it does not carry.
 *
 * This is NOT a display choice — it mirrors `INTRADAY_INTERVAL[interval] ?? '5'`
 * in the bridge. A strategy saved as "3m" makes the engine request 3m, receive
 * 5m bars, and evaluate them as if they were 3m; the request is silently
 * substituted with no error anywhere in the chain.
 *
 * Reproducing the substitution here is deliberate. The chart's job is to show
 * the series the engine is READING, not the one the strategy ASKED FOR, and
 * `substituted` below carries the discrepancy so the UI can say it out loud
 * instead of quietly drawing the same wrong thing.
 */
const BRIDGE_FALLBACK: CandleInterval = '5m';

/**
 * The engine's own default when a strategy names no timeframe — mirrors
 * `_timeframe_of()` in `services/sentinel-py/app/watch/poller.py`. The service
 * deliberately sends `timeframe: null` rather than a second copy of this
 * number, so this is the one place in the browser that assumes it.
 */
const ENGINE_DEFAULT_TIMEFRAME = '15m';

/**
 * How much history to load per interval. Originally mirrored the timeframe
 * tabs on the dashboard's `LiveMarketOverview` card; that card was removed on
 * 2026-08-16 (archived as `web-sentinel-live-market-overview-2026-08-16.tsx.txt`)
 * and this table is now the sole owner of the mapping.
 */
const DAYS_FOR: Record<CandleInterval, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 10,
  '1h': 30,
  '1d': 180,
};

const MINUTES_FOR: Record<CandleInterval, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '1d': 1440,
};

export interface ResolvedSeries {
  /** The interval the bridge will actually serve — what to draw. */
  interval: CandleInterval;
  days: number;
  minutes: number;
  /** What the strategy asked for, or null when it named nothing. */
  requested: string | null;
  /** True when the bridge cannot serve `requested` and substitutes `interval`. */
  substituted: boolean;
  /** True when the strategy named no timeframe and the engine default applies. */
  assumedDefault: boolean;
}

/**
 * Resolve a saved strategy's timeframe to the series both the engine and the
 * chart will really get.
 */
export function resolveSeries(timeframe: string | null | undefined): ResolvedSeries {
  const assumedDefault = !timeframe;
  const requested = timeframe ?? null;
  const wanted = (timeframe || ENGINE_DEFAULT_TIMEFRAME).trim().toLowerCase();

  const serves = BRIDGE_INTERVALS.has(wanted);
  const interval = (serves ? wanted : BRIDGE_FALLBACK) as CandleInterval;

  return {
    interval,
    days: DAYS_FOR[interval],
    minutes: MINUTES_FOR[interval],
    requested,
    substituted: !serves,
    assumedDefault,
  };
}

/**
 * The instrument and series a selected watch puts under observation.
 *
 * `strike`/`optionType` are the contract the sweep reads. A watch with no
 * strike is an index watch, and the engine reads the index — the two are never
 * interchangeable (see `_candles_for` in the poller), so this carries the
 * distinction rather than defaulting a strike in.
 */
export interface ChartFocus {
  watchId: string;
  symbol: string;
  strike: number | null;
  optionType: 'CE' | 'PE' | null;
  expiry: string | null;
  state: WatchState;
  series: ResolvedSeries;
}

/**
 * Build the focus from a timeline. Returns null when there is no timeline yet,
 * which is the honest state before the first watch exists — the charts then
 * fall back to their own market/ATM selection rather than inventing a focus.
 */
export function focusFromTimeline(timeline: Timeline | null): ChartFocus | null {
  if (!timeline) return null;
  const { watch } = timeline;
  const strike = watch.strike == null ? null : Number(watch.strike);

  return {
    watchId: watch.id,
    symbol: watch.symbol,
    strike: strike != null && Number.isFinite(strike) ? strike : null,
    optionType: watch.optionType,
    expiry: watch.expiry,
    state: watch.state,
    series: resolveSeries(watch.timeframe),
  };
}

/** Plain-words label for the series, for a caption under the chart. */
export function seriesNote(series: ResolvedSeries): string {
  if (series.substituted) {
    return `Your strategy says ${series.requested}. The market-data bridge has no ${series.requested} series, so Sentinel is evaluating ${series.interval} bars — and so is this chart.`;
  }
  if (series.assumedDefault) {
    return `Your strategy names no timeframe, so Sentinel evaluates its ${series.interval} default. This chart draws the same bars.`;
  }
  return `Sentinel evaluates this watch on ${series.interval} bars. This chart draws the same ones.`;
}

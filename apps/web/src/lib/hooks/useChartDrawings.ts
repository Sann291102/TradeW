'use client';

import { useEffect } from 'react';
import type { Candle } from '@tradew/types';
import { useWorkspaceStore } from '../store/workspaceStore';
import type { ChartDrawing } from '../charts/drawings';

/**
 * Connect one chart to the assistant's drawing layer.
 *
 * Two directions in one hook, deliberately:
 *
 *  - **up**: publish which bars are on screen, so `chartDetect` runs against
 *    exactly the series the user is looking at rather than re-fetching a
 *    window that might not match.
 *  - **down**: hand back the drawings computed for *this* series.
 *
 * ── THE SERIES KEY IS THE SAFETY MECHANISM ─────────────────────────────────
 *
 * Zones found on NIFTY 15m describe price levels that mean nothing on
 * RELIANCE 1D. Rendering them there would be the drawing layer's version of
 * the fabrication class this repo has been bitten by before — a confident
 * annotation asserting a level nothing detected. So both the published series
 * and the stored drawings carry the key, the store drops drawings when the key
 * changes, and this hook returns nothing unless the two still agree. Three
 * independent checks for one invariant, because a stale zone is silent.
 *
 * `seriesKey` should be the same string the chart uses as its `fitKey` —
 * `SYMBOL|timeframe`, or `SYMBOL|contract|timeframe` for an option contract.
 */
export function useChartDrawings(
  seriesKey: string,
  candles: Candle[] | null | undefined,
  lastPrice: number | null | undefined,
  /**
   * The chart's interval, as the user sees it on the pill ('15m', '1H').
   *
   * Published as its OWN store field rather than parsed back out of
   * `seriesKey`. The key's format is owned by the staleness invariant (and is
   * `SYMBOL|contract|timeframe` for an option chart, where a naive split
   * returns the contract), so reading an interval out of it couples "analyse
   * this chart" to a string shape that exists for a different reason.
   *
   * Optional so existing callers that only want the drawing layer are
   * unaffected; when omitted the timeframe is simply not published.
   */
  timeframe?: string,
): ChartDrawing[] | undefined {
  const publishChartSeries = useWorkspaceStore((s) => s.publishChartSeries);
  const setChartTimeframe = useWorkspaceStore((s) => s.setChartTimeframe);
  const stored = useWorkspaceStore((s) => s.chartDrawings);

  useEffect(() => {
    if (!candles?.length) return;
    publishChartSeries(seriesKey, candles, lastPrice ?? null);
  }, [seriesKey, candles, lastPrice, publishChartSeries]);

  // Separate from the series effect on purpose: the interval is meaningful
  // before the first candle arrives, and an analysis request made in that
  // window must still carry the timeframe the user is looking at.
  useEffect(() => {
    if (!timeframe) return;
    setChartTimeframe(timeframe);
  }, [timeframe, setChartTimeframe]);

  return stored?.seriesKey === seriesKey ? stored.drawings : undefined;
}

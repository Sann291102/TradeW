'use client';

import { useEffect, useRef, useState } from 'react';
import { cn, Skeleton } from '@tradew/ui';
import { useWorkspaceStore, resolveTheme } from '@/lib/store/workspaceStore';

/**
 * TradingView's Advanced Chart widget, embedded for the USD venues (crypto and
 * spot FX) in the Markets workspace.
 *
 * ── WHY THIS EXISTS ALONGSIDE `TradeChart` ─────────────────────────────────
 *
 * `TradeChart` (lightweight-charts) draws OUR data: bars we fetched, price
 * lines we computed, tokens from our theme. It is the right tool everywhere we
 * own the series, and it stays the chart on /trade and on every rupee venue.
 *
 * This component is the opposite trade-off, chosen deliberately for crypto and
 * FX: TradingView's own iframe, with their full indicator and drawing toolbar,
 * fed by THEIR data rather than ours.
 *
 * ── THE HONEST CAVEAT ──────────────────────────────────────────────────────
 *
 * The prices inside this iframe are not the prices on the board above it.
 * The board polls services/api (Binance / Twelve Data); the widget streams
 * from TradingView. Two feeds, two timestamps, and no way for us to reconcile
 * them — the iframe is cross-origin, so nothing on our side can read a value
 * out of it, overlay a line on it, or even tell whether it resolved the symbol
 * at all.
 *
 * Two things keep that from being a trap:
 *
 *  · Symbol mapping targets the SAME venue wherever possible. Crypto maps to
 *    `BINANCE:*` — literally the exchange our board polls — so the two agree
 *    to within their respective tick latencies. FX maps to `FX_IDC:*`, which
 *    is a different aggregator from Twelve Data and will differ by a pip or
 *    so on the minors; see `lib/markets/tradingViewSymbols.ts`.
 *  · The caller labels the chart with its source. `sourceNote` is rendered
 *    under the frame and is not optional-by-accident: a second price feed on
 *    a trading screen has to say whose numbers it is showing.
 *
 * This is why the widget is NOT used for the rupee venues. There, our own
 * Dhan series is the one the order ticket prices against, and a chart quietly
 * disagreeing with the ticket beside it is exactly the class of error the
 * no-fabricated-data rule exists to prevent.
 */

const LOADER_SRC = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';

/** Widget interval codes. Keyed by the pill labels the rest of the app uses so
 *  the timeframe row reads the same here as on /trade. */
export const TV_INTERVALS = ['1m', '5m', '15m', '1H', '1D', '1W'] as const;
export type TvInterval = (typeof TV_INTERVALS)[number];

const TV_INTERVAL_CODE: Record<TvInterval, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1H': '60',
  '1D': 'D',
  '1W': 'W',
};

export interface TradingViewWidgetProps {
  /** Fully-qualified TradingView symbol, e.g. `BINANCE:BTCUSDT`. Build it with
   *  `lib/markets/tradingViewSymbols.ts` rather than concatenating by hand —
   *  an unprefixed symbol silently resolves to whatever exchange TradingView
   *  picks, which for FX majors is not the one we quote. */
  symbol: string;
  interval?: TvInterval;
  /** Provider attribution, rendered under the frame. See the caveat above. */
  sourceNote: string;
  className?: string;
}

export function TradingViewWidget({
  symbol,
  interval = '15m',
  sourceNote,
  className,
}: TradingViewWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  // Follow the app's own theme rather than pinning one. `system` resolves to
  // an actual palette here; high-contrast has no TradingView equivalent, so it
  // maps to dark (their light theme is the worse of the two for contrast).
  const theme = useWorkspaceStore((s) => s.theme);
  const resolved = resolveTheme(theme);
  const tvTheme = resolved === 'light' ? 'light' : 'dark';

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    setState('loading');

    // The loader reads its configuration from its OWN innerHTML — it is not a
    // library with an init function, so there is no way to reconfigure an
    // existing embed. Every symbol/interval/theme change tears the whole thing
    // down and builds a fresh one. That is the documented usage, not a
    // workaround.
    const widgetHost = document.createElement('div');
    widgetHost.className = 'tradingview-widget-container__widget';
    widgetHost.style.height = '100%';
    widgetHost.style.width = '100%';
    container.appendChild(widgetHost);

    const script = document.createElement('script');
    script.src = LOADER_SRC;
    script.async = true;
    script.type = 'text/javascript';
    script.innerHTML = JSON.stringify({
      symbol,
      interval: TV_INTERVAL_CODE[interval],
      theme: tvTheme,
      autosize: true,
      // 1 = candles. The rest of the app charts candles by default and a
      // different default here would read as a different instrument.
      style: '1',
      locale: 'en',
      // IST, matching `TradeChart`'s pinned Asia/Kolkata axis — the two charts
      // must not label the same bar with two different times.
      timezone: 'Asia/Kolkata',
      hide_side_toolbar: false,
      allow_symbol_change: false,
      save_image: false,
      support_host: 'https://www.tradingview.com',
    });

    // The loader resolving is the only success signal available from outside a
    // cross-origin iframe. It says the script arrived and ran — NOT that the
    // symbol resolved or that a chart drew. A wrong symbol renders
    // TradingView's own "invalid symbol" inside the frame, which is theirs to
    // display and ours to have avoided by mapping correctly upstream.
    script.onload = () => setState('ready');
    // Fires on a network failure or a CSP block. Worth distinguishing: if the
    // script-src entry in next.config.mjs is ever dropped, this is the only
    // thing that will say so out loud instead of leaving an empty rectangle.
    script.onerror = () => setState('failed');

    container.appendChild(script);

    return () => {
      // Remove the host and the script together. Leaving either behind stacks
      // a second chart under the first on the next symbol change.
      container.innerHTML = '';
    };
  }, [symbol, interval, tvTheme]);

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="relative min-h-0 flex-1">
        {state === 'loading' && (
          <div className="absolute inset-0 z-10 p-2">
            <Skeleton className="h-full w-full" />
          </div>
        )}

        {state === 'failed' && (
          <div
            role="alert"
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 px-4 text-center"
          >
            <p className="text-[12px] font-semibold text-muted">TradingView chart could not be loaded</p>
            <p className="max-w-md text-[11px] leading-relaxed text-faint">
              The chart is served from tradingview.com and that request did not complete — a network
              block, an extension, or a content-security-policy change. Prices on the board above come
              from our own market-data service and are unaffected.
            </p>
          </div>
        )}

        {/* One stable node for the component's lifetime. The effect above owns
            everything inside it and empties it on every teardown, so there is
            no stale iframe to key away from — and a changing key would detach
            the ref on each symbol change for no benefit. */}
        <div ref={containerRef} className="tradingview-widget-container h-full w-full" />
      </div>

      <p className="shrink-0 px-1 pt-2 text-[11px] leading-relaxed text-faint">{sourceNote}</p>
    </div>
  );
}

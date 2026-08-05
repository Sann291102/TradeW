'use client';

import type { ReactNode } from 'react';
import { cn } from '@tradew/ui';
import { CrownIcon, ShieldCheckIcon } from './sentinel-icons';

/**
 * The Sentinel workspace header — title, entitlement marker, and the toolbar
 * controls (Option Chain + Market head) on one line.
 *
 * The controls themselves are unchanged and passed in as `controls`; this
 * component only owns the layout and typography around them, so the market
 * selection flow (page state → useSentinel(symbol) → /observe) is untouched.
 *
 * The "Premium" chip is a real entitlement readout, not decoration: it renders
 * only when the session actually carries the `sentinel` capability
 * (SUBSCRIPTIONS.md §4, the same check that decides `SentinelLocked`). It is a
 * status marker, never an upsell button — users without the capability never
 * reach this page.
 */
export function SentinelHeader({
  status,
  premium,
  controls,
}: {
  /** Honest one-line data-source/state readout, e.g. "Reading Nifty 50 · live market data". */
  status: ReactNode;
  premium: boolean;
  controls: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="text-[26px] font-extrabold leading-none tracking-tightTrack text-text sm:text-[30px]">
            Sentinel
          </h1>
          <span
            title="Observation-only market safety layer"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-teal-bg text-teal"
          >
            <ShieldCheckIcon className="h-[15px] w-[15px]" />
          </span>
        </div>
        <p className="mt-1.5 text-[13px] text-muted">AI-powered market safety &amp; intelligence</p>
        <p className="mt-0.5 text-[11.5px] text-faint">{status}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        {controls}
        {premium && (
          <span
            className={cn(
              'flex items-center gap-1.5 rounded-xl border border-teal bg-teal-bg px-3 py-2.5',
              'text-[12px] font-bold text-teal shadow-elev1',
            )}
          >
            <CrownIcon className="h-4 w-4" />
            Premium
          </span>
        )}
      </div>
    </header>
  );
}

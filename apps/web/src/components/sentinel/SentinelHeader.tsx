'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@tradew/ui';
import { CrownIcon, ShieldCheckIcon } from './sentinel-icons';

/**
 * The Sentinel workspace header — title, entitlement marker, and the toolbar
 * controls (Option Chain + Market head) on one line.
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
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4" suppressHydrationWarning>
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

      <div className="flex flex-wrap items-center gap-2.5" suppressHydrationWarning>
        {controls}
        {mounted && premium && (
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

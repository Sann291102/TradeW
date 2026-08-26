'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Panel, Sparkline, cn } from '@tradew/ui';
import { WATCHLIST } from '@/lib/mock/market';
import { fmt, pct } from '@/lib/format';
import { fetchResearchPreferences } from '@/lib/research/storage';
import { useSignedIn } from '@/lib/query/usePortfolio';
import type { DockPanelContentProps } from './types';

/** Watchlist slot — the canonical left-rail watchlist as a terminal panel. */
export function WatchlistPanel({ className, actions, collapsed }: DockPanelContentProps) {
  const signedIn = useSignedIn();
  const prefs = useQuery({
    queryKey: ['research', 'prefs'],
    queryFn: fetchResearchPreferences,
    enabled: signedIn,
    staleTime: 60_000,
    retry: 1,
  });
  const entries =
    prefs.data && prefs.data.watchlist.length > 0
      ? prefs.data.watchlist.map((entry) => ({
          symbol: entry.symbol,
          name: entry.name,
          ltp: 0,
          changePct: 0,
          spark: [] as number[],
          href: `/research?symbol=${encodeURIComponent(entry.symbol)}`,
        }))
      : WATCHLIST.map((entry) => ({ ...entry, href: '/markets' }));

  return (
    <Panel title="Watchlist" className={className} actions={actions} collapsed={collapsed}>
      <ul className="-mx-1 divide-y divide-border">
        {entries.map((w) => {
          const up = w.changePct >= 0;
          return (
            <li key={w.symbol}>
              <Link href={w.href} className="flex items-center gap-2 px-1 py-1.5 transition-colors hover:bg-hover">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-text">{w.symbol}</div>
                  <div className="truncate text-[10px] text-faint">{w.name}</div>
                </div>
                {w.spark.length > 0 ? (
                  <Sparkline data={w.spark} width={44} height={16} aria-label={`${w.symbol} trend`} />
                ) : (
                  <div className="w-11 text-center text-[9px] text-faint">Research</div>
                )}
                <div className="w-16 text-right">
                  <div className="font-mono text-[12px] tabular-nums text-text">{w.ltp ? fmt(w.ltp) : '—'}</div>
                  <div className={cn('font-mono text-[10px] tabular-nums', up ? 'text-up' : 'text-down')}>
                    {w.ltp ? pct(w.changePct) : 'saved'}
                  </div>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

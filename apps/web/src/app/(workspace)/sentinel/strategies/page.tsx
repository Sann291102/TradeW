'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Skeleton } from '@tradew/ui';
import { api } from '@/lib/api';
import { useSessionStore } from '@/lib/store/sessionStore';
import { StrategyCatalogue } from '@/components/sentinel/StrategyCatalogue';
import { StrategyWorkspace } from '@/components/sentinel/StrategyWorkspace';

/**
 * `/sentinel/strategies` — Catalogue → Adopt → Configure → Watch → Focus →
 * Feed → Performance.
 *
 * Reached from the sidebar ("Strategy Watches") and from the Sentinel
 * workspace. It previously had neither: the route existed, the components
 * existed, and there was no way for a user to arrive here, which is a
 * different thing from the feature not working.
 *
 * Entitlement is handled the same way `/sentinel` handles it, including the
 * third state: until the session resolves, `hasCapability` is false for
 * everyone, so branching on it alone would flash "subscription required" at
 * paying subscribers on every load.
 */

interface StrategyRow {
  id: string;
  name: string;
  status: string;
}

export default function StrategiesPage() {
  const status = useSessionStore((s) => s.status);
  const hasSentinel = useSessionStore((s) => s.hasCapability('sentinel'));

  const [strategies, setStrategies] = useState<StrategyRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (selectId?: string) => {
    try {
      const rows = (await api('/sentinel-py/strategies')) as StrategyRow[];
      const active = rows.filter((row) => row.status !== 'archived');
      setStrategies(active);
      setSelected((current) => selectId ?? current ?? active[0]?.id ?? null);
      setError(null);
    } catch (err) {
      setStrategies([]);
      // Named rather than swallowed: "no strategies yet" and "the service is
      // not reachable" look identical on screen otherwise, and only one of
      // them is the user's problem to solve.
      setError(err instanceof Error ? err.message : 'Could not reach the strategy service');
    }
  }, []);

  useEffect(() => {
    if (status === 'authenticated' && hasSentinel) void refresh();
  }, [status, hasSentinel, refresh]);

  if (status === 'idle' || status === 'loading') {
    return (
      <Shell>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </Shell>
    );
  }

  if (!hasSentinel) {
    return (
      <Shell>
        <Card>
          <h1 className="text-[15px] font-bold text-text">Sentinel Pro required</h1>
          <p className="mt-1 text-[12.5px] text-muted">
            Strategy watching is part of Sentinel. Open Sentinel to see what it includes.
          </p>
          <Link
            href="/sentinel"
            className="mt-3 inline-block rounded-lg border border-border px-3 py-1.5 text-[12px] text-text hover:bg-hover"
          >
            Go to Sentinel
          </Link>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <header>
        <h1 className="text-[22px] font-extrabold tracking-tightTrack text-text sm:text-[26px]">
          Strategy Watches
        </h1>
        <p className="mt-1 text-[12.5px] text-muted">
          Adopt a definition, make it yours, and Sentinel will watch it and explain what it sees.
        </p>
      </header>

      {error && (
        <Card>
          <p className="text-[12.5px] text-amber">{error}</p>
        </Card>
      )}

      {(strategies?.length ?? 0) > 0 && (
        <nav className="flex flex-wrap gap-2">
          {strategies!.map((strategy) => (
            <button
              key={strategy.id}
              type="button"
              onClick={() => setSelected(strategy.id)}
              className={
                strategy.id === selected
                  ? 'rounded-lg border border-teal bg-teal-bg px-3 py-1.5 text-[12px] text-text'
                  : 'rounded-lg border border-border px-3 py-1.5 text-[12px] text-muted hover:bg-hover'
              }
            >
              {strategy.name}
            </button>
          ))}
        </nav>
      )}

      {selected && (
        <Card>
          <StrategyWorkspace strategyId={selected} />
        </Card>
      )}

      <Card>
        <h2 className="mb-3 text-[13px] font-bold text-text">Strategy catalogue</h2>
        <StrategyCatalogue onAdopted={(id) => void refresh(id)} />
      </Card>
    </Shell>
  );
}

/** The same page shell every workspace route uses. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-bg">
      <main className="mx-auto max-w-[1600px] space-y-4 px-4 py-5 sm:px-6">{children}</main>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <section className="rounded-2xl border border-border bg-card p-5 shadow-elev2">{children}</section>;
}

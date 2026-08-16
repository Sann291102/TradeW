'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSentinel } from '@/lib/sentinel/useSentinel';
import { useSessionStore } from '@/lib/store/sessionStore';
import { buildDashboardModel } from '@/lib/sentinel/dashboardModel';
import { DEFAULT_MARKET, findMarket } from '@/lib/sentinel/markets';
import type { StrategyMode } from '@/lib/sentinel/types';
import { MarketSelector } from '@/components/sentinel/MarketSelector';
import { OptionChainPanel } from '@/components/sentinel/OptionChainPanel';
import { SentinelDashboard } from '@/components/sentinel/dashboard/SentinelDashboard';
import { SentinelStrategyWorkspace } from '@/components/sentinel/strategy/SentinelStrategyWorkspace';

/**
 * The Sentinel workspace proper — unchanged behaviour, lifted out of
 * `(workspace)/sentinel/page.tsx` on 2026-08-15 so that page can decide between
 * this and `SentinelPricingView` without either one's hooks running for a user
 * who will not see it. Previously the entitlement check sat BELOW
 * `useSentinel()`, so an account without Sentinel fired an `/observe` request
 * on every render that could only ever 403.
 *
 * Rendered only for an authenticated account holding the `sentinel` capability.
 */
export function SentinelWorkspace() {
  const [symbol, setSymbol] = useState(DEFAULT_MARKET);
  const [strategyMode] = useState<StrategyMode>('auto');
  const { data, summary, unavailable, loading } = useSentinel(symbol, { strategyMode });
  const user = useSessionStore((s) => s.user);

  const market = findMarket(symbol);

  const controls = (
    <>
      <OptionChainPanel symbol={symbol} />
      <MarketSelector value={symbol} onChange={setSymbol} />
    </>
  );

  // No observation, and nothing invented in its place — each fault named for
  // what it actually is.
  if (unavailable) {
    const fault: { title: string; detail: string; action?: { href: string; label: string } } =
      unavailable.kind === 'unauthenticated'
        ? {
            title: 'Not signed in',
            detail:
              'Sentinel runs its observation against your account. Sign in to get a live read — no sample analysis is shown in the meantime.',
          }
        : unavailable.kind === 'entitlement-required'
          ? {
              // Reachable despite the entitlement gate above: a subscription can
              // lapse between the session load and this request. The page-level
              // check will flip to the pricing view on the next session refresh;
              // until then, say what is actually blocking the observation.
              title: 'Sentinel Pro required',
              detail:
                "You're signed in, but this account doesn't have an active Sentinel Pro subscription — that's what's blocking the observation, not your session.",
            }
          : unavailable.kind === 'api-unreachable'
            ? {
                title: 'API not connected',
                detail: `The TradeW API could not be reached, so no observation could be run for ${market.name}. Start services/api (port 4000) and reload.`,
              }
            : {
                title: 'Sentinel service not connected',
                detail: `The API answered but Sentinel could not complete the observation (HTTP ${unavailable.status}: ${unavailable.message}). Check that services/sentinel is running on port 4010.`,
              };

    return (
      <div className="bg-bg">
        <main className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6">
          <header className="mb-5">
            <h1 className="text-[24px] font-extrabold tracking-tightTrack text-text">{greeting(user?.email)}</h1>
            <p className="mt-1 text-[12.5px] text-muted">
              Reading <span className="font-semibold">{market.name}</span> · {fault.title.toLowerCase()}
            </p>
          </header>
          <div className="rounded-2xl border border-border bg-card p-10 text-center shadow-elev2">
            <p className="text-[14px] font-bold text-text">{fault.title}</p>
            <p className="mx-auto mt-2 max-w-xl text-[12.5px] leading-relaxed text-muted">{fault.detail}</p>
            {fault.action && (
              <Link
                href={fault.action.href}
                className="mt-4 inline-block text-[12.5px] font-semibold text-teal hover:underline"
              >
                {fault.action.label}
              </Link>
            )}
          </div>

          {/*
            The user's own strategies do not come from `/observe` — they are a
            different service (services/sentinel-py) reached through a different
            route. So a dead observation service must not take them off the page
            with it: the strategy the user wrote and the watches running against
            it are exactly what they would want to still see.
          */}
          {unavailable.kind === 'service-error' && (
            <div className="mt-4">
              <SentinelStrategyWorkspace />
            </div>
          )}
        </main>
      </div>
    );
  }

  const model = buildDashboardModel(data ?? null, loading);
  const sourceLabel = model.marketActive
    ? 'live market data'
    : model.sessionPhase === 'pre-market'
      ? 'pre-market'
      : 'market closed';

  return (
    <div className="bg-bg">
      <main className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6">
        <SentinelDashboard
          model={model}
          symbol={symbol}
          marketName={market.name}
          greeting={greeting(user?.email)}
          statusLine={
            <>
              Reading <span className="font-semibold text-muted">{market.name}</span> · {sourceLabel}
              {loading && ' · refreshing…'}
            </>
          }
          controls={controls}
          /*
           * Only the observation-side figure is threaded through now. The
           * strategy-side ones (confirmed, open, outcomes, expectancy) are
           * fetched by the stats grid itself against services/sentinel-py on
           * its own faster cadence — they describe the user's watches, which
           * the sweep re-evaluates every 15s, and re-deriving them from this
           * 45s poll would show a confirmed setup as unconfirmed for most of
           * a minute. `tradesToday`/`flaggedEvents` still come from here —
           * they describe the trader's own activity rather than any strategy,
           * so they stay on the observation cadence and are rendered as a
           * separate line rather than as tiles in the strategy grid.
           */
          sessionStats={{
            signalsTriggered: (data?.signals ?? []).filter((s) => s.triggered).length,
            tradesToday: summary?.tradesToday ?? null,
            flaggedEvents: summary?.flaggedEvents ?? null,
          }}
          strategyWorkspace={<SentinelStrategyWorkspace />}
        />
      </main>
    </div>
  );
}

/** IST-aware greeting with the trader's first name from their email local part. */
function greeting(email?: string | null): string {
  const hourIst = Number(
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()),
  );
  const part = hourIst < 12 ? 'Good Morning' : hourIst < 17 ? 'Good Afternoon' : 'Good Evening';
  const local = (email ?? '').split('@')[0]?.split(/[.\-_]/)[0] ?? '';
  const name = local ? local.charAt(0).toUpperCase() + local.slice(1) : 'Trader';
  return `${part}, ${name} 👋`;
}

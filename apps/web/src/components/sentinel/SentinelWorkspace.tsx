'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSentinel, type SentinelUnavailable } from '@/lib/sentinel/useSentinel';
import { useSessionStore } from '@/lib/store/sessionStore';
import { buildDashboardModel } from '@/lib/sentinel/dashboardModel';
import { DEFAULT_MARKET, findMarket } from '@/lib/sentinel/markets';
import type { StrategyMode } from '@/lib/sentinel/types';
import { MarketSelector } from '@/components/sentinel/MarketSelector';
import { OptionChainPanel } from '@/components/sentinel/OptionChainPanel';
import { SentinelConnectionBanner } from '@/components/sentinel/SentinelConnectionBanner';
import { SentinelDashboard } from '@/components/sentinel/dashboard/SentinelDashboard';
import { SentinelStrategyWorkspace } from '@/components/sentinel/strategy/SentinelStrategyWorkspace';

/**
 * The Sentinel workspace proper — lifted out of `(workspace)/sentinel/page.tsx`
 * on 2026-08-15 so that page can decide between this and `SentinelPricingView`
 * without either one's hooks running for a user who will not see it.
 * Previously the entitlement check sat BELOW `useSentinel()`, so an account
 * without Sentinel fired an `/observe` request on every render that could only
 * ever 403.
 *
 * Rendered only for an authenticated account holding the `sentinel` capability.
 *
 * ── THE SHELL IS NOT ALLOWED TO DISAPPEAR ──────────────────────────────────
 *
 * This component used to `return` a full-page fault card the moment `/observe`
 * failed, replacing everything: the market selector, the option chain, the
 * strategy composer, the saved strategies, the active watches. All of it, for
 * a failure in ONE of the three services those surfaces read from — and most
 * often for a 429, a state that had already expired by the time it was
 * rendered.
 *
 * The rule now: a fault takes away only what it actually broke.
 *
 *   · retrying, with a previous observation cached → inline banner, full
 *     workspace, nothing else changes. (`reconnecting`)
 *   · retries exhausted with nothing cached, or a fault that retrying cannot
 *     fix (not signed in, not entitled) → the fault card, but the strategy
 *     workspace stays below it, because the user's own strategies come from a
 *     different service and are still perfectly readable. (`unavailable`)
 *
 * The word "reload" appears nowhere in either path, by design.
 */
export function SentinelWorkspace() {
  const [symbol, setSymbol] = useState(DEFAULT_MARKET);
  const [strategyMode] = useState<StrategyMode>('auto');
  const { data, unavailable, reconnecting, loading, refreshing, updatedAt } = useSentinel(symbol, {
    strategyMode,
  });
  const user = useSessionStore((s) => s.user);

  const market = findMarket(symbol);

  const controls = (
    <>
      <OptionChainPanel symbol={symbol} />
      <MarketSelector value={symbol} onChange={setSymbol} />
    </>
  );

  // No observation, nothing cached, and nothing invented in its place — each
  // fault named for what it actually is.
  if (unavailable) {
    const fault = describeFault(unavailable, market.name);
    return (
      <div className="bg-bg">
        <main className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6">
          <header className="mb-5">
            <h1 className="text-[24px] font-extrabold tracking-tightTrack text-text">{greeting(user?.email)}</h1>
            <p className="mt-1 text-[12.5px] text-muted">
              Reading <span className="font-semibold">{market.name}</span> · {fault.title.toLowerCase()}
              {refreshing && ' · retrying…'}
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

            Shown for every fault except the two that would make it 401/403 as
            well, where it would only render its own copy of the same message.
          */}
          {unavailable.kind !== 'unauthenticated' && unavailable.kind !== 'entitlement-required' && (
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
        {/* Above the dashboard, not instead of it. */}
        {reconnecting && <SentinelConnectionBanner fault={reconnecting} updatedAt={updatedAt} />}
        <SentinelDashboard
          model={model}
          symbol={symbol}
          marketName={market.name}
          greeting={greeting(user?.email)}
          statusLine={
            <>
              Reading <span className="font-semibold text-muted">{market.name}</span> ·{' '}
              {reconnecting ? 'last known reading' : sourceLabel}
              {refreshing && ' · refreshing…'}
            </>
          }
          controls={controls}
          strategyWorkspace={<SentinelStrategyWorkspace />}
        />
      </main>
    </div>
  );
}

interface FaultCopy {
  title: string;
  detail: string;
  action?: { href: string; label: string };
}

/**
 * What the empty state says. Every branch names the service that actually
 * failed rather than collapsing four different faults into one sentence —
 * see `lib/sentinel/faults.ts` for why 401 and 403 in particular are never
 * merged.
 *
 * Note what these no longer say: "and reload". Nothing here requires one. By
 * the time this card is on screen the retries behind it are exhausted, the
 * poll has backed off to a slower cadence, and it is still running — a service
 * that comes back replaces this card by itself.
 */
function describeFault(fault: SentinelUnavailable, marketName: string): FaultCopy {
  switch (fault.kind) {
    case 'unauthenticated':
      return {
        title: 'Not signed in',
        detail:
          'Sentinel runs its observation against your account. Sign in to get a live read — no sample analysis is shown in the meantime.',
      };
    case 'entitlement-required':
      // Reachable despite the entitlement gate on the page: a subscription can
      // lapse between the session load and this request. The page-level check
      // will flip to the pricing view on the next session refresh; until then,
      // say what is actually blocking the observation.
      return {
        title: 'Sentinel Pro required',
        detail:
          "You're signed in, but this account doesn't have an active Sentinel Pro subscription — that's what's blocking the observation, not your session.",
      };
    case 'api-unreachable':
      return {
        title: 'API not connected',
        detail: `The TradeW API could not be reached, so no observation could be run for ${marketName}. Sentinel keeps retrying in the background and will pick up on its own once services/api (port 4000) is answering.`,
      };
    case 'service-error':
      return {
        title: fault.status === 429 ? 'Sentinel is rate limited' : 'Sentinel service not connected',
        detail:
          fault.status === 429
            ? `Too many observation requests reached Sentinel from this network, so it is refusing new ones for a moment. Retries are already backing off and will resume automatically — nothing needs to be done here.`
            : `The API answered but Sentinel could not complete the observation (HTTP ${fault.status}: ${fault.message}). Retries continue in the background; check that services/sentinel is running on port 4010.`,
      };
  }
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

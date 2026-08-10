'use client';

import { useState } from 'react';
import { useSentinel } from '@/lib/sentinel/useSentinel';
import { useSessionStore } from '@/lib/store/sessionStore';
import { buildDashboardModel } from '@/lib/sentinel/dashboardModel';
import { DEFAULT_MARKET, findMarket } from '@/lib/sentinel/markets';
import type { StrategyMode } from '@/lib/sentinel/types';
import { MarketSelector } from '@/components/sentinel/MarketSelector';
import { OptionChainPanel } from '@/components/sentinel/OptionChainPanel';
import { SentinelLocked } from '@/components/sentinel/SentinelLocked';
import { SentinelDashboard } from '@/components/sentinel/dashboard/SentinelDashboard';

/**
 * Sentinel — the reference-design operational dashboard.
 *
 * Rebuilt 2026-08-11 to match the authoritative Sentinel reference images: a
 * status-card row (Market Regime · Confidence · Composite Risk · State Machine
 * · Session Observations), a Live Market Overview with a real candle chart and
 * a computed indicator strip, the single-conclusion Sentinel Observation card,
 * an 8-factor Risk Radar, Emotion Mirror, Session Timeline and Quick Actions.
 *
 * Every element is wired to the REAL `/sentinel/observe` response via
 * `buildDashboardModel` — no fabricated values. The previous two-column
 * "Market Context Intelligence" composition is archived to
 * archive/apps-web-sentinel-dashboard-redesign-2026-08-11/ (see
 * archive/README.md). Same backend, same auth, same entitlement gating —
 * only the presentation changed.
 *
 * Shares the standard Sidebar/TopBar shell like every other workspace
 * (ARCHITECTURE.md §2.2).
 */
export default function SentinelPage() {
  const [symbol, setSymbol] = useState(DEFAULT_MARKET);
  const [strategyMode] = useState<StrategyMode>('auto');
  const { data, unavailable, loading } = useSentinel(symbol, { strategyMode });
  const status = useSessionStore((s) => s.status);
  const user = useSessionStore((s) => s.user);
  const hasCapability = useSessionStore((s) => s.hasCapability);

  const market = findMarket(symbol);
  const locked = status === 'authenticated' && !hasCapability('sentinel');
  if (locked) return <SentinelLocked />;

  const controls = (
    <>
      <OptionChainPanel symbol={symbol} />
      <MarketSelector value={symbol} onChange={setSymbol} />
    </>
  );

  // No observation, and nothing invented in its place — each fault named for
  // what it actually is (unchanged behavior from the previous page).
  if (unavailable) {
    const fault =
      unavailable.kind === 'unauthenticated'
        ? {
            title: 'Not signed in',
            detail:
              'Sentinel runs its observation against your account. Sign in to get a live read — no sample analysis is shown in the meantime.',
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
          </div>
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

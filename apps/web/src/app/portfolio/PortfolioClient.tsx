'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Card, EmptyState, Skeleton, StatCard, buttonClasses, cn } from '@tradew/ui';
import { fmt, inr, pct, sign } from '@/lib/format';
import {
  PRODUCT_TYPE_LABELS,
  type PortfolioSummary,
  type PositionDto,
  exitPosition,
  fetchPortfolio,
  fetchPositions,
  isSignedIn,
} from '@/lib/oms';

/**
 * Portfolio workspace — the REAL paper account.
 *
 * Until now this page rendered `PORTFOLIO_SUMMARY` from lib/mock/market.ts:
 * a hardcoded ₹5,12,840 with a hand-written "+5.41%", above an empty state
 * reading "once the trading backend is connected". The backend had in fact
 * been connected for some time — `/sim/portfolio`, `/sim/positions` and
 * `/sim/trades` were live and serving real fills — so the page was showing a
 * paying user invented figures as their own account while their actual
 * positions sat one endpoint away. Every number here now comes from the OMS.
 *
 * Positions are polled rather than fetched once: `currentPrice`, `unrealizedPnl`
 * and `dailyPnl` are all marked to the live bridge price server-side, so a
 * static read would go stale the moment the market moved.
 */

const POLL_MS = 5_000;

type Tab = 'Positions' | 'Performance';
const TABS: Tab[] = ['Positions', 'Performance'];

export function PortfolioClient() {
  const [tab, setTab] = useState<Tab>('Positions');
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [positions, setPositions] = useState<PositionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exiting, setExiting] = useState<string | null>(null);
  const signedIn = useSignedIn();

  const load = useCallback(async () => {
    const [s, p] = await Promise.all([fetchPortfolio(), fetchPositions()]);
    setSummary(s);
    setPositions(p);
    setError(null);
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        await load();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not reach the trading backend');
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_MS);
      }
    }
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [signedIn, load]);

  async function onExit(p: PositionDto) {
    setExiting(p.instrumentId);
    try {
      await exitPosition(p.instrumentId, p.productType);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not square off that position');
    } finally {
      setExiting(null);
    }
  }

  if (!signedIn) {
    return (
      <Shell tab={tab} setTab={setTab} summary={null}>
        <EmptyState
          title="Sign in to see your paper account"
          description="Your positions, P&L and margin live on your account — there is nothing to show for a signed-out visitor."
        />
      </Shell>
    );
  }

  return (
    <Shell tab={tab} setTab={setTab} summary={summary}>
      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-amber-bg px-3 py-2 text-xs leading-relaxed text-amber">
          {error}
        </p>
      )}

      {tab === 'Positions' &&
        (positions === null && !error ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : positions && positions.length > 0 ? (
          <ul className="space-y-1.5">
            {positions.map((p) => (
              <PositionRow key={p.id} p={p} onExit={() => onExit(p)} exiting={exiting === p.instrumentId} />
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No open positions"
            description="Positions appear here as soon as an order fills on the Trade screen."
          />
        ))}

      {tab === 'Performance' && summary && <Performance summary={summary} />}
    </Shell>
  );
}

// ------------------------------------------------------------------ layout

function Shell({
  tab,
  setTab,
  summary,
  children,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  summary: PortfolioSummary | null;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[1200px] space-y-4 p-4">
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Available" value={summary ? inr(summary.availableBalance) : '—'} />
        <StatCard label="Margin used" value={summary ? inr(summary.marginUsed) : '—'} />
        <StatCard
          label="Unrealised P&L"
          value={summary ? `${sign(summary.unrealizedPnl)}${inr(Math.abs(summary.unrealizedPnl))}` : '—'}
          delta={summary ? deltaVsStart(summary.unrealizedPnl, summary.startingBalance) : undefined}
        />
        <StatCard
          label="Today's P&L"
          value={summary ? `${sign(summary.dailyPnl)}${inr(Math.abs(summary.dailyPnl))}` : '—'}
          delta={summary ? deltaVsStart(summary.dailyPnl, summary.startingBalance) : undefined}
        />
      </section>

      <div role="tablist" aria-label="Portfolio sections" className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              tab === t ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <Card title={tab}>{children}</Card>
    </div>
  );
}

function PositionRow({ p, onExit, exiting }: { p: PositionDto; onExit: () => void; exiting: boolean }) {
  const long = p.quantity > 0;
  const up = p.unrealizedPnl >= 0;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border2 bg-bg px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-bold text-text">{p.displayName}</span>
          <Badge tone={long ? 'positive' : 'negative'} className="px-1.5 py-0 text-[9px]">
            {long ? 'LONG' : 'SHORT'}
          </Badge>
          <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
            {PRODUCT_TYPE_LABELS[p.productType]}
          </Badge>
          {/* Never let a stale mark read as a live one. */}
          {p.priceStatus === 'stale' && (
            <Badge tone="warning" className="px-1.5 py-0 text-[9px]">
              STALE PRICE
            </Badge>
          )}
        </div>
        <div className="mt-0.5 font-mono text-[11px] tabular-nums text-faint">
          {Math.abs(p.quantity)} @ {fmt(p.avgPrice)} → {fmt(p.currentPrice)} · margin {inr(p.marginUsed)}
        </div>
      </div>

      <div className="shrink-0 text-right">
        <div className={cn('font-mono text-sm font-bold tabular-nums', up ? 'text-up' : 'text-down')}>
          {sign(p.unrealizedPnl)}
          {inr(Math.abs(p.unrealizedPnl), 2)}
        </div>
        <div className="font-mono text-[11px] tabular-nums text-muted">
          day {sign(p.dailyPnl)}
          {inr(Math.abs(p.dailyPnl), 2)}
        </div>
      </div>

      <button
        type="button"
        onClick={onExit}
        disabled={exiting}
        className={cn(buttonClasses({ variant: 'outline', size: 'sm' }), 'shrink-0 disabled:opacity-40')}
      >
        {exiting ? 'Squaring off…' : 'Square off'}
      </button>
    </li>
  );
}

function Performance({ summary }: { summary: PortfolioSummary }) {
  const rows: Array<[string, string]> = [
    ['Starting capital', inr(summary.startingBalance)],
    ['Available cash', inr(summary.availableBalance)],
    ['Margin blocked', inr(summary.marginUsed)],
    ['Position value', inr(summary.positionValue)],
    ['Realised P&L', `${sign(summary.realizedPnl)}${inr(Math.abs(summary.realizedPnl), 2)}`],
    ['Unrealised P&L', `${sign(summary.unrealizedPnl)}${inr(Math.abs(summary.unrealizedPnl), 2)}`],
    ['Net worth', inr(summary.netWorth)],
    ['Open positions', String(summary.openPositionsCount)],
  ];
  return (
    <dl className="space-y-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-4 border-b border-border pb-1.5 last:border-0">
          <dt className="text-xs text-muted">{label}</dt>
          <dd className="font-mono text-xs font-semibold tabular-nums text-text">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** P&L as a percentage of starting capital — a real denominator, not a
 *  hand-written figure like the one this page used to print. */
function deltaVsStart(value: number, startingBalance: number): string | undefined {
  if (!startingBalance) return undefined;
  return pct((value / startingBalance) * 100);
}

/** `isSignedIn` reads localStorage, which does not exist during SSR; reading it
 *  in render would make server and client HTML disagree. Same pattern the order
 *  ticket already uses. */
function useSignedIn(): boolean {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => setSignedIn(isSignedIn()), []);
  return signedIn;
}

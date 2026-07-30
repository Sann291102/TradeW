'use client';

import { useEffect, useState } from 'react';
import { Panel, Badge, EmptyState, Skeleton, cn } from '@tradew/ui';
import { fmt, inr, sign } from '@/lib/format';
import {
  type OrderDto,
  type PositionDto,
  type TradeDto,
  cancelOrder,
  fetchOrders,
  fetchPositions,
  fetchTrades,
  isSignedIn,
} from '@/lib/oms';
import type { DockPanelContentProps } from './types';

/**
 * The terminal blotter — Positions / Orders / Trades, live from the OMS.
 *
 * Previously a pure shell: every tab rendered "Data appears here once the
 * trading backend is connected", which was untrue — /sim/positions,
 * /sim/orders and /sim/trades were live and holding real fills. Same defect
 * the Portfolio page had, and the reason a filled order appeared nowhere in
 * the UI. Both are now wired to the same endpoints.
 *
 * Polls while mounted: position marks come from the live bridge price
 * server-side, and a resting order can be filled by the matching engine at any
 * time, so a one-shot read would be stale within seconds.
 *
 * The former "Activity" tab is gone. There is no activity endpoint, and a tab
 * that can only ever render an empty state is worse than one tab fewer.
 */

const TABS = ['Positions', 'Orders', 'Trades'] as const;
type Tab = (typeof TABS)[number];

const POLL_MS = 5_000;

/** Statuses worth showing in a working blotter — terminal ones are history. */
const LIVE_ORDER_STATUSES = new Set(['PENDING', 'OPEN', 'TRIGGER_PENDING', 'PARTIALLY_FILLED']);

export function BlotterPanel({ className, actions, collapsed }: DockPanelContentProps) {
  const [tab, setTab] = useState<Tab>('Positions');
  const [positions, setPositions] = useState<PositionDto[] | null>(null);
  const [orders, setOrders] = useState<OrderDto[] | null>(null);
  const [trades, setTrades] = useState<TradeDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);

  // localStorage does not exist during SSR; reading it in render would make
  // server and client HTML disagree. Same pattern as the order ticket.
  useEffect(() => setSignedIn(isSignedIn()), []);

  useEffect(() => {
    if (!signedIn || collapsed) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const [p, o, t] = await Promise.all([fetchPositions(), fetchOrders(), fetchTrades()]);
        if (cancelled) return;
        setPositions(p);
        setOrders(o);
        setTrades(t);
        setError(null);
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
  }, [signedIn, collapsed]);

  const counts: Record<Tab, number | null> = {
    Positions: positions?.length ?? null,
    Orders: orders?.filter((o) => LIVE_ORDER_STATUSES.has(o.status)).length ?? null,
    Trades: trades?.length ?? null,
  };

  return (
    <Panel
      className={className}
      actions={actions}
      collapsed={collapsed}
      title={
        <span role="tablist" aria-label="Blotter" className="flex items-center gap-1">
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                'rounded px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                tab === t ? 'bg-teal-bg text-teal' : 'text-muted hover:text-text',
              )}
            >
              {t}
              {counts[t] ? <span className="ml-1 font-mono tabular-nums opacity-70">{counts[t]}</span> : null}
            </button>
          ))}
        </span>
      }
    >
      {!signedIn ? (
        <EmptyState title="Not signed in" description="Your blotter lives on your account." />
      ) : error ? (
        <p role="alert" className="rounded-lg bg-amber-bg px-3 py-2 text-[11px] leading-relaxed text-amber">
          {error}
        </p>
      ) : (
        <>
          {tab === 'Positions' && <Positions rows={positions} />}
          {tab === 'Orders' && <Orders rows={orders} onCancel={(id) => void cancelOrder(id)} />}
          {tab === 'Trades' && <Trades rows={trades} />}
        </>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------- tables

function Loading() {
  return (
    <div className="space-y-1.5">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

function Positions({ rows }: { rows: PositionDto[] | null }) {
  if (rows === null) return <Loading />;
  if (rows.length === 0) return <EmptyState title="No open positions" description="Fills appear here immediately." />;
  return (
    <ul className="space-y-1">
      {rows.map((p) => {
        const up = p.unrealizedPnl >= 0;
        return (
          <li key={p.id} className="flex items-center justify-between gap-3 rounded border border-border2 bg-bg px-2 py-1.5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[11px] font-bold text-text">{p.displayName}</span>
                <Badge tone={p.quantity > 0 ? 'positive' : 'negative'} className="px-1 py-0 text-[8px]">
                  {p.quantity > 0 ? 'LONG' : 'SHORT'}
                </Badge>
                {p.priceStatus === 'stale' && (
                  <Badge tone="warning" className="px-1 py-0 text-[8px]">
                    STALE
                  </Badge>
                )}
              </div>
              <div className="font-mono text-[10px] tabular-nums text-faint">
                {Math.abs(p.quantity)} @ {fmt(p.avgPrice)} → {fmt(p.currentPrice)}
              </div>
            </div>
            <div className={cn('shrink-0 font-mono text-[11px] font-bold tabular-nums', up ? 'text-up' : 'text-down')}>
              {sign(p.unrealizedPnl)}
              {inr(Math.abs(p.unrealizedPnl), 2)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Orders({ rows, onCancel }: { rows: OrderDto[] | null; onCancel: (id: string) => void }) {
  if (rows === null) return <Loading />;
  if (rows.length === 0) return <EmptyState title="No orders yet" description="Placed orders appear here." />;
  return (
    <ul className="space-y-1">
      {rows.slice(0, 50).map((o) => {
        const live = LIVE_ORDER_STATUSES.has(o.status);
        return (
          <li key={o.id} className="flex items-center justify-between gap-3 rounded border border-border2 bg-bg px-2 py-1.5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className={cn('text-[10px] font-bold', o.side === 'BUY' ? 'text-up' : 'text-down')}>{o.side}</span>
                <span className="truncate text-[11px] font-semibold text-text">
                  {o.instrument?.displayName ?? o.instrument?.symbol ?? o.instrumentId}
                </span>
                <Badge tone={o.status === 'REJECTED' ? 'warning' : live ? 'brand' : 'neutral'} className="px-1 py-0 text-[8px]">
                  {o.status.replace('_', ' ')}
                </Badge>
              </div>
              <div className="font-mono text-[10px] tabular-nums text-faint">
                {o.filledQuantity}/{o.quantity} · {o.type}
                {o.avgFillPrice ? ` @ ${fmt(Number(o.avgFillPrice))}` : ''}
                {o.rejectReason ? ` · ${o.rejectReason}` : ''}
              </div>
            </div>
            {live && (
              <button
                type="button"
                onClick={() => onCancel(o.id)}
                className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold text-muted hover:bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                Cancel
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Trades({ rows }: { rows: TradeDto[] | null }) {
  if (rows === null) return <Loading />;
  if (rows.length === 0) return <EmptyState title="No trades today" description="Executed fills appear here." />;
  return (
    <ul className="space-y-1">
      {rows.slice(0, 50).map((t) => {
        const realized = t.realizedPnl === null ? null : Number(t.realizedPnl);
        return (
          <li key={t.id} className="flex items-center justify-between gap-3 rounded border border-border2 bg-bg px-2 py-1.5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className={cn('text-[10px] font-bold', t.side === 'BUY' ? 'text-up' : 'text-down')}>{t.side}</span>
                <span className="truncate text-[11px] font-semibold text-text">
                  {t.instrument?.displayName ?? t.instrument?.symbol ?? t.instrumentId}
                </span>
              </div>
              <div className="font-mono text-[10px] tabular-nums text-faint">
                {t.quantity} @ {fmt(Number(t.fillPrice))} · {timeLabel(t.executedAt)} · charges {inr(Number(t.charges), 2)}
              </div>
            </div>
            {realized !== null && (
              <div className={cn('shrink-0 font-mono text-[11px] font-bold tabular-nums', realized >= 0 ? 'text-up' : 'text-down')}>
                {sign(realized)}
                {inr(Math.abs(realized), 2)}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** 'HH:mm:ss' in IST — the exchange's clock, not the browser's. */
function timeLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Card, EmptyState, Skeleton, cn } from '@tradew/ui';
import { fetchTradeHistory } from '@/lib/oms';
import { qk } from '@/lib/query/keys';
import { LIVE_POLL_MS, liveQueryOptions } from '@/lib/query/live';
import { useSignedIn } from '@/lib/query/usePortfolio';
import { fmt, sign, inr } from '@/lib/format';

/** Today's date, IST, as `YYYY-MM-DD` — the `/sim/trade-history` filter
 *  boundary. NSE's own trading day is IST, matching every other date/time
 *  filter in the app (see lib/news.ts `newsTime`). */
function todayIsoIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

/**
 * TodaysTrades — the reference's "Today's Trades" card: Stock/Type/Qty/Price/
 * P&L rows with a Total P&L footer. New widget — no dashboard component
 * consumed `/sim/trade-history` before this. Footer sums exactly the rows
 * shown (not a separate performance-endpoint figure) so the number on screen
 * always reconciles with what's listed above it.
 */
export function TodaysTrades() {
  const signedIn = useSignedIn();

  const todayFilters = { from: todayIsoIst(), to: todayIsoIst(), pageSize: 20 };
  const query = useQuery({
    queryKey: qk.tradeHistory.list(todayFilters),
    queryFn: () => fetchTradeHistory(todayFilters),
    ...liveQueryOptions({ intervalMs: LIVE_POLL_MS, enabled: signedIn }),
  });

  const rows = query.data?.rows ?? null;
  const error =
    query.isError && !query.data
      ? query.error instanceof Error
        ? query.error.message
        : 'Could not reach the trading backend'
      : null;

  const totalPnl = rows?.reduce((sum, r) => sum + r.netPnl, 0) ?? 0;

  return (
    <Card
      title="Today's Trades"
      className="flex h-full flex-col"
      actions={
        <Link href="/portfolio" className="text-xs font-semibold text-teal hover:underline">
          View All
        </Link>
      }
    >
      {!signedIn ? (
        <div className="flex flex-1 flex-col justify-center">
          <EmptyState title="Sign in to see today's trades" description="Executed fills appear here as soon as an order fills on the Trade screen." />
        </div>
      ) : error ? (
        <div role="alert" className="py-4 text-center text-xs text-down">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="mt-1.5 font-semibold underline underline-offset-2 hover:no-underline"
          >
            Try again
          </button>
        </div>
      ) : rows === null ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-1 flex-col justify-center">
          <EmptyState title="No trades yet today" description="Fills placed today will show up here in real time." />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-faint">
                  <th className="pb-2 font-semibold">Stock</th>
                  <th className="pb-2 font-semibold">Type</th>
                  <th className="pb-2 text-right font-semibold">Qty</th>
                  <th className="pb-2 text-right font-semibold">Price</th>
                  <th className="pb-2 text-right font-semibold">P&amp;L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => {
                  const up = r.netPnl >= 0;
                  return (
                    <tr key={r.id}>
                      <td className="py-1.5 font-semibold text-text">{r.symbol}</td>
                      <td className={cn('py-1.5 font-bold', r.side === 'BUY' ? 'text-up' : 'text-down')}>{r.side}</td>
                      <td className="py-1.5 text-right font-mono tabular-nums text-muted">{r.quantity}</td>
                      <td className="py-1.5 text-right font-mono tabular-nums text-muted">{fmt(r.entryPrice)}</td>
                      <td className={cn('py-1.5 text-right font-mono font-semibold tabular-nums', up ? 'text-up' : 'text-down')}>
                        {sign(r.netPnl)}
                        {fmt(Math.abs(r.netPnl))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-border pt-2.5">
            <span className="text-xs font-semibold text-muted">Total P&amp;L</span>
            <span className={cn('font-mono text-sm font-bold tabular-nums', totalPnl >= 0 ? 'text-up' : 'text-down')}>
              {sign(totalPnl)}
              {inr(Math.abs(totalPnl), 2)}
            </span>
          </div>
        </>
      )}
    </Card>
  );
}

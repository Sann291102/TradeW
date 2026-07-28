'use client';

import { useEffect, useState } from 'react';
import { Badge, Card, Skeleton, cn } from '@tradew/ui';
import { pct, sign } from '@/lib/format';

/**
 * A live price board for one external market (crypto or FX).
 *
 * Shared by /crypto and /forex because the two differ only in provider, poll
 * interval and number formatting — not in behaviour. Read-only by design:
 * there is no order affordance anywhere on it, because neither market is
 * placeable in the rupee-denominated paper OMS.
 *
 * Honest failure: when the provider is unreachable this renders the reason,
 * not an empty table and not the last-known prices. Consistent with the rule
 * the Dhan charts already follow — a stale price under a live-looking ticker is
 * the most expensive kind of wrong a trading screen can be.
 *
 * Mobile-first: the grid collapses to one card per row on a phone; every row is
 * a self-contained card rather than a wide table that would need horizontal
 * scrolling.
 */

export interface BoardRow {
  symbol: string;
  displayName: string;
  ltp: number;
  change: number;
  changePct: number;
  high: number;
  low: number;
  marketOpen: boolean;
}

export interface GlobalMarketBoardProps {
  title: string;
  subtitle: string;
  /** Provider attribution — shown so the source of every number is visible. */
  sourceLabel: string;
  load: () => Promise<BoardRow[]>;
  pollMs: number;
  /** Decimal places for the price column; FX needs more than crypto. */
  precision: number;
  /** Optional caveat rendered under the board (e.g. a proxy-pair warning). */
  note?: string;
}

export function GlobalMarketBoard({
  title,
  subtitle,
  sourceLabel,
  load,
  pollMs,
  precision,
  note,
}: GlobalMarketBoardProps) {
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const next = await load();
        if (cancelled) return;
        setRows(next);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        // Keep whatever is already on screen ONLY if we have never succeeded;
        // otherwise surface the failure so nobody reads stale numbers as live.
        setError(err instanceof Error ? err.message : 'Could not reach the market-data service');
      } finally {
        if (!cancelled) timer = setTimeout(tick, pollMs);
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `load` is a stable module-level function per page; poll interval is constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollMs]);

  const open = rows?.some((r) => r.marketOpen) ?? false;

  return (
    <Card
      title={title}
      subtitle={subtitle}
      actions={
        rows && !error ? (
          <Badge tone={open ? 'positive' : 'neutral'} className="px-1.5 py-0 text-[9px]">
            {open ? 'LIVE' : 'CLOSED'}
          </Badge>
        ) : undefined
      }
    >
      {error && (
        <p role="alert" className="rounded-lg bg-amber-bg px-3 py-2 text-xs leading-relaxed text-amber">
          {error} — nothing is shown rather than a stale price.
        </p>
      )}

      {!rows && !error && (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      )}

      {rows && !error && (
        <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => {
            const up = r.changePct >= 0;
            return (
              <li
                key={r.symbol}
                className="flex items-center justify-between gap-3 rounded-lg border border-border2 bg-bg px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-xs font-bold text-text">{r.displayName}</div>
                  <div className="truncate text-[10px] text-faint">
                    H {r.high.toFixed(precision)} · L {r.low.toFixed(precision)}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-sm font-bold tabular-nums text-text">
                    {r.ltp.toFixed(precision)}
                  </div>
                  <div className={cn('font-mono text-[11px] tabular-nums', up ? 'text-up' : 'text-down')}>
                    {sign(r.change)}
                    {Math.abs(r.change).toFixed(precision)} ({pct(r.changePct)})
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-faint">
        {sourceLabel} Prices are shown for reference — these markets are not tradeable in your paper account.
        {note ? ` ${note}` : ''}
      </p>
    </Card>
  );
}

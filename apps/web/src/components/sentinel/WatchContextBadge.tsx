'use client';

import { cn } from '@tradew/ui';
import { useDhanLiveFeed } from '@/lib/hooks/useDhanLiveFeed';
import { useSentinelWatch } from '@/lib/sentinel/WatchContext';
import { findMarket } from '@/lib/sentinel/markets';
import { expiryTag } from '@/lib/sentinel/watchState';

/**
 * What the workspace is currently pointed at, in the toolbar slot the two
 * duplicate selectors used to occupy.
 *
 * It replaced them rather than joining them: the top-right `MarketSelector` and
 * `OptionChainPanel` were a second market dropdown and a second strike picker
 * for choices the "Watch market" section already owns, and the chain panel's
 * picks had not reached anything since 2026-08-11 (see `WatchContext.tsx`). The
 * space now reports the canonical selection instead of offering a competing way
 * to set it — one control for choosing, one readout for confirming.
 *
 * ── EVERY VALUE HERE IS REAL OR ABSENT ─────────────────────────────────────
 * The market, expiry and both strikes come from the canonical `WatchSelection`.
 * The connection state and tick time come from the shared Dhan feed singleton.
 * Nothing is placeholder: a leg with no strike selected prints an em dash, and
 * the tick line is omitted entirely when the feed has never delivered a quote
 * for this symbol rather than showing a stale or invented time.
 */
export function WatchContextBadge() {
  const { selection, mode, instruments } = useSentinelWatch();
  const { quotes, stocks, etfs, commodities, status } = useDhanLiveFeed();

  const market = findMarket(selection.symbol);

  // The same lookup `useCandles` does — the bridge groups its universe, and the
  // selected market may be an index, a stock, an ETF or a commodity.
  const quote =
    [...(quotes ?? []), ...(stocks ?? []), ...(etfs ?? []), ...(commodities ?? [])].find(
      (q) => q.symbol === selection.symbol,
    ) ?? null;

  const feed: { label: string; tone: string } =
    status === 'live'
      ? { label: 'Live', tone: 'text-up' }
      : status === 'closed'
        ? { label: 'Market closed', tone: 'text-muted' }
        : status === 'loading'
          ? { label: 'Connecting', tone: 'text-muted' }
          : { label: 'Feed unreachable', tone: 'text-down' };

  return (
    <div className="flex flex-wrap items-stretch gap-2.5">
      <div className="rounded-xl border border-border bg-card px-3.5 py-2 shadow-elev1">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">Watching</p>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <span className="font-mono text-[13px] font-bold text-text">{market.symbol}</span>
          {mode === 'underlying' ? (
            <span className="text-[11px] text-muted">underlying</span>
          ) : (
            <>
              {selection.expiry && (
                <span className="font-mono text-[11px] text-muted">{expiryTag(selection.expiry)}</span>
              )}
              <span className="font-mono text-[11.5px] font-semibold text-up">
                CALL {instruments.call?.strike ?? '—'}
              </span>
              <span className="font-mono text-[11.5px] font-semibold text-down">
                PUT {instruments.put?.strike ?? '—'}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card px-3.5 py-2 shadow-elev1">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">Feed</p>
        <div className="mt-0.5 flex items-baseline gap-2">
          <span
            aria-hidden
            className={cn(
              'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
              status === 'live' ? 'bg-up' : status === 'unreachable' ? 'bg-down' : 'bg-muted',
            )}
          />
          <span className={cn('text-[11.5px] font-semibold', feed.tone)}>{feed.label}</span>
          <span className="text-[10.5px] text-faint">Dhan</span>
        </div>
        {/* Omitted, not faked, when no quote for this symbol has arrived — or
            when one has but carries no observed price, so there is no tick time
            to name. */}
        {quote?.updatedAt && (
          <p className="mt-0.5 font-mono text-[10px] text-faint">
            tick{' '}
            {new Date(quote.updatedAt).toLocaleTimeString('en-GB', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              timeZone: 'Asia/Kolkata',
            })}
          </p>
        )}
      </div>
    </div>
  );
}

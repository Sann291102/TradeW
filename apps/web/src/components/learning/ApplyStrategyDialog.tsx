'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, cn } from '@tradew/ui';
import { fetchDhanExpiryList } from '@/lib/dhanLiveFeed';
import { EXPIRIES, formatExpiryLabel } from '@/lib/mock/optionChain';

/**
 * The instrument + expiry picker behind a strategy's "Apply" action.
 *
 * Applying is VISUALISE-ONLY — it navigates to /trade, where the strategy's
 * legs are drawn on the chart with a payoff curve. Nothing is ordered and no
 * paper position is opened, per LEARNING-HUB.md §6 (the Learning Hub is
 * education, not a signal service). The copy in this dialog says so, because a
 * button labelled "Apply" next to a trading strategy invites the other reading.
 */

/**
 * Index underlyings that carry listed options, with their expiry cadence.
 *
 * `weekly` is a real structural fact, not decoration: SEBI's November 2024
 * rationalisation left each exchange with weekly contracts on ONE index — NIFTY
 * on NSE, SENSEX on BSE. Everything else is monthly-only, which changes how
 * long a position is held and therefore its whole theta profile. Surfacing it
 * at the moment of choosing avoids the common assumption that BANKNIFTY still
 * has weeklies. See docs/learning/india-market-structure/expiry-architecture.md.
 */
const UNDERLYINGS = [
  { symbol: 'NIFTY', name: 'NIFTY 50', exchange: 'NSE', weekly: true },
  { symbol: 'BANKNIFTY', name: 'NIFTY Bank', exchange: 'NSE', weekly: false },
  { symbol: 'FINNIFTY', name: 'NIFTY Financial Services', exchange: 'NSE', weekly: false },
  { symbol: 'MIDCPNIFTY', name: 'NIFTY Midcap Select', exchange: 'NSE', weekly: false },
  { symbol: 'SENSEX', name: 'BSE Sensex', exchange: 'BSE', weekly: true },
] as const;

export interface ApplyStrategyDialogProps {
  strategyId: string;
  strategyName: string;
  legCount: number;
  onClose: () => void;
}

export function ApplyStrategyDialog({ strategyId, strategyName, legCount, onClose }: ApplyStrategyDialogProps) {
  const router = useRouter();
  const [symbol, setSymbol] = useState<string>(UNDERLYINGS[0].symbol);
  const [expiries, setExpiries] = useState<string[] | null>(null);
  const [expiry, setExpiry] = useState<string | null>(null);
  /** True when showing the simulated expiry table rather than Dhan's own. */
  const [simulated, setSimulated] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Escape closes, and focus moves into the dialog on open so keyboard users
  // are not left behind on the trigger button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Real expiry dates for the chosen underlying, straight from Dhan's option
  // chain, falling back to the shared simulated table when the market-data
  // bridge is unreachable (it is a separate process from web/api, and is often
  // not running outside market hours).
  //
  // The fallback is labelled, not hidden. Blocking Apply entirely whenever the
  // bridge is down would make the whole feature depend on a process that is
  // frequently absent, and `resolveExpiry` already accepts either a real ISO
  // date or a simulated label — so the trade page handles both identically.
  useEffect(() => {
    let cancelled = false;
    setExpiries(null);
    setExpiry(null);

    // Not named `useFallback` — the `use` prefix makes eslint's rules-of-hooks
    // treat a plain callback as a hook and fail the build.
    const applyFallback = () => {
      if (cancelled) return;
      const labels = EXPIRIES.map((e) => e.label);
      setSimulated(true);
      setExpiries(labels);
      setExpiry(labels[0] ?? null);
    };

    fetchDhanExpiryList(symbol)
      .then((list) => {
        if (cancelled) return;
        if (!list.length) return applyFallback();
        setSimulated(false);
        setExpiries(list);
        setExpiry(list[0]);
      })
      .catch(applyFallback);

    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const apply = useCallback(() => {
    if (!expiry) return;
    const params = new URLSearchParams({ symbol, expiry, strategy: strategyId });
    router.push(`/trade?${params.toString()}`);
    closeRef.current();
  }, [expiry, router, strategyId, symbol]);

  const selected = UNDERLYINGS.find((u) => u.symbol === symbol)!;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="apply-strategy-title"
        tabIndex={-1}
        className="w-full max-w-md rounded-card border border-border bg-card p-4 shadow-card focus:outline-none"
      >
        <h2 id="apply-strategy-title" className="text-sm font-bold text-text">
          See {strategyName} on a chart
        </h2>
        <p className="mt-1 text-[11px] text-faint">
          Draws the structure&apos;s {legCount} {legCount === 1 ? 'leg' : 'legs'} against live prices, with the bands
          where it gains and loses. Nothing is ordered and no position is opened.
        </p>

        <div className="mt-4">
          <label className="text-[11px] font-semibold uppercase tracking-wide text-muted" id="underlying-label">
            Market
          </label>
          <div className="mt-1.5 grid gap-1.5" role="radiogroup" aria-labelledby="underlying-label">
            {UNDERLYINGS.map((u) => (
              <button
                key={u.symbol}
                role="radio"
                aria-checked={symbol === u.symbol}
                onClick={() => setSymbol(u.symbol)}
                className={cn(
                  'flex items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors duration-micro',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                  symbol === u.symbol ? 'border-teal bg-teal-bg' : 'border-border hover:border-teal',
                )}
              >
                <span>
                  <span className="block text-xs font-semibold text-text">{u.symbol}</span>
                  <span className="block text-[10.5px] text-faint">{u.name}</span>
                </span>
                <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
                  {u.weekly ? `${u.exchange} · weekly` : `${u.exchange} · monthly only`}
                </Badge>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <label htmlFor="expiry-select" className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            Expiry
          </label>
          {expiries === null ? (
            <div className="mt-1.5 h-9 w-full animate-pulse rounded-lg bg-hover" />
          ) : (
            <select
              id="expiry-select"
              value={expiry ?? ''}
              onChange={(e) => setExpiry(e.target.value)}
              className={cn(
                'mt-1.5 w-full rounded-lg border border-border bg-bg px-3 py-2 text-xs text-text',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              )}
            >
              {expiries.map((value) => (
                <option key={value} value={value}>
                  {simulated ? value : formatExpiryLabel(value)}
                </option>
              ))}
            </select>
          )}
          {expiries !== null && (
            <p className="mt-1.5 text-[10.5px] text-faint">
              {simulated && 'Simulated expiry dates — the live market-data bridge is unreachable. '}
              {!selected.weekly && `${selected.symbol} has no weekly contracts, so these are monthly expiries.`}
            </p>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={apply} disabled={!expiry}>
            Show on chart
          </Button>
        </div>
      </div>
    </div>
  );
}

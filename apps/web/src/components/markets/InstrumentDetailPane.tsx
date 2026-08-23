'use client';

import { useEffect, useRef, useState } from 'react';
import { Card, Panel, IconButton, cn } from '@tradew/ui';
import { CloseIcon } from '@/components/shell/icons';
import { pct, sign } from '@/lib/format';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import {
  TradingViewWidget,
  TV_INTERVALS,
  type TvInterval,
} from '@/components/charts/TradingViewWidget';
import { cryptoTradingViewSymbol, fxTradingViewSymbol } from '@/lib/markets/tradingViewSymbols';
import type { BoardRow } from './GlobalMarketBoard';

/**
 * The expanded instrument view for a USD venue, rendered IN PLACE underneath
 * the Markets board.
 *
 * ── WHY THIS IS NOT THE TRADE PAGE ─────────────────────────────────────────
 *
 * It is shaped like `TradeWorkspace` on purpose — the same
 * `lg:grid-cols-[1fr_360px]` split, chart on the left, instrument column on the
 * right — so opening a crypto chart feels like the workspace a trader already
 * knows. It is not that page, and it deliberately cannot become it.
 *
 * Nothing here routes. There is no `router.push('/trade')` anywhere in this
 * tree, and the board rows that open it call a callback rather than a link.
 * That is a correctness boundary, not a styling preference:
 *
 *  · /trade prices against the Dhan feed. It has no quote for BTCUSDT and
 *    never will — the symbol is not in the scrip master.
 *  · Its order ticket writes to the rupee OMS, where `Order.quantity` is an
 *    `Int` and prices are `Decimal(12,2)`. The smallest expressible crypto
 *    order there is one whole BTC.
 *  · Its option-chain, depth and technicals tabs are all Dhan-shaped. None of
 *    them has a meaning on a spot FX pair.
 *
 * Routing a crypto click into /trade would therefore land on a page showing an
 * order ticket for an instrument it cannot price and the OMS cannot accept.
 * Keeping the expansion local is what makes the click safe.
 *
 * ── WHY THERE IS NO ORDER TICKET (YET) ─────────────────────────────────────
 *
 * The right column shows instrument statistics, not a ticket. Crypto paper
 * trading has a home already — `CryptoWallet` / `CryptoOrder` /
 * `CryptoPosition` in schema.prisma, USD and spot-only, migrated in
 * `20260729000000_crypto_space` — but no service writes to those tables yet.
 * Until one does, a ticket here would be a control that drops its input, so
 * the column states the position honestly instead.
 */

export type UsdVenue = 'CRYPTO' | 'FX';

export interface InstrumentDetailPaneProps {
  venue: UsdVenue;
  /** Vendor symbol — `BTCUSDT` for crypto, `EUR/USD` for FX. */
  symbol: string;
  /** The board row for this symbol, when the board currently has one. Null
   *  while the board is still loading or if the symbol dropped out of it. */
  row: BoardRow | null;
  precision: number;
  onClose: () => void;
}

/** One statistic. Renders an em dash rather than a zero when the board has no
 *  row yet — a 0.00 high on a live instrument is a wrong number, not a
 *  placeholder. */
function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border py-2 last:border-b-0">
      <span className="text-[11px] text-faint">{label}</span>
      <span
        className={cn(
          'font-mono text-xs tabular-nums',
          tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text',
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function InstrumentDetailPane({
  venue,
  symbol,
  row,
  precision,
  onClose,
}: InstrumentDetailPaneProps) {
  const [interval, setInterval] = useState<TvInterval>('15m');
  const headingRef = useRef<HTMLDivElement>(null);

  // Scroll the pane into view when it opens, and again when the instrument
  // changes. Without this, picking a row near the bottom of a twelve-row board
  // expands a 600px panel entirely below the fold and looks like nothing
  // happened.
  useEffect(() => {
    headingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [symbol]);

  // Escape closes, matching every other dismissible surface in the shell.
  // Scoped to this component rather than added to `closeAllOverlays` because
  // this is inline page content, not an overlay — it does not trap focus and
  // must not be swept up by a global "close everything" that also shuts modals.
  //
  // Deferred while any overlay is open, for the same reason. The command
  // palette, AI dock, notification centre and shortcuts sheet all render ON TOP
  // of this pane and all close on Escape; without this guard one Escape press
  // would dismiss the overlay the user was actually looking at AND collapse the
  // chart underneath it, which reads as the page losing its place.
  const overlayOpen = useWorkspaceStore(
    (s) => s.commandPaletteOpen || s.aiDockOpen || s.notificationCenterOpen || s.shortcutsHelpOpen || s.mobileNavOpen,
  );
  useEffect(() => {
    if (overlayOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, overlayOpen]);

  const tvSymbol = venue === 'CRYPTO' ? cryptoTradingViewSymbol(symbol) : fxTradingViewSymbol(symbol);

  const sourceNote =
    venue === 'CRYPTO'
      ? `Chart by TradingView (${tvSymbol}) — the same Binance market the prices above are polled from.`
      : `Chart by TradingView (${tvSymbol}), an ICE Data composite. The prices above come from Twelve Data's interbank composite — two aggregators of the same market, so they agree closely but do not tick together.`;

  const up = (row?.changePct ?? 0) >= 0;
  const fmtPrice = (n: number | undefined) => (n == null ? '—' : n.toFixed(precision));

  return (
    <div ref={headingRef} className="scroll-mt-20">
      <Card
        title={row?.displayName ?? symbol}
        subtitle={venue === 'CRYPTO' ? '· Binance · USD' : '· interbank spot · USD'}
        actions={
          <IconButton aria-label="Close chart" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        }
      >
        {/* Same split as TradeWorkspace — see the note at the top of this file
            for why it looks like that page and is not it. */}
        <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-[1fr_360px]">
          <div className="flex min-w-0 flex-col gap-3">
            <div role="tablist" aria-label="Chart timeframe" className="flex flex-wrap gap-1">
              {TV_INTERVALS.map((tf) => (
                <button
                  key={tf}
                  role="tab"
                  aria-selected={interval === tf}
                  onClick={() => setInterval(tf)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors duration-micro',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                    interval === tf ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
                  )}
                >
                  {tf}
                </button>
              ))}
            </div>

            <TradingViewWidget
              symbol={tvSymbol}
              interval={interval}
              sourceNote={sourceNote}
              className="min-h-[460px] flex-1"
            />
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <Panel title="Instrument" elevation={1}>
              <div className="flex flex-col">
                <Stat label="Last" value={fmtPrice(row?.ltp)} />
                <Stat
                  label="Change"
                  value={
                    row ? `${sign(row.change)}${Math.abs(row.change).toFixed(precision)}` : '—'
                  }
                  tone={row ? (up ? 'up' : 'down') : undefined}
                />
                <Stat
                  label="Change %"
                  value={row ? pct(row.changePct) : '—'}
                  tone={row ? (up ? 'up' : 'down') : undefined}
                />
                <Stat label="High" value={fmtPrice(row?.high)} />
                <Stat label="Low" value={fmtPrice(row?.low)} />
                <Stat label="Symbol" value={symbol} />
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-faint">
                {row
                  ? 'Statistics from our own market-data service, on the board’s poll interval — not read from the chart.'
                  : 'Waiting for the board’s first quote for this instrument.'}
              </p>
            </Panel>

            <Panel title="Trading" elevation={1}>
              <p className="text-[11.5px] leading-relaxed text-faint">
                {venue === 'CRYPTO' ? (
                  <>
                    Crypto is not placeable yet. The USD paper wallet it will settle against exists in
                    the database but nothing writes to it, so there is no order ticket here rather
                    than one that would discard what you enter.
                  </>
                ) : (
                  <>
                    Spot FX is not placeable. It has no paper wallet or position model at all, and
                    unlike crypto it is a margined, lot-denominated market that would need one of its
                    own before an order could mean anything.
                  </>
                )}
              </p>
            </Panel>
          </div>
        </div>
      </Card>
    </div>
  );
}

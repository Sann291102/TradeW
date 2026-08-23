'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, Badge, cn } from '@tradew/ui';
import { TradeIcon } from '@/components/shell/icons';
import { SECTORS, SECTOR_STOCKS, COMMODITIES } from '@/lib/mock/market';
import { ALL_NSE_INDICES } from '@/lib/mock/indices';
import { FO_STOCK_UNIVERSE } from '@/lib/mock/foUniverse';
import { useDhanLiveFeed, type DhanFeedStatus } from '@/lib/hooks/useDhanLiveFeed';
import { fmt, pct } from '@/lib/format';
import { useWorkspaceStore, type MarketCurrency } from '@/lib/store/workspaceStore';
import { CryptoBoard, ForexBoard, CRYPTO_PRECISION, FX_PRECISION } from './ExternalBoards';
import { InstrumentDetailPane, type UsdVenue } from './InstrumentDetailPane';
import type { BoardRow } from './GlobalMarketBoard';

/**
 * Categories, grouped by the currency the venue actually quotes in.
 *
 * The rupee venues are the Dhan-fed Indian markets this page has always shown.
 * The dollar venues are Crypto and Forex, which used to be two separate
 * sidebar entries with their own routes — they are venues, exactly like
 * Commodities, so they belong here rather than beside Portfolio and Settings.
 *
 * The two lists never mix on screen. See `MarketCurrency` in workspaceStore
 * for why nothing is converted between them.
 */
const INR_CATEGORIES = ['Indices', 'Stocks', 'ETFs', 'Commodities'] as const;
const USD_CATEGORIES = ['Crypto', 'Forex'] as const;

type Category = (typeof INR_CATEGORIES)[number] | (typeof USD_CATEGORIES)[number];

const CATEGORIES_BY_CURRENCY: Record<MarketCurrency, readonly Category[]> = {
  INR: INR_CATEGORIES,
  USD: USD_CATEGORIES,
};

/** `?cat=` deep-link values, lower-cased. `/crypto` and `/forex` redirect to
 *  `/markets?cat=crypto|forex`, so these two names are load-bearing URLs, not
 *  just internal state. */
const CATEGORY_BY_PARAM: Record<string, Category> = {
  indices: 'Indices',
  stocks: 'Stocks',
  etfs: 'ETFs',
  commodities: 'Commodities',
  crypto: 'Crypto',
  forex: 'Forex',
};

function currencyOf(cat: Category): MarketCurrency {
  return (USD_CATEGORIES as readonly string[]).includes(cat) ? 'USD' : 'INR';
}

function venueOf(cat: Category): UsdVenue | null {
  return cat === 'Crypto' ? 'CRYPTO' : cat === 'Forex' ? 'FX' : null;
}

/** The Dhan bridge's index symbols, mapped onto the matching `ALL_NSE_INDICES`
 *  row name — NSE's own index list uses full names ("NIFTY 50"), the bridge
 *  uses ticker-style symbols. SENSEX has no row here (BSE index, this list is
 *  NSE-only), so it never overlays. */
const INDEX_NAME_TO_DHAN_SYMBOL: Record<string, string> = {
  'NIFTY 50': 'NIFTY',
  'NIFTY BANK': 'BANKNIFTY',
  'NIFTY FINANCIAL SERVICES': 'FINNIFTY',
  'INDIA VIX': 'INDIAVIX',
};

/** A row generic enough to cover indices/stocks/ETFs/commodities in one table. */
interface QuoteRow {
  symbol: string;
  name: string;
  ltp: number | null;
  changePct: number | null;
  isLive: boolean;
}

/** Buy / Sell / Chart, revealed on row hover (or keyboard focus). Same
 *  `/trade?symbol=…&action=buy|sell` convention the Option Chain's
 *  QuickActionsDock already uses — no separate order-entry flow invented
 *  here, this just routes into the existing trade page. */
function RowActions({ symbol }: { symbol: string }) {
  const router = useRouter();
  return (
    <div
      className="ml-2 flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-micro group-hover:opacity-100 group-focus-within:opacity-100"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        title={`Buy ${symbol}`}
        aria-label={`Buy ${symbol}`}
        onClick={() => router.push(`/trade?symbol=${symbol}&action=buy`)}
        className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-up transition-colors duration-micro hover:bg-up-bg"
      >
        B
      </button>
      <button
        type="button"
        title={`Sell ${symbol}`}
        aria-label={`Sell ${symbol}`}
        onClick={() => router.push(`/trade?symbol=${symbol}&action=sell`)}
        className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-down transition-colors duration-micro hover:bg-down-bg"
      >
        S
      </button>
      <button
        type="button"
        title={`Open ${symbol} chart`}
        aria-label={`Open ${symbol} chart`}
        onClick={() => router.push(`/trade?symbol=${symbol}`)}
        className="flex h-6 w-6 items-center justify-center rounded-full text-teal transition-colors duration-micro hover:bg-teal-bg"
      >
        <TradeIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** Single consistent row layout for Stocks/ETFs/Commodities — replaces the
 *  old two-column grid, whose alignment broke as soon as some rows had a
 *  price sub-line and others didn't. Every row is the same height and shape
 *  now regardless of whether the bridge has live data for that symbol. */
function QuoteList({ rows, emptyMessage }: { rows: QuoteRow[]; emptyMessage: string }) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">{emptyMessage}</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {rows.map((r) => {
        const up = (r.changePct ?? 0) >= 0;
        return (
          <li key={r.symbol} className="group flex items-center gap-3 rounded-lg px-2 py-2.5 -mx-2 transition-colors duration-micro hover:bg-hover">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-text">
                {r.symbol}
                {r.isLive && <span className="ml-1.5 text-[9px] font-normal text-teal">●</span>}
              </div>
              <div className="truncate text-[11px] text-faint">{r.name}</div>
            </div>
            <div className="w-24 shrink-0 text-right">
              {r.ltp != null ? (
                <>
                  <div className="font-mono text-sm tabular-nums text-text">{fmt(r.ltp)}</div>
                  <div className={cn('font-mono text-[11px] tabular-nums', up ? 'text-up' : 'text-down')}>
                    {r.changePct != null ? pct(r.changePct) : '—'}
                  </div>
                </>
              ) : (
                <span className="text-xs text-faint">—</span>
              )}
            </div>
            <RowActions symbol={r.symbol} />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Currency switch — ₹ INR / $ USD.
 *
 * This is what lets a trader move between the Indian venues and the global
 * ones. It selects which markets are on screen; it does not convert anything,
 * and the label says so on hover rather than leaving the question open.
 */
function CurrencySwitch({
  value,
  onChange,
}: {
  value: MarketCurrency;
  onChange: (c: MarketCurrency) => void;
}) {
  const OPTIONS: { id: MarketCurrency; label: string; title: string }[] = [
    { id: 'INR', label: '₹ INR', title: 'Indian venues — indices, stocks, ETFs and commodities, quoted in rupees' },
    { id: 'USD', label: '$ USD', title: 'Global venues — crypto and spot forex, quoted in US dollars' },
  ];
  return (
    <div
      role="group"
      aria-label="Market currency"
      className="flex items-center rounded-lg border border-border2 p-0.5 text-xs font-bold"
    >
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          title={o.title}
          onClick={() => onChange(o.id)}
          className={cn(
            'rounded-md px-2.5 py-1 transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
            value === o.id ? 'bg-teal-bg text-teal' : 'text-muted hover:text-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function LiveBadge({ status }: { status: DhanFeedStatus }) {
  if (status === 'live') return <Badge tone="positive" className="px-1.5 py-0 text-[9px]">LIVE</Badge>;
  if (status === 'closed') return <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">CLOSED</Badge>;
  return null;
}

/**
 * Markets workspace — converted from the canonical `pageMarkets`. Category tabs
 * over a quotes table. Futures and Options are handled by the dedicated
 * Option Chain terminal panel (chart-tabs/OptionChainTab.tsx), not this page,
 * so they aren't listed here.
 *
 * Indices tab: every NSE index (`ALL_NSE_INDICES`, 139 rows — real dated
 * figures from the user-supplied `MW-All-Indices-*.csv`, see
 * lib/mock/indices.ts), live-overlaid for the 4 the bridge covers.
 *
 * Stocks tab: every NSE F&O-eligible stock (`FO_STOCK_UNIVERSE`, ~210
 * symbols — see lib/mock/foUniverse.ts), live-overlaid for the ~211 the
 * Dhan bridge resolves from its own scrip master at boot (effectively the
 * whole list). `?sector=<key>` narrows to one sector's constituents.
 *
 * ETFs tab: sourced entirely from the Dhan bridge — no separate static ETF
 * list exists, unlike Stocks/Indices, since there's no equivalent curated
 * source file for ETFs. Empty until the bridge is reachable.
 */
export function MarketsWorkspace() {
  const searchParams = useSearchParams();
  const sectorParam = searchParams.get('sector');
  const catParam = searchParams.get('cat');

  const marketCurrency = useWorkspaceStore((s) => s.marketCurrency);
  const setMarketCurrency = useWorkspaceStore((s) => s.setMarketCurrency);
  const setMarketVenue = useWorkspaceStore((s) => s.setMarketVenue);
  const hasHydrated = useWorkspaceStore((s) => s.hasHydrated);

  // `?cat=` wins on first render — a link to /markets?cat=crypto (which is what
  // /crypto now redirects to) has to land on Crypto regardless of anything
  // stored.
  //
  // The stored currency is deliberately NOT read here. The workspace store is
  // created with `skipHydration: true` and rehydrates in an effect after mount
  // (see useHydrated.ts), so at this point `marketCurrency` is always its
  // default 'INR' — reading it would look like it worked and silently ignore
  // what the trader actually last chose. It is adopted in the effect below,
  // once hydration has really happened.
  const initialCat: Category =
    (catParam ? CATEGORY_BY_PARAM[catParam.toLowerCase()] : undefined) ??
    (sectorParam ? 'Stocks' : 'Indices');

  const [cat, setCat] = useState<Category>(initialCat);
  // Whether the trader has picked a tab (or arrived on an explicit link) since
  // mount. Guards the one-shot hydration adoption below from yanking the view
  // out from under a click that lands in the same tick as rehydration.
  const [touched, setTouched] = useState<boolean>(!!catParam || !!sectorParam);
  const [sector, setSector] = useState<string | null>(sectorParam);
  const [indexFilter, setIndexFilter] = useState('');
  const [stockFilter, setStockFilter] = useState('');
  const [etfFilter, setEtfFilter] = useState('');

  // The instrument expanded in the detail pane, and the board rows behind it.
  // Both are scoped to the USD venues: the rupee categories already open their
  // instruments on /trade, which is the correct destination for an instrument
  // the OMS can actually price.
  const [selected, setSelected] = useState<{ venue: UsdVenue; symbol: string } | null>(null);
  const [cryptoRows, setCryptoRows] = useState<BoardRow[]>([]);
  const [fxRows, setFxRows] = useState<BoardRow[]>([]);

  const currency = currencyOf(cat);
  const venue = venueOf(cat);

  // a new ?sector= link (clicking a different heatmap tile while already on
  // this page) should re-open the filter, not be stuck on the first value
  useEffect(() => {
    if (sectorParam) {
      setTouched(true);
      setSector(sectorParam);
      setCat('Stocks');
    }
  }, [sectorParam]);

  // Same for a new ?cat= link arriving while already on this page — the
  // /crypto and /forex redirects both land that way.
  useEffect(() => {
    const fromParam = catParam ? CATEGORY_BY_PARAM[catParam.toLowerCase()] : undefined;
    if (fromParam) {
      setTouched(true);
      setCat(fromParam);
      setSector(null);
    }
  }, [catParam]);

  // Adopt the stored currency once localStorage has actually been read, unless
  // the URL or the trader has already chosen a tab. This is what makes the
  // switch stick between visits; see `initialCat` for why it cannot be done
  // during the first render.
  useEffect(() => {
    if (!hasHydrated || touched) return;
    setTouched(true);
    if (marketCurrency !== 'INR') setCat(CATEGORIES_BY_CURRENCY[marketCurrency][0]);
  }, [hasHydrated, touched, marketCurrency]);

  // Keep the stored currency in step with the tab actually being viewed, so
  // the next visit reopens where the trader left off. Gated on hydration:
  // writing before the store has been read would persist the pre-hydration
  // default over whatever was saved, which is the same bug from the other end.
  useEffect(() => {
    if (!hasHydrated) return;
    setMarketCurrency(currency);
  }, [hasHydrated, currency, setMarketCurrency]);

  // Publish the venue for the top bar's session pill, and hand it back to NSE
  // on unmount — the pill is global chrome and must not keep claiming "Crypto
  // 24/7" after the user has navigated to Portfolio.
  useEffect(() => {
    setMarketVenue(venue === 'CRYPTO' ? 'CRYPTO' : venue === 'FX' ? 'FX' : 'NSE');
    return () => setMarketVenue('NSE');
  }, [venue, setMarketVenue]);

  // Close the expanded chart when the tab changes. Leaving a BTCUSDT chart
  // open under the Forex board would attribute it to the wrong venue.
  useEffect(() => {
    setSelected(null);
  }, [cat]);

  const { quotes: liveIndices, stocks: liveStocks, etfs: liveEtfs, commodities: liveCommodities, status } = useDhanLiveFeed();
  const live = status === 'live' || status === 'closed';
  const liveIndexByDhanSymbol = live ? new Map((liveIndices ?? []).map((q) => [q.symbol, q])) : null;
  const liveStockBySymbol = live ? new Map((liveStocks ?? []).map((q) => [q.symbol, q])) : null;
  const liveCommodityBySymbol = live ? new Map((liveCommodities ?? []).map((q) => [q.symbol, q])) : null;

  const sectorMeta = sector ? SECTORS.find((s) => s.key === sector) : null;
  const sectorStocks = sector ? SECTOR_STOCKS[sector] : null;

  const filteredIndices = useMemo(() => {
    const q = indexFilter.trim().toLowerCase();
    if (!q) return ALL_NSE_INDICES;
    return ALL_NSE_INDICES.filter((i) => i.name.toLowerCase().includes(q));
  }, [indexFilter]);

  const filteredUniverse = useMemo(() => {
    const q = stockFilter.trim().toLowerCase();
    if (!q) return FO_STOCK_UNIVERSE;
    return FO_STOCK_UNIVERSE.filter((s) => s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
  }, [stockFilter]);

  const filteredEtfs = useMemo(() => {
    const all = liveEtfs ?? [];
    const q = etfFilter.trim().toLowerCase();
    if (!q) return all;
    return all.filter((e) => e.symbol.toLowerCase().includes(q) || e.displayName.toLowerCase().includes(q));
  }, [liveEtfs, etfFilter]);

  const stockRows: QuoteRow[] = sectorStocks
    ? sectorStocks.map((r) => {
        const liveMatch = liveStockBySymbol?.get(r.symbol);
        return { symbol: r.symbol, name: r.name, ltp: liveMatch?.ltp ?? r.ltp, changePct: liveMatch?.changePct ?? r.changePct, isLive: !!liveMatch };
      })
    : filteredUniverse.map((s) => {
        const liveMatch = liveStockBySymbol?.get(s.symbol);
        return { symbol: s.symbol, name: s.name, ltp: liveMatch?.ltp ?? null, changePct: liveMatch?.changePct ?? null, isLive: !!liveMatch };
      });

  const etfRows: QuoteRow[] = filteredEtfs.map((e) => ({ symbol: e.symbol, name: e.displayName, ltp: e.ltp, changePct: e.changePct, isLive: true }));

  const commodityRows: QuoteRow[] = COMMODITIES.map((c) => {
    const liveMatch = liveCommodityBySymbol?.get(c.symbol);
    return {
      symbol: c.symbol,
      name: `${c.name} /${c.unit}`,
      ltp: liveMatch?.ltp ?? c.ltp,
      changePct: liveMatch?.changePct ?? c.changePct,
      isLive: !!liveMatch,
    };
  });

  return (
    <div className="mx-auto max-w-[1200px] space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Market categories" className="flex flex-wrap gap-1.5">
          {CATEGORIES_BY_CURRENCY[currency].map((c) => (
            <button
              key={c}
              role="tab"
              aria-selected={cat === c}
              onClick={() => {
                setTouched(true);
                setCat(c);
                if (c !== 'Stocks') setSector(null);
              }}
              className={cn(
                'rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                cat === c ? 'bg-teal-bg text-teal' : 'text-muted hover:bg-hover hover:text-text',
              )}
            >
              {c}
            </button>
          ))}
        </div>

        <CurrencySwitch
          value={currency}
          onChange={(next) => {
            if (next === currency) return;
            setTouched(true);
            // Land on the new space's first venue. Switching currency is a
            // change of market, so the sector filter and any expanded chart
            // from the old space go with it.
            setCat(CATEGORIES_BY_CURRENCY[next][0]);
            setSector(null);
          }}
        />
      </div>

      {venue ? (
        <>
          {venue === 'CRYPTO' ? (
            <CryptoBoard
              onSelectSymbol={(symbol) =>
                // Clicking the open instrument again collapses the pane, so the
                // row is a toggle rather than a one-way door.
                setSelected((prev) =>
                  prev?.symbol === symbol && prev.venue === 'CRYPTO' ? null : { venue: 'CRYPTO', symbol },
                )
              }
              selectedSymbol={selected?.venue === 'CRYPTO' ? selected.symbol : null}
              onRowsChange={setCryptoRows}
            />
          ) : (
            <ForexBoard
              onSelectSymbol={(symbol) =>
                setSelected((prev) =>
                  prev?.symbol === symbol && prev.venue === 'FX' ? null : { venue: 'FX', symbol },
                )
              }
              selectedSymbol={selected?.venue === 'FX' ? selected.symbol : null}
              onRowsChange={setFxRows}
            />
          )}

          {selected && (
            <InstrumentDetailPane
              venue={selected.venue}
              symbol={selected.symbol}
              row={
                (selected.venue === 'CRYPTO' ? cryptoRows : fxRows).find(
                  (r) => r.symbol === selected.symbol,
                ) ?? null
              }
              precision={selected.venue === 'CRYPTO' ? CRYPTO_PRECISION : FX_PRECISION}
              onClose={() => setSelected(null)}
            />
          )}
        </>
      ) : (
      <Card
        title={
          cat === 'Stocks' && sectorMeta
            ? `Stocks — ${sectorMeta.name}`
            : cat === 'Indices'
              ? `Indices (${ALL_NSE_INDICES.length})`
              : cat === 'Stocks'
                ? `Stocks (${FO_STOCK_UNIVERSE.length})`
                : cat === 'ETFs'
                  ? `ETFs${liveEtfs && liveEtfs.length > 0 ? ` (${liveEtfs.length})` : ''}`
                  : cat
        }
        actions={
          cat === 'Stocks' && sector ? (
            <div className="flex items-center gap-2">
              <LiveBadge status={status} />
              <button onClick={() => setSector(null)} className="text-xs font-semibold text-teal hover:underline">
                ← All sectors
              </button>
            </div>
          ) : cat === 'Indices' ? (
            <div className="flex items-center gap-2">
              <LiveBadge status={status} />
              <input
                value={indexFilter}
                onChange={(e) => setIndexFilter(e.target.value)}
                placeholder="Filter indices…"
                className="w-40 rounded-lg border border-border2 bg-bg px-2.5 py-1 text-xs text-text placeholder:text-faint focus:border-teal focus:outline-none"
              />
            </div>
          ) : cat === 'Stocks' && !sector ? (
            <div className="flex items-center gap-2">
              <LiveBadge status={status} />
              <input
                value={stockFilter}
                onChange={(e) => setStockFilter(e.target.value)}
                placeholder="Filter stocks…"
                className="w-40 rounded-lg border border-border2 bg-bg px-2.5 py-1 text-xs text-text placeholder:text-faint focus:border-teal focus:outline-none"
              />
            </div>
          ) : cat === 'ETFs' ? (
            <div className="flex items-center gap-2">
              <LiveBadge status={status} />
              <input
                value={etfFilter}
                onChange={(e) => setEtfFilter(e.target.value)}
                placeholder="Filter ETFs…"
                className="w-40 rounded-lg border border-border2 bg-bg px-2.5 py-1 text-xs text-text placeholder:text-faint focus:border-teal focus:outline-none"
              />
            </div>
          ) : cat === 'Commodities' ? (
            <LiveBadge status={status} />
          ) : undefined
        }
      >
        {cat === 'Indices' ? (
          <div className="max-h-[560px] overflow-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="sticky top-0 bg-card text-faint">
                <tr className="border-b border-border text-left">
                  <th className="py-2 font-semibold">Name</th>
                  <th className="py-2 text-right font-semibold">Current</th>
                  <th className="py-2 text-right font-semibold">% Chg</th>
                  <th className="py-2 text-right font-semibold">52W High</th>
                  <th className="py-2 text-right font-semibold">52W Low</th>
                  <th className="py-2 text-right font-semibold">30D %</th>
                  <th className="py-2 text-right font-semibold">365D %</th>
                  <th className="py-2 text-right font-semibold"></th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {filteredIndices.map((idx) => {
                  const dhanSymbol = INDEX_NAME_TO_DHAN_SYMBOL[idx.name];
                  const liveMatch = dhanSymbol ? liveIndexByDhanSymbol?.get(dhanSymbol) : undefined;
                  const current = liveMatch?.ltp ?? idx.current;
                  const changePct = liveMatch?.changePct ?? idx.changePct;
                  const up = (changePct ?? 0) >= 0;
                  return (
                    <tr key={idx.name} className="group border-b border-border">
                      <td className="py-2 font-sans font-semibold text-text">
                        {idx.name}
                        {liveMatch && <span className="ml-1.5 text-[9px] font-normal text-teal">●</span>}
                      </td>
                      <td className="py-2 text-right text-text">{fmt(current)}</td>
                      <td className={cn('py-2 text-right', changePct == null ? 'text-faint' : up ? 'text-up' : 'text-down')}>
                        {changePct == null ? '—' : pct(changePct)}
                      </td>
                      <td className="py-2 text-right text-muted">{idx.week52High != null ? fmt(idx.week52High) : '—'}</td>
                      <td className="py-2 text-right text-muted">{idx.week52Low != null ? fmt(idx.week52Low) : '—'}</td>
                      <td className={cn('py-2 text-right', idx.chg30D == null ? 'text-faint' : idx.chg30D >= 0 ? 'text-up' : 'text-down')}>
                        {idx.chg30D != null ? pct(idx.chg30D) : '—'}
                      </td>
                      <td className={cn('py-2 text-right', idx.chg365D == null ? 'text-faint' : idx.chg365D >= 0 ? 'text-up' : 'text-down')}>
                        {idx.chg365D != null ? pct(idx.chg365D) : '—'}
                      </td>
                      <td className="py-2 pl-2 text-right">
                        <RowActions symbol={dhanSymbol ?? idx.name.replace(/\s+/g, '')} />
                      </td>
                    </tr>
                  );
                })}
                {filteredIndices.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-6 text-center font-sans text-muted">
                      No indices match &ldquo;{indexFilter}&rdquo;.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : cat === 'Stocks' ? (
          <div className="max-h-[560px] overflow-auto">
            <QuoteList rows={stockRows} emptyMessage={`No stocks match “${stockFilter}”.`} />
          </div>
        ) : cat === 'ETFs' ? (
          <div className="max-h-[560px] overflow-auto">
            {liveEtfs === null ? (
              <p className="py-6 text-center text-sm text-muted">ETFs stream live from the Dhan bridge — connecting…</p>
            ) : (
              <QuoteList rows={etfRows} emptyMessage={etfFilter ? `No ETFs match “${etfFilter}”.` : 'ETF feed unreachable right now.'} />
            )}
          </div>
        ) : (
          <QuoteList rows={commodityRows} emptyMessage="No commodities available." />
        )}
      </Card>
      )}
    </div>
  );
}

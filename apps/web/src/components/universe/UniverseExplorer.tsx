'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Badge, Card, cn } from '@tradew/ui';
import { qk } from '@/lib/query/keys';
import {
  ASSET_CLASS_LABELS,
  MARKET_LABELS,
  quoteCurrencyLabel,
  searchUniverse,
  fetchUniverseFacets,
  type UniverseAssetClass,
  type UniverseInstrument,
  type UniverseMarket,
} from '@/lib/universe';

/**
 * The universe browser — search and filter every tradable instrument across all
 * five markets, without ever holding the catalogue in the browser.
 *
 * HOW THE SIZE PROBLEM IS ACTUALLY SOLVED
 *
 * The catalogue is ~10^5 instruments. Three properties keep that off the client:
 *
 *  1. THE SERVER SEARCHES. Every keystroke (debounced) becomes a server query
 *     against a trigram-indexed column. There is no client-side `.filter()` in
 *     this file, because filtering in the browser would require the data to be
 *     in the browser first — which is the whole thing being avoided.
 *
 *  2. PAGES, NOT LISTS. `useInfiniteQuery` walks opaque keyset cursors, 50 rows
 *     at a time. Scrolling loads the next page; it never loads "the rest".
 *
 *  3. THE DOM STAYS SMALL. A new search resets the pages entirely rather than
 *     appending, so the row count in the document is bounded by how far one
 *     person has scrolled, not by how big the market is.
 *
 * WHY THE CURRENCY IS SHOWN TWICE, AND DIFFERENTLY
 *
 * Each row shows the price currency of the VENUE and, where it differs, the
 * currency the PAPER ACCOUNT settles in. A UK share is quoted in pence and
 * settled in dollars, and a user who is not told that will read a GBX price as
 * if it were the account's money. Nothing here converts between them: this is a
 * catalogue, not a pricing surface, and a conversion without a live rate is a
 * wrong number wearing a right one's clothes.
 */

const PAGE_SIZE = 50;
/** Long enough that a typed word is one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 250;

type MarketFilter = UniverseMarket | 'ALL';

const MARKET_ORDER: UniverseMarket[] = ['INDIA', 'USA', 'UK', 'FOREX', 'CRYPTO'];

export function UniverseExplorer({ onSelect }: { onSelect?: (instrument: UniverseInstrument) => void }) {
  const [rawQuery, setRawQuery] = useState('');
  const [query, setQuery] = useState('');
  const [market, setMarket] = useState<MarketFilter>('ALL');
  const [exchange, setExchange] = useState<string | null>(null);
  const [assetClass, setAssetClass] = useState<UniverseAssetClass | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);

  // Debounce the text box, not the filters: a filter click is one deliberate
  // action and should feel immediate, while typing "reliance" would otherwise
  // be eight requests for one intention.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(rawQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [rawQuery]);

  // Changing the market invalidates an exchange chosen under the old one —
  // "NASDAQ" is not a filter that means anything once the market is INDIA.
  useEffect(() => {
    setExchange(null);
    setAssetClass(null);
  }, [market]);

  const facetsQuery = useQuery({
    queryKey: qk.universe.facets(),
    queryFn: fetchUniverseFacets,
    // Facets change only when a catalogue sync runs, which is daily.
    staleTime: 5 * 60_000,
  });

  const searchParams = useMemo(
    () => ({
      q: query || undefined,
      market: market === 'ALL' ? undefined : market,
      exchange: exchange ?? undefined,
      assetClass: assetClass ?? undefined,
      includeInactive: includeInactive || undefined,
      limit: PAGE_SIZE,
    }),
    [query, market, exchange, assetClass, includeInactive],
  );

  const results = useInfiniteQuery({
    queryKey: qk.universe.search(searchParams as Record<string, string | boolean | number | undefined>),
    queryFn: ({ pageParam }) => searchUniverse({ ...searchParams, cursor: pageParam as string | undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });

  const rows = useMemo(() => results.data?.pages.flatMap((p) => p.items) ?? [], [results.data]);

  const sentinel = useInfiniteScroll(
    useCallback(() => {
      if (results.hasNextPage && !results.isFetchingNextPage) void results.fetchNextPage();
    }, [results]),
  );

  const marketFacets = facetsQuery.data?.markets ?? [];
  const exchangeFacets = (facetsQuery.data?.exchanges ?? []).filter(
    (e) => market === 'ALL' || e.market === market,
  );
  const assetClassFacets = (facetsQuery.data?.assetClasses ?? []).filter(
    (a) => market === 'ALL' || a.market === market,
  );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <input
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            placeholder="Search every market — ticker, company, ISIN, or pair (RELIANCE, AAPL, BTC, EUR/USD)"
            aria-label="Search the tradable universe"
            className="w-full rounded-lg border border-border2 bg-bg px-4 py-2.5 text-sm text-text outline-none placeholder:text-faint focus:border-teal"
          />
          {results.isFetching && !results.isFetchingNextPage && (
            <span className="shrink-0 text-xs text-faint">searching…</span>
          )}
        </div>

        <FilterRow label="Market">
          <Chip active={market === 'ALL'} onClick={() => setMarket('ALL')}>
            All markets
          </Chip>
          {MARKET_ORDER.map((m) => {
            const facet = marketFacets.find((f) => f.market === m);
            return (
              <Chip key={m} active={market === m} onClick={() => setMarket(m)}>
                <span className="mr-1">{MARKET_LABELS[m].flag}</span>
                {MARKET_LABELS[m].label}
                {/* The account currency sits on the market chip because it is a
                    property of the market, not of any one instrument — this is
                    where a user learns that UK trades settle in dollars. */}
                <span className="ml-1.5 text-[10px] uppercase tracking-wide text-muted">
                  {facet?.accountCurrency ?? MARKET_ACCOUNT_CURRENCY[m]}
                </span>
                {facet && <span className="ml-1.5 text-[10px] text-faint">{compact(facet.count)}</span>}
              </Chip>
            );
          })}
        </FilterRow>

        {exchangeFacets.length > 1 && (
          <FilterRow label="Exchange">
            <Chip active={exchange === null} onClick={() => setExchange(null)}>
              Any
            </Chip>
            {exchangeFacets.map((e) => (
              <Chip
                key={`${e.market}:${e.exchange}`}
                active={exchange === e.exchange}
                onClick={() => setExchange(exchange === e.exchange ? null : e.exchange)}
              >
                {e.exchange}
                <span className="ml-1.5 text-[10px] text-faint">{compact(e.count)}</span>
              </Chip>
            ))}
          </FilterRow>
        )}

        {assetClassFacets.length > 1 && (
          <FilterRow label="Type">
            <Chip active={assetClass === null} onClick={() => setAssetClass(null)}>
              Any
            </Chip>
            {assetClassFacets.map((a) => (
              <Chip
                key={`${a.market}:${a.assetClass}`}
                active={assetClass === a.assetClass}
                onClick={() => setAssetClass(assetClass === a.assetClass ? null : a.assetClass)}
              >
                {ASSET_CLASS_LABELS[a.assetClass]}
                <span className="ml-1.5 text-[10px] text-faint">{compact(a.count)}</span>
              </Chip>
            ))}
          </FilterRow>
        )}

        <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="accent-teal"
          />
          {/* Delisted rows are kept forever so an old order or journal entry can
              still resolve a name; they are simply out of the default view. */}
          Include delisted and suspended instruments
        </label>
      </header>

      <Card className="overflow-hidden p-0">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-border2 px-4 py-2 text-[11px] uppercase tracking-wider text-muted">
          <span>Instrument</span>
          <span className="text-right">Venue · currency</span>
        </div>

        {results.isPending ? (
          <SkeletonRows />
        ) : results.isError ? (
          <p className="px-4 py-8 text-center text-sm text-down">
            The universe could not be loaded. {(results.error as Error)?.message}
          </p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted">
            Nothing matches {query ? <span className="text-text">“{query}”</span> : 'these filters'}.
          </p>
        ) : (
          <ul className="divide-y divide-border2">
            {rows.map((row) => (
              <InstrumentRow key={row.ref} instrument={row} onSelect={onSelect} />
            ))}
          </ul>
        )}

        {/* The cursor's end, not a page number: `hasNextPage` is answered by the
            server having handed back a cursor, so there is never a COUNT(*). */}
        <div ref={sentinel} className="h-px" aria-hidden />
        {results.isFetchingNextPage && (
          <p className="px-4 py-3 text-center text-xs text-faint">loading more…</p>
        )}
        {!results.hasNextPage && rows.length > 0 && (
          <p className="px-4 py-3 text-center text-xs text-faint">
            End of results — {rows.length.toLocaleString()} shown
          </p>
        )}
      </Card>
    </div>
  );
}

function InstrumentRow({
  instrument,
  onSelect,
}: {
  instrument: UniverseInstrument;
  onSelect?: (instrument: UniverseInstrument) => void;
}) {
  const inactive = instrument.status !== 'ACTIVE' && instrument.status !== 'UNKNOWN';

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect?.(instrument)}
        disabled={!onSelect}
        className={cn(
          'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-2.5 text-left transition',
          onSelect && 'hover:bg-hover',
          inactive && 'opacity-55',
        )}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-bold text-text">{instrument.symbol}</span>
            <Badge tone="neutral" className="text-[10px]">
              {ASSET_CLASS_LABELS[instrument.assetClass]}
            </Badge>
            {inactive && (
              <Badge tone="warning" className="text-[10px]">
                {instrument.status}
              </Badge>
            )}
          </div>
          <p className="truncate text-xs text-muted">{instrument.displayName}</p>
        </div>

        <div className="text-right text-xs">
          <div className="text-muted">
            {MARKET_LABELS[instrument.market].flag} {instrument.exchange}
          </div>
          <div className="text-faint">
            {/* Priced in the venue's currency. Where the paper account settles in
                something else, both are shown — never one silently standing in
                for the other, and never a converted number without a rate. */}
            Priced in {quoteCurrencyLabel(instrument.quoteCurrency)}
            {instrument.requiresFxConversion && (
              <span className="ml-1 text-amber">→ settles {instrument.accountCurrency}</span>
            )}
          </div>
        </div>
      </button>
    </li>
  );
}

/** The paper-account currency per market, for the moment before facets load. */
const MARKET_ACCOUNT_CURRENCY: Record<UniverseMarket, string> = {
  INDIA: 'INR',
  USA: 'USD',
  UK: 'USD',
  FOREX: 'USD',
  CRYPTO: 'USD',
};

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 w-16 shrink-0 text-[11px] uppercase tracking-wider text-faint">{label}</span>
      {children}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-full border px-3 py-1 text-xs transition',
        active
          ? 'border-teal bg-teal-bg text-teal'
          : 'border-border2 text-muted hover:border-teal hover:text-text',
      )}
    >
      {children}
    </button>
  );
}

function SkeletonRows() {
  return (
    <ul className="divide-y divide-border2">
      {Array.from({ length: 8 }).map((_, i) => (
        <li key={i} className="px-4 py-3">
          <div className="h-3 w-28 animate-pulse rounded bg-hover" />
          <div className="mt-2 h-2.5 w-56 animate-pulse rounded bg-hover" />
        </li>
      ))}
    </ul>
  );
}

/**
 * Fire `onReach` when the returned ref scrolls into view.
 *
 * An IntersectionObserver rather than a scroll handler: a scroll listener fires
 * on every frame of a flick and would queue several page fetches for one
 * gesture. The observer fires once per crossing.
 */
function useInfiniteScroll(onReach: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const callback = useRef(onReach);
  callback.current = onReach;

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) callback.current();
      },
      // Start the next page a little before the sentinel is visible, so
      // scrolling stays continuous instead of stalling at the bottom.
      { rootMargin: '400px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return ref;
}

/** 41,921 -> "41.9k". Facet counts are context, not figures to read precisely. */
function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

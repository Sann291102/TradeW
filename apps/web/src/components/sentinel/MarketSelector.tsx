'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn } from '@tradew/ui';
import { ALL_MARKETS, findMarket, searchMarkets, type Market, type MarketKind } from '@/lib/sentinel/markets';
import { ChevronDownIcon } from '../shell/icons';

/**
 * "Market head" control — user-centric market selection for the Sentinel
 * workspace. A single button showing the active market opens a search +
 * grouped dropdown; picking a market re-runs the full Sentinel analysis for
 * that symbol (page state → useSentinel(symbol) → /observe).
 *
 * Search is prioritised over scrolling because the universe is ~220 symbols;
 * an empty query shows the featured groups (indices, commodities, and the
 * symbols Sentinel has real data for) so common picks are one click away.
 */

const KIND_LABEL: Record<MarketKind, string> = {
  index: 'Indices',
  commodity: 'Commodities',
  stock: 'Stocks',
};

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.6" />
      <path d="m14 14 3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function RealDataDot() {
  return (
    <span
      title="Live Dhan market data"
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-up"
      aria-label="live data"
    />
  );
}

export function MarketSelector({ value, onChange }: { value: string; onChange: (symbol: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const reduce = useReducedMotion();

  const active = findMarket(value);

  // Empty query → featured groups (indices + commodities + any real-data
  // stock); a query → flat, ranked results.
  const groups = useMemo(() => {
    if (query.trim()) return null;
    const featured = ALL_MARKETS.filter((m) => m.kind !== 'stock' || m.real);
    const byKind: Record<MarketKind, Market[]> = { index: [], commodity: [], stock: [] };
    for (const m of featured) byKind[m.kind].push(m);
    return byKind;
  }, [query]);

  const results = useMemo(() => (query.trim() ? searchMarkets(query) : []), [query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    // focus the search box on open
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      clearTimeout(t);
    };
  }, [open]);

  function pick(symbol: string) {
    onChange(symbol);
    setOpen(false);
    setQuery('');
  }

  function Row({ m }: { m: Market }) {
    const isActive = m.symbol === value;
    return (
      <button
        type="button"
        onClick={() => pick(m.symbol)}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-micro',
          'hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
          isActive && 'bg-hover',
        )}
      >
        <span className="flex w-16 shrink-0 items-center gap-1.5 font-mono text-[12.5px] font-semibold text-text">
          {m.real && <RealDataDot />}
          {m.symbol}
        </span>
        <span className="truncate text-[12.5px] text-muted">{m.name}</span>
        {isActive && <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-teal">Active</span>}
      </button>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 py-2.5 text-left shadow-elev1 transition-colors duration-micro hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="text-[10px] font-semibold uppercase tracking-wide text-faint">Market</span>
        <span className="flex items-center gap-1.5">
          {active.real && <RealDataDot />}
          <span className="font-mono text-sm font-bold text-text">{active.symbol}</span>
        </span>
        <span className="hidden max-w-[160px] truncate text-[12.5px] text-muted sm:inline">{active.name}</span>
        <ChevronDownIcon className={cn('h-4 w-4 text-muted transition-transform duration-micro', open && 'rotate-180')} aria-hidden="true" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: 0.14, ease: [0.4, 0, 0.2, 1] }}
            className="absolute left-0 z-30 mt-2 w-[340px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-card shadow-elev3"
            role="listbox"
          >
            <div className="border-b border-border p-2.5">
              <div className="flex items-center gap-2 rounded-lg border border-border bg-bg px-2.5">
                <SearchIcon className="h-4 w-4 shrink-0 text-faint" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search markets — symbol or name"
                  className="w-full bg-transparent py-2 text-[13px] text-text placeholder:text-faint focus:outline-none"
                />
              </div>
            </div>

            <div className="max-h-[320px] overflow-y-auto p-1.5">
              {groups ? (
                (Object.keys(groups) as MarketKind[]).map((kind) =>
                  groups[kind].length ? (
                    <div key={kind} className="mb-1">
                      <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-faint">{KIND_LABEL[kind]}</p>
                      {groups[kind].map((m) => (
                        <Row key={m.symbol} m={m} />
                      ))}
                    </div>
                  ) : null,
                )
              ) : results.length ? (
                results.map((m) => <Row key={m.symbol} m={m} />)
              ) : (
                <p className="px-2.5 py-6 text-center text-[12.5px] text-muted">No market matches “{query}”.</p>
              )}
            </div>

            <div className="flex items-center gap-1.5 border-t border-border px-3 py-2 text-[11px] text-faint">
              <RealDataDot />
              <span>Live market data via Dhan — Sentinel reads real prices for every market here.</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

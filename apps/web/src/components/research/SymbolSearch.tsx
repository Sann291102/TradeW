'use client';

import { useEffect, useRef, useState } from 'react';
import { Badge, Skeleton, cn } from '@tradew/ui';
import { searchCompanies } from '@/lib/research/api';
import type { SymbolSearchHit } from '@/lib/research/types';

/**
 * Company / symbol search.
 *
 * ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
 *
 * It never substitutes a symbol. If the provider cannot be reached, or returns
 * nothing for the query, the box says so and the page stays where it was — it
 * does not quietly load a different company, and it does not fall back to a
 * local instrument list whose rows have no fundamentals coverage.
 *
 * ── KEYBOARD ───────────────────────────────────────────────────────────────
 *
 * ↑/↓ move, Enter selects, Escape closes. Implemented with `aria-activedescendant`
 * on a combobox rather than roving focus, so the input keeps focus and the typed
 * query is never interrupted mid-word.
 */
export function SymbolSearch({
  onSelect,
  currentSymbol,
}: {
  onSelect: (hit: SymbolSearchHit) => void;
  currentSymbol: string;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SymbolSearchHit[] | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  // Debounced, and every in-flight request is invalidated by the next keystroke
  // so a slow early response cannot overwrite a fast later one.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits(null);
      setReason(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      searchCompanies(q)
        .then((res) => {
          if (cancelled) return;
          setHits(res.results);
          setReason(res.unavailableReason ?? null);
          setCursor(0);
          setOpen(true);
        })
        .catch((err) => {
          if (cancelled) return;
          setHits([]);
          setReason(err instanceof Error ? err.message : 'Search could not be completed.');
          setOpen(true);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const choose = (hit: SymbolSearchHit) => {
    onSelect(hit);
    setQuery('');
    setHits(null);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || !hits || hits.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (c + 1) % hits.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (c - 1 + hits.length) % hits.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[cursor];
      if (hit) choose(hit);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={boxRef} className="relative w-full max-w-md">
      <label htmlFor="research-search" className="sr-only">
        Search for a company or symbol
      </label>
      <input
        id="research-search"
        role="combobox"
        aria-expanded={open}
        aria-controls="research-search-results"
        aria-autocomplete="list"
        aria-activedescendant={open && hits?.length ? `research-hit-${cursor}` : undefined}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => hits && setOpen(true)}
        placeholder={`Search a company or symbol (showing ${currentSymbol})`}
        className="w-full rounded-lg border border-border2 bg-card px-3 py-2 text-xs font-semibold text-text placeholder:font-normal placeholder:text-faint focus:border-teal focus:outline-none"
      />

      {open && (
        <div
          id="research-search-results"
          role="listbox"
          className="absolute z-30 mt-1 w-full overflow-hidden rounded-lg border border-border bg-card shadow-card"
        >
          {loading && (
            <div className="space-y-1.5 p-2">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
            </div>
          )}

          {!loading && reason && (
            <p className="px-3 py-3 text-[11px] leading-relaxed text-amber">
              {/* The provider's own sentence. A generic "no results" here would
                  hide the difference between "no such company" and "the data
                  provider is not configured". */}
              {reason}
            </p>
          )}

          {!loading && !reason && hits && hits.length === 0 && (
            <p className="px-3 py-3 text-[11px] text-faint">
              No company matched &ldquo;{query.trim()}&rdquo;. Nothing else has been loaded — the page still shows{' '}
              {currentSymbol}.
            </p>
          )}

          {!loading &&
            hits?.map((hit, i) => (
              <button
                key={`${hit.symbol}:${hit.exchange}:${i}`}
                id={`research-hit-${i}`}
                role="option"
                aria-selected={i === cursor}
                type="button"
                onMouseEnter={() => setCursor(i)}
                onClick={() => choose(hit)}
                className={cn(
                  'flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors',
                  i === cursor ? 'bg-teal-bg' : 'hover:bg-hover',
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs font-bold text-text">{hit.name}</span>
                  <span className="block truncate text-[10.5px] text-faint">
                    {hit.symbol}
                    {hit.country ? ` · ${hit.country}` : ''}
                    {hit.instrumentType ? ` · ${hit.instrumentType}` : ''}
                  </span>
                </span>
                <Badge tone="neutral" className="shrink-0 px-1.5 py-0 text-[9px]">
                  {hit.exchange}
                </Badge>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

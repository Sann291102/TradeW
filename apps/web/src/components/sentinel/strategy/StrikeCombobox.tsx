'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn } from '@tradew/ui';
import {
  filterStrikes,
  formatLtp,
  resolveTypedStrike,
  strikeWindow,
  type StrikeRow,
} from '@/lib/sentinel/optionChain';
import type { InstrumentStatus } from '@/lib/sentinel/useOptionInstruments';
import type { OptionInstrument } from '@/lib/sentinel/watchState';
import { ChevronDownIcon } from '@/components/shell/icons';

/**
 * What the dropdown offers, for a given side's ladder and the typed query.
 *
 * Exported and pure so the "a CE box cannot offer a PE strike" property is
 * assertable without a DOM. It is a property of THIS function plus the single
 * `rows` array the component is given: every option, filtered or default, comes
 * out of that array, so a control handed the call ladder has nothing else to
 * return.
 */
export function strikeOptions(rows: StrikeRow[], atmIndex: number, query: string): StrikeRow[] {
  return query.trim() ? filterStrikes(rows, query) : strikeWindow(rows, atmIndex);
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.6" />
      <path d="m14 14 3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * One side's strike selector: the SAME control shape as the market head next to
 * it — a summary button that opens a searchable popover — reading one side's
 * real ladder.
 *
 * ── WHY IT LOOKS LIKE `MarketSelector` ─────────────────────────────────────
 *
 * The market and the two strikes are one act of selection: "which contract is
 * Sentinel watching". They sit on one row and are operated the same way — a
 * head button showing the current value in the mono face, a popover with a
 * search box over a scrollable list, a live-data footnote. The strike control
 * used to be a bare text input inside a separate panel further down the form,
 * which read as a different kind of thing from the market it belongs to and
 * left the operator typing into a box while the market sat in a dropdown.
 *
 * The classes here mirror `components/sentinel/MarketSelector.tsx` deliberately
 * (`rounded-xl border bg-card px-3.5 py-2.5 shadow-elev1` head, `w-[280px]`
 * `shadow-elev3` popover, `font-mono text-sm font-bold` value). If that control
 * is restyled, restyle this one with it — a near-match is worse than either
 * extreme, because two controls one gap apart are read as a set.
 *
 * ── WHAT MAKES A CE BOX UNABLE TO PICK A PE ────────────────────────────────
 *
 * `rows` is ONE side's ladder, passed in by the caller (`chain.ce` or
 * `chain.pe`). Everything this component can offer, filter or accept comes from
 * that array, so there is no code path — typed, clicked or keyboard-selected —
 * that reaches the opposite leg. `side` is used for labelling and for the token
 * check below; it never selects between two ladders here, because there is only
 * ever one.
 *
 * That is the first of three guards on the same property. The second is
 * `fetchDhanOptionInstrument`, which rejects a bridge response whose
 * `optionType` is not the one requested. The third is `instrumentDescribes`,
 * which refuses to attach such a token to the leg. Three, because the
 * consequence — Sentinel observing a put while the screen says call — is
 * invisible from the outside.
 *
 * ── THE DEFAULT VIEW IS SIX ROWS; THE SEARCH IS THE WHOLE LADDER ───────────
 *
 * With nothing typed the list is `strikeWindow` — the six strikes around the
 * at-the-money row that the brief specifies. Typing searches every listed
 * strike for the expiry, because "searchable" and "only currently available
 * strikes" are both requirements and capping the list at six would make the
 * search box decorative. Every row in both cases is a strike Dhan published.
 *
 * ── A TYPED STRIKE IS ACCEPTED OR REFUSED, NEVER ADJUSTED ──────────────────
 *
 * `resolveTypedStrike` does not snap to the nearest listed strike. Typing
 * 24337 leaves the selection where it was and says why. Silently rounding to
 * 24350 would create a watch on a contract the operator did not choose, and
 * they would have no way to tell from the screen — the same class of fault as
 * the ATM fallback that made the old charts look connected to controls they
 * were not.
 */
export function StrikeCombobox({
  side,
  rows,
  atmIndex,
  value,
  onChange,
  disabled = false,
  instrumentStatus,
  instrument,
  focused = false,
  context,
}: {
  side: 'CE' | 'PE';
  /** THIS side's ladder. The only source of anything this control can select. */
  rows: StrikeRow[];
  atmIndex: number;
  value: number | null;
  onChange: (strike: number | null) => void;
  disabled?: boolean;
  instrumentStatus: InstrumentStatus;
  instrument: OptionInstrument | null;
  /** Purely visual — which side the workspace is emphasising. */
  focused?: boolean;
  /**
   * Which chain these strikes came from, e.g. "NIFTY · 1 Sep". Shown in the
   * popover so the ladder is never read as free-floating: these strikes exist
   * because THAT index and THAT expiry publish them, and changing either
   * changes every row here.
   */
  context?: string;
}) {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const reduce = useReducedMotion();

  const options = useMemo(() => strikeOptions(rows, atmIndex, query), [rows, atmIndex, query]);

  // The premium for what is CURRENTLY selected, read from this side's ladder —
  // never from the other leg's, and never carried over from a previous strike.
  const selectedRow = value === null ? null : (rows.find((r) => r.strike === value) ?? null);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, rows]);

  // A disabled control cannot be left hanging open: the underlying-only tick
  // and a market change both disable this mid-interaction.
  useEffect(() => {
    if (disabled) {
      setOpen(false);
      setQuery('');
    }
  }, [disabled]);

  const commit = (strike: number) => {
    onChange(strike);
    setQuery('');
    setRejected(null);
    setOpen(false);
  };

  /** Apply whatever has been typed, or explain why it cannot be applied. */
  const commitTyped = () => {
    if (!query.trim()) {
      setOpen(false);
      return;
    }
    const result = resolveTypedStrike(rows, query);
    if (result.ok) {
      commit(result.row.strike);
      return;
    }
    // The previous selection survives every rejection. Clearing it would punish
    // a typo by discarding a valid leg the operator had already configured.
    setRejected(
      result.reason === 'not-listed'
        ? `${query.trim()} is not a listed ${side} strike for this expiry.`
        : result.reason === 'not-a-number'
          ? `"${query.trim()}" is not a strike price.`
          : result.reason === 'no-ladder'
            ? `No ${side} strikes are available to match against right now.`
            : null,
    );
    setQuery('');
    setOpen(false);
  };

  // Focus the search box on open — the same popover mechanics as the market
  // head, so the two controls are operated identically: click, type, pick.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(t);
  }, [open]);

  // Close on an outside click or Escape. Clicking away COMMITS what was typed
  // rather than discarding it: a trader who types a strike and clicks elsewhere
  // meant to choose it, and a silent discard would leave the old leg in place
  // with no explanation. The listeners are re-bound as the query changes because
  // that is what `commitTyped` reads.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) commitTyped();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setQuery('');
        setRejected(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, rows, side]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => {
        if (options.length === 0) return 0;
        const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
        return (next + options.length) % options.length;
      });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (options[activeIndex]) {
        commit(options[activeIndex].strike);
        return;
      }
      commitTyped();
    }
  };

  const tone = side === 'CE' ? 'text-up' : 'text-down';
  const ring = side === 'CE' ? 'border-up' : 'border-down';

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${side} strike`}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-xl border bg-card px-3.5 py-2.5 text-left shadow-elev1',
          'transition-colors duration-micro hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-card',
          focused ? ring : 'border-border',
        )}
      >
        <span className={cn('text-[10px] font-semibold uppercase tracking-wide', focused ? tone : 'text-faint')}>
          {side}
        </span>
        <span className="font-mono text-sm font-bold text-text">{value === null ? '—' : value}</span>
        <span className={cn('font-mono text-[12.5px] tabular-nums', tone)}>
          {selectedRow ? formatLtp(selectedRow.ltp) : '—'}
        </span>
        <ChevronDownIcon
          className={cn('ml-auto h-4 w-4 shrink-0 text-muted transition-transform duration-micro', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>

      <AnimatePresence>
        {open && !disabled && (
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: 0.14, ease: [0.4, 0, 0.2, 1] }}
            className="absolute left-0 z-30 mt-2 w-[280px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-card shadow-elev3"
          >
            <div className="border-b border-border p-2.5">
              <div className="flex items-center gap-2 rounded-lg border border-border bg-bg px-2.5">
                <SearchIcon className="h-4 w-4 shrink-0 text-faint" />
                <input
                  ref={inputRef}
                  type="text"
                  role="combobox"
                  aria-expanded={open}
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-label={`Search ${side} strikes`}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setRejected(null);
                  }}
                  onKeyDown={onKeyDown}
                  placeholder={`Search ${side} strikes`}
                  className="w-full bg-transparent py-2 font-mono text-[13px] text-text placeholder:text-faint focus:outline-none"
                />
              </div>
            </div>

            <div
              id={listId}
              role="listbox"
              aria-label={`${side} strikes`}
              className="max-h-[320px] overflow-y-auto p-1.5"
            >
              <p className="px-2.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-faint">
                {query.trim() ? `Matches in ${rows.length} listed strikes` : 'Around the money'}
                {context ? ` · ${context}` : ''}
              </p>
              {options.length === 0 ? (
                <p className="px-2.5 py-6 text-center text-[12.5px] text-muted">
                  {rows.length === 0 ? 'No live chain for this expiry.' : `No ${side} strike matches “${query.trim()}”.`}
                </p>
              ) : (
                options.map((row, i) => (
                  <button
                    key={row.strike}
                    type="button"
                    role="option"
                    aria-selected={row.strike === value}
                    // Mouse-down rather than click: the outside-click handler
                    // would otherwise fire first and close the list out from
                    // under the pointer.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      commit(row.strike);
                    }}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-micro',
                      'hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                      i === activeIndex && 'bg-hover',
                    )}
                  >
                    <span className="w-16 shrink-0 font-mono text-[12.5px] font-semibold text-text">{row.strike}</span>
                    <span className={cn('font-mono text-[12.5px] tabular-nums', tone)}>{formatLtp(row.ltp)}</span>
                    {row.strike === value && (
                      <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-teal">Active</span>
                    )}
                  </button>
                ))
              )}
            </div>

            <p className="border-t border-border px-3 py-2 text-[11px] leading-snug text-faint">
              Live {side} strikes{context ? ` from the ${context} chain` : ''} via Dhan — every strike here is one the
              chain published, and a strike it does not list is refused rather than rounded.
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── the readout: what is selected, and what it IS ──────────────────── */}
      <p className="mt-1 truncate font-mono text-[10.5px] text-faint">
        {value === null ? 'no strike selected' : `${value} ${side}`} ·{' '}
        {rows.length > 0 ? `${rows.length} listed strikes` : 'no strikes'}
      </p>

      {/*
        The contract identity, shown rather than implied. A strike number alone
        cannot tell the operator whether the leg is addressable; the trading
        symbol can, and its absence is what the disabled "Start watching"
        button is about.
      */}
      <p className="truncate font-mono text-[10px] text-faint" aria-live="polite">
        {value === null
          ? '—'
          : instrumentStatus === 'resolving'
            ? 'resolving contract…'
            : instrument
              ? `${instrument.tradingSymbol} · id ${instrument.securityId}`
              : instrumentStatus === 'unresolvable'
                ? 'contract could not be resolved'
                : '—'}
      </p>

      {rejected && (
        <p role="alert" className="mt-1 text-[11px] leading-snug text-down">
          {rejected}
        </p>
      )}
    </div>
  );
}

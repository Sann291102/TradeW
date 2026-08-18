'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
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

/**
 * One side's strike selector: typeable, searchable, and unable to return the
 * other side's contract.
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
}) {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const options = useMemo(() => strikeOptions(rows, atmIndex, query), [rows, atmIndex, query]);

  // The premium for what is CURRENTLY selected, read from this side's ladder —
  // never from the other leg's, and never carried over from a previous strike.
  const selectedRow = value === null ? null : (rows.find((r) => r.strike === value) ?? null);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, rows]);

  // Close on an outside click. A combobox that stays open over the rest of the
  // form is the difference between two usable selectors and two that fight.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

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
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActiveIndex((i) => {
        if (options.length === 0) return 0;
        const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
        return (next + options.length) % options.length;
      });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (open && options[activeIndex]) {
        commit(options[activeIndex].strike);
        return;
      }
      commitTyped();
      return;
    }
    if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
      setRejected(null);
    }
  };

  const tone = side === 'CE' ? 'text-up' : 'text-down';
  const ring = side === 'CE' ? 'border-up' : 'border-down';

  return (
    <div
      ref={boxRef}
      className={cn(
        'rounded-xl border bg-bg p-2.5 transition-colors duration-micro',
        focused ? ring : 'border-border',
      )}
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className={cn('text-[11px] font-bold uppercase tracking-wide', tone)}>{side}</span>
        <span className="truncate text-[10.5px] text-faint">
          {rows.length > 0 ? `${rows.length} listed strikes` : 'no strikes'}
        </span>
      </div>

      <div className="relative">
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={`${side} strike`}
          disabled={disabled}
          placeholder={value === null ? `Search ${side} strikes` : String(value)}
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setRejected(null);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            // Blur commits rather than discards: a trader who types a strike
            // and tabs away meant to choose it.
            if (query.trim()) commitTyped();
          }}
          className={cn(
            'w-full rounded-lg border border-border bg-card px-2.5 py-2 font-mono text-[12.5px] text-text',
            'placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus',
            'disabled:opacity-50',
          )}
        />

        {open && !disabled && (
          <ul
            id={listId}
            role="listbox"
            aria-label={`${side} strikes`}
            className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border bg-card py-1 shadow-elev2"
          >
            {options.length === 0 ? (
              <li className="px-2.5 py-2 text-[11.5px] text-muted">
                {rows.length === 0 ? 'No live chain for this expiry.' : `No ${side} strike matches "${query.trim()}".`}
              </li>
            ) : (
              options.map((row, i) => (
                <li key={row.strike}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={row.strike === value}
                    // Mouse-down rather than click: the input's blur handler
                    // fires first on click and would commit the typed text,
                    // closing the list out from under the pointer.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      commit(row.strike);
                    }}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={cn(
                      'flex w-full items-baseline justify-between gap-3 px-2.5 py-1.5 text-left font-mono text-[12px]',
                      i === activeIndex ? 'bg-bg' : '',
                      row.strike === value ? 'font-bold text-text' : 'text-muted',
                    )}
                  >
                    <span>{row.strike}</span>
                    <span className={cn('tabular-nums', tone)}>{formatLtp(row.ltp)}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>

      {/* ── the readout: what is selected, what it costs, what it IS ──────── */}
      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        <span className="truncate font-mono text-[12.5px] font-bold text-text">
          {value === null ? '—' : `${value} ${side}`}
        </span>
        <span className={cn('shrink-0 font-mono text-[12px] font-semibold', tone)}>
          {selectedRow ? formatLtp(selectedRow.ltp) : '—'}
        </span>
      </div>

      {/*
        The contract identity, shown rather than implied. A strike number alone
        cannot tell the operator whether the leg is addressable; the trading
        symbol can, and its absence is what the disabled "Start watching"
        button is about.
      */}
      <p className="mt-0.5 truncate font-mono text-[10px] text-faint" aria-live="polite">
        {value === null
          ? 'no strike selected'
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

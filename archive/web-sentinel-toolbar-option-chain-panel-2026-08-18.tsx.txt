'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn } from '@tradew/ui';
import { useOptionChainStrikes } from '@/lib/sentinel/useOptionChainStrikes';
import { formatLtp, strikeOptionLabel } from '@/lib/sentinel/optionChain';
import { ChevronDownIcon } from '../shell/icons';

/**
 * Option Chain control for the Sentinel toolbar.
 *
 * A compact button that expands two dropdowns — CE and PE — each showing only
 * Strike + LTP for the selected market's nearest expiry. Everything reloads
 * automatically when the market changes (the hook keys on `symbol`). The panel
 * is observation-only: selecting a strike sets what the user is watching; it
 * never places an order.
 *
 * Placed slightly LEFT of the Market selector in the page toolbar.
 */
export function OptionChainPanel({
  symbol,
  onSelectionChange,
}: {
  symbol: string;
  /** Notifies the page which CE/PE strikes the user is watching (observation only). */
  onSelectionChange?: (sel: { ce: number | null; pe: number | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [ceStrike, setCeStrike] = useState<number | null>(null);
  const [peStrike, setPeStrike] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  const chain = useOptionChainStrikes(symbol, open);

  // When the market changes, drop any prior selection — a NIFTY strike is
  // meaningless on BANKNIFTY.
  useEffect(() => {
    setCeStrike(null);
    setPeStrike(null);
  }, [symbol]);

  // Default both dropdowns to the ATM strike once a live chain arrives.
  useEffect(() => {
    if (chain.status !== 'live') return;
    if (ceStrike == null && chain.ce[chain.atmIndex]) setCeStrike(chain.ce[chain.atmIndex].strike);
    if (peStrike == null && chain.pe[chain.atmIndex]) setPeStrike(chain.pe[chain.atmIndex].strike);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain.status, chain.atmIndex]);

  useEffect(() => {
    onSelectionChange?.({ ce: ceStrike, pe: peStrike });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ceStrike, peStrike]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const ceLtp = ceStrike != null ? chain.ce.find((r) => r.strike === ceStrike)?.ltp ?? null : null;
  const peLtp = peStrike != null ? chain.pe.find((r) => r.strike === peStrike)?.ltp ?? null : null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5 text-left shadow-elev1 transition-colors duration-micro hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="text-[10px] font-semibold uppercase tracking-wide text-faint">Option Chain</span>
        {ceStrike != null || peStrike != null ? (
          <span className="flex items-center gap-1.5 font-mono text-[12px] font-semibold">
            {ceStrike != null && <span className="text-up">{ceStrike}CE</span>}
            {peStrike != null && <span className="text-down">{peStrike}PE</span>}
          </span>
        ) : (
          <span className="hidden text-[12.5px] text-muted sm:inline">Strikes</span>
        )}
        <ChevronDownIcon className={cn('h-4 w-4 text-muted transition-transform duration-micro', open && 'rotate-180')} aria-hidden="true" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: 0.14, ease: [0.4, 0, 0.2, 1] }}
            className="absolute left-0 z-30 mt-2 w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-card shadow-elev3"
            role="dialog"
            aria-label="Option chain strikes"
          >
            <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">{symbol} · nearest expiry</span>
              <span className="text-[11px] text-muted">
                {chain.status === 'live' && chain.spot != null ? `Spot ${chain.spot.toLocaleString('en-IN')}` : ''}
              </span>
            </div>

            {chain.status === 'loading' ? (
              <p className="px-3.5 py-6 text-center text-[12.5px] text-muted">Loading the live option chain…</p>
            ) : chain.status === 'unavailable' ? (
              <p className="px-3.5 py-6 text-center text-[12.5px] text-muted">
                No live option chain for {symbol}. Indices like NIFTY, BANKNIFTY, FINNIFTY and SENSEX have one.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2.5 p-3">
                <Dropdown
                  label="CE"
                  accent="up"
                  rows={chain.ce}
                  value={ceStrike}
                  ltp={ceLtp}
                  onChange={setCeStrike}
                />
                <Dropdown
                  label="PE"
                  accent="down"
                  rows={chain.pe}
                  value={peStrike}
                  ltp={peLtp}
                  onChange={setPeStrike}
                />
              </div>
            )}

            <p className="border-t border-border px-3.5 py-2 text-[10.5px] leading-relaxed text-faint">
              Observation only — selecting a strike sets what Sentinel watches. It never places an order.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Dropdown({
  label,
  accent,
  rows,
  value,
  ltp,
  onChange,
}: {
  label: 'CE' | 'PE';
  accent: 'up' | 'down';
  rows: { strike: number; ltp: number | null }[];
  value: number | null;
  ltp: number | null;
  onChange: (strike: number) => void;
}) {
  const accentClass = accent === 'up' ? 'text-up' : 'text-down';
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className={cn('text-[11px] font-semibold uppercase tracking-wide', accentClass)}>{label}</span>
        <span className="font-mono text-[12px] font-semibold text-text">{formatLtp(ltp)}</span>
      </div>
      <div className="relative">
        <select
          value={value ?? ''}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full appearance-none rounded-lg border border-border bg-bg px-2.5 py-2 pr-8 font-mono text-[12.5px] text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          aria-label={`${label} strike`}
        >
          {value == null && <option value="">Select strike</option>}
          {rows.map((r) => (
            <option key={r.strike} value={r.strike}>
              {strikeOptionLabel(r)}
            </option>
          ))}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
      </div>
      <div className="mt-1 flex justify-between px-0.5 text-[10px] text-faint">
        <span>Strike</span>
        <span>LTP</span>
      </div>
    </div>
  );
}

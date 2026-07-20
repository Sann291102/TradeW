'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { fade, panelSlide, Surface, Badge } from '@tradew/ui';
import { fmt, pct } from '@/lib/format';
import { CloseIcon } from '@/components/shell/icons';
import type { Greeks } from '@/lib/black-scholes';

export interface ContractAnalysisData {
  underlying: string;
  strike: number;
  optionType: 'CE' | 'PE';
  expiryLabel: string;
  ltp: number;
  ltpChangePct: number;
  ivPct: number;
  oi: number;
  oiChangePct: number;
  volume: number;
  greeks: Greeks;
  /** how far this strike's IV sits from the chain's average — drives the
   *  "cheap/expensive vs the smile" observation. */
  ivVsAverage: number;
}

/** Deterministic, rule-based observations — no LLM call. Same posture as
 *  Sentinel elsewhere in the app: describes what the numbers show, never a
 *  buy/sell/entry/exit recommendation. */
function generateObservations(d: ContractAnalysisData): string[] {
  const notes: string[] = [];

  notes.push(
    d.ivVsAverage > 1.5
      ? `Implied volatility (${d.ivPct.toFixed(1)}%) is elevated relative to the rest of this expiry's chain — the market is pricing wider potential moves into this strike.`
      : d.ivVsAverage < -1.5
        ? `Implied volatility (${d.ivPct.toFixed(1)}%) sits below the chain average — relatively cheaper optionality at this strike right now.`
        : `Implied volatility (${d.ivPct.toFixed(1)}%) is roughly in line with the rest of the chain for ${d.expiryLabel}.`,
  );

  notes.push(
    d.oiChangePct > 20
      ? `Open interest up ${pct(d.oiChangePct)} with ${d.volume.toLocaleString('en-IN')} traded — reads as fresh position-building, not just existing positions closing out.`
      : d.oiChangePct < -20
        ? `Open interest down ${pct(d.oiChangePct)} — more consistent with unwinding than new positioning.`
        : `Open interest is broadly stable (${pct(d.oiChangePct)}) this session.`,
  );

  notes.push(
    Math.abs(d.greeks.theta) > 15
      ? `Theta of ${d.greeks.theta.toFixed(2)}/day — this premium decays quickly as ${d.expiryLabel} approaches; time is working against the option holder here.`
      : `Theta of ${d.greeks.theta.toFixed(2)}/day — moderate time decay at this distance from expiry.`,
  );

  notes.push(
    `Delta of ${d.greeks.delta.toFixed(2)} — for every ₹1 move in ${d.underlying}, this contract's theoretical value moves roughly ₹${Math.abs(d.greeks.delta).toFixed(2)}.`,
  );

  return notes;
}

export function ContractAnalysisDrawer({ data, onClose }: { data: ContractAnalysisData | null; onClose: () => void }) {
  return (
    <AnimatePresence>
      {data && (
        <>
          <motion.div
            key="backdrop"
            initial="hidden"
            animate="visible"
            exit="exit"
            variants={fade}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/50"
          />
          <motion.div
            key="drawer"
            initial="hidden"
            animate="visible"
            exit="exit"
            variants={panelSlide}
            className="fixed inset-y-0 right-0 z-50 w-full max-w-sm overflow-y-auto border-l border-border bg-card p-4 shadow-elev4"
            role="dialog"
            aria-label="Contract analysis"
          >
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold text-text">
                  {data.underlying} {data.strike} {data.optionType}
                </h2>
                <p className="text-xs text-faint">{data.expiryLabel} expiry</p>
              </div>
              <button
                type="button"
                aria-label="Close analysis"
                onClick={onClose}
                className="rounded p-1 text-faint hover:bg-hover hover:text-text"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Surface elevation={1} className="p-2 text-center">
                <div className="text-[10px] text-faint">LTP</div>
                <div className="font-mono text-sm font-bold text-text">{fmt(data.ltp)}</div>
              </Surface>
              <Surface elevation={1} className="p-2 text-center">
                <div className="text-[10px] text-faint">IV</div>
                <div className="font-mono text-sm font-bold text-text">{data.ivPct.toFixed(1)}%</div>
              </Surface>
              <Surface elevation={1} className="p-2 text-center">
                <div className="text-[10px] text-faint">Delta</div>
                <div className="font-mono text-sm font-bold text-text">{data.greeks.delta.toFixed(2)}</div>
              </Surface>
              <Surface elevation={1} className="p-2 text-center">
                <div className="text-[10px] text-faint">Gamma</div>
                <div className="font-mono text-sm font-bold text-text">{data.greeks.gamma.toFixed(4)}</div>
              </Surface>
              <Surface elevation={1} className="p-2 text-center">
                <div className="text-[10px] text-faint">Theta</div>
                <div className="font-mono text-sm font-bold text-text">{data.greeks.theta.toFixed(2)}</div>
              </Surface>
              <Surface elevation={1} className="p-2 text-center">
                <div className="text-[10px] text-faint">Vega</div>
                <div className="font-mono text-sm font-bold text-text">{data.greeks.vega.toFixed(2)}</div>
              </Surface>
            </div>

            <div className="mt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Observations</h3>
              <ul className="space-y-2">
                {generateObservations(data).map((note, i) => (
                  <li key={i} className="rounded-lg bg-bg p-2.5 text-xs leading-relaxed text-muted">
                    {note}
                  </li>
                ))}
              </ul>
            </div>

            <Badge tone="neutral" className="mt-4 w-full justify-center py-1.5 text-center text-[10px]">
              Rule-based observations from live chain data — never a buy/sell instruction.
            </Badge>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

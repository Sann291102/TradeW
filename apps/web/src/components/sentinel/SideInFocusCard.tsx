'use client';

import { cn } from '@tradew/ui';
import type { SideInFocus } from '@/lib/sentinel/types';

/**
 * Side in Focus — the single, confidence-gated directional lens.
 *
 * Renders ONLY when the backend surfaced a side (it returns null below the
 * confidence threshold or outside a guidance state), so this card is never a
 * weak read. It shows which side (CE/PE) has stronger confirmation, the ATM
 * strike the reasoning engine framed, the supporting rationale, and an
 * educational trade-management structure — never a buy/sell instruction.
 *
 * When `sideInFocus` is null the page shows the neutral "waiting" card below
 * instead of this one.
 */
export function SideInFocusCard({ focus }: { focus: SideInFocus }) {
  const isCe = focus.side === 'CE';
  return (
    <section
      className={cn(
        'rounded-2xl border p-5 sm:p-6',
        isCe ? 'border-up/40 bg-up/5' : 'border-down/40 bg-down/5',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl font-mono text-sm font-bold',
              isCe ? 'bg-up/15 text-up' : 'bg-down/15 text-down',
            )}
          >
            {focus.side}
          </span>
          <div>
            <h2 className="text-sm font-bold text-text">
              {focus.side} side in focus
              {focus.strike != null && <span className="ml-1.5 font-mono text-muted">· {focus.strike}</span>}
            </h2>
            <p className="text-[12px] text-muted">
              {focus.bias === 'bullish' ? 'Bullish' : 'Bearish'} confirmation is currently stronger · {Math.round(focus.confidence)}% confidence
            </p>
          </div>
        </div>
        <span className={cn('rounded-lg px-2.5 py-1 text-[11px] font-semibold', isCe ? 'bg-up/15 text-up' : 'bg-down/15 text-down')}>
          {Math.round(focus.confidence)}%
        </span>
      </div>

      {focus.rationale.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {focus.rationale.map((r, i) => (
            <li key={i} className="flex gap-2 text-[12.5px] text-text">
              <span className={cn('mt-1.5 h-1 w-1 shrink-0 rounded-full', isCe ? 'bg-up' : 'bg-down')} />
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 rounded-lg bg-bg/60 px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12.5px]">
          <span className="flex items-center gap-1.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-faint">Risk : Reward</span>
            <span className="font-semibold text-text">{focus.tradeManagement.riskReward}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-faint">Trailing</span>
            <span className="font-mono font-semibold text-text">{focus.tradeManagement.trailing.join('  →  ')}</span>
          </span>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted">{focus.tradeManagement.note}</p>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-faint">{focus.disclaimer}</p>
    </section>
  );
}

/** Neutral placeholder shown when no side clears the confidence threshold. */
export function WaitingForConfirmation() {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 text-[13px] text-muted sm:p-6">
      <h2 className="mb-1 text-sm font-bold text-text">Waiting for stronger confirmation</h2>
      <p className="text-[12.5px] leading-relaxed">
        No side has cleared the confidence threshold yet. Sentinel stays quiet on purpose — it surfaces a side only when
        the evidence genuinely corroborates, never on a weak read.
      </p>
    </section>
  );
}

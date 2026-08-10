'use client';

import { cn } from '@tradew/ui';
import type { PublicationDecision, SideInFocus } from '@/lib/sentinel/types';
import { HourglassIcon } from './sentinel-icons';

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
        'rounded-2xl border p-5 shadow-elev2 sm:p-6',
        isCe ? 'border-up bg-up-bg' : 'border-down bg-down-bg',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border font-mono text-sm font-bold',
              isCe ? 'border-up bg-card text-up' : 'border-down bg-card text-down',
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
        <div className="flex flex-col items-end gap-1.5">
          <span
            className={cn(
              'rounded-lg border px-2.5 py-1 font-mono text-[11px] font-bold tabular-nums',
              isCe ? 'border-up bg-card text-up' : 'border-down bg-card text-down',
            )}
          >
            {Math.round(focus.confidence)}%
          </span>
          {focus.liveValidation && (
            <span
              className={cn(
                'rounded-md px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide',
                focus.liveValidation.status === 'invalidated'
                  ? 'bg-down/20 text-down border border-down/30'
                  : 'bg-up/20 text-up border border-up/30',
              )}
            >
              {focus.liveValidation.label}
            </span>
          )}
        </div>
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

      <div className="mt-4 rounded-xl border border-border bg-card px-4 py-3.5">
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
/**
 * Wait and Watch, with its reasoning.
 *
 * Silence is a designed output state, but silence without a reason teaches
 * nothing. When the backend supplies the publication decision, this shows the
 * binding constraint and every condition that was checked — so a trader can
 * see *which* piece of evidence is missing rather than being told only that
 * something is.
 *
 * Falls back to the generic copy when `publication` is absent, so an older
 * backend or a failed secondary fetch degrades rather than breaks.
 */
export function WaitingForConfirmation({ publication }: { publication?: PublicationDecision }) {
  const failed = publication?.conditions.filter((c) => !c.passed) ?? [];
  const met = publication?.conditions.filter((c) => c.passed) ?? [];

  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-elev2 sm:p-6">
      <div className="flex items-start gap-3.5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-teal-bg text-teal">
          <HourglassIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-[13.5px] font-bold text-text">Wait and Watch</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">
            {publication?.waitAndWatchReason ??
              'No side has cleared the publication gate yet. Sentinel stays quiet on purpose — it surfaces a side only when the evidence genuinely corroborates, never on a weak read.'}
          </p>
        </div>
      </div>

      {publication && (
        <dl className="mt-4 space-y-2 border-t border-border pt-4">
          {[...failed, ...met].map((condition) => (
            <div key={condition.id} className="flex items-start gap-2.5">
              <span
                aria-hidden
                className={cn(
                  'mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold',
                  condition.passed ? 'bg-up-bg text-up' : 'bg-down-bg text-down',
                )}
              >
                {condition.passed ? '✓' : '·'}
              </span>
              <div className="min-w-0">
                <dt className={cn('text-[12px] font-semibold', condition.passed ? 'text-text' : 'text-down')}>
                  {condition.label}
                  <span className="sr-only">{condition.passed ? ' — met' : ' — not met'}</span>
                </dt>
                <dd className="text-[11.5px] leading-relaxed text-muted">{condition.detail}</dd>
              </div>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

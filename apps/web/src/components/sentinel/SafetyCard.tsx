'use client';

import { useState } from 'react';
import { cn, Badge } from '@tradew/ui';
import type { BadgeTone } from '@tradew/ui';
import { contractBadge, type SafetyCardData } from '@/lib/sentinel/deriveContext';
import { ChevronDownIcon } from '../shell/icons';

const SEVERITY_TONE: Record<SafetyCardData['severity'], BadgeTone> = {
  high: 'negative',
  medium: 'warning',
  low: 'brand',
};

function formatTime(iso: string | null): string {
  if (!iso) return 'now';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'now';
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * One Live Safety Feed entry. Collapsed state is the whole product surface —
 * a timestamp, an action word, and one sentence. The "Why" panel (redesign
 * question 5) is opt-in and shows only evidence/confidence/explanation,
 * never an agent/internal-architecture name (see SOURCE_LABEL in
 * deriveContext.ts).
 */
export function SafetyCard({ card }: { card: SafetyCardData }) {
  const [open, setOpen] = useState(false);
  // Only the directional read from `sideInFocus` carries a side; a card that
  // reached the "Side in Focus" label through ACTION_MAP (a bare pattern
  // detection) has none, and must render none. The rule itself lives in
  // `contractBadge` so it is covered by tests.
  const badge = contractBadge(card);
  const isPe = badge?.side === 'PE';
  const hasSide = badge !== null;

  return (
    <li
      className={cn(
        'overflow-hidden rounded-xl border bg-bg transition-colors duration-micro',
        hasSide
          ? isPe
            ? 'border-down bg-down-bg/50 shadow-elev2 ring-1 ring-down/30'
            : 'border-up bg-up-bg/50 shadow-elev2 ring-1 ring-up/30'
          : card.pinned
            ? 'border-teal shadow-elev2'
            : 'border-border hover:border-border2',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-hover px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-faint">
              {formatTime(card.timestamp)}
            </span>
            <span className={cn('text-[13.5px] font-bold', hasSide ? (isPe ? 'text-down' : 'text-up') : 'text-text')}>
              {card.action}
            </span>
            {badge && (
              <span className={cn('rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase', badge.tone === 'down' ? 'bg-down/20 text-down' : 'bg-up/20 text-up')}>
                {badge.label}
              </span>
            )}
            <Badge tone={hasSide ? (isPe ? 'negative' : 'positive') : SEVERITY_TONE[card.severity]} className="text-[10px]">
              {(card.confidence * 100).toFixed(0)}%
            </Badge>
          </div>
          <p className={cn('mt-1.5 text-[12.5px] leading-snug', hasSide ? 'font-semibold text-text' : 'text-muted')}>
            {card.explanation}
          </p>
        </div>
        <ChevronDownIcon
          className={cn('mt-1 h-4 w-4 shrink-0 text-faint transition-transform duration-micro', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className="border-t border-border bg-card px-4 py-3.5">
          <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-faint">Why</p>
          <ul className="mb-2 space-y-1">
            {card.evidence.length > 0 ? (
              card.evidence.map((e, i) => (
                <li key={i} className="text-[12.5px] text-muted">
                  · {e}
                </li>
              ))
            ) : (
              <li className="text-[12.5px] text-muted">· {card.explanation}</li>
            )}
          </ul>
          <p className="text-[11px] text-faint">
            {card.source} · confidence {(card.confidence * 100).toFixed(0)}%
          </p>
        </div>
      )}
    </li>
  );
}

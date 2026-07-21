'use client';

import { useState } from 'react';
import { cn, Badge } from '@tradew/ui';
import type { BadgeTone } from '@tradew/ui';
import type { SafetyCardData } from '@/lib/sentinel/deriveContext';
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

  return (
    <li className={cn('rounded-xl border bg-card', card.pinned ? 'border-teal shadow-elev2' : 'border-border')}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3.5 text-left"
      >
        <span className="mt-0.5 font-mono text-[11px] tabular-nums text-faint">{formatTime(card.timestamp)}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-text">{card.action}</span>
            <Badge tone={SEVERITY_TONE[card.severity]} className="text-[10px]">
              {(card.confidence * 100).toFixed(0)}%
            </Badge>
          </div>
          <p className="mt-1 text-[13px] leading-snug text-muted">{card.explanation}</p>
        </div>
        <ChevronDownIcon
          className={cn('mt-1 h-4 w-4 shrink-0 text-faint transition-transform duration-micro', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className="border-t border-border px-4 py-3.5">
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

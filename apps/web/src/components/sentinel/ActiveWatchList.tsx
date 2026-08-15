'use client';

import { cn } from '@tradew/ui';
import type { ContractWatch } from '@/lib/sentinel/strategyContract';

/**
 * Active Watches: the operational surface.
 *
 * Each card says what is running, what state it is in, and how far through
 * the user's own conditions it has got. The actions are operational —
 * pause, resume, edit, view — never "enter", "exit" or "take profit".
 * Sentinel watches the user's strategy; it does not instruct them to trade,
 * and this card is the surface where that temptation is strongest.
 *
 * The checklist is the conditions the user defined, from the same contract
 * the focus panel reads, so a card and a panel open side by side cannot
 * disagree about what is met.
 */

const STATE_TONE: Record<string, string> = {
  IDLE: 'bg-bg2 text-muted',
  FORMING: 'bg-amber-bg text-amber',
  CONFIRMED: 'bg-emerald-500/15 text-emerald-400',
  IN_TRADE: 'bg-sky-500/15 text-sky-400',
  EXITED: 'bg-bg2 text-faint',
};

interface Props {
  watches: ContractWatch[];
  focusedWatchId: string | null;
  onFocus: (watchId: string) => void;
  onPause?: (watchId: string) => void;
  onResume?: (watchId: string) => void;
  onEdit?: (watchId: string) => void;
}

function instrument(watch: ContractWatch): string {
  if (!watch.strike || !watch.optionType) return watch.symbol ?? '—';
  return `${watch.symbol} ${watch.strike} ${watch.optionType}`;
}

export function ActiveWatchList({
  watches,
  focusedWatchId,
  onFocus,
  onPause,
  onResume,
  onEdit,
}: Props) {
  if (watches.length === 0) {
    return (
      <p data-testid="no-watches" className="text-sm text-muted">
        No watches yet. Create one to start watching this strategy.
      </p>
    );
  }

  return (
    <ul data-testid="active-watches" className="space-y-3">
      {watches.map((watch) => {
        const paused = watch.status === 'paused';
        return (
          <li
            key={watch.id}
            data-testid={`watch-${watch.id}`}
            className={cn(
              'rounded-lg border bg-bg1 p-3',
              watch.id === focusedWatchId ? 'border-fg/30' : 'border-line',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-fg">{instrument(watch)}</p>
                <p className="mt-0.5 text-[11px] uppercase tracking-wide text-faint">
                  {paused ? 'PAUSED' : 'ACTIVE'}
                </p>
              </div>
              <span
                className={cn(
                  'shrink-0 rounded px-2 py-0.5 text-[11px] font-medium',
                  STATE_TONE[watch.state ?? 'IDLE'] ?? 'bg-bg2 text-muted',
                )}
              >
                {watch.state ?? 'IDLE'}
              </span>
            </div>

            <div className="mt-3">
              <p className="mb-1.5 text-[11px] uppercase tracking-wide text-muted">
                Setup lifecycle · {watch.met}/{watch.total}
              </p>
              <ul className="space-y-1">
                {watch.conditions.map((condition) => (
                  <li key={condition.id} className="flex items-center gap-2 text-xs">
                    <span className={condition.met ? 'text-emerald-400' : 'text-faint'}>
                      {condition.met ? '✓' : '○'}
                    </span>
                    <span className={condition.met ? 'text-fg' : 'text-muted'}>
                      {condition.name}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {paused
                ? onResume && (
                    <button type="button" onClick={() => onResume(watch.id)} className="rounded-md border border-line px-2.5 py-1 text-[11px] text-fg hover:bg-bg2">
                      Resume
                    </button>
                  )
                : onPause && (
                    <button type="button" onClick={() => onPause(watch.id)} className="rounded-md border border-line px-2.5 py-1 text-[11px] text-fg hover:bg-bg2">
                      Pause
                    </button>
                  )}
              {onEdit && (
                <button type="button" onClick={() => onEdit(watch.id)} className="rounded-md border border-line px-2.5 py-1 text-[11px] text-fg hover:bg-bg2">
                  Edit
                </button>
              )}
              <button type="button" onClick={() => onFocus(watch.id)} className="rounded-md border border-line px-2.5 py-1 text-[11px] text-fg hover:bg-bg2">
                View
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

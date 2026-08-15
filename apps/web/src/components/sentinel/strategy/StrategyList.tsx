'use client';

import { useState } from 'react';
import { Badge, cn } from '@tradew/ui';
import type { UserStrategy } from '@/lib/sentinel/strategyApi';
import { isWatchable, ruleCounts } from '@/lib/sentinel/watchModel';

/**
 * The user's saved strategies, and the picker for which one a new watch
 * applies to.
 *
 * A row shows what the strategy will actually watch for (its mandatory rule
 * count), not just its name — two strategies can be named alike and watch for
 * entirely different things, and the count is the honest summary.
 *
 * Pausing is surfaced because it has a real effect: the sweep loop joins on
 * `status = 'active'`, so a paused strategy stops every watch under it.
 */
export function StrategyList({
  strategies,
  selectedId,
  onSelect,
  onPauseResume,
  onArchive,
  loading,
  emptyMessage,
}: {
  strategies: UserStrategy[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPauseResume: (strategy: UserStrategy) => Promise<void>;
  onArchive: (strategy: UserStrategy) => Promise<void>;
  loading: boolean;
  emptyMessage?: string;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);

  const act = async (id: string, action: () => Promise<void>) => {
    setPendingId(id);
    try {
      await action();
    } finally {
      setPendingId(null);
    }
  };

  if (loading && strategies.length === 0) {
    return <p className="py-6 text-center text-[12px] text-muted">Loading your strategies…</p>;
  }

  if (strategies.length === 0) {
    return (
      <p className="py-6 text-center text-[12px] leading-relaxed text-muted">
        {emptyMessage ?? 'No strategies yet. Describe one above and Sentinel will watch for exactly those conditions.'}
      </p>
    );
  }

  return (
    <ul className="space-y-2" role="radiogroup" aria-label="Your strategies">
      {strategies.map((strategy) => {
        const counts = ruleCounts(strategy.rules);
        const selected = strategy.id === selectedId;
        const paused = strategy.status === 'paused';
        const busy = pendingId === strategy.id;
        return (
          <li key={strategy.id}>
            <div
              className={cn(
                'rounded-xl border p-3 transition-colors duration-micro',
                selected ? 'border-teal bg-teal-bg' : 'border-border bg-bg hover:bg-hover',
              )}
            >
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onSelect(strategy.id)}
                className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-text">{strategy.name}</span>
                  {paused && (
                    <Badge tone="warning" className="shrink-0 px-1.5 py-0 text-[9px]">
                      Paused
                    </Badge>
                  )}
                  {selected && (
                    <Badge tone="brand" className="shrink-0 px-1.5 py-0 text-[9px]">
                      Selected
                    </Badge>
                  )}
                </div>
                <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-muted">
                  {strategy.rawInput || 'No original text kept for this strategy.'}
                </p>
                <p className="mt-1.5 text-[10.5px] text-faint">
                  {counts.mandatory} mandatory
                  {counts.optional > 0 && ` · ${counts.optional} optional`}
                  {strategy.rules?.timeframe && ` · ${strategy.rules.timeframe}`}
                  {!isWatchable(strategy.rules) && ' · nothing to confirm'}
                </p>
              </button>

              <div className="mt-2 flex items-center gap-3 border-t border-border pt-2">
                <button
                  type="button"
                  onClick={() => void act(strategy.id, () => onPauseResume(strategy))}
                  disabled={busy}
                  className="text-[11px] font-semibold text-muted hover:text-text disabled:opacity-50"
                >
                  {paused ? 'Resume watching' : 'Pause'}
                </button>
                <button
                  type="button"
                  onClick={() => void act(strategy.id, () => onArchive(strategy))}
                  disabled={busy}
                  className="ml-auto text-[11px] font-semibold text-muted hover:text-down disabled:opacity-50"
                >
                  Archive
                </button>
              </div>
              {paused && (
                <p className="mt-1.5 text-[10.5px] leading-relaxed text-amber">
                  Paused — every watch under this strategy is skipped until you resume it.
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

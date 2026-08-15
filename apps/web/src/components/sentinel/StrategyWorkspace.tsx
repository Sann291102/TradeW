'use client';

import { useState } from 'react';
import { renderableSegments, toTimelineWatch } from '@/lib/sentinel/strategyContract';
import { useStrategyContract } from '@/lib/query/useSentinel';
import { ActiveWatchList } from './ActiveWatchList';
import { ObservedContextPanel } from './ObservedContextPanel';
import { StrategyConfigureForm } from './StrategyConfigureForm';
import { StrategyPerformancePanel } from './StrategyPerformancePanel';
import { TimelineEventCard } from './TimelineEventCard';

/**
 * The strategy workspace: Configure → Watch → Focus → Feed → Performance,
 * all rendered from ONE contract fetch.
 *
 * Every child receives a slice of the same `StrategyContract`. No child
 * fetches anything for itself, and no child knows which strategy it is
 * showing. That is what stops this becoming ten dashboards: the components
 * here render an EMA reclaim and a liquidity sweep through exactly the same
 * code, because the only strategy-specific knowledge in the system lives in
 * the backend contract data.
 *
 * If a `strategy.template.id === '…'` check ever appears in this subtree, the
 * generic contract has leaked and the fix belongs in the backend.
 */

interface Props {
  strategyId: string;
}

export function StrategyWorkspace({ strategyId }: Props) {
  const [watchId, setWatchId] = useState<string | undefined>(undefined);

  // The manual request-ticket guard this used to keep — "a slow response for
  // one watch must not overwrite a newer one the user has switched to" — is
  // now structural: the watch id is part of the query key, so a stale response
  // lands in the entry it belongs to and can no longer overwrite the current
  // one. Switching back to a watch also reads its cached contract rather than
  // re-fetching from nothing.
  const query = useStrategyContract(strategyId, watchId);
  const contract = query.data ?? null;
  const error =
    query.isError && !contract
      ? query.error instanceof Error
        ? query.error.message
        : 'Could not load this strategy'
      : null;

  // A failure here is no longer terminal: the shared retry policy has already
  // backed off through 429s and 5xxs before this renders, and the button gives
  // the user a way through anything that outlived it.
  if (error) {
    return (
      <div className="text-sm text-red-400">
        <p>{error}</p>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="mt-2 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text hover:border-teal"
        >
          Try again
        </button>
      </div>
    );
  }
  if (!contract) return <p className="text-sm text-muted">Loading your strategy…</p>;

  const focused = contract.watches.find((w) => w.id === contract.focusedWatchId) ?? null;

  return (
    <div data-testid="strategy-workspace" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="space-y-6">
        <StrategyConfigureForm
          strategyName={contract.name}
          parameters={contract.configuration.parameters}
        />

        <div>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
            Active watches
          </h3>
          <ActiveWatchList
            watches={contract.watches}
            focusedWatchId={contract.focusedWatchId}
            onFocus={setWatchId}
          />
        </div>
      </div>

      <div className="space-y-6">
        <section data-testid="strategy-focus">
          <p className="text-xs uppercase tracking-wide text-muted">My strategy</p>
          <h2 className="text-base font-medium text-fg">{contract.name}</h2>
          <p className="mt-1 text-[11px] uppercase tracking-wide text-faint">
            {focused ? `${focused.symbol ?? ''} · ${contract.currentState ?? 'IDLE'}` : 'No watch selected'}
          </p>

          {contract.conditions.length > 0 && (
            <ul className="mt-3 space-y-1">
              {contract.conditions.map((condition) => (
                <li key={condition.id} className="flex items-start gap-2 text-xs">
                  <span className={condition.met ? 'text-emerald-400' : 'text-faint'}>
                    {condition.met ? '✓' : '○'}
                  </span>
                  <span className="flex-1">
                    <span className={condition.met ? 'text-fg' : 'text-muted'}>{condition.name}</span>
                    {condition.detail && (
                      <span className="block text-[11px] leading-relaxed text-faint">
                        {condition.detail}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <ObservedContextPanel observation={contract.latestObservation} />

        <section data-testid="strategy-feed">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            Lifecycle
          </h3>
          {contract.lifecycle.length === 0 || !focused ? (
            <p className="text-xs text-muted">Nothing has changed yet on this watch.</p>
          ) : (
            <ul className="space-y-2">
              {/* Already collapsed server-side: a state the watch is sitting in
                  is one entry with a count, not one card per 15s sweep. */}
              {contract.lifecycle.map((event) => (
                <li key={`${event.id}-${event.kind}`}>
                  <TimelineEventCard event={event} watch={toTimelineWatch(focused!, contract.id)} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <StrategyPerformancePanel
          performance={contract.performance}
          segments={renderableSegments(contract)}
        />
      </div>
    </div>
  );
}

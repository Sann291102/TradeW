'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchStrategyContract, renderableSegments, toTimelineWatch } from '@/lib/sentinel/strategyContract';
import type { StrategyContract } from '@/lib/sentinel/strategyContract';
import { ObservedContextPanel } from '../ObservedContextPanel';
import { StrategyConfigureForm } from '../StrategyConfigureForm';
import { StrategyPerformancePanel } from '../StrategyPerformancePanel';
import { TimelineEventCard } from '../TimelineEventCard';

const POLL_MS = 10_000;

/**
 * "My strategy" — everything about the ONE strategy the user has selected:
 * what it is, how it is configured, what state its watch is in, what has
 * happened on it, and how it has behaved.
 *
 * Two properties this panel exists to hold:
 *
 * 1. **The explanation stays visible.** The user should never have to
 *    remember which strategy they picked, so the name and summary sit above
 *    the configuration rather than only in the selector that chose it.
 *
 * 2. **The feed is scoped to this strategy.** It renders `lifecycle` from
 *    this strategy's contract, so a user watching an EMA reclaim sees EMA
 *    reclaim events and nothing else. A feed that mixed in other strategies'
 *    events would be describing a market, not their strategy.
 *
 * Everything comes from the generic contract. There is no per-strategy branch
 * here, and the configuration is a loop over `configuration.parameters`
 * rather than a form written for any particular setup.
 */

export function SelectedStrategyPanel({ strategyId }: { strategyId: string }) {
  const [contract, setContract] = useState<StrategyContract | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A slow response for one strategy must not overwrite a newer one the user
  // has already switched to.
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++requestRef.current;
    try {
      const next = await fetchStrategyContract(strategyId);
      if (ticket === requestRef.current) {
        setContract(next);
        setError(null);
      }
    } catch (err) {
      if (ticket === requestRef.current) {
        setError(err instanceof Error ? err.message : 'Could not load this strategy');
      }
    }
  }, [strategyId]);

  useEffect(() => {
    setContract(null);
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (error && !contract) {
    return <p className="text-[11.5px] text-down">{error}</p>;
  }
  if (!contract) {
    return <p className="text-[12px] text-muted">Loading your strategy…</p>;
  }

  const focused = contract.watches.find((w) => w.id === contract.focusedWatchId) ?? null;

  return (
    <div data-testid="selected-strategy" className="space-y-4">
      <header>
        <h3 className="text-[12px] font-bold uppercase tracking-wide text-faint">My strategy</h3>
        <p className="mt-1 text-[13.5px] font-bold text-text">{contract.name}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">{contract.template.summary}</p>
        <p className="mt-1.5 text-[11px] uppercase tracking-wide text-faint">
          Watch status · {focused ? (contract.currentState ?? 'IDLE') : 'not watching yet'}
        </p>
      </header>

      <div className="border-t border-border pt-3.5">
        <StrategyConfigureForm parameters={contract.configuration.parameters} />
      </div>

      {contract.conditions.length > 0 && (
        <div className="border-t border-border pt-3.5">
          <h4 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-faint">Conditions</h4>
          <ul className="space-y-1">
            {contract.conditions.map((condition) => (
              <li key={condition.id} className="flex items-start gap-2 text-[12px]">
                <span className={condition.met ? 'text-up' : 'text-faint'}>{condition.met ? '✓' : '○'}</span>
                <span className="flex-1">
                  <span className={condition.met ? 'text-text' : 'text-muted'}>{condition.name}</span>
                  {condition.detail && (
                    <span className="block text-[11px] leading-relaxed text-faint">{condition.detail}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="border-t border-border pt-3.5">
        <ObservedContextPanel observation={contract.latestObservation} />
      </div>

      <div className="border-t border-border pt-3.5">
        <h4 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-faint">
          {contract.name} · lifecycle
        </h4>
        {!contract.dataStatus.ok ? (
          // Named, not silent. "Sentinel could not read the market" and "the
          // market did nothing" produce the same empty feed, and only one of
          // them is something the user can act on.
          <p className="text-[12px] leading-relaxed text-amber">
            Sentinel could not read the market on its last check
            {contract.dataStatus.reason ? ` — ${contract.dataStatus.reason}` : ''}. No events are
            shown rather than events invented from missing data.
          </p>
        ) : contract.lifecycle.length === 0 || !focused ? (
          <p className="text-[12px] text-muted">
            {focused
              ? 'Waiting for live strategy conditions.'
              : 'Not watching yet — choose a market below to start.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {/* Collapsed server-side: a state the watch is sitting in is one
                entry with a count, not one card per 15s sweep. */}
            {contract.lifecycle.map((event) => (
              <li key={`${event.id}-${event.kind}`}>
                <TimelineEventCard event={event} watch={toTimelineWatch(focused, contract.id)} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-border pt-3.5">
        <StrategyPerformancePanel
          performance={contract.performance}
          segments={renderableSegments(contract)}
        />
      </div>
    </div>
  );
}

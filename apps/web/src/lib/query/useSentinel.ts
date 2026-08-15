'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adoptTemplate, fetchStrategyContract, listTemplates } from '@/lib/sentinel/strategyContract';
import { fetchStrategyPerformance, fetchTimeline } from '@/lib/sentinel/sentinelPy';
import { qk } from './keys';
import { NEAR_LIVE_POLL_MS, liveQueryOptions } from './live';

/**
 * Sentinel's strategy surfaces.
 *
 * The workspace, the timeline feed and the focus panel are separate components
 * that render one conceptual thing — the strategy the user adopted and what it
 * has done since. Each owned a `setInterval` and its own copy of the "did this
 * fail?" logic, which is how the Sentinel bugs that opened this audit showed
 * up: the route remounted, three timers restarted at once, three requests went
 * out together, and the 429 that came back was rendered as a permanent error
 * card by whichever component drew first.
 *
 * The remount is gone (see AppFrame) and these queries are what stops the rest
 * of it recurring: shared keys so the three cannot stampede, the global 429/5xx
 * backoff so a rate-limit answers itself, and a poll that stops when nobody is
 * looking.
 */

/** The adoptable catalogue. Reference data — templates change on deploy. */
export function useStrategyTemplates() {
  return useQuery({
    queryKey: qk.sentinel.templates(),
    queryFn: listTemplates,
  });
}

/**
 * Adopting a template creates a strategy, which changes the catalogue's
 * adopted-state AND the user's strategy list. Invalidating the whole
 * `sentinel` prefix is deliberate: the alternative is enumerating which of the
 * two the caller happened to be looking at, which is how a list goes stale.
 */
export function useAdoptTemplate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (templateId: string) => adoptTemplate(templateId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.sentinel.all });
    },
  });
}

export function useStrategyContract(strategyId: string, watchId?: string) {
  return useQuery({
    queryKey: qk.sentinel.contract(strategyId, watchId ?? null),
    queryFn: () => fetchStrategyContract(strategyId, watchId),
    ...liveQueryOptions({ intervalMs: NEAR_LIVE_POLL_MS, enabled: Boolean(strategyId) }),
  });
}

export function useStrategyTimeline(watchId: string | null) {
  return useQuery({
    queryKey: qk.sentinel.timeline(watchId ?? 'none'),
    queryFn: () => fetchTimeline(watchId as string),
    ...liveQueryOptions({ intervalMs: NEAR_LIVE_POLL_MS, enabled: Boolean(watchId) }),
  });
}

export function useStrategyPerformance(strategyId: string) {
  return useQuery({
    queryKey: qk.sentinel.performance(strategyId),
    queryFn: () => fetchStrategyPerformance(strategyId),
    enabled: Boolean(strategyId),
  });
}

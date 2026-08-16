import { QueryClient } from '@tanstack/react-query';
import { logIfRateLimited, retryDelayMs, shouldRetry } from './sentinel/retryPolicy';

/**
 * The app's single QueryClient.
 *
 * ── WHY ONE CLIENT PER TAB, AND WHY THAT FIXES "RELOAD TO SEE IT" ──────────
 *
 * Every Sentinel surface used to hold its data in `useState` inside the
 * component that rendered it. State in a component dies with the component,
 * and the workspace shell was remounting the whole page subtree on every
 * client-side navigation (`AppFrame` keyed its content by pathname). So
 * Dashboard → Sentinel was not a navigation, it was a cold start: empty state,
 * a fresh `/observe`, and whatever that request happened to return — including
 * a 429 from the burst the previous mount had just spent.
 *
 * This client is created once, above the router, and outlives every route
 * change. Navigating back to /sentinel now renders the previous observation
 * out of cache on the first frame and revalidates behind it. Nothing about
 * that requires a reload, which is precisely the point.
 *
 * ── THE DEFAULTS ARE THE POLICY ────────────────────────────────────────────
 *
 * Set here rather than per-hook so a new Sentinel query cannot be added
 * without retry and caching. A hook may tighten a value it has a reason to
 * (a poll cadence, a longer staleTime for data that barely moves); it should
 * not be re-declaring what "retryable" means. See `sentinel/retryPolicy.ts`
 * for why 401/403 are excluded and why the delay carries jitter.
 */

/** Data is served from cache without a refetch for this long. */
const STALE_TIME_MS = 5_000;

/**
 * How long an unused cache entry survives. Five minutes is the window in which
 * "I went to the dashboard and came back" has to be instant — the whole
 * navigation bug lives inside it.
 */
const GC_TIME_MS = 5 * 60_000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME_MS,
        gcTime: GC_TIME_MS,
        retry: (failureCount, error) => {
          logIfRateLimited(error, 'query');
          return shouldRetry(failureCount, error);
        },
        retryDelay: (attemptIndex, error) => retryDelayMs(attemptIndex, error),
        // Coming back to the tab is the strongest possible signal that someone
        // is about to read this. It is also the cheapest recovery path out of a
        // failed state: the refetch it triggers is what makes a service that
        // healed while the tab was in the background show up without a reload.
        refetchOnWindowFocus: true,
        // The cache is already rendered by then; this only revalidates it.
        refetchOnMount: true,
        refetchOnReconnect: true,
      },
      mutations: {
        // A mutation is a user action with a body. Replaying it because the
        // response was slow risks creating the same strategy twice, so only
        // the faults that provably never reached the handler are retried —
        // and `shouldRetry` already excludes 5xx-after-write ambiguity by
        // capping at one attempt here.
        retry: (failureCount, error) => shouldRetry(failureCount, error, 1),
        retryDelay: (attemptIndex, error) => retryDelayMs(attemptIndex, error),
      },
    },
  });
}

/**
 * The browser's client, memoised across Fast Refresh and across every
 * `QueryProvider` render. Deliberately module-level in the browser only: on
 * the server a shared client would leak one request's data into another's.
 */
let browserClient: QueryClient | null = null;

export function getQueryClient(): QueryClient {
  if (typeof window === 'undefined') return createQueryClient();
  if (!browserClient) browserClient = createQueryClient();
  return browserClient;
}

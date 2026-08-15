import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/**
 * The caching, deduplication and retry policy for every read in the app.
 *
 * ── WHAT THIS EXISTS TO FIX ────────────────────────────────────────────────
 *
 * Before this file, every screen owned its own `useEffect(() => { fetch() })`.
 * That produced four failure modes at once, all of which are policy problems
 * rather than bugs in any individual component:
 *
 *   • No deduplication. `MarketNews` (dashboard), `NewsPanel` (terminal) and
 *     `NewsClient` (/news) each polled the SAME newswire endpoint on their own
 *     timer. Mount two of them and the app made two identical requests a few
 *     milliseconds apart, forever.
 *
 *   • No cache. Navigating away and back re-fetched from cold, so the user
 *     stared at a spinner for data the app had held moments earlier.
 *
 *   • No retry. A single 429 or a 502 from a service still warming up became a
 *     permanent error card. The data never arrived on its own; the only exit
 *     was a manual reload.
 *
 *   • No backoff. What retrying did exist hammered a struggling backend at a
 *     fixed interval, which is precisely how a transient 500 becomes a
 *     sustained one.
 *
 * ── THE RETRY RULE ─────────────────────────────────────────────────────────
 *
 * 429 and 5xx are the server saying "not now", so they are retried. 4xx other
 * than 429 is the server saying "not ever, as asked" — a 401, a 403 on a
 * gated course, a 404 for a watch with no timeline yet — and retrying those
 * only burns the rate limit to arrive at the same answer.
 *
 * A thrown `TypeError` (no `status` at all) means the request never reached
 * the server: DNS, an offline laptop, a dropped tunnel. That is the MOST
 * transient failure of the set, so it retries too. Reading the spec's rule
 * literally would have returned false there and made a two-second Wi-Fi blip
 * as fatal as a 403, which is clearly not what "treat transient failures as
 * transient" is asking for.
 *
 * Backoff is exponential and capped at 30s, with up to 500ms of jitter so that
 * N components whose queries failed in the same tick do not all wake up in the
 * same tick and repeat the thundering herd that caused the failure.
 */
function isRetryableError(error: unknown): boolean {
  // Never reached the server — network-level failure, always worth another go.
  if (!(error instanceof ApiError)) return true;
  if (error.status === 429) return true;
  return error.status >= 500;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Long enough that moving between workspaces reads from cache instead
        // of re-hitting the API. Anything genuinely live (quotes, the blotter,
        // the option chain) overrides this at the call site — see lib/query.
        staleTime: 5 * 60 * 1000,
        gcTime: 30 * 60 * 1000,
        retry: (failureCount, error) => failureCount < 3 && isRetryableError(error),
        retryDelay: (attemptIndex) =>
          Math.min(1000 * 2 ** attemptIndex, 30_000) + Math.random() * 500,
        // Coming back to the tab is the clearest signal a trader wants current
        // numbers, and reconnecting is the clearest signal that whatever failed
        // while offline can now succeed. Both refetch in the background against
        // data already on screen, so neither shows a spinner.
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        // Keep the previous page's rows visible while the next key loads, so
        // changing a filter or a tab dissolves rather than collapsing the
        // layout to a spinner and shoving it back a moment later.
        placeholderData: <T,>(previousData: T) => previousData,
      },
      mutations: {
        retry: 1,
      },
    },
  });
}

/**
 * The browser's single cache.
 *
 * Deliberately NOT a module-level `new QueryClient()`. Next renders client
 * components on the server too, and a module singleton there would be shared
 * by every concurrent request — one user's holdings served to the next. On the
 * server each render gets a throwaway client (nothing is fetched during SSR
 * anyway, since every query here needs a bearer token from the browser); in
 * the browser there is exactly one, for the lifetime of the tab.
 */
let browserQueryClient: QueryClient | undefined;

export function getQueryClient(): QueryClient {
  if (typeof window === 'undefined') return createQueryClient();
  if (!browserQueryClient) browserQueryClient = createQueryClient();
  return browserQueryClient;
}

/**
 * Non-React callers (stores, the session bootstrap) that need to invalidate
 * reach the cache through `getQueryClient()` rather than an eagerly-evaluated
 * `export const queryClient`. A bare `const` is resolved at module load, which
 * on the server is once per process — exactly the shared-across-users instance
 * the function above exists to avoid. Inside a component use `useQueryClient()`.
 */

/**
 * Query options for data that is genuinely live.
 *
 * The global defaults in `lib/queryClient.ts` are tuned for reference data —
 * five minutes fresh, half an hour cached. Quotes and the blotter are the
 * opposite: seconds fresh, and refetched on a timer.
 *
 * ── WHY THIS REPLACES setInterval ──────────────────────────────────────────
 *
 * Every live surface in the app used to own a hand-rolled `setInterval` or a
 * self-rescheduling `setTimeout`. None of them checked whether anyone was
 * looking. A laptop with the app open in a background tab kept polling the
 * portfolio every 5 seconds and the newswire every 2 minutes, all day, for a
 * screen nobody could see — burning the API's rate limit for the tabs that
 * WERE visible.
 *
 * `refetchInterval` is paused by react-query whenever the window loses focus
 * (`refetchIntervalInBackground` defaults to false) and resumes on return,
 * paired with the `refetchOnWindowFocus` default so the first thing a
 * returning trader sees is current. That is the `enabled: isVisible` behaviour
 * the audit asked for, except it is the library's job rather than something
 * each of a dozen components has to remember.
 */

/** Cadence constants, named so the intent survives being read out of context. */
export const LIVE_POLL_MS = 5_000;
export const NEAR_LIVE_POLL_MS = 15_000;

interface LiveOptions {
  /** How often to refetch while the tab is focused. */
  intervalMs: number;
  /** Set false to stop polling entirely (signed out, panel collapsed, tab hidden). */
  enabled?: boolean;
}

/**
 * Spread into a `useQuery` call for a live feed.
 *
 * `staleTime` is one interval: within a single tick the data is considered
 * fresh, so a second component mounting mid-cycle reads the cache instead of
 * firing its own request, but nothing is ever served older than one poll.
 */
export function liveQueryOptions({ intervalMs, enabled = true }: LiveOptions) {
  return {
    enabled,
    staleTime: intervalMs,
    refetchInterval: enabled ? intervalMs : (false as const),
  };
}

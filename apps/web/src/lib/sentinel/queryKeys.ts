/**
 * Every React Query key Sentinel uses, in one place.
 *
 * ── WHY A MODULE AND NOT INLINE ARRAYS ─────────────────────────────────────
 *
 * Two things depend on these keys agreeing exactly, and both fail silently
 * when they drift:
 *
 *  1. DEDUPLICATION. Two components that read the same endpoint under two
 *     slightly different keys are two cache entries and therefore two HTTP
 *     requests. `SentinelWorkspace` and the terminal's `SentinelPanel` both
 *     call `useSentinel`; the strategy panel and the timeline feed both read
 *     the watch list. Sharing a key is what collapses those into one in-flight
 *     request — which is the actual fix for the 429s, not the backoff.
 *
 *  2. INVALIDATION. A mutation that invalidates `['strategies', userId]` while
 *     the list is cached under `['strategies']` invalidates nothing, and the
 *     UI stays stale until a reload. That was the "saved strategies don't
 *     appear" bug.
 *
 * ── WHY userId IS IN THE KEY ───────────────────────────────────────────────
 *
 * The cache outlives a sign-out: the QueryClient is created once per tab and
 * survives every client-side navigation (that is the point). Keying by user
 * means the next account to sign in cannot be handed the previous account's
 * strategies out of cache while its own request is in flight. `null` for a
 * signed-out session is a distinct key from any real user, which is correct —
 * those entries hold nothing worth showing anyone.
 */

export type UserScope = string | null;

export const sentinelKeys = {
  all: ['sentinel'] as const,

  /**
   * The market observation. Keyed by every input that changes the response, so
   * switching market or strategy focus reads its own cache entry rather than
   * overwriting the previous one — and switching back is instant.
   */
  observe: (userId: UserScope, symbol: string, strategyMode: string, selectedStrategyIds: string[]) =>
    ['sentinel', 'observe', userId, symbol, strategyMode, [...selectedStrategyIds].sort().join(',')] as const,

  sessionSummary: (userId: UserScope) => ['sentinel', 'session-summary', userId] as const,

  journal: (userId: UserScope) => ['sentinel', 'journal', userId] as const,

  /** The user's authored strategies (services/sentinel-py). */
  strategies: (userId: UserScope) => ['strategies', userId] as const,

  /** The watches those strategies are running against. */
  watches: (userId: UserScope) => ['watches', userId] as const,

  timeline: (userId: UserScope, watchId: string) => ['watches', userId, 'timeline', watchId] as const,
};

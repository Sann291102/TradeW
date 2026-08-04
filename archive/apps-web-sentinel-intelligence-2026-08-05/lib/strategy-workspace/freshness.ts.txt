/**
 * Human-readable "how stale is this" label for the live-data indicator.
 *
 * Pure and clock-injected so it is testable without mocking timers or waiting
 * on a real interval — `now` defaults to `Date.now()` for callers, tests pass
 * a fixed value.
 */
export function freshnessLabel(fetchedAt: number | null, now: number = Date.now()): string {
  if (fetchedAt === null) return 'not yet loaded';
  const deltaMs = now - fetchedAt;
  if (deltaMs < 0) return 'just now'; // clock skew guard, never show negative age
  if (deltaMs < 5_000) return 'just now';
  if (deltaMs < 60_000) return `${Math.floor(deltaMs / 1000)}s ago`;
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)}m ago`;
  return `${Math.floor(deltaMs / 3_600_000)}h ago`;
}

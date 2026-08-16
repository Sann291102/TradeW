'use client';

import { useQuery } from '@tanstack/react-query';
import { NEWS_POLL_MS, fetchNews, type NewsItem } from '@/lib/news';
import { qk } from './keys';

/**
 * The newswire, fetched once for the whole app.
 *
 * ── WHY ONE LIMIT AND NOT THREE ────────────────────────────────────────────
 *
 * Three surfaces show headlines: the dashboard card (3), the terminal's news
 * panel (12) and the /news route (40). Each used to call `fetchNews(n)` on its
 * own two-minute timer, so opening the dashboard with the terminal docked made
 * two near-simultaneous requests for what is the same newest-first list, and
 * the two could disagree about the top headline depending on which landed
 * first.
 *
 * Caching them separately would not have helped — `['news', 3]` and
 * `['news', 12]` are different keys, so the cache would have faithfully stored
 * both and still made both requests.
 *
 * So there is one request, for the largest list anyone needs, and each caller
 * slices what it shows. Fewer requests AND the surfaces can no longer
 * contradict each other, which the per-component version could not guarantee
 * at any cache setting.
 */
const CANONICAL_LIMIT = 40;

export interface NewsQuery {
  items: NewsItem[] | null;
  /** The message to show, or null. Absent while stale data is still on screen. */
  error: string | null;
  isLoading: boolean;
  refetch: () => void;
}

export function useNews(take = CANONICAL_LIMIT): NewsQuery {
  const query = useQuery({
    queryKey: qk.news.list(CANONICAL_LIMIT),
    queryFn: () => fetchNews(CANONICAL_LIMIT),
    // Headlines are cached for five minutes server-side; polling faster than
    // the poll constant only re-reads that same cache.
    staleTime: NEWS_POLL_MS,
    refetchInterval: NEWS_POLL_MS,
  });

  return {
    items: query.data ? query.data.slice(0, take) : null,
    // Only surface a failure when there is nothing to show. A poll that fails
    // while yesterday's headlines are still on screen is not worth an error
    // banner — the retry is already scheduled, and the list is still true.
    error: query.isError && !query.data ? errorText(query.error) : null,
    isLoading: query.isPending,
    refetch: () => void query.refetch(),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not load market news';
}

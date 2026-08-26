'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { buttonClasses } from '@tradew/ui';
import { fetchResearchPreferences, saveResearchPreferences } from '@/lib/research/storage';

export function WatchlistButton({
  symbol,
  name,
  exchange,
}: {
  symbol: string;
  name: string;
  exchange: string;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['research', 'prefs'],
    queryFn: fetchResearchPreferences,
    staleTime: 60_000,
    retry: 1,
  });

  const inWatchlist = query.data?.watchlist.some((entry) => entry.symbol === symbol) ?? false;

  return (
    <button
      type="button"
      disabled={!query.data}
      onClick={async () => {
        if (!query.data) return;
        const watchlist = inWatchlist
          ? query.data.watchlist.filter((entry) => entry.symbol !== symbol)
          : [{ symbol, name, exchange, addedAt: new Date().toISOString() }, ...query.data.watchlist].slice(0, 40);
        await saveResearchPreferences({ ...query.data, watchlist });
        await client.invalidateQueries({ queryKey: ['research', 'prefs'] });
      }}
      className={buttonClasses({ variant: inWatchlist ? 'primary' : 'outline', size: 'sm' })}
    >
      {inWatchlist ? 'In watchlist' : 'Add to watchlist'}
    </button>
  );
}

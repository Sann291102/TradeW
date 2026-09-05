import { Suspense } from 'react';
import { CandleLoader } from '@tradew/ui';
import { UniverseClient } from './UniverseClient';

export const metadata = {
  title: 'Tradable universe · TradeW',
  description:
    'Search every instrument TradeW can quote — NSE and BSE equities, US and UK listings, spot forex pairs and crypto pairs.',
};

/**
 * The tradable universe.
 *
 * A route of its own rather than a tab inside /markets. Markets is a live PRICE
 * board — a handful of instruments, polling, changing every second. This is a
 * CATALOGUE browser — a hundred thousand instruments, static between daily
 * syncs, searched rather than watched. Putting them on one screen would mean
 * one component doing both, and the polling half would keep re-rendering the
 * paginated half.
 */
export default function UniversePage() {
  return (
    <Suspense fallback={<CandleLoader size="sm" className="m-4" label="Loading universe" />}>
      <UniverseClient />
    </Suspense>
  );
}

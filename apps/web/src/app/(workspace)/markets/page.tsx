import { Suspense } from 'react';
import { CandleLoader } from '@tradew/ui';
import { MarketsWorkspace } from '@/components/markets/MarketsWorkspace';

/**
 * Markets page — thin wrapper so `MarketsWorkspace` can read `?sector=` via
 * `useSearchParams` (requires a Suspense boundary in the app router — same
 * pattern as `app/trade/page.tsx`).
 */
export default function MarketsPage() {
  return (
    <Suspense fallback={<CandleLoader size="sm" className="m-4" label="Loading page" />}>
      <MarketsWorkspace />
    </Suspense>
  );
}

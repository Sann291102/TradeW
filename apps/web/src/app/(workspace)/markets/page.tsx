import { Suspense } from 'react';
import { MarketsWorkspace } from '@/components/markets/MarketsWorkspace';

/**
 * Markets page — thin wrapper so `MarketsWorkspace` can read `?sector=` via
 * `useSearchParams` (requires a Suspense boundary in the app router — same
 * pattern as `app/trade/page.tsx`).
 */
export default function MarketsPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-faint">Loading…</div>}>
      <MarketsWorkspace />
    </Suspense>
  );
}

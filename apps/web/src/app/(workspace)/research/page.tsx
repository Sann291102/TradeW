import { Suspense } from 'react';
import { CandleLoader } from '@tradew/ui';
import { ResearchClient } from './ResearchClient';

export const metadata = { title: 'Research — TradeW' };

/**
 * Research workspace — fundamental company research.
 *
 * Rebuilt 2026-08-23. The previous implementation was a single client component
 * that rendered hardcoded fundamentals (P/E, ROE, ROCE, EPS, market cap,
 * shareholding), a fabricated "AI summary" with an invented confidence score and
 * quality ratings, two contradictory market-cap figures on the same screen, nine
 * tabs that changed only a highlight colour, and four buttons with no handler.
 * It reached no backend of any kind. See
 * docs/audits/SIDEBAR-FEATURE-REALITY-AUDIT.md §4.8 for the full record; the
 * file itself is preserved at
 * archive/web-research-fabricated-page-2026-08-23.tsx.txt per the repo's
 * archive-don't-delete rule.
 *
 * Nothing from it is carried over. Every figure now comes from
 * `GET /research/:symbol` (services/api/src/research), which normalizes a real
 * vendor's statements and returns each part of the page as a section that is
 * either available with data and provenance, or unavailable with a reason.
 *
 * Server component; `ResearchClient` is the 'use client' wrapper that reads
 * `?symbol=&section=&period=` through `useSearchParams`, which is why the
 * Suspense boundary is required here — same pattern as `/trade` and `/markets`.
 */
export default function ResearchPage() {
  return (
    <Suspense fallback={<CandleLoader size="sm" className="m-4" label="Loading research" />}>
      <ResearchClient />
    </Suspense>
  );
}

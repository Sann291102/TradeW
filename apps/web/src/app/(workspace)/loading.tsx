import { Skeleton } from '@tradew/ui';

/**
 * The workspace route-transition fallback.
 *
 * SCOPE, precisely — because this file is easy to over-credit: no workspace
 * page fetches on the server (every one of them is a thin wrapper around a
 * `'use client'` component that fetches in `useEffect`), so this is NOT what
 * covers a slow API call. Each page's own skeleton does that, and
 * `LearningClient` and `CheckoutClient` already do it well.
 *
 * What this covers is the gap BEFORE that component exists in the browser at
 * all: the RSC payload and the route's JS chunk still being fetched after a
 * sidebar click. Without a `loading.tsx` the App Router holds the *previous*
 * page on screen for that whole window with no indication anything is
 * happening — on a cold container over a slow link that reads as a dead click,
 * and a dead click is what makes someone reload. With one, the navigation
 * commits immediately and the wait becomes visible.
 *
 * Deliberately generic: it stands in for every workspace route, so it mimics
 * the shape they share — a title, a primary panel, a secondary row — rather
 * than any single page's layout. A per-route file can be added later where the
 * shape is worth matching more closely.
 */
export default function WorkspaceLoading() {
  return (
    <div className="space-y-4 p-4" role="status" aria-label="Loading">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-52 w-full" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
      <span className="sr-only">Loading page…</span>
    </div>
  );
}

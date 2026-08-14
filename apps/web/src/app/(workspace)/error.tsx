'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button, buttonClasses } from '@tradew/ui';

/**
 * The workspace error boundary — the fix for "the page is blank until I reload".
 *
 * Every workspace page is a thin server wrapper around a `'use client'`
 * component that fetches in `useEffect` (LearningClient, SentinelPage, …).
 * Those components handle *rejected fetches* themselves, and handle them well.
 * What none of them can catch is a THROW DURING RENDER — `buildDashboardModel`
 * reading a field off a malformed `/observe` payload, a `.map()` on something
 * the API returned as `null`, a selector narrowing that no longer holds. React
 * unmounts the whole subtree on such a throw, and with no boundary above it the
 * unmount reaches the root: the user gets a blank screen with no control on it,
 * and the only way out is a manual reload. That is precisely the reported
 * symptom, and this file is what ends it.
 *
 * Placed INSIDE the `(workspace)` group on purpose: the group's layout (and so
 * AppFrame's sidebar, topbar and ticker) stays mounted and interactive, and the
 * failure is contained to the page area. A boundary at the root would blank the
 * chrome too and lose the user their navigation — the same failure with nicer
 * text.
 *
 * `reset()` re-renders the segment without a full document reload, so a
 * transient fault (a 502 from a container that was still starting) recovers in
 * place and keeps client state. When the fault is not transient the user still
 * has the sidebar and the dashboard link, rather than a dead tab.
 */
export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The browser console is the only sink wired today. `digest` is the id
    // Next.js also writes to the SERVER log for this same error, and in
    // production it is the *only* identifying detail the client is given —
    // React deliberately withholds the real message there. Logging it is what
    // makes a user's screenshot correlatable with the server-side stack.
    console.error('[workspace] unhandled render error', { digest: error.digest, error });
  }, [error]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-5 py-20 text-center">
      <h1 className="text-lg font-bold text-text">This page stopped responding</h1>
      <p className="text-sm text-muted">
        Something in the page failed while rendering. Nothing you were doing was saved or sent, and
        the rest of the workspace is still working — use the sidebar to move on, or try this page
        again.
      </p>

      <div className="flex items-center gap-2">
        <Button variant="primary" size="md" onClick={reset}>
          Try again
        </Button>
        <Link href="/dashboard" className={buttonClasses({ variant: 'outline', size: 'md' })}>
          Back to dashboard
        </Link>
      </div>

      {error.digest && (
        <p className="font-mono text-[11px] text-muted">
          Reference: {error.digest}
        </p>
      )}
    </div>
  );
}

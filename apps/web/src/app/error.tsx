'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button, buttonClasses } from '@tradew/ui';

/**
 * The error boundary for the chrome-free routes — `/`, `/login`, `/signup`,
 * `/reset` and `/auth/callback` (see `(workspace)/layout.tsx` for why those sit
 * outside the workspace group).
 *
 * `(workspace)/error.tsx` covers the signed-in app. It does NOT cover these:
 * a boundary only catches throws from below its own position in the tree, and
 * these routes are its siblings, not its children. Without this file a render
 * throw on any of them still walks to the root and blanks the tab.
 *
 * These are the worst routes to lose that way. `/auth/callback` is a client
 * component that runs the OAuth exchange, and `/reset` is reached by someone
 * signed out, from an email link, who has no session and no navigation to fall
 * back on — for them a blank page is not a page that needs reloading, it is a
 * password reset that appears to have failed.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app] unhandled render error', { digest: error.digest, error });
  }, [error]);

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-5 text-center">
      <h1 className="text-lg font-bold text-text">Something went wrong</h1>
      <p className="text-sm text-muted">
        This page failed to load. Nothing was submitted. Try again, or head back to the home page and
        start over.
      </p>

      <div className="flex items-center gap-2">
        <Button variant="primary" size="md" onClick={reset}>
          Try again
        </Button>
        <Link href="/" className={buttonClasses({ variant: 'outline', size: 'md' })}>
          Go home
        </Link>
      </div>

      {error.digest && <p className="font-mono text-[11px] text-muted">Reference: {error.digest}</p>}
    </div>
  );
}

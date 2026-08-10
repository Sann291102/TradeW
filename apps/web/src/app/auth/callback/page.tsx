'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { setSession } from '@/lib/api';
import { useSessionStore } from '@/lib/store/sessionStore';

/**
 * Landing strip for the Google OAuth round-trip.
 *
 * The API cannot return JSON to the SPA here — its callback arrives as a
 * top-level browser navigation, so it redirects to this page with the token
 * pair in the URL **fragment**. The fragment is deliberate: unlike a query
 * string it is never sent to any server, never lands in an access log, and
 * never ends up in a Referer header.
 *
 * This page's only job is to move those tokens into storage and get the
 * fragment out of the address bar before anything else can read it.
 */
export default function AuthCallbackPage() {
  const router = useRouter();

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const accessToken = params.get('accessToken');
    const refreshToken = params.get('refreshToken') ?? undefined;

    if (!accessToken) {
      router.replace('/?auth_error=Google+sign-in+did+not+complete.#auth');
      return;
    }

    setSession(accessToken, refreshToken);
    // Drop the fragment immediately so a token cannot be recovered from
    // history or a shared URL.
    window.history.replaceState(null, '', '/auth/callback');

    void useSessionStore
      .getState()
      .init()
      .finally(() => router.replace('/dashboard'));
  }, [router]);

  return (
    <main className="grid min-h-screen place-items-center bg-bg p-6">
      <p className="text-fsXs text-muted">Completing sign-in…</p>
    </main>
  );
}

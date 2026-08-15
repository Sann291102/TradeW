'use client';

import { useState, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { getQueryClient } from '@/lib/queryClient';

/**
 * Mounts the app's cache. Sits in the ROOT layout, not the workspace one, so
 * that bare routes (the landing page's auth panel, /checkout, /reset) share the
 * same cache as the workspace — otherwise signing in on `/` and landing on
 * `/dashboard` would cross a cache boundary and re-fetch everything the auth
 * flow had already loaded.
 *
 * `useState` rather than a bare call keeps the client stable across re-renders,
 * and `getQueryClient` keeps it a true singleton in the browser: two providers
 * (or a fast-refresh remount in dev) resolve to the same cache instead of
 * quietly splitting into two, which would silently restore the duplicate
 * fetching this whole change removes.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(getQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

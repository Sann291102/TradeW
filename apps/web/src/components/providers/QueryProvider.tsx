'use client';

import { type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { getQueryClient } from '@/lib/queryClient';

/**
 * Mounts the app's QueryClient above the router.
 *
 * ── IT IS IN THE ROOT LAYOUT ON PURPOSE ────────────────────────────────────
 *
 * Not in `(workspace)/layout.tsx`, even though every current consumer lives
 * inside that route group. A provider mounted inside the group is remounted
 * whenever the group's layout is, and a remounted provider that built its own
 * client would throw the cache away — reintroducing the exact "navigate away
 * and back, get a cold start and an error card" bug this whole change exists
 * to remove. The root layout is the only place in the App Router tree that is
 * guaranteed to persist across every client-side navigation.
 *
 * The client itself is memoised in `lib/queryClient.ts`, so even a remount
 * here reuses the same cache. Both halves of that are deliberate: the mount
 * point makes it correct, the memo makes it survivable.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={getQueryClient()}>{children}</QueryClientProvider>;
}

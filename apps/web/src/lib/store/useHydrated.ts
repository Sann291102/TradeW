'use client';

import { useEffect } from 'react';
import { useWorkspaceStore } from './workspaceStore';

/**
 * Triggers the workspace store's localStorage rehydration exactly once, after
 * mount. The store is created with `skipHydration: true` specifically so this
 * runs in a useEffect (client-only, post-hydration) instead of during store
 * creation (which would run identically on the server and desync the very
 * first client render from what React expects — a hydration-mismatch trap).
 *
 * Mount this once, high in the tree (AppFrame). Components that render
 * persisted state (theme, panel layout, tabs) should read `hasHydrated` from
 * the store and fall back to the deterministic default state until it's true.
 */
export function useHydrateWorkspaceStore() {
  useEffect(() => {
    void useWorkspaceStore.persist.rehydrate();
  }, []);
}

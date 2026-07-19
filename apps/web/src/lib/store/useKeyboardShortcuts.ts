'use client';

import { useEffect } from 'react';
import { useWorkspaceStore } from './workspaceStore';

/**
 * Global keyboard shortcut handler (Milestone 3 §7). Mounted once, high in
 * the tree (AppFrame). See lib/shortcuts.ts for the documented table shown in
 * ShortcutsHelp — keep the two in sync when adding a binding.
 *
 * All bound combos use a modifier key (safe to fire regardless of focus — see
 * the doc comment in lib/shortcuts.ts) except Escape, which is safe everywhere.
 */
export function useKeyboardShortcuts() {
  const store = useWorkspaceStore;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;

      if (e.key === 'Escape') {
        store.getState().closeAllOverlays();
        return;
      }

      if (!mod) return;

      if (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'p') {
        e.preventDefault();
        store.setState((s) => ({ commandPaletteOpen: !s.commandPaletteOpen }));
        return;
      }

      if (e.key.toLowerCase() === 'b') {
        e.preventDefault();
        store.getState().toggleSidebar();
        return;
      }

      if (e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        // topbar-search is a button that opens the command palette (see
        // shell/TopBar.tsx) — .click() triggers it, .focus() alone would not.
        const trigger = document.getElementById('topbar-search') as HTMLButtonElement | null;
        if (trigger) trigger.click();
        else store.getState().setCommandPaletteOpen(true);
        return;
      }

      if (e.key === '/') {
        e.preventDefault();
        store.setState((s) => ({ shortcutsHelpOpen: !s.shortcutsHelpOpen }));
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [store]);
}

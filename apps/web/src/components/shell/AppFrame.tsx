'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { Ticker } from './Ticker';
import { FloatingAI } from './FloatingAI';
import { NotificationCenter } from './NotificationCenter';
import { isBareRoute, isStandaloneRoute } from './nav-config';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import { useHydrateWorkspaceStore } from '@/lib/store/useHydrated';
import { useKeyboardShortcuts } from '@/lib/store/useKeyboardShortcuts';
import { useSessionStore } from '@/lib/store/sessionStore';
import { CommandPalette } from '../workspace/CommandPalette';
import { ShortcutsHelp } from '../workspace/ShortcutsHelp';
import { DisciplinePanel } from '../discipline/DisciplinePanel';
import { useDisciplineStore } from '@/lib/store/disciplineStore';

/**
 * AppFrame — the permanent application shell (Milestone 2, Step 1; overlay
 * wiring added Milestone 3). Wraps every workspace route with Sidebar +
 * TopBar + Ticker + content, and renders auth/marketing routes bare. Placed
 * in the ROOT layout so existing pages get the chrome WITHOUT being moved.
 *
 * As of Milestone 3, Sidebar/TopBar/FloatingAI read their open/collapsed
 * state directly from the workspace store (not props) — this file just
 * mounts the store's hydration + global keyboard-shortcut hooks once and
 * renders the shell-level overlays (command palette, shortcuts help,
 * notification center) that any route can trigger.
 */
export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const reduce = useReducedMotion();
  const mobileNavOpen = useWorkspaceStore((s) => s.mobileNavOpen);
  const setMobileNavOpen = useWorkspaceStore((s) => s.setMobileNavOpen);
  const theme = useWorkspaceStore((s) => s.theme);
  const sessionStatus = useSessionStore((s) => s.status);

  useHydrateWorkspaceStore();
  useKeyboardShortcuts();

  // Verify/load the real session once on mount (Milestone 4, Step 1) — reads
  // the token lib/api.ts already owns, calls the real GET /auth/me +
  // GET /entitlements/me. Runs before the bare-route check below so hooks stay
  // unconditional; harmless no-op-ish on /login /signup where nothing reads it yet.
  useEffect(() => {
    void useSessionStore.getState().init();
  }, []);

  // Start the discipline session check once the user is known to be signed in.
  // Gated on `authenticated` rather than run unconditionally like the session
  // init above, because `/discipline/today` is an authenticated route — firing
  // it for a signed-out visitor would only produce a 401 and push the store
  // into its retry backoff for nothing. `init` is idempotent, so the
  // SessionBudgetCard calling it too is a no-op.
  useEffect(() => {
    if (sessionStatus === 'authenticated') useDisciplineStore.getState().init();
  }, [sessionStatus]);

  // The inline script in layout.tsx only runs once, pre-hydration (prevents
  // FOUC on load). Subsequent theme changes — ThemeMenu, the command palette's
  // theme commands, or rehydration restoring a different saved theme — apply
  // here.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  if (isBareRoute(pathname) || isStandaloneRoute(pathname)) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-text">
      <Sidebar />

      {/* mobile drawer scrim */}
      <AnimatePresence>
        {mobileNavOpen && (
          <motion.button
            type="button"
            aria-label="Close navigation"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setMobileNavOpen(false)}
            className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          />
        )}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <Ticker />
        <main className="min-h-0 flex-1 overflow-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={pathname}
              initial={reduce ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
              className=""
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      <FloatingAI />
      <NotificationCenter />
      <CommandPalette />
      <ShortcutsHelp />
      {/* Last, and at the highest z-index of the shell overlays: when a
          discipline session is required it must sit over everything, including
          the command palette. It renders nothing unless the server says a
          session is needed — see DisciplinePanel / disciplineStore. */}
      <DisciplinePanel />
    </div>
  );
}

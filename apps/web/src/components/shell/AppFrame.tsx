'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { Ticker } from './Ticker';
import { FloatingAI } from './FloatingAI';
import { NotificationCenter } from './NotificationCenter';
import { NotificationSync } from './NotificationSync';
import { SettingsEffects } from './SettingsEffects';
import { useWorkspaceStore, resolveTheme } from '@/lib/store/workspaceStore';
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
 * TopBar + Ticker + content.
 *
 * It used to sit in the ROOT layout and strip its own chrome by testing
 * `usePathname()` against BARE_ROUTES/STANDALONE_ROUTES, so that pages could
 * get the shell without being moved. That check has been removed: it made the
 * shell depend on a string that can disagree with what actually rendered.
 * Signed out on `/profile`, the auth gate redirected the RSC payload to `/`,
 * Next patched the landing page into the tree while pathname still read
 * `/profile`, and this component wrapped the marketing page in trader chrome.
 *
 * Mounting now lives in `app/(workspace)/layout.tsx`, so only routes inside
 * that group get the shell and the desync is structurally impossible. Bare
 * routes are bare because of where their files are, not because of a
 * comparison made at render time.
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
  // theme commands, the Settings → Appearance screen, or rehydration restoring
  // a different saved theme — apply here.
  //
  // `system` is resolved rather than written: `data-theme="system"` matches no
  // token block, so the page would fall through to the :root (light) set. The
  // media-query listener keeps it honest when the OS flips at dusk while the
  // tab is open; it is only attached for the `system` choice, so an explicit
  // dark/light user is unaffected by their OS.
  useEffect(() => {
    const apply = () => document.documentElement.setAttribute('data-theme', resolveTheme(theme));
    apply();
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: light)');
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [theme]);

  // Replay the route transition WITHOUT remounting the route.
  //
  // ── THE BUG THIS REPLACES ────────────────────────────────────────────────
  //
  // This used to be `<AnimatePresence mode="wait"><motion.div key={pathname}>`.
  // `key={pathname}` made React tear down and rebuild the ENTIRE route subtree
  // on every pathname change, and `mode="wait"` held the OLD tree mounted for
  // the full exit before the new one mounted — so two trees were live at once,
  // both fetching. The fade was never the problem; the key was.
  //
  // A CSS animation fires when an element is created or when the animation is
  // (re)applied — not when a stable element's children change. So the class is
  // stripped, a reflow is forced to flush the removal, and it is re-applied.
  // That restarts the animation on the same DOM node, which is the whole
  // trick: the fade is back, and the element's identity never changes, so
  // nothing below it unmounts. See the note in the JSX below for what
  // remounting cost us.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = contentRef.current;
    if (!el || reduce) return;
    el.classList.remove('route-fade');
    void el.offsetWidth; // force reflow — without it the removal is coalesced away
    el.classList.add('route-fade');
  }, [pathname, reduce]);

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
          {/*
            ── NO `key={pathname}` HERE. IT MUST NOT COME BACK. ──────────────

            This used to be `<AnimatePresence mode="wait"><motion.div key={pathname}>`,
            which bought a 250ms cross-fade between routes and paid for it with
            the three worst bugs Sentinel had.

            Changing the key unmounts the entire page subtree and mounts a new
            one. So every client-side navigation into /sentinel was a cold
            start: hooks re-ran from scratch, in-component state was discarded,
            and a fresh `/sentinel/observe` fired. When that request lost —
            because a burst of remounts had already spent the per-IP rate-limit
            budget — the workspace latched into "Sentinel service not
            connected", and the only escape was a full browser reload. Which
            worked, and therefore looked like a server problem, when it was
            this line.

            `mode="wait"` made it worse: the outgoing subtree was held mounted
            for the length of the exit animation while the incoming one
            mounted, so both were live at once and both fetched.

            The transition is now driven by CSS on a STABLE element (see
            `.route-fade` in globals.css) — the animation replays on navigation
            because the content changes, without the identity of the tree
            changing. React reconciles rather than remounts, React Query keeps
            its cache, and Dashboard → Sentinel renders the last observation on
            the first frame.

            If a route genuinely needs a hard reset, it should key ITSELF on
            whatever actually changed. Never here, for every route at once.
          */}
          <div ref={contentRef} className="route-content">
            {children}
          </div>
        </main >
      </div >

      <FloatingAI />
      <SettingsEffects />
      <NotificationSync />
      <NotificationCenter />
      <CommandPalette />
      <ShortcutsHelp />
  {/* Last, and at the highest z-index of the shell overlays: when a
          discipline session is required it must sit over everything, including
          the command palette. It renders nothing unless the server says a
          session is needed — see DisciplinePanel / disciplineStore. */}
  <DisciplinePanel />
    </div >
  );
}

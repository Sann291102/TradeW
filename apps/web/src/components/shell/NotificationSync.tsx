'use client';

import { useEffect, useRef } from 'react';
import { useSessionStore } from '@/lib/store/sessionStore';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import { useSettingsStore } from '@/lib/store/settingsStore';
import { playNotificationSound } from '@/lib/notificationSound';
import { useNotifications } from '@/lib/query/useNotifications';

/**
 * Keeps the workspace store's notification list in sync with the real backend
 * (services/api `/notifications`) and rings the TradeW mark when something new
 * genuinely arrives.
 *
 * Renders nothing — it is a headless effect host mounted once in AppFrame, next
 * to the other shell-level singletons. Both the top-bar bell badge and the
 * NotificationCenter drawer read the same store slice, so writing here updates
 * every surface at once; there is deliberately no second copy of this polling.
 *
 * WHY POLL, NOT SSE (yet)
 * `/notifications` is a plain REST list today. A 30s poll is enough for the
 * event classes this carries (order fills, Sentinel observations, EOD summary)
 * and adds no server-side streaming to operate. The seam is isolated: swapping
 * to the admin-style SSE stream later means changing only this file.
 *
 * THE "no chime for the backlog" RULE
 * On the first successful load after sign-in we seed the seen-set WITHOUT
 * sounding — otherwise every unread notification waiting in the account would
 * fire the chime at once on login. Only ids that appear in a LATER poll are
 * treated as new and allowed to ring.
 */
export function NotificationSync() {
  const status = useSessionStore((s) => s.status);
  const setNotifications = useWorkspaceStore((s) => s.setNotifications);

  // Ids we have already shown the user. A ref, not state: mutating it must not
  // trigger a re-render, and it has to survive across polls.
  const seen = useRef<Set<string>>(new Set());
  const primed = useRef(false);

  const authenticated = status === 'authenticated';

  // The fetch, the 30s cadence and the retry policy now belong to the shared
  // query (lib/query/useNotifications) rather than a private setInterval here.
  // Three things fall out of that: the /notifications page reuses this exact
  // request instead of making its own, the poll pauses while the tab is in the
  // background, and marking something read from the page invalidates this
  // entry — so the bell's unread count corrects immediately instead of at the
  // next tick. What stays local is the part that is genuinely this component's
  // job: deciding when to ring.
  const { data: items } = useNotifications(authenticated);

  useEffect(() => {
    if (!authenticated) {
      // Reset so a future different sign-in re-primes cleanly rather than
      // inheriting the previous user's seen-set.
      seen.current = new Set();
      primed.current = false;
    }
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated || !items) return;

    // Genuinely-new unread ids: not seen before AND currently unread.
    const fresh = items.filter((n) => !n.read && !seen.current.has(n.id));
    // Track every id we've now observed, read or not.
    for (const n of items) seen.current.add(n.id);

    setNotifications(items);

    // Sound only after the first load has primed the seen-set, and only if the
    // operator hasn't muted. Read the flag at ring-time so a mid-session mute
    // takes effect immediately.
    if (primed.current && fresh.length > 0) {
      // Two independent mutes, and both have to be off for a chime. The
      // workspace store's is the per-device one behind the top bar's speaker
      // button; the settings store's is the account preference that follows
      // the user between devices. Read at ring-time so a mid-session change to
      // either takes effect on the next notification, not the next reload.
      const deviceMuted = useWorkspaceStore.getState().notificationsMuted;
      const soundEnabled = useSettingsStore.getState().prefs.notifications.sound;
      if (!deviceMuted && soundEnabled) playNotificationSound();
    }
    primed.current = true;
  }, [authenticated, items, setNotifications]);

  return null;
}

'use client';

import { useEffect } from 'react';
import { useSessionStore } from '@/lib/store/sessionStore';
import { useSettingsStore } from '@/lib/store/settingsStore';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import { applyCandleColors, CANDLE_COLOR_CACHE_KEY } from '@/lib/settings/apply';

/**
 * Headless host that makes stored settings actually do something.
 *
 * Mounted once in AppFrame beside NotificationSync. Three jobs, all of them
 * "get a saved preference from the account onto the page":
 *
 *  1. Load `GET /auth/preferences` when a session appears, and drop the cached
 *     copy when it goes — a signed-out tab must not keep rendering the last
 *     user's colours.
 *  2. Adopt the account's theme. The local `workspaceStore.theme` stays the
 *     thing the renderer reads (it is what the pre-hydration script can see);
 *     this only pushes the server's value into it, once, when the account's
 *     copy differs from what this device had.
 *  3. Push the candle colours and density onto <html>, where the chart and the
 *     stylesheet read them.
 *
 * Nothing here writes to the server. Saves happen where the user makes the
 * change, so a failed save is reported next to the control that caused it.
 */
export function SettingsEffects() {
  const status = useSessionStore((s) => s.status);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const reset = useSettingsStore((s) => s.reset);
  const loaded = useSettingsStore((s) => s.loaded);
  const appearance = useSettingsStore((s) => s.prefs.appearance);
  const density = useSettingsStore((s) => s.prefs.general.density);
  const setTheme = useWorkspaceStore((s) => s.setTheme);

  useEffect(() => {
    if (status === 'authenticated') {
      void hydrate();
    } else if (status === 'unauthenticated') {
      reset();
      // Clear the mirrored colours too. They are a paint-time cache of one
      // account's choice, and leaving them behind would show the next person
      // to sign in on this device somebody else's chart.
      try {
        localStorage.removeItem(CANDLE_COLOR_CACHE_KEY);
      } catch {
        /* private mode / storage disabled — the cache is optional by design */
      }
    }
  }, [status, hydrate, reset]);

  // Adopt the account's theme once the real document has arrived. Gated on
  // `loaded` so the defaults this store starts with can never overwrite a
  // deliberate local choice before the server has answered.
  useEffect(() => {
    if (!loaded) return;
    if (useWorkspaceStore.getState().theme !== appearance.theme) setTheme(appearance.theme);
  }, [loaded, appearance.theme, setTheme]);

  useEffect(() => {
    applyCandleColors(appearance.candleUp, appearance.candleDown);
  }, [appearance.candleUp, appearance.candleDown]);

  useEffect(() => {
    document.documentElement.setAttribute('data-density', density);
  }, [density]);

  return null;
}

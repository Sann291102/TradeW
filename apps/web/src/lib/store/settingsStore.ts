'use client';

import { create } from 'zustand';
import { api } from '../api';
import {
  DEFAULT_PREFERENCES,
  parsePreferences,
  type PreferenceKey,
  type PreferenceSet,
} from '../settings/preferences';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface SettingsState {
  /** The live preference set. Starts at defaults so every reader has something
   *  valid to render before (and without) a server round-trip. */
  prefs: PreferenceSet;
  /** Whether `hydrate()` has completed at least once for the current session.
   *  Surfaces that must not save over an un-loaded document check this. */
  loaded: boolean;
  loading: boolean;
  /** Per-key save state, so one section's spinner is not another's. */
  saveState: Partial<Record<PreferenceKey, SaveState>>;
  /** Per-key error text from the last failed save. */
  saveError: Partial<Record<PreferenceKey, string>>;

  hydrate: () => Promise<void>;
  reset: () => void;
  /**
   * Merge a patch into one preference document and persist it.
   *
   * Returns true only when the server accepted the write. The local copy is
   * updated optimistically so the control does not lag the click, and rolled
   * back on failure — the alternative (leave the new value on screen after a
   * 4xx) is the exact "says Saved, saved nothing" behaviour this whole area
   * has to avoid.
   */
  update: <K extends PreferenceKey>(key: K, patch: Partial<PreferenceSet[K]>) => Promise<boolean>;
  /** Replace one document wholesale — used by "Reset to default". */
  replace: <K extends PreferenceKey>(key: K, value: PreferenceSet[K]) => Promise<boolean>;
}

/**
 * Server-backed user settings.
 *
 * ── WHY THIS IS NOT `persist()`d TO localStorage ───────────────────────────
 *
 * `workspaceStore` persists to localStorage because what it holds — which
 * panels are open, which tab is active — is genuinely per-device. Settings are
 * not: a trader who sets their candle colours on a laptop expects them on the
 * phone. So this store is a cache of `UserPreference` rows and nothing else.
 * It holds NO authority: the values are whatever the last successful
 * `GET /auth/preferences` returned, plus writes the server acknowledged.
 *
 * A signed-out visitor gets `DEFAULT_PREFERENCES` and cannot save — there is
 * no account to save against, and writing to localStorage instead would create
 * a second, divergent source of truth the moment they signed in.
 */
export const useSettingsStore = create<SettingsState>((set, get) => ({
  prefs: DEFAULT_PREFERENCES,
  loaded: false,
  loading: false,
  saveState: {},
  saveError: {},

  hydrate: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const raw = (await api('/auth/preferences')) as Record<string, unknown>;
      set({ prefs: parsePreferences(raw), loaded: true, loading: false });
    } catch {
      // A failed load is not a reason to show a user someone else's defaults
      // as though they were theirs — `loaded` stays false, and the sections
      // that can save check it before offering to.
      set({ loading: false });
    }
  },

  reset: () => set({ prefs: DEFAULT_PREFERENCES, loaded: false, saveState: {}, saveError: {} }),

  update: async (key, patch) => {
    const next = { ...get().prefs[key], ...patch } as PreferenceSet[typeof key];
    return get().replace(key, next);
  },

  replace: async (key, value) => {
    const previous = get().prefs[key];
    set((s) => ({
      prefs: { ...s.prefs, [key]: value },
      saveState: { ...s.saveState, [key]: 'saving' },
      saveError: { ...s.saveError, [key]: undefined },
    }));
    try {
      await api(`/auth/preferences/${key}`, { method: 'POST', body: JSON.stringify({ value }) });
      set((s) => ({ saveState: { ...s.saveState, [key]: 'saved' } }));
      return true;
    } catch (err) {
      set((s) => ({
        // Roll back. The control snaps to what is actually stored.
        prefs: { ...s.prefs, [key]: previous },
        saveState: { ...s.saveState, [key]: 'error' },
        saveError: {
          ...s.saveError,
          [key]: err instanceof Error ? err.message : 'Could not save that setting.',
        },
      }));
      return false;
    }
  },
}));

/** Convenience selector — the whole set, for readers that need several groups. */
export const usePreferences = () => useSettingsStore((s) => s.prefs);

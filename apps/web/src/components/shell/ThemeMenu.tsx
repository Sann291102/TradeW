'use client';

import { cn } from '@tradew/ui';
import { useWorkspaceStore, type ThemeName } from '@/lib/store/workspaceStore';
import { Popover } from '../workspace/Popover';
import { SunIcon, MoonIcon, ContrastIcon, CheckIcon, DeviceIcon } from './icons';
import { useSessionStore } from '@/lib/store/sessionStore';
import { useSettingsStore } from '@/lib/store/settingsStore';

const THEMES: Array<{ id: ThemeName; label: string; icon: typeof SunIcon }> = [
  { id: 'dark', label: 'Dark', icon: MoonIcon },
  { id: 'light', label: 'Light', icon: SunIcon },
  // Added with the Settings -> Appearance screen. Resolved to dark or light
  // against prefers-color-scheme before it is painted; see resolveTheme().
  { id: 'system', label: 'System', icon: DeviceIcon },
  { id: 'high-contrast', label: 'High Contrast', icon: ContrastIcon },
];

/** ThemeMenu — Theme Engine switcher (Milestone 3 §9): dark/light/high-contrast, token-driven. */
export function ThemeMenu() {
  const theme = useWorkspaceStore((s) => s.theme);
  const setTheme = useWorkspaceStore((s) => s.setTheme);
  const signedIn = useSessionStore((s) => s.status === 'authenticated');
  const updatePrefs = useSettingsStore((s) => s.update);
  const current = THEMES.find((t) => t.id === theme) ?? THEMES[0];

  return (
    <Popover
      align="right"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-label="Change theme"
          aria-expanded={open}
          aria-haspopup="menu"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors duration-micro hover:bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <current.icon className="h-[18px] w-[18px]" />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              role="menuitemradio"
              aria-checked={t.id === theme}
              onClick={() => {
                setTheme(t.id);
                // Persist to the account as well, so the choice follows the
                // user to their other devices rather than living only in this
                // browser's localStorage. Fire-and-forget: the local switch has
                // already happened and must not wait on, or be undone by, a
                // network call. Signed-out visitors keep the local-only
                // behaviour this menu has always had.
                if (signedIn) void updatePrefs('appearance', { theme: t.id });
                close();
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-semibold',
                'transition-colors duration-micro hover:bg-hover',
                t.id === theme ? 'text-teal' : 'text-text',
              )}
            >
              <t.icon className="h-3.5 w-3.5" />
              {t.label}
              {t.id === theme && <CheckIcon className="ml-auto h-3.5 w-3.5" />}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

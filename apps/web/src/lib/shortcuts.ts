/**
 * The documented shortcut table (Milestone 3 §7 — "document all shortcuts").
 * `combo` is the display string; matching logic lives in useKeyboardShortcuts
 * (kept separate so this file stays a pure data source for ShortcutsHelp).
 *
 * Every bound shortcut uses a modifier key (Ctrl/⌘), so it's safe to fire
 * globally regardless of focus — a modifier+letter combo doesn't insert text
 * into a focused input, unlike a bare key. Escape is the one bare-key binding
 * and is safe everywhere (it never types a character). Space is intentionally
 * NOT bound globally — reserved for a possible future "quick preview," binding
 * it now would break every text input and button on the page.
 */
export interface ShortcutEntry {
  combo: string;
  description: string;
}

export const SHORTCUTS: ShortcutEntry[] = [
  { combo: 'Ctrl / ⌘ + K', description: 'Open the command palette (search everything)' },
  { combo: 'Ctrl / ⌘ + P', description: 'Quick open (alias for the command palette)' },
  { combo: 'Ctrl / ⌘ + B', description: 'Toggle the sidebar' },
  { combo: 'Ctrl / ⌘ + Shift + F', description: 'Focus the top bar search field' },
  { combo: 'Ctrl / ⌘ + /', description: 'Show this shortcuts reference' },
  { combo: 'Esc', description: 'Close the command palette, notifications, shortcuts help, or mobile menu' },
  { combo: '↑ / ↓', description: 'Move selection in the command palette and notification list' },
  { combo: 'Enter', description: 'Activate the highlighted command palette result' },
  { combo: 'Double-click a workspace tab', description: 'Rename it' },
  { combo: 'Drag a panel’s grip handle', description: 'Move it to another dock zone' },
];

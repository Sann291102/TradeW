'use client';

import { cn } from '@tradew/ui';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import { Popover } from './Popover';
import { LayoutIcon, ChevronIcon, CheckIcon } from '../shell/icons';

/**
 * LayoutMenu — the "Workspace Layout Manager" (Milestone 3 §2): switch between
 * the 6 built-in presets (Scalping/Swing/Options/Learning/Research/Minimal).
 * Applying a preset replaces the active tab's panel arrangement + column
 * sizes; the user's own resize/move/close edits after that mark the tab
 * "customized" until they reset.
 */
export function LayoutMenu() {
  const layouts = useWorkspaceStore((s) => s.layouts);
  const tab = useWorkspaceStore((s) => s.activeTab());
  const applyLayout = useWorkspaceStore((s) => s.applyLayout);
  const active = layouts.find((l) => l.id === tab.activeLayoutId);

  return (
    <Popover
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="menu"
          className="flex items-center gap-1.5 rounded-lg border border-border2 px-2.5 py-1.5 text-xs font-semibold text-muted transition-colors duration-micro hover:bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <LayoutIcon className="h-3.5 w-3.5" />
          {active?.name ?? 'Layout'}
          {tab.layoutDirty && <span className="h-1.5 w-1.5 rounded-full bg-amber" aria-label="unsaved changes" />}
          <ChevronIcon className={cn('h-3 w-3 transition-transform duration-micro', open && 'rotate-90')} />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label="Workspace layouts">
          {layouts.map((l) => (
            <button
              key={l.id}
              role="menuitemradio"
              aria-checked={l.id === tab.activeLayoutId}
              onClick={() => {
                applyLayout(l.id);
                close();
              }}
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-semibold',
                'transition-colors duration-micro hover:bg-hover',
                l.id === tab.activeLayoutId ? 'text-teal' : 'text-text',
              )}
            >
              {l.name}
              {l.id === tab.activeLayoutId && <CheckIcon className="h-3.5 w-3.5" />}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

'use client';

import { cn } from '@tradew/ui';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import { Popover } from './Popover';
import { PANEL_REGISTRY } from './panel-registry';
import { PlusIcon, ChevronIcon } from '../shell/icons';

/**
 * ClosedPanelsMenu — the "Restore" half of close/restore (Milestone 3 §1).
 * Closing a panel just hides it (visible: false); this is how it comes back
 * without reapplying a whole layout preset.
 */
export function ClosedPanelsMenu() {
  const tab = useWorkspaceStore((s) => s.activeTab());
  const restorePanel = useWorkspaceStore((s) => s.restorePanel);
  const closed = tab.panels.filter((p) => !p.visible);

  return (
    <Popover
      align="right"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          disabled={closed.length === 0}
          aria-expanded={open}
          aria-haspopup="menu"
          className="flex items-center gap-1.5 rounded-lg border border-border2 px-2.5 py-1.5 text-xs font-semibold text-muted transition-colors duration-micro hover:bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-40"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          Closed {closed.length > 0 && `(${closed.length})`}
          <ChevronIcon className={cn('h-3 w-3 transition-transform duration-micro', open && 'rotate-90')} />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label="Closed panels">
          {closed.length === 0 ? (
            <p className="px-2.5 py-1.5 text-xs text-faint">Nothing closed</p>
          ) : (
            closed.map((p) => {
              const entry = PANEL_REGISTRY[p.kind];
              return (
                <button
                  key={p.id}
                  role="menuitem"
                  onClick={() => {
                    restorePanel(p.id);
                    close();
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-semibold text-text transition-colors duration-micro hover:bg-hover"
                >
                  <entry.icon className="h-3.5 w-3.5 text-faint" />
                  {entry.title}
                </button>
              );
            })
          )}
        </div>
      )}
    </Popover>
  );
}

'use client';

import { IconButton, cn } from '@tradew/ui';
import { useWorkspaceStore, type PanelState } from '@/lib/store/workspaceStore';
import { GripIcon, PinIcon, CloseIcon, ChevronUpIcon, ChevronDownIcon, PopOutIcon, ChevronIcon } from '../shell/icons';

interface DockControlsProps {
  panel: PanelState;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

const btn = 'h-6 w-6 rounded';

/**
 * DockControls — the chrome every dockable panel gets in its own header,
 * rendered via that panel's `actions` prop (see terminal/panels/types.ts) so
 * there's exactly one header row per panel, not a second stacked bar.
 *
 * Move: Grip (M2)     Reorder: ▲▼ (2)     Pin: (M2)     Pop-out: (M2, arch. only)
 * Collapse: ⌄ (M2)    Close: ✕ (M2)
 */
export function DockControls({ panel, canMoveUp, canMoveDown }: DockControlsProps) {
  const toggleCollapse = useWorkspaceStore((s) => s.toggleCollapse);
  const togglePin = useWorkspaceStore((s) => s.togglePin);
  const closePanel = useWorkspaceStore((s) => s.closePanel);
  const reorderPanel = useWorkspaceStore((s) => s.reorderPanel);

  function onDragStart(e: React.DragEvent) {
    e.dataTransfer.setData('text/tradew-panel', panel.id);
    e.dataTransfer.effectAllowed = 'move';
    const card = (e.target as HTMLElement).closest('section');
    if (card) e.dataTransfer.setDragImage(card, 16, 16);
  }

  return (
    <div className="flex items-center gap-0.5">
      {(canMoveUp || canMoveDown) && (
        <>
          <IconButton
            aria-label={`Move ${panel.kind} panel up`}
            disabled={!canMoveUp}
            onClick={() => reorderPanel(panel.id, 'up')}
            className={btn}
          >
            <ChevronUpIcon className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            aria-label={`Move ${panel.kind} panel down`}
            disabled={!canMoveDown}
            onClick={() => reorderPanel(panel.id, 'down')}
            className={btn}
          >
            <ChevronDownIcon className="h-3.5 w-3.5" />
          </IconButton>
        </>
      )}
      <IconButton
        aria-label={panel.pinned ? `Unpin ${panel.kind} panel` : `Pin ${panel.kind} panel`}
        aria-pressed={panel.pinned}
        onClick={() => togglePin(panel.id)}
        className={cn(btn, panel.pinned && 'text-teal')}
      >
        <PinIcon className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton
        aria-label="Pop out to another monitor — coming soon"
        disabled={!panel.detachable}
        title={panel.detachable ? 'Multi-monitor pop-out — coming soon' : undefined}
        className={btn}
      >
        <PopOutIcon className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton
        aria-label={panel.collapsed ? `Expand ${panel.kind} panel` : `Collapse ${panel.kind} panel`}
        aria-expanded={!panel.collapsed}
        onClick={() => toggleCollapse(panel.id)}
        className={btn}
      >
        <ChevronIcon className={cn('h-3.5 w-3.5 transition-transform duration-micro', panel.collapsed ? '-rotate-90' : 'rotate-90')} />
      </IconButton>
      <IconButton aria-label={`Close ${panel.kind} panel`} onClick={() => closePanel(panel.id)} className={btn}>
        <CloseIcon className="h-3.5 w-3.5" />
      </IconButton>
      <span
        draggable
        onDragStart={onDragStart}
        role="button"
        tabIndex={-1}
        aria-hidden="true"
        title="Drag to move this panel to another dock zone"
        className="ml-0.5 flex h-6 w-4 cursor-grab items-center justify-center text-faint hover:text-muted active:cursor-grabbing"
      >
        <GripIcon className="h-3.5 w-3.5" />
      </span>
    </div>
  );
}

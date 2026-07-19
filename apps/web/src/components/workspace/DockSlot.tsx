'use client';

import { useState } from 'react';
import { cn } from '@tradew/ui';
import { useWorkspaceStore, type PanelState, type SlotId } from '@/lib/store/workspaceStore';
import { PANEL_REGISTRY } from './panel-registry';
import { DockControls } from './DockControls';

interface DockSlotProps {
  slot: SlotId;
  panels: PanelState[];
  className?: string;
  emptyHint?: string;
}

/**
 * DockSlot — one dock zone. Renders its visible panels as a vertical stack
 * (each takes an equal share of the slot's height unless collapsed) and
 * accepts a panel dropped from any other slot (native HTML5 DnD — see
 * DockControls' grip handle), reassigning that panel's `slot`.
 */
export function DockSlot({ slot, panels, className, emptyHint = 'Drop a panel here' }: DockSlotProps) {
  const movePanelToSlot = useWorkspaceStore((s) => s.movePanelToSlot);
  const [dropHover, setDropHover] = useState(false);

  const visible = panels.filter((p) => p.slot === slot && p.visible).sort((a, b) => a.order - b.order);

  function onDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes('text/tradew-panel')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dropHover) setDropHover(true);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDropHover(false);
    const id = e.dataTransfer.getData('text/tradew-panel');
    if (id) movePanelToSlot(id as PanelState['id'], slot);
  }

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={() => setDropHover(false)}
      onDrop={onDrop}
      className={cn(
        'flex min-h-0 flex-col gap-3 rounded-card transition-colors duration-micro',
        dropHover && 'outline outline-2 outline-dashed outline-teal outline-offset-2',
        className,
      )}
    >
      {visible.length === 0 ? (
        <div className="flex min-h-[80px] flex-1 items-center justify-center rounded-card border border-dashed border-border2 text-[11px] text-faint">
          {emptyHint}
        </div>
      ) : (
        visible.map((panel, idx) => {
          const entry = PANEL_REGISTRY[panel.kind];
          const Content = entry.Component;
          return (
            <div key={panel.id} className={cn('min-h-0', panel.collapsed ? 'shrink-0' : 'flex-1')}>
              <Content
                className="h-full"
                collapsed={panel.collapsed}
                actions={<DockControls panel={panel} canMoveUp={idx > 0} canMoveDown={idx < visible.length - 1} />}
              />
            </div>
          );
        })
      )}
    </div>
  );
}

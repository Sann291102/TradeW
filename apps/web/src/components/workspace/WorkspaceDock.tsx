'use client';

import { useRef } from 'react';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import { DockSlot } from './DockSlot';
import { Splitter } from './Splitter';

/**
 * WorkspaceDock — the dockable trading workspace (Milestone 3), superseding
 * M2's static `TerminalWorkspace` grid (archived at
 * archive/web-terminal-workspace-static-grid.tsx.txt). Same panel CONTENT
 * components as M2 — only the arrangement is now dynamic: store-driven,
 * resizable, collapsible, movable between zones, closable/restorable.
 *
 * Layout: two vertical splitters split the row into left / center / right;
 * within center, one horizontal splitter splits main (chart) from the auxA/
 * auxB row. Every zone is a DockSlot, which independently supports 0+ stacked
 * panels — dragging a panel into any zone is always valid.
 */
export function WorkspaceDock() {
  const tab = useWorkspaceStore((s) => s.activeTab());
  const resizeColumns = useWorkspaceStore((s) => s.resizeColumns);
  const resizeMainHeight = useWorkspaceStore((s) => s.resizeMainHeight);

  const { panels, leftWidth, rightWidth, mainHeightPct } = tab;
  const centerRef = useRef<HTMLDivElement>(null);

  return (
    <>
      {/* Desktop: full dock with splitters */}
      <div className="hidden min-h-0 gap-0 p-3 lg:flex lg:h-full">
        <div className="min-h-0 shrink-0" style={{ width: leftWidth }}>
          <DockSlot slot="left" panels={panels} className="h-full" emptyHint="Drop watchlist, learning, or research here" />
        </div>
        <Splitter
          orientation="vertical"
          aria-label="Resize left panel column"
          onDelta={(d) => resizeColumns(leftWidth + d, rightWidth)}
        />

        <div ref={centerRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0" style={{ flex: `${mainHeightPct} 0 0%` }}>
            <DockSlot slot="main" panels={panels} className="h-full" emptyHint="Drop the chart or another panel here" />
          </div>
          <Splitter
            orientation="horizontal"
            aria-label="Resize chart height"
            onDelta={(d) => {
              const containerH = centerRef.current?.clientHeight || 640;
              resizeMainHeight(mainHeightPct + (d / containerH) * 100);
            }}
          />
          <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 pt-3">
            <DockSlot slot="auxA" panels={panels} emptyHint="Drop blotter, news, or research here" />
            <DockSlot slot="auxB" panels={panels} emptyHint="Drop option chain or another panel here" />
          </div>
        </div>

        <Splitter
          orientation="vertical"
          aria-label="Resize right panel column"
          onDelta={(d) => resizeColumns(leftWidth, rightWidth - d)}
        />
        <div className="min-h-0 shrink-0 overflow-y-auto" style={{ width: rightWidth }}>
          <DockSlot slot="right" panels={panels} emptyHint="Drop order ticket, depth, sentinel, or news here" />
        </div>
      </div>

      {/* Mobile/tablet: stacked, no resize/drag — same panels, reading order */}
      <div className="flex flex-col gap-3 p-3 lg:hidden">
        <DockSlot slot="main" panels={panels} />
        <DockSlot slot="left" panels={panels} />
        <DockSlot slot="auxA" panels={panels} />
        <DockSlot slot="auxB" panels={panels} />
        <DockSlot slot="right" panels={panels} />
      </div>
    </>
  );
}

'use client';

import { useRef, useState } from 'react';
import { cn, IconButton } from '@tradew/ui';
import { useWorkspaceStore } from '@/lib/store/workspaceStore';
import { LayoutMenu } from './LayoutMenu';
import { ClosedPanelsMenu } from './ClosedPanelsMenu';
import { PlusIcon, CloseIcon } from '../shell/icons';

function TabButton({ id, name, active }: { id: string; name: string; active: boolean }) {
  const switchTab = useWorkspaceStore((s) => s.switchWorkspaceTab);
  const renameTab = useWorkspaceStore((s) => s.renameWorkspaceTab);
  const removeTab = useWorkspaceStore((s) => s.removeWorkspaceTab);
  const tabCount = useWorkspaceStore((s) => s.workspaceTabs.length);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  function commit() {
    setEditing(false);
    renameTab(id, draft);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setDraft(name);
            setEditing(false);
          }
        }}
        aria-label="Workspace tab name"
        className="w-28 rounded-md border border-teal bg-bg px-2 py-1 text-xs font-semibold text-text focus-visible:outline-none"
      />
    );
  }

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={() => switchTab(id)}
      onDoubleClick={() => setEditing(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') switchTab(id);
        if (e.key === 'F2') setEditing(true);
      }}
      title="Double-click to rename"
      className={cn(
        'group flex cursor-pointer items-center gap-1.5 rounded-t-md border-b-2 px-3 py-1.5 text-xs font-semibold',
        'transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
        active ? 'border-teal text-teal' : 'border-transparent text-muted hover:text-text',
      )}
    >
      <span className="max-w-[120px] truncate">{name}</span>
      {tabCount > 1 && (
        <span
          role="button"
          tabIndex={-1}
          aria-label={`Close ${name}`}
          onClick={(e) => {
            e.stopPropagation();
            removeTab(id);
          }}
          className="rounded p-0.5 text-faint opacity-0 hover:bg-hover hover:text-text group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <CloseIcon className="h-3 w-3" />
        </span>
      )}
    </div>
  );
}

/**
 * WorkspaceTabs — "Workspace Tabs" (Milestone 3 §4): multiple independent
 * workspaces, each remembering its own panel arrangement, sizes, selected
 * symbol, and watchlist tab (WorkspaceTab in the store). Rendered above the
 * dock on the Trade route only — it's the trading workspace's own tab strip,
 * not a replacement for the app's page navigation (Sidebar).
 */
export function WorkspaceTabs() {
  const tabs = useWorkspaceStore((s) => s.workspaceTabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const addTab = useWorkspaceStore((s) => s.addWorkspaceTab);

  return (
    <div role="tablist" aria-label="Workspaces" className="flex items-center gap-1 border-b border-border bg-card px-3">
      {tabs.map((t) => (
        <TabButton key={t.id} id={t.id} name={t.name} active={t.id === activeTabId} />
      ))}
      <IconButton aria-label="New workspace tab" onClick={() => addTab()} className="h-7 w-7">
        <PlusIcon className="h-3.5 w-3.5" />
      </IconButton>
      <div className="ml-auto flex items-center gap-1.5 py-1.5">
        <LayoutMenu />
        <ClosedPanelsMenu />
      </div>
    </div>
  );
}

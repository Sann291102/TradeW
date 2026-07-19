import type { ReactNode } from 'react';

/**
 * Shared prop contract for every dockable panel's content component
 * (Milestone 3). `WorkspaceDock` renders each panel through this contract so
 * dock chrome (collapse/pin/close/reorder controls) lands in the SAME header
 * row as the panel's own title/actions, instead of a second stacked header.
 */
export interface DockPanelContentProps {
  className?: string;
  /** Dock controls, merged into this panel's own `<Panel actions>`. */
  actions?: ReactNode;
  /** Hides the body, keeps the header — set by the dock when the user collapses this panel. */
  collapsed?: boolean;
}

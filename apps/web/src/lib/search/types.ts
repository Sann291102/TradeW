import type { ComponentType, SVGProps } from 'react';
import type { ThemeName } from '../store/workspaceStore';

export interface SearchResult {
  id: string;
  title: string;
  subtitle?: string;
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  /** Rendered but not activatable — used by stub providers (§6 of the M3 brief:
   *  "prepare modular providers, backend search can come later"). */
  disabled?: boolean;
  action?: () => void;
}

/** Everything a provider needs to actually DO something (navigate, mutate
 *  workspace state) without importing hooks into a plain lib module. */
export interface SearchContext {
  navigate: (href: string) => void;
  setSelectedSymbol: (symbol: string) => void;
  setTheme: (theme: ThemeName) => void;
  toggleSidebar: () => void;
  openNotifications: () => void;
  openShortcutsHelp: () => void;
  resetLayout: () => void;
  newWorkspaceTab: () => void;
}

export interface SearchProvider {
  id: string;
  label: string;
  search: (query: string, ctx: SearchContext) => SearchResult[];
}

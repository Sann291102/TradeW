import { WorkspaceTabs } from '@/components/workspace/WorkspaceTabs';
import { WorkspaceDock } from '@/components/workspace/WorkspaceDock';

export const metadata = { title: 'Trade — TradeW Terminal' };

/**
 * Trade workspace (Milestone 3) — the institutional dockable trading desk:
 * multiple workspace tabs, each with its own resizable/movable/collapsible
 * panel arrangement, switchable layout presets, and closed-panel restore.
 * See components/workspace/WorkspaceDock.tsx and WORKSPACE-SHELL.md.
 *
 * Superseded the M2 static grid (components/terminal/TerminalWorkspace.tsx,
 * now a deprecation stub; full original archived per Rule 1). The Sprint-0
 * order-entry form is archived at archive/web-trade-sprint0-page.tsx.txt —
 * its backend wiring returns to the Order Ticket / Blotter panels later.
 */
export default function TradePage() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceTabs />
      <div className="min-h-0 flex-1">
        <WorkspaceDock />
      </div>
    </div>
  );
}

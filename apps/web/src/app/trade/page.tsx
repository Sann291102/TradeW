import { Suspense } from 'react';
import { TradeWorkspace } from '@/components/trade/TradeWorkspace';

export const metadata = { title: 'Trade — TradeW Terminal' };

/**
 * Trade page — a single integrated instrument workspace (Phase 1 redesign),
 * not a dock of movable panels. Previously rendered `WorkspaceTabs` +
 * `WorkspaceDock` (Milestone 3's dockable trading desk); superseded per
 * explicit feedback that the dock's chrome (drag handles, pin/pop-out/
 * collapse/close, multi-workspace tabs, empty drop zones) read as bolted-on
 * "addon" widgets rather than one page. That dock infrastructure is untouched
 * and still available — see components/workspace/ and WORKSPACE-SHELL.md —
 * just not used on this route anymore (never deleted, per repo Rule 1). The
 * M2 static grid before that is archived at
 * archive/web-terminal-workspace-static-grid.tsx.txt.
 */
export default function TradePage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-faint">Loading…</div>}>
      <TradeWorkspace />
    </Suspense>
  );
}

'use client';

import { Panel } from '@tradew/ui';
import { OptionChainTab } from './chart-tabs/OptionChainTab';
import type { DockPanelContentProps } from './types';

/**
 * Option Chain slot — standalone panel, kept for the "Closed" restore menu
 * and any layout that wants it as its own dock panel rather than a tab
 * inside ChartPanel. Thin wrapper over the shared `OptionChainTab` content
 * so the two surfaces never drift. Lazy-loaded (next/dynamic) per the
 * performance brief. Default export for dynamic import.
 */
export default function OptionChainPanel({ className, actions, collapsed }: DockPanelContentProps) {
  return (
    <Panel
      title="Option Chain"
      subtitle="NIFTY · nearest expiry"
      className={className}
      actions={actions}
      collapsed={collapsed}
      bodyClassName="flex flex-col"
    >
      <OptionChainTab />
    </Panel>
  );
}

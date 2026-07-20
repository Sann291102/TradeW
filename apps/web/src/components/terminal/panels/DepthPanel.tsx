import { Panel } from '@tradew/ui';
import { DepthTab } from './chart-tabs/DepthTab';
import type { DockPanelContentProps } from './types';

/**
 * Market Depth slot — standalone panel, kept for the "Closed" restore menu
 * and any layout that wants it as its own dock panel rather than a tab
 * inside ChartPanel. Thin wrapper over the shared `DepthTab` content so the
 * two surfaces never drift.
 */
export function DepthPanel({ className, actions, collapsed }: DockPanelContentProps) {
  return (
    <Panel title="Market Depth" className={className} actions={actions} collapsed={collapsed}>
      <DepthTab />
    </Panel>
  );
}

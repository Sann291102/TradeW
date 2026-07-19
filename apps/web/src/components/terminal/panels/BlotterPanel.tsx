'use client';

import { useState } from 'react';
import { Panel, EmptyState, cn } from '@tradew/ui';
import type { DockPanelContentProps } from './types';

// Positions / Orders / Trades / Activity slots, combined into one tabbed blotter
// (matches the canonical terminal's bottom tab strip). Empty states in M2 — the
// backend blotter data wires in a later milestone.
const TABS = ['Positions', 'Orders', 'Trades', 'Activity'] as const;
type Tab = (typeof TABS)[number];

const EMPTY_COPY: Record<Tab, string> = {
  Positions: 'No open positions',
  Orders: 'No orders yet',
  Trades: 'No trades today',
  Activity: 'No recent activity',
};

export function BlotterPanel({ className, actions, collapsed }: DockPanelContentProps) {
  const [tab, setTab] = useState<Tab>('Positions');
  return (
    <Panel
      className={className}
      actions={actions}
      collapsed={collapsed}
      title={
        <span
          role="tablist"
          aria-label="Blotter"
          className="flex items-center gap-1"
        >
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                'rounded px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                tab === t ? 'bg-teal-bg text-teal' : 'text-muted hover:text-text',
              )}
            >
              {t}
            </button>
          ))}
        </span>
      }
    >
      <EmptyState title={EMPTY_COPY[tab]} description="Data appears here once the trading backend is connected." />
    </Panel>
  );
}

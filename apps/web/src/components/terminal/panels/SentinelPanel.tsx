import Link from 'next/link';
import { Panel, Badge, buttonClasses } from '@tradew/ui';
import { SentinelIcon } from '../../shell/icons';
import type { DockPanelContentProps } from './types';

/**
 * Sentinel slot in the terminal — always visible, but premium reasoning is
 * entitlement-gated (SUBSCRIPTIONS.md §4, TRADEW-OS.md §5). M2 renders the
 * locked/upgrade state; observation content arrives when entitled + wired.
 */
export function SentinelPanel({ className, actions, collapsed }: DockPanelContentProps) {
  return (
    <Panel
      className={className}
      collapsed={collapsed}
      title={
        <span className="flex items-center gap-1.5 normal-case">
          <SentinelIcon className="h-4 w-4 text-teal" />
          Sentinel
        </span>
      }
      actions={
        <>
          <Badge tone="warning" className="px-1.5 py-0 text-[9px]">PRO</Badge>
          {actions}
        </>
      }
    >
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <p className="text-xs text-muted">
          Sentinel observes market structure and your behavior in parallel — never a buy/sell
          instruction. Unlock premium reasoning to see live observations here.
        </p>
        <Link href="/settings" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
          Start free trial
        </Link>
        <p className="text-[10px] text-faint">Observation only — never investment advice.</p>
      </div>
    </Panel>
  );
}

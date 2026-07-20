import Link from 'next/link';
import { Panel, Badge, buttonClasses } from '@tradew/ui';
import { OBSERVATION_ONLY_DISCLAIMER } from '@/lib/sentinel/types';
import { SentinelIcon } from '../../shell/icons';
import type { DockPanelContentProps } from './types';

/**
 * Sentinel slot in the terminal — always visible, but premium reasoning is
 * entitlement-gated (SUBSCRIPTIONS.md §4, TRADEW-OS.md §5). Locked/upgrade
 * teaser; the full observation experience lives at /sentinel (see
 * SENTINEL.md §5 — the two surfaces share `OBSERVATION_ONLY_DISCLAIMER` and
 * the agent-label/color maps from lib/sentinel/types.ts so they never drift).
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
        <p className="text-xs text-muted">{OBSERVATION_ONLY_DISCLAIMER} Unlock premium reasoning to see live observations here.</p>
        <Link href="/settings" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
          Start free trial
        </Link>
        <p className="text-[10px] text-faint">Observation only — never investment advice.</p>
      </div>
    </Panel>
  );
}

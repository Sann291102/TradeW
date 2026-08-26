import Link from 'next/link';
import { Panel, EmptyState, Badge } from '@tradew/ui';
import { ResearchIcon } from '../../shell/icons';
import { RESEARCH_SECTIONS } from '@/lib/research/sections';
import type { DockPanelContentProps } from './types';

/** Research mini panel — a real launcher into the Research workspace's live sections. */
export function ResearchMiniPanel({ className, actions, collapsed }: DockPanelContentProps) {
  return (
    <Panel title="Research" className={className} actions={actions} collapsed={collapsed}>
      <EmptyState
        icon={<ResearchIcon className="h-6 w-6" />}
        title="Deep research, on-demand"
        description="Per-symbol company, fundamentals, and technicals analysis — TradeW AI's Research workspace."
      />
      <div className="mt-2 flex flex-wrap gap-1">
        {RESEARCH_SECTIONS.slice(0, 6).map((section) => (
          <Badge key={section.key} tone="neutral" className="px-1.5 py-0 text-[9px]">
            {section.label}
          </Badge>
        ))}
      </div>
      <Link href="/research" className="mt-3 inline-block text-[11px] font-semibold text-teal hover:underline">
        Open Research workspace →
      </Link>
    </Panel>
  );
}

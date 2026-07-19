import Link from 'next/link';
import { Panel } from '@tradew/ui';
import { LEARNING_PATHS } from '@/lib/mock/learning';
import type { DockPanelContentProps } from './types';

/** Learning mini panel — continue-learning teaser for the dock, linking to `/learning`. */
export function LearningMiniPanel({ className, actions, collapsed }: DockPanelContentProps) {
  return (
    <Panel title="Learning" className={className} actions={actions} collapsed={collapsed}>
      <div className="space-y-2">
        {LEARNING_PATHS.map((p) => (
          <div key={p.name}>
            <div className="text-xs font-semibold text-text">{p.name}</div>
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-border2">
              <div className="h-full rounded-full bg-teal" style={{ width: `${p.pct}%` }} />
            </div>
          </div>
        ))}
      </div>
      <Link href="/learning" className="mt-3 inline-block text-[11px] font-semibold text-teal hover:underline">
        Open Learning Hub →
      </Link>
    </Panel>
  );
}

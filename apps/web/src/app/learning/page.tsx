import { Card, Badge, cn } from '@tradew/ui';
import { LearningIcon } from '@/components/shell/icons';
import { LEARNING_CATEGORIES as CATEGORIES, LEARNING_PATHS as PATHS } from '@/lib/mock/learning';

export const metadata = { title: 'Learning — TradeW' };

/**
 * Learning Hub workspace (LEARNING-HUB.md) — its own pillar/nav entry, NOT part
 * of Sentinel. M2 prepares the UI architecture: learning paths with progress +
 * the category grid. Lesson content is generated/served in a later phase.
 */
export default function LearningPage() {
  return (
    <div className="mx-auto max-w-[1200px] space-y-4 p-4">
      <Card title="Continue learning" subtitle="· your paths">
        <div className="grid gap-3 sm:grid-cols-3">
          {PATHS.map((p) => (
            <div key={p.name} className="rounded-lg border border-border bg-bg p-3">
              <div className="text-sm font-semibold text-text">{p.name}</div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border2">
                <div className="h-full rounded-full bg-teal" style={{ width: `${p.pct}%` }} />
              </div>
              <div className="mt-1 text-[11px] text-faint">{p.pct > 0 ? `${p.pct}% complete` : 'Not started'}</div>
            </div>
          ))}
        </div>
      </Card>

      <div>
        <h2 className="mb-2 text-sm font-bold text-text">Explore by topic</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {CATEGORIES.map((c) => (
            <div
              key={c.name}
              className={cn(
                'flex flex-col gap-2 rounded-card border border-border bg-card p-4 shadow-card',
                'transition-colors duration-micro hover:border-teal',
              )}
            >
              <span className="text-teal">
                <LearningIcon className="h-5 w-5" />
              </span>
              <div className="text-sm font-semibold text-text">{c.name}</div>
              <div className="mt-auto flex items-center justify-between">
                <span className="text-[11px] text-faint">{c.lessons} lessons</span>
                <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
                  {c.tier}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

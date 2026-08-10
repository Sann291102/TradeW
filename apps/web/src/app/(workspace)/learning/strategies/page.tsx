import Link from 'next/link';
import { Card, Badge, cn } from '@tradew/ui';
import { LearningIcon } from '@/components/shell/icons';
import { LEARNING_CATEGORIES as CATEGORIES, LEARNING_PATHS as PATHS } from '@/lib/mock/learning';
import { getLessons, getStrategies } from '@/lib/learning/catalog';
import { StrategyBrowser } from '@/components/learning/StrategyBrowser';

export const metadata = { title: 'Strategies — TradeW Learning' };

/**
 * Relocated 2026-08-04 from apps/web/src/app/learning/page.tsx (unchanged)
 * when the restored course-platform LearningClient took over the bare
 * /learning route as the Learning Hub homepage. See
 * archive/apps-web-learning-catalog-homepage-superseded-2026-08-04/ for the
 * displaced original and LearningClient.tsx for the new homepage.
 *
 * The strategy catalogue and lesson list are read from `docs/learning/` at
 * build time (see lib/learning/catalog.ts) — real authored content, not mock
 * data. The paths/categories cards above them are still the M2 placeholders,
 * since progress tracking needs the per-user tables from LEARNING-HUB.md §4
 * that do not exist yet.
 */
export default function LearningStrategiesPage() {
  const strategies = getStrategies();
  const lessons = getLessons();

  return (
    <div className="mx-auto max-w-[1200px] space-y-4 p-4">
      <Link href="/learning" className="text-[12px] text-teal hover:underline">← Learning</Link>

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
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-bold text-text">Strategies</h2>
          <span className="text-[11px] text-faint">
            {strategies.length} explained · each one can be drawn against live prices
          </span>
        </div>
        <div className="space-y-3">
          <StrategyBrowser strategies={strategies} />
        </div>
      </div>

      {lessons.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-bold text-text">Market structure &amp; concepts</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {lessons.map((lesson) => (
              <Link
                key={lesson.id}
                href={`/learning/strategy/${lesson.id}`}
                className="rounded-lg border border-border bg-card p-3 shadow-card transition-colors duration-micro hover:border-teal"
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold text-text">{lesson.name}</span>
                  <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
                    {lesson.tier}
                  </Badge>
                </div>
                <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{lesson.summary}</p>
              </Link>
            ))}
          </div>
        </div>
      )}

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

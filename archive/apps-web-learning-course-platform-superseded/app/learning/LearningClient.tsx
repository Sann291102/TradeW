'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, Badge, cn } from '@tradew/ui';
import { LearningIcon } from '@/components/shell/icons';
import { learningApi } from '@/lib/learning/api';
import type { CoursesResponse } from '@/lib/learning/types';

/**
 * Learning Hub landing — now backed by the generated course catalogue.
 * Reuses the original layout (Continue-learning row + "Explore by topic" grid)
 * and design tokens; the only change is that cards are real, clickable, lock-
 * and progress-aware, and driven entirely by the knowledge graph.
 */
export function LearningClient() {
  const [data, setData] = useState<CoursesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    learningApi
      .courses()
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setError('Could not load courses. The learning service may be starting up.'));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="mx-auto max-w-[1200px] p-4">
        <div className="rounded-card border border-border bg-card p-6 text-center text-[13px] text-muted">{error}</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-[1200px] p-4">
        <div className="rounded-card border border-border bg-card p-6 text-center text-[13px] text-muted">Loading courses…</div>
      </div>
    );
  }

  const started = data.courses.filter((c) => c.progress.completed > 0);
  const continueId = data.progress.continueLearning?.courseId;

  return (
    <div className="mx-auto max-w-[1200px] space-y-4 p-4">
      {data.isAdmin && (
        <div className="flex items-center gap-2 rounded-card border border-amber/40 bg-amber/5 px-4 py-2.5 text-[12.5px]">
          <span className="rounded bg-amber/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber">Admin</span>
          <span className="text-muted">Every course is unlocked and lesson tools are available inside each lesson.</span>
        </div>
      )}

      <Card title="Continue learning" subtitle="· your paths">
        <div className="grid gap-3 sm:grid-cols-3">
          {started.length === 0 ? (
            <div className="col-span-full text-[12.5px] text-muted">
              You haven’t started a course yet. Pick one below — {data.progress.streak > 0 ? `${data.progress.streak}-day streak going.` : 'begin your streak today.'}
            </div>
          ) : (
            started.slice(0, 3).map((c) => (
              <Link
                key={c.id}
                href={`/learning/${c.id}`}
                className={cn(
                  'rounded-lg border bg-bg p-3 transition-colors duration-micro hover:border-teal',
                  c.id === continueId ? 'border-teal' : 'border-border',
                )}
              >
                <div className="text-sm font-semibold text-text">{c.name}</div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border2">
                  <div className="h-full rounded-full bg-teal" style={{ width: `${c.progress.pct}%` }} />
                </div>
                <div className="mt-1 text-[11px] text-faint">
                  {c.progress.completed}/{c.progress.total} lessons · {c.progress.pct}%
                </div>
              </Link>
            ))
          )}
        </div>
        <div className="mt-3 flex items-center gap-4 text-[11.5px] text-faint">
          <span>Overall progress: <span className="font-semibold text-text">{data.progress.overallPct}%</span></span>
          <span>Streak: <span className="font-semibold text-text">{data.progress.streak} day{data.progress.streak === 1 ? '' : 's'}</span></span>
        </div>
      </Card>

      <div>
        <h2 className="mb-2 text-sm font-bold text-text">Explore by topic</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {data.courses.map((c) => (
            <Link
              key={c.id}
              href={`/learning/${c.id}`}
              className={cn(
                'flex flex-col gap-2 rounded-card border border-border bg-card p-4 shadow-card',
                'transition-colors duration-micro hover:border-teal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              )}
            >
              <div className="flex items-start justify-between">
                <span className="text-teal">
                  <LearningIcon className="h-5 w-5" />
                </span>
                {c.locked ? (
                  <span className="flex items-center gap-1 rounded bg-amber/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber">
                    🔒 Premium
                  </span>
                ) : c.free ? (
                  <span className="rounded bg-teal-bg px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-teal">Free</span>
                ) : null}
              </div>
              <div className="text-sm font-semibold text-text">{c.name}</div>
              {c.progress.total > 0 && c.progress.completed > 0 && (
                <div className="h-1 w-full overflow-hidden rounded-full bg-border2">
                  <div className="h-full rounded-full bg-teal" style={{ width: `${c.progress.pct}%` }} />
                </div>
              )}
              <div className="mt-auto flex items-center justify-between">
                <span className="text-[11px] text-faint">{c.lessonCount} lessons</span>
                <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
                  {c.tier}
                </Badge>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, Badge, cn } from '@tradew/ui';
import { learningApi } from '@/lib/learning/api';
import type { CourseCard, CoursesResponse } from '@/lib/learning/types';

/**
 * A generated learning path. Reuses the courses response (already lock- and
 * progress-annotated) so one request drives the whole page. A locked course
 * shows the "Requires Sentinel Pro" upgrade card; an unlocked one lists its
 * generated lessons with per-lesson completion ticks.
 */
export function CoursePathClient({ courseId }: { courseId: string }) {
  const [data, setData] = useState<CoursesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    learningApi
      .courses()
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setError('Could not load this course.'));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <Shell><p className="text-[13px] text-muted">{error}</p></Shell>;
  if (!data) return <Shell><p className="text-[13px] text-muted">Loading…</p></Shell>;

  const course = data.courses.find((c) => c.id === courseId);
  if (!course) return <Shell><p className="text-[13px] text-muted">Course not found. <Link className="text-teal" href="/learning">Back to Learning</Link></p></Shell>;

  if (course.locked) return <LockedCourse course={course} />;

  async function onRefresh() {
    setRefreshing(true);
    try {
      await learningApi.refresh();
      const d = await learningApi.courses();
      setData(d);
    } catch {
      /* non-fatal */
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Shell>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Link href="/learning" className="text-[12px] text-teal hover:underline">← Learning</Link>
            <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">{course.tier}</Badge>
            {course.free && <span className="rounded bg-teal-bg px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-teal">Free</span>}
          </div>
          <h1 className="mt-1 text-lg font-bold text-text">{course.name}</h1>
          <p className="mt-0.5 max-w-2xl text-[12.5px] text-muted">{course.summary}</p>
        </div>
        {data.isAdmin && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="rounded-lg border border-amber/40 bg-amber/5 px-3 py-1.5 text-[11.5px] font-semibold text-amber transition-colors hover:bg-amber/10 disabled:opacity-60"
          >
            {refreshing ? 'Refreshing…' : 'Refresh Knowledge'}
          </button>
        )}
      </div>

      <div className="mb-4 flex items-center gap-4 text-[11.5px] text-faint">
        <span>{course.progress.completed}/{course.progress.total} lessons complete</span>
        <div className="h-1.5 w-40 overflow-hidden rounded-full bg-border2">
          <div className="h-full rounded-full bg-teal" style={{ width: `${course.progress.pct}%` }} />
        </div>
        <span className="font-semibold text-text">{course.progress.pct}%</span>
      </div>

      {course.lessons.length === 0 ? (
        <Card title="No lessons yet">
          <p className="text-[12.5px] text-muted">This course is generated from the knowledge base as concepts are added. Check back soon.</p>
        </Card>
      ) : (
        <ol className="space-y-2">
          {course.lessons.map((l) => (
            <li key={l.id}>
              <Link
                href={`/learning/${course.id}/${encodeURIComponent(l.conceptId)}`}
                className={cn(
                  'flex items-center gap-3 rounded-card border border-border bg-card p-3.5 shadow-card',
                  'transition-colors duration-micro hover:border-teal',
                )}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg font-mono text-[12px] font-semibold text-muted">
                  {l.order}
                </span>
                <span className="text-[13px] font-semibold text-text">{l.title}</span>
                <span className="ml-auto text-[11px] text-faint">Lesson →</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </Shell>
  );
}

function LockedCourse({ course }: { course: CourseCard }) {
  const unlocks = ['AI Teacher', 'Interactive Lessons', 'Quizzes', 'Flashcards', 'Strategy Library', 'Practical Exercises', 'Live Market Learning'];
  return (
    <Shell>
      <Link href="/learning" className="text-[12px] text-teal hover:underline">← Learning</Link>
      <div className="mx-auto mt-4 max-w-lg rounded-card border border-amber/40 bg-amber/5 p-6 text-center">
        <div className="mb-2 text-2xl">🔒</div>
        <h1 className="text-base font-bold text-text">Requires Sentinel Pro</h1>
        <p className="mt-1 text-[12.5px] text-muted">{course.name} is a premium course. Upgrade to unlock:</p>
        <ul className="mx-auto mt-3 grid max-w-xs grid-cols-1 gap-1.5 text-left text-[12.5px] text-text">
          {unlocks.map((u) => (
            <li key={u} className="flex items-center gap-2">
              <span className="text-teal">✓</span> {u}
            </li>
          ))}
        </ul>
        <Link
          href="/settings"
          className="mt-5 inline-block rounded-lg bg-teal px-5 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
        >
          Upgrade
        </Link>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-[1000px] space-y-2 p-4">{children}</div>;
}

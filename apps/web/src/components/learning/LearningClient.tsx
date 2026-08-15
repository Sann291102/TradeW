'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Card,
  Badge,
  EmptyState,
  Skeleton,
  buttonClasses,
  cn,
  staggerContainerSlow,
  cardEntrance,
  withReducedMotion,
} from '@tradew/ui';
import { SearchIcon, CheckIcon, TradeIcon } from '@/components/shell/icons';
import { useCourses } from '@/lib/query/useLearning';
import type { CourseCard } from '@/lib/learning-platform/types';
import { RadialProgress } from './RadialProgress';
import { StreakStrip } from './StreakStrip';
import { CourseCarousel } from './CourseCarousel';
import { CourseTile } from './CourseTile';
import { iconForCourse, FlameIcon, CalendarIcon, StrategyIcon } from './category-icons';

/**
 * Learning Hub landing — premium visual redesign (2026-08-05) of the layout
 * restored 2026-08-04 from archive/apps-web-learning-course-platform-superseded.
 * Presentation layer only: same `learningApi.courses()` call, same
 * `services/api` LearningController underneath, nothing in the backend
 * touched. The previous plain list/grid version is preserved at
 * archive/web-learning-homepage-pre-premium-redesign-2026-08-05.tsx.txt.
 *
 * Every widget below is wired to a real field on `CoursesResponse` EXCEPT
 * "Certificates Earned" and "Hours Learned" (no such fields exist anywhere in
 * the backend — `learning-progress.service.ts`'s `StoredProgress` has no
 * certificate/hours concept) and "Upcoming Live Sessions" (no live-session
 * entity exists in services/api or services/sentinel). Those render as
 * explicit "coming soon" states rather than invented numbers — see
 * knowledge/Patterns/2026-08-05 - Learning homepage premium redesign.
 */
export function LearningClient() {
  const [query, setQuery] = useState('');
  const reduce = useReducedMotion();
  const container = withReducedMotion(staggerContainerSlow, !!reduce);
  const item = withReducedMotion(cardEntrance, !!reduce);

  // Shares one cached `/learning/courses` request with the course path page.
  const coursesQuery = useCourses();
  const data = coursesQuery.data ?? null;
  const error =
    coursesQuery.isError && !coursesQuery.data
      ? 'Could not load courses. The learning service may be starting up.'
      : null;

  const derived = useMemo(() => {
    if (!data) return null;
    const courses = data.courses;
    const q = query.trim().toLowerCase();
    const filtered = q ? courses.filter((c) => `${c.name} ${c.summary}`.toLowerCase().includes(q)) : courses;

    const completed = courses.filter((c) => c.progress.total > 0 && c.progress.completed === c.progress.total);
    const inProgress = courses.filter((c) => c.progress.completed > 0 && c.progress.completed < c.progress.total);
    const notStarted = courses.filter((c) => c.progress.completed === 0);

    const continueLearning = data.progress.continueLearning;
    const continueCourse = courses.find((c) => c.id === continueLearning?.courseId) ?? inProgress[0] ?? null;
    // continueLearning.lessonId is services/api's real "last activity" anchor
    // (LearningProgressService.pickContinue) — the lesson the user most
    // recently completed or quizzed, NOT necessarily an incomplete one, so
    // it's surfaced as "Resume" rather than "Next". Only trust it when it
    // actually names a course we resolved above; the inProgress[0] fallback
    // has no such signal, so that case picks a real starting lesson (order 0)
    // and is labelled "Start with" instead — never implying resumed activity
    // that didn't happen.
    const resumeConceptId =
      continueLearning?.courseId === continueCourse?.id ? continueLearning?.lessonId.split('::').slice(1).join('::') : undefined;
    const resumeLesson = continueCourse
      ? continueCourse.lessons.find((l) => l.conceptId === resumeConceptId) ?? [...continueCourse.lessons].sort((a, b) => a.order - b.order)[0]
      : null;
    const resumeIsRealAnchor = !!resumeConceptId && continueCourse?.lessons.some((l) => l.conceptId === resumeConceptId);

    const featured = [...filtered].sort((a, b) => b.progress.pct - a.progress.pct).slice(0, 5);
    const filteredInProgress = filtered.filter((c) => c.progress.completed > 0 && c.progress.completed < c.progress.total);
    const filteredNotStarted = filtered.filter((c) => c.progress.completed === 0).slice(0, 8);

    return { courses, filtered, completed, inProgress, notStarted, continueCourse, resumeLesson, resumeIsRealAnchor, featured, filteredInProgress, filteredNotStarted };
  }, [data, query]);

  if (error) {
    return (
      <div className="mx-auto max-w-[1440px] p-4">
        <div className="rounded-card border border-border bg-card p-6 text-center text-[13px] text-muted">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void coursesQuery.refetch()}
            className={cn(buttonClasses({ variant: 'outline', size: 'sm' }), 'mt-3')}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!data || !derived) {
    return (
      <div className="mx-auto max-w-[1440px] space-y-4 p-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.4fr]">
          <Skeleton className="h-52" />
          <Skeleton className="h-52" />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      </div>
    );
  }

  const { courses, filtered, completed, inProgress, continueCourse, resumeLesson, resumeIsRealAnchor, featured, filteredInProgress, filteredNotStarted } = derived;

  return (
    <motion.div initial="hidden" animate="visible" variants={container} className="mx-auto max-w-[1440px] space-y-4 p-4">
      {data.isAdmin && (
        <motion.div variants={item} className="flex items-center gap-2 rounded-card border border-amber/40 bg-amber/5 px-4 py-2.5 text-[12.5px]">
          <span className="rounded bg-amber/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber">Admin</span>
          <span className="text-muted">Every course is unlocked and lesson tools are available inside each lesson.</span>
        </motion.div>
      )}

      {/* Header — title, live course search filter, real streak + completed badges.
          Global search/notifications/avatar already live in TopBar; this row is
          Learning-specific only, not a duplicate of the app chrome. */}
      <motion.div variants={item} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-text">Learning</h1>
          <p className="text-xs text-muted">Learn. Practice. Grow.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          <div className="relative w-full sm:w-64">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search courses, topics…"
              aria-label="Search courses and topics"
              className="w-full rounded-lg border border-border2 bg-bg py-2 pl-9 pr-3 text-sm text-text placeholder:text-faint transition-colors duration-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            />
          </div>
          <Badge tone="warning" className="gap-1.5 whitespace-nowrap px-3 py-1.5 text-[11px]">
            <FlameIcon width={14} height={14} />
            {data.progress.streak} Day{data.progress.streak === 1 ? '' : 's'} Streak
          </Badge>
          <Badge tone="brand" className="gap-1.5 whitespace-nowrap px-3 py-1.5 text-[11px]">
            <CheckIcon className="h-3.5 w-3.5" />
            {completed.length} Completed
          </Badge>
        </div>
      </motion.div>

      {/* Progress donut + Continue Learning */}
      <motion.div variants={item} className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.4fr]">
        <Card title="Your Learning Progress">
          <div className="flex items-center gap-5">
            <RadialProgress value={data.progress.overallPct} size={124} strokeWidth={11} className="shrink-0">
              <div className="text-center">
                <div className="text-2xl font-bold text-text">{data.progress.overallPct}%</div>
                <div className="text-[9.5px] font-semibold uppercase tracking-wide text-faint">Completed</div>
              </div>
            </RadialProgress>
            <div className="flex-1 space-y-2.5">
              <StatRow icon={<CheckIcon className="h-4 w-4" />} label="Completed Courses" value={completed.length} />
              <StatRow icon={<StrategyIcon width={16} height={16} />} label="In Progress" value={inProgress.length} />
              <StatRow label="Certificates Earned" comingSoon />
              <StatRow label="Hours Learned" comingSoon />
            </div>
          </div>
        </Card>

        <Card title="Continue Learning" subtitle={continueCourse ? '· pick up where you left off' : undefined}>
          {continueCourse ? (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <ContinueThumb course={continueCourse} />
              <div className="min-w-0 flex-1 space-y-2">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">
                    {continueCourse.progress.completed}/{continueCourse.progress.total} lessons
                  </div>
                  <div className="truncate text-base font-bold text-text">{continueCourse.name}</div>
                  {resumeLesson && (
                    <div className="truncate text-xs text-muted">
                      {resumeIsRealAnchor ? 'Resume: ' : 'Start with: '}
                      {resumeLesson.title}
                    </div>
                  )}
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-border2">
                  <div className="h-full rounded-full bg-teal transition-[width] duration-panel" style={{ width: `${continueCourse.progress.pct}%` }} />
                </div>
                <div className="flex items-center justify-between text-[11px] text-faint">
                  <span>{continueCourse.progress.pct}% complete</span>
                  <span>{data.progress.streak > 0 ? `${data.progress.streak}-day streak` : 'Start your streak today'}</span>
                </div>
                <Link
                  href={resumeLesson ? `/learning/${continueCourse.id}/${resumeLesson.conceptId}` : `/learning/${continueCourse.id}`}
                  className={buttonClasses({ size: 'md', className: 'mt-1 w-full sm:w-auto' })}
                >
                  Continue Lesson
                </Link>
              </div>
            </div>
          ) : (
            <EmptyState
              title="You haven't started a course yet"
              description="Pick one from Explore by Category below to begin your streak."
            />
          )}
        </Card>
      </motion.div>

      {/* Explore by Category */}
      <motion.div variants={item}>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-bold text-text">Explore by Category</h2>
          {query.trim() && (
            <span className="text-[11px] text-faint">
              {filtered.length} of {courses.length}
            </span>
          )}
        </div>
        {filtered.length === 0 ? (
          <EmptyState title="No courses match your search" description={`Nothing found for "${query}".`} />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {filtered.map((c) => (
              <CourseTile key={c.id} course={c} />
            ))}
          </div>
        )}
      </motion.div>

      {/* Featured Courses + right rail */}
      <motion.div variants={item} className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Featured Courses" subtitle="· by progress" className="lg:col-span-2">
          {featured.length === 0 ? (
            <EmptyState title="No courses to show" />
          ) : (
            <div className="divide-y divide-border">
              {featured.map((c) => (
                <FeaturedRow key={c.id} course={c} />
              ))}
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card title="Learning Streak">
            <StreakStrip streak={data.progress.streak} lastActivityAt={data.progress.lastActivityAt} />
            <p className="mt-3 text-[11.5px] text-muted">
              {data.progress.streak > 0
                ? `You're on a ${data.progress.streak}-day streak. Complete a lesson today to keep it alive.`
                : 'Complete a lesson today to start your streak.'}
            </p>
          </Card>

          <Card title="Upcoming Live Sessions">
            {/* Integration point: no live-session entity/endpoint exists yet in
                services/api or services/sentinel (see docs/product-architecture/
                LEARNING-HUB.md). Honest "coming soon" state — no fabricated
                schedule — until that backend surface exists. */}
            <EmptyState
              icon={<CalendarIcon width={22} height={22} />}
              title="No sessions scheduled yet"
              description="Live trading sessions will appear here once they're added."
            />
          </Card>

          <Card title="Quick Practice">
            <div className="-mx-1">
              {resumeLesson && continueCourse && (
                <QuickPracticeRow
                  icon={<CheckIcon className="h-4 w-4" />}
                  title="Quiz & Flashcards"
                  subtitle="Test what you've learned"
                  href={`/learning/${continueCourse.id}/${resumeLesson.conceptId}`}
                  cta="Start"
                />
              )}
              <QuickPracticeRow icon={<TradeIcon className="h-4 w-4" />} title="Paper Trading" subtitle="Practice with virtual money" href="/trade" cta="Launch" />
              <QuickPracticeRow icon={<StrategyIcon width={16} height={16} />} title="Strategy Catalog" subtitle="14 strategies, explained" href="/learning/strategies" cta="Browse" />
            </div>
          </Card>
        </div>
      </motion.div>

      {/* Continue Where You Left Off */}
      {filteredInProgress.length > 0 && (
        <motion.div variants={item}>
          <h2 className="mb-2 text-sm font-bold text-text">Continue Where You Left Off</h2>
          <CourseCarousel aria-label="Courses in progress">
            {filteredInProgress.map((c) => (
              <div key={c.id} className="w-[240px] shrink-0 snap-start">
                <CourseTile course={c} />
              </div>
            ))}
          </CourseCarousel>
        </motion.div>
      )}

      {/* Recommended For You */}
      {filteredNotStarted.length > 0 && (
        <motion.div variants={item}>
          <h2 className="mb-2 text-sm font-bold text-text">Recommended For You</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {filteredNotStarted.map((c) => (
              <CourseTile key={c.id} course={c} />
            ))}
          </div>
        </motion.div>
      )}

      {/* Strategies catalog — preserved existing feature, unchanged route/copy */}
      <motion.div variants={item}>
        <Link href="/learning/strategies" className="block rounded-card border border-border bg-card p-4 shadow-card transition-colors duration-micro hover:border-teal">
          <div className="text-sm font-semibold text-text">Browse strategies →</div>
          <p className="mt-1 text-[11.5px] text-muted">14 single/multi-leg strategies explained, each drawable against live prices.</p>
        </Link>
      </motion.div>
    </motion.div>
  );
}

function StatRow({ icon, label, value, comingSoon }: { icon?: React.ReactNode; label: string; value?: number; comingSoon?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-[12.5px] text-muted">
        {icon && <span className="text-teal">{icon}</span>}
        {label}
      </span>
      {comingSoon ? (
        <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
          Coming soon
        </Badge>
      ) : (
        <span className="font-mono text-sm font-bold tabular-nums text-text">{value}</span>
      )}
    </div>
  );
}

function ContinueThumb({ course }: { course: CourseCard }) {
  const Icon = iconForCourse(`${course.name} ${course.summary}`);
  return (
    <div className="relative flex h-28 w-full shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-bg sm:w-36">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,var(--teal-bg),transparent_70%)]" />
      <span className="relative text-teal">
        <Icon width={34} height={34} />
      </span>
    </div>
  );
}

function FeaturedRow({ course }: { course: CourseCard }) {
  const Icon = iconForCourse(`${course.name} ${course.summary}`);
  const started = course.progress.total > 0 && course.progress.completed > 0;
  return (
    <Link
      href={`/learning/${course.id}`}
      className="flex items-center gap-3 py-3 first:pt-0 last:pb-0 transition-colors duration-micro hover:bg-hover -mx-1 px-1 rounded-lg"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-bg text-teal">
        <Icon />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-text">{course.name}</span>
          <Badge tone="neutral" className="shrink-0 px-1.5 py-0 text-[9px] uppercase">
            {course.tier}
          </Badge>
        </div>
        <p className="truncate text-[11px] text-muted">{course.summary}</p>
        {started && (
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-border2">
            <div className="h-full rounded-full bg-teal" style={{ width: `${course.progress.pct}%` }} />
          </div>
        )}
      </div>
      <div className="shrink-0 text-right">
        <div className="font-mono text-sm font-bold tabular-nums text-text">{started ? `${course.progress.pct}%` : `${course.lessonCount}`}</div>
        <div className="text-[10px] text-faint">{started ? 'complete' : 'lessons'}</div>
      </div>
    </Link>
  );
}

function QuickPracticeRow({ icon, title, subtitle, href, cta }: { icon: React.ReactNode; title: string; subtitle: string; href: string; cta: string }) {
  return (
    <Link href={href} className={cn('flex items-center gap-3 rounded-lg px-1 py-2.5 transition-colors duration-micro hover:bg-hover')}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-bg text-teal">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-semibold text-text">{title}</div>
        <div className="truncate text-[11px] text-faint">{subtitle}</div>
      </div>
      <span className={buttonClasses({ variant: 'outline', size: 'sm', className: 'shrink-0' })}>{cta}</span>
    </Link>
  );
}

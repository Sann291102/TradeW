'use client';

import Link from 'next/link';
import { Badge, cn } from '@tradew/ui';
import { iconForCourse } from './category-icons';
import type { CourseCard } from '@/lib/learning-platform/types';

export interface CourseTileProps {
  course: CourseCard;
  className?: string;
}

/**
 * CourseTile — a single course as an "Explore by Category" / "Recommended
 * For You" tile. Every field shown (name, lesson count, tier, free/locked
 * flag, progress) comes straight off the live `CourseCard` — no fabricated
 * ratings or ETAs the reference screenshot shows but the backend doesn't have.
 */
export function CourseTile({ course, className }: CourseTileProps) {
  const Icon = iconForCourse(`${course.name} ${course.summary}`);
  const started = course.progress.total > 0 && course.progress.completed > 0;

  return (
    <Link
      href={`/learning/${course.id}`}
      className={cn(
        'group flex flex-col gap-2.5 rounded-card border border-border bg-card p-4 shadow-card',
        'transition-all duration-micro ease-standard hover:-translate-y-0.5 hover:border-teal hover:shadow-elev3',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-bg text-teal">
          <Icon />
        </span>
        {course.locked ? (
          <Badge tone="warning" className="px-1.5 py-0 text-[9px]">
            Premium
          </Badge>
        ) : course.free ? (
          <Badge tone="brand" className="px-1.5 py-0 text-[9px]">
            Free
          </Badge>
        ) : null}
      </div>

      <div>
        <div className="text-sm font-semibold leading-tight text-text group-hover:text-teal">{course.name}</div>
        <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-muted">{course.summary}</p>
      </div>

      {started && (
        <div className="mt-auto space-y-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-border2">
            <div className="h-full rounded-full bg-teal transition-[width] duration-panel" style={{ width: `${course.progress.pct}%` }} />
          </div>
          <div className="text-[10.5px] text-faint">{course.progress.pct}% complete</div>
        </div>
      )}

      <div className={cn('flex items-center justify-between text-[11px] text-faint', !started && 'mt-auto')}>
        <span>{course.lessonCount} lessons</span>
        <Badge tone="neutral" className="px-1.5 py-0 text-[9px] uppercase">
          {course.tier}
        </Badge>
      </div>
    </Link>
  );
}

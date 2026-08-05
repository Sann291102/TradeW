'use client';

import { cn } from '@tradew/ui';

export interface StreakStripProps {
  /** Consecutive-day count from CoursesResponse['progress']['streak']. */
  streak: number;
  /** ISO date/datetime string from CoursesResponse['progress']['lastActivityAt']. */
  lastActivityAt: string | null;
  className?: string;
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const IST_TZ = 'Asia/Kolkata';

/** YYYY-MM-DD in IST, matching the timezone convention used elsewhere in the
 *  app (DashboardHero's greeting, news timestamps). */
function istDateKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IST_TZ }).format(d);
}

/** IST weekday index, Monday=0..Sunday=6 (Intl's 'short' weekday + a lookup,
 *  since JS Date's getDay() reads the *local* machine timezone, not IST). */
function istWeekdayIndex(d: Date): number {
  const short = new Intl.DateTimeFormat('en-US', { timeZone: IST_TZ, weekday: 'short' }).format(d);
  const order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const map: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return map[order.find((o) => short.startsWith(o)) ?? 'Mon'] ?? map[short] ?? 0;
}

/**
 * StreakStrip — a Mon–Sun week view derived ENTIRELY from two real backend
 * fields (`streak` day-count + `lastActivityAt`), no fabricated history. A
 * "streak of N ending on lastActivityAt" mathematically fixes which of the
 * last N calendar days were active — this renders whichever of those days
 * fall inside the current displayed week. See
 * knowledge/Patterns/2026-08-05 - Learning homepage premium redesign.
 */
export function StreakStrip({ streak, lastActivityAt, className }: StreakStripProps) {
  const now = new Date();
  const todayKey = istDateKey(now);
  const todayIdx = istWeekdayIndex(now);

  // Active calendar-day keys: the `streak` consecutive days ending at lastActivityAt.
  const activeKeys = new Set<string>();
  if (lastActivityAt && streak > 0) {
    const last = new Date(lastActivityAt);
    for (let i = 0; i < streak; i++) {
      const d = new Date(last);
      d.setDate(d.getDate() - i);
      activeKeys.add(istDateKey(d));
    }
  }

  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - todayIdx);

  const days = DAY_LABELS.map((label, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    const key = istDateKey(d);
    return { label, key, active: activeKeys.has(key), isToday: key === todayKey };
  });

  return (
    <div className={cn('grid grid-cols-7 gap-2', className)}>
      {days.map((d) => (
        <div key={d.key} className="flex flex-col items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-faint">{d.label}</span>
          <div
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-full border text-xs font-bold',
              d.active
                ? 'border-teal bg-teal-bg text-teal'
                : 'border-border2 bg-bg text-faint',
              d.isToday && (d.active ? 'ring-2 ring-amber ring-offset-2 ring-offset-card' : 'border-amber text-amber'),
            )}
            aria-label={`${d.label}${d.active ? ' — active' : ''}${d.isToday ? ' (today)' : ''}`}
          >
            {d.active ? (
              <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12.5 10 17 19 7" />
              </svg>
            ) : (
              d.isToday && <span className="h-1.5 w-1.5 rounded-full bg-amber" aria-hidden="true" />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

'use client';

import { cn } from '@tradew/ui';
import type { TimelineDot } from '@/lib/sentinel/dashboardModel';
import { toneBar, toneText } from './tone';

/**
 * Session Timeline — a horizontal track of the session's real observation /
 * setup / guidance / state-change events (`timeline[]` from /observe), most
 * recent last. Scrolls horizontally on narrow viewports rather than wrapping,
 * matching the reference's single-line timeline.
 */
export function SessionTimeline({ dots }: { dots: TimelineDot[] }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-elev2">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[13px] font-bold text-text">Session Timeline</h2>
        <span className="text-[10.5px] text-faint">{dots.length} events</span>
      </div>

      {dots.length === 0 ? (
        <p className="py-6 text-center text-[12px] text-faint">
          No session events yet. The timeline fills as Sentinel observes the live session.
        </p>
      ) : (
        <div className="overflow-x-auto pb-2">
          <div className="relative flex min-w-max items-start gap-0">
            {/* connecting rail */}
            <div className="absolute left-0 right-0 top-[7px] h-px bg-border" aria-hidden />
            {dots.map((d, i) => (
              <div key={i} className="relative flex w-[120px] flex-col items-center px-1 text-center">
                <span className={cn('z-10 mb-2 h-3.5 w-3.5 rounded-full ring-4 ring-card', toneBar[d.tone])} />
                <span className="text-[11px] font-bold text-text">{d.time}</span>
                <span className={cn('mt-0.5 text-[10.5px] font-semibold', toneText[d.tone])}>{d.title}</span>
                {d.detail && <span className="mt-0.5 line-clamp-2 text-[10px] leading-tight text-faint">{d.detail}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

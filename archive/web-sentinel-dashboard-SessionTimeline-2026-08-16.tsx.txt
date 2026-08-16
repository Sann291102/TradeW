'use client';

import { cn } from '@tradew/ui';
import type { TimelineDot } from '@/lib/sentinel/sessionTimeline';
import { toneBar, toneText } from './tone';

/**
 * Session Timeline — the session's real observation / setup / guidance /
 * state-change events as a horizontal track, oldest left, newest right.
 *
 * The times are market times, not refresh times: a strategy detection is
 * stamped with the bar its rules matched on and the ordering is done on that
 * instant (`sessionTimeline.ts`). That module is also where the ordering fix
 * lives — the engine returns entries in append order, which is not the same
 * thing as time order once bar-timed and poll-timed entries are mixed.
 *
 * Scrolls horizontally rather than wrapping, and auto-scrolls to the newest
 * entry: a track that silently keeps its oldest events in view while the
 * session moves on is a stale panel that looks live.
 */
export function SessionTimeline({ dots }: { dots: TimelineDot[] }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-elev2">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[13px] font-bold text-text">Session Timeline</h2>
        <span className="text-[10.5px] text-faint">
          {dots.length} {dots.length === 1 ? 'event' : 'events'} · IST
        </span>
      </div>

      {dots.length === 0 ? (
        <p className="py-6 text-center text-[12px] text-faint">
          No session events yet. The timeline fills as Sentinel observes the live session.
        </p>
      ) : (
        <div className="overflow-x-auto pb-2">
          {/* `flex-row-reverse` + `justify-end` keeps the NEWEST entry in view
              when the track overflows, without a scroll effect that would
              fight a user who has scrolled back deliberately. The DOM order is
              reversed to achieve it, so the visual order stays oldest-left. */}
          <div className="relative flex min-w-max flex-row-reverse justify-end items-start">
            <div className="absolute left-0 right-0 top-[7px] h-px bg-border" aria-hidden />
            {[...dots].reverse().map((d) => (
              <div key={`${d.at}-${d.title}`} className="relative flex w-[132px] flex-col items-center px-1.5 text-center">
                <span
                  className={cn(
                    'z-10 mb-2 h-3.5 w-3.5 rounded-full ring-4 ring-card',
                    toneBar[d.tone],
                    d.latest && 'animate-pulse',
                  )}
                />
                <span className="text-[11.5px] font-bold text-text">{d.time}</span>
                <span className={cn('mt-0.5 text-[10.5px] font-semibold leading-tight', toneText[d.tone])}>
                  {d.title}
                </span>
                {d.meta && <span className="mt-0.5 text-[10px] leading-tight text-muted">{d.meta}</span>}
                {d.detail && (
                  <span className="mt-0.5 line-clamp-3 text-[10px] leading-tight text-faint" title={d.detail}>
                    {d.detail}
                  </span>
                )}
                {d.latest && (
                  <span className="mt-1 rounded bg-teal-bg px-1.5 py-px text-[9px] font-bold uppercase tracking-wideTrack text-teal">
                    Current
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

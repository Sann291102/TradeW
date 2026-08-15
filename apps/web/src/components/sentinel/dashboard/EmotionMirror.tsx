'use client';

import { cn } from '@tradew/ui';
import type { EmotionCard } from '@/lib/sentinel/dashboardModel';
import { toneText } from './tone';

/**
 * Emotion Mirror — reflects the trader's behavioral state for the session,
 * derived from the real emotion-intelligence signals (emotional_risk factor +
 * emotion-agent observations). Reflective, never prescriptive.
 */
export function EmotionMirror({ emotion }: { emotion: EmotionCard }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-elev2">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[13px] font-bold text-text">Emotion Mirror</h2>
        <span className={cn('text-[13px] font-extrabold', toneText[emotion.tone])}>{emotion.state}</span>
      </div>
      <p className="text-[12px] leading-relaxed text-muted">{emotion.message}</p>
      {/* Calm baseline sparkline — a purely decorative EKG-style trace tinted by
          tone; it encodes no data and is marked aria-hidden so it never reads as
          a real metric. */}
      <svg viewBox="0 0 300 48" className="mt-3 h-12 w-full" aria-hidden preserveAspectRatio="none">
        <path
          d="M0 32 Q20 30 40 28 T80 30 Q100 20 120 26 T160 24 Q185 34 210 22 T260 26 Q280 18 300 22"
          fill="none"
          stroke="var(--teal)"
          strokeWidth="1.6"
          opacity="0.7"
        />
      </svg>
    </section>
  );
}

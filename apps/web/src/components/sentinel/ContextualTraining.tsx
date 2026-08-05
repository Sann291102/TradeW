import Link from 'next/link';
import { buttonClasses } from '@tradew/ui';
import { TrainingRadarArt } from './SentinelArt';

/**
 * "Training" — surfaces the lesson that matches today's dominant safety
 * observation (redesign point 8: training reinforces what Sentinel just
 * observed, it isn't a separate, unrelated catalog browse). Learning Hub
 * content itself is still mock-data-backed today (no Prisma models yet per
 * the platform audit), so this links to the existing /learning route rather
 * than a specific lesson id — a real deep link is follow-up work once
 * Learning Hub has real content to link into.
 */
export function ContextualTraining({ title, blurb }: { title: string; blurb: string }) {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-elev2 sm:p-6">
      <div className="grid grid-cols-1 items-center gap-4 sm:grid-cols-[minmax(0,1fr)_150px]">
        <div className="min-w-0">
          <h2 className="text-[11px] font-bold uppercase tracking-wideTrack text-faint">Training</h2>
          <p className="mt-2 text-[14px] font-bold leading-snug text-text">{title}</p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{blurb}</p>
          <Link href="/learning" className={buttonClasses({ variant: 'outline', size: 'sm', className: 'mt-4' })}>
            Unlocked for today&rsquo;s market →
          </Link>
        </div>

        <TrainingRadarArt className="hidden h-[110px] w-full justify-self-end sm:block" />
      </div>
    </section>
  );
}

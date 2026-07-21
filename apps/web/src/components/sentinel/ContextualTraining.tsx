import Link from 'next/link';
import { buttonClasses } from '@tradew/ui';

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
    <section className="rounded-2xl border border-border bg-card p-5 sm:p-6">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">Training</h2>
      <p className="mb-1 text-sm font-bold text-text">{title}</p>
      <p className="mb-4 text-[12.5px] text-muted">{blurb}</p>
      <Link href="/learning" className={buttonClasses({ variant: 'outline', size: 'sm' })}>
        Unlocked for today&rsquo;s market →
      </Link>
    </section>
  );
}

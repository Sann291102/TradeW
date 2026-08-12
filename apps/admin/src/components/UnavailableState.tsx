import type { ReactNode } from 'react';

/**
 * The honest state for a module whose UI architecture exists but whose backend
 * capability does not yet. It is the successor to the bare `ModulePlaceholder`:
 * it lays out the module's INTENDED structure — the panels an operator will
 * eventually use — so the final layout is established and future backend work
 * plugs into a real shell, WITHOUT ever showing a fabricated metric.
 *
 * The distinction the design brief insists on is encoded here:
 *   · interaction/layout design  → the header, the section skeletons, the shell
 *   · live backend capability     → explicitly "not connected", never faked
 *
 * A skeleton panel shows a title and a "capability not yet available" line, and
 * dashed placeholder bars that are visibly inert (no numbers, no units, no
 * plausible values). Nothing here can be mistaken for a live read.
 */
export function UnavailableState({
  title,
  description,
  reason = 'This module is scaffolded (routing, auth, navigation) but its backend capability is not yet available.',
  sections,
  actions,
}: {
  title: string;
  description: string;
  /** The panels this module will have once its backend exists. Rendered as
   *  labelled, empty skeletons so the layout is real but the data is honestly
   *  absent. */
  sections: Array<{ label: string; hint?: string; span?: 1 | 2 | 3 }>;
  reason?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[1500px] space-y-4 p-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight">{title}</h1>
          <p className="text-[12px] text-muted">{description}</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-amber/30 bg-amber-bg/40 px-2.5 py-1 text-[11px] font-medium text-amber">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber" aria-hidden />
          Backend not connected
        </span>
      </header>

      <div className="rounded-xl border border-dashed border-white/[0.12] bg-white/[0.015] px-4 py-3">
        <p className="text-[12px] text-muted">
          <span className="font-semibold text-text">Coming online. </span>
          {reason} No sample data is shown in the meantime — the panels below are the intended layout, waiting on a live
          source.
        </p>
        {actions && <div className="mt-2.5 flex flex-wrap gap-2">{actions}</div>}
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {sections.map((s) => (
          <SkeletonPanel key={s.label} label={s.label} hint={s.hint} span={s.span} />
        ))}
      </div>
    </div>
  );
}

function SkeletonPanel({ label, hint, span = 1 }: { label: string; hint?: string; span?: 1 | 2 | 3 }) {
  const colSpan = span === 3 ? 'lg:col-span-3' : span === 2 ? 'lg:col-span-2' : '';
  return (
    <section className={`rounded-xl border border-white/[0.07] bg-white/[0.02] ${colSpan}`}>
      <header className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-2.5">
        <div className="min-w-0">
          <h3 className="truncate text-[12.5px] font-semibold">{label}</h3>
          {hint && <p className="truncate text-[10.5px] text-faint">{hint}</p>}
        </div>
        <span className="rounded border border-white/10 px-1.5 py-px text-[9.5px] uppercase tracking-wide text-faint">Awaiting data</span>
      </header>
      <div className="space-y-2.5 p-4" aria-hidden>
        {[78, 54, 66, 40].map((w, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="h-1.5 rounded-full bg-white/[0.05]" style={{ width: `${w}%` }} />
            <div className="h-1.5 w-8 rounded-full bg-white/[0.03]" />
          </div>
        ))}
      </div>
    </section>
  );
}

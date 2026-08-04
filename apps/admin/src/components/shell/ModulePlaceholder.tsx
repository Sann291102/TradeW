/**
 * Honest "not built yet" state for a module page, matching this codebase's
 * standing rule against inventing data in place of a real connection: a
 * placeholder says so plainly rather than rendering sample numbers that could
 * be mistaken for a real read.
 */
export function ModulePlaceholder({ title, description }: { title: string; description: string }) {
  return (
    <div className="max-w-2xl space-y-3">
      <div>
        <h1 className="text-lg font-bold text-text">{title}</h1>
        <p className="text-[12.5px] text-muted">{description}</p>
      </div>
      <div className="rounded-lg border border-dashed border-border bg-surface p-6 text-center">
        <p className="text-[12.5px] font-semibold text-text">Not built yet</p>
        <p className="mx-auto mt-1.5 max-w-md text-[11.5px] leading-relaxed text-muted">
          This module is scaffolded (routing, auth, nav) but not wired to live data. No sample data is shown in the
          meantime.
        </p>
      </div>
    </div>
  );
}

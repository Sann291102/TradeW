import { cn } from '@tradew/ui';

/**
 * The honest-absence primitives.
 *
 * These exist so that "we do not have this" has a FIRST-CLASS rendering, as
 * visually deliberate as a number is. The failure mode being designed against is
 * not ugliness — it is a designer or an engineer reaching for `—` or `0.00`
 * because the empty state looked unfinished. If absence looks intentional, the
 * temptation goes away.
 *
 * Every one of them requires a REASON. There is no default text and no
 * `reason?: string`, so a caller cannot render "unavailable" without saying why.
 */

/** A whole section that could not be retrieved. */
export function DataUnavailable({
  title,
  reason,
  className,
  action,
}: {
  title: string;
  reason: string;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        'rounded-lg border border-dashed border-border2 bg-bg/40 px-4 py-6 text-center',
        className,
      )}
    >
      <p className="text-sm font-semibold text-muted">{title}</p>
      {/* The server's own sentence, verbatim. Rewriting it here would put a
          second, less accurate explanation in front of the user. */}
      <p className="mx-auto mt-1.5 max-w-lg text-xs leading-relaxed text-faint">{reason}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/**
 * One cell or field with no reported value.
 *
 * Deliberately the words "not reported" rather than a dash: a dash is
 * ambiguous between "zero", "not applicable" and "we don't know", and only the
 * last one is true here.
 */
export function NotReported({ className, title }: { className?: string; title?: string }) {
  return (
    <span
      className={cn('text-[11px] italic text-faint', className)}
      title={title ?? 'The data provider did not publish this figure for this period.'}
    >
      not reported
    </span>
  );
}

/** Inline provenance line — source, vendor stamp, retrieval time. */
export function SourceLine({
  source,
  sourceTimestamp,
  fetchedAt,
  className,
}: {
  source: string;
  sourceTimestamp: string;
  fetchedAt: string;
  className?: string;
}) {
  return (
    <p className={cn('text-[10.5px] leading-relaxed text-faint', className)}>
      Source: <span className="font-semibold">{source}</span> · reported as of {sourceTimestamp} · retrieved{' '}
      {fetchedAt}
    </p>
  );
}

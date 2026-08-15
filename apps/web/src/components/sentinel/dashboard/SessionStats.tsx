'use client';

import { cn } from '@tradew/ui';

/**
 * Session Stats — the reference's bottom-row metric tiles, built only from
 * metrics Sentinel actually has this session: observations recorded, signals
 * that triggered, the trader's trades today and how many were flagged. The
 * reference mock also shows an "accuracy %" and "learning patterns" count;
 * those have no honest data source yet, so they are deliberately omitted
 * rather than shown as invented numbers.
 */
export function SessionStats({
  observations,
  signalsTriggered,
  tradesToday,
  flaggedEvents,
}: {
  observations: number;
  signalsTriggered: number;
  tradesToday: number | null;
  flaggedEvents: number | null;
}) {
  const tiles: { label: string; value: string; tone: string }[] = [
    { label: 'Observations', value: String(observations), tone: 'text-teal' },
    { label: 'Signals Triggered', value: String(signalsTriggered), tone: 'text-text' },
    { label: 'Trades Today', value: tradesToday == null ? '—' : String(tradesToday), tone: 'text-text' },
    { label: 'Flagged Events', value: flaggedEvents == null ? '—' : String(flaggedEvents), tone: flaggedEvents ? 'text-amber' : 'text-up' },
  ];
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-elev2">
      <h2 className="mb-3 text-[13px] font-bold text-text">Session Stats</h2>
      <div className="grid grid-cols-2 gap-2.5">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border border-border bg-bg p-3">
            <p className={cn('font-mono text-[20px] font-extrabold leading-none', t.tone)}>{t.value}</p>
            <p className="mt-1.5 text-[10.5px] font-semibold text-faint">{t.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

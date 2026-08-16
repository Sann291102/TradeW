'use client';

import { cn } from '@tradew/ui';
import type { SessionStatsModel } from '@/lib/sentinel/sessionStats';

/**
 * Session Stats — the reference's eight-tile metric grid.
 *
 * The first two tiles describe what Sentinel did this session (from
 * `/observe`); the other six describe what the user's own strategies did (from
 * `services/sentinel-py`'s watch history). Both halves are real recorded
 * events — a watch that reached a state, an outcome that completed.
 *
 * ── DIFFERENCES FROM THE MOCK, AND WHY ─────────────────────────────────────
 *  · "High Probability" → **Confirmed** — a count of watches whose mandatory
 *    conditions are all met right now. There is no probability model behind
 *    any of this and naming one would invent a claim (this service has no
 *    confidence score at all, by design — see `sentinelPy.ts`).
 *  · "Closed Win" → **Reached Projected** — reaching the level the user
 *    declared is what was recorded; "win" would be a P&L claim, and no order
 *    ever passed through TradeW.
 *  · "(Simulated)" is dropped from both rate tiles. These are the user's real
 *    recorded outcomes, not a simulation, and mislabelling them understates
 *    them as badly as the reverse would overstate them.
 *  · The win rate never appears without the outcome count it was computed
 *    from — 1/1 and 34/50 are not the same claim.
 */
export function SessionStats({
  observations,
  signalsTriggered,
  tradesToday,
  flaggedEvents,
  stats,
  stale,
}: {
  observations: number;
  signalsTriggered: number;
  /**
   * The trader's own activity for the session, from `/sentinel/session-summary`
   * — a different subject from the eight tiles (which are about strategies),
   * and on the slower observation cadence, so it gets its own line rather than
   * a tile in the grid.
   */
  tradesToday: number | null;
  flaggedEvents: number | null;
  stats: SessionStatsModel;
  /** The strategy figures could not be refreshed; they are the last good read. */
  stale?: boolean;
}) {
  const tiles: { label: string; value: string; sub?: string; tone: string }[] = [
    { label: 'Observations', value: String(observations), tone: 'text-teal' },
    { label: 'Signals Triggered', value: String(signalsTriggered), tone: 'text-text' },
    { label: 'Confirmed', value: String(stats.confirmed), tone: stats.confirmed > 0 ? 'text-up' : 'text-text' },
    {
      label: 'Stepped Back',
      value: String(stats.steppedBack),
      tone: stats.steppedBack > 0 ? 'text-amber' : 'text-text',
    },
    { label: 'Open Positions', value: String(stats.openPositions), tone: 'text-text' },
    {
      label: 'Reached Projected',
      value: String(stats.reachedProjected),
      tone: stats.reachedProjected > 0 ? 'text-up' : 'text-text',
    },
    {
      label: 'Reached Invalidation',
      value: String(stats.reachedInvalidation),
      tone: stats.reachedInvalidation > 0 ? 'text-down' : 'text-text',
    },
    {
      label: 'Expectancy',
      value: stats.expectancy == null ? '—' : `${stats.expectancy >= 0 ? '+' : ''}${stats.expectancy.toFixed(2)}R`,
      sub: stats.completed > 0 ? `over ${stats.completed} completed` : 'no completed outcomes yet',
      tone: stats.expectancy == null ? 'text-faint' : stats.expectancy >= 0 ? 'text-up' : 'text-down',
    },
  ];

  return (
    <section className="flex h-full flex-col rounded-2xl border border-border bg-card p-5 shadow-elev2">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-bold text-text">Session Stats</h2>
        {stats.winRate != null && (
          <span className="text-[10.5px] text-faint">
            <span className="font-bold text-text">{Math.round(stats.winRate * 100)}%</span> reached projected
            <span className="ml-1">of {stats.decided} decided</span>
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border border-border bg-bg p-3">
            <p className={cn('font-mono text-[19px] font-extrabold leading-none', t.tone)}>{t.value}</p>
            <p className="mt-1.5 text-[10.5px] font-semibold leading-tight text-faint">{t.label}</p>
            {t.sub && <p className="mt-0.5 text-[9.5px] leading-tight text-faint">{t.sub}</p>}
          </div>
        ))}
      </div>

      <p className="mt-2.5 flex flex-wrap gap-x-4 text-[10.5px] text-faint">
        <span>
          Your trades today <span className="font-bold text-text">{tradesToday == null ? '—' : tradesToday}</span>
        </span>
        <span>
          Flagged events{' '}
          <span className={cn('font-bold', flaggedEvents ? 'text-amber' : 'text-text')}>
            {flaggedEvents == null ? '—' : flaggedEvents}
          </span>
        </span>
      </p>

      {/* Sample size is never hidden behind a rate — the same rule the
          performance engine states in its own `note`. */}
      {stats.thinSample && stats.completed > 0 && (
        <p className="mt-2.5 text-[10.5px] leading-relaxed text-amber">
          Too few completed outcomes for these figures to describe how your strategies behave — they are a record of
          what happened, not yet a measurement.
        </p>
      )}
      {stale && (
        <p className="mt-2.5 text-[10.5px] leading-relaxed text-amber">
          Your strategy figures could not be refreshed just now — the counts above are the last ones that loaded.
        </p>
      )}
    </section>
  );
}

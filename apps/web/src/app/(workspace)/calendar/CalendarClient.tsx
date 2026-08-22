'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Badge, Card, CandleLoader, EmptyState } from '@tradew/ui';
import { api } from '@/lib/api';

/**
 * Calendar — upcoming corporate events, from the exchange.
 *
 * The data is real: `GET /nse/events` proxies NSE's event calendar (board
 * meetings and their stated purpose) through the API's cached connector. Note
 * what that connector deliberately drops — the company-authored description
 * field — so nothing here is free text written by a third party.
 *
 * ── WHY THERE IS NO "ADD EVENT" BUTTON ─────────────────────────────────────
 *
 * A trading calendar would also hold economic releases, expiries and the
 * user's own reminders. TradeW has no table for user reminders and no
 * economic-events feed: the `EconomicCalendar` widget on Home renders
 * `lib/mock/market.ts`, which is exactly why it is not reused here. A "remind
 * me" control that dropped its input on the floor would be worse than its
 * absence, so the gap is stated instead.
 */

interface NseEvent {
  symbol: string;
  company: string;
  purpose: string;
  date: string;
}

export function CalendarClient() {
  const query = useQuery({
    queryKey: ['nse', 'events'],
    queryFn: async () => (await api('/nse/events?limit=100')) as { events: NseEvent[]; fetchedAt: string },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const events = query.data?.events ?? [];
  const grouped = groupByDate(events);

  return (
    <div className="mx-auto max-w-[1000px] space-y-4 p-4">
      <header className="flex flex-wrap items-baseline gap-2">
        <h1 className="text-xl font-bold text-text">Calendar</h1>
        {query.data?.fetchedAt && (
          <span className="text-[11px] text-faint">
            NSE · fetched {new Date(query.data.fetchedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
          </span>
        )}
      </header>

      <Card title="Upcoming corporate events" subtitle="· board meetings">
        {query.isLoading ? (
          <div className="flex justify-center py-8">
            <CandleLoader size="md" label="Loading the exchange calendar" />
          </div>
        ) : query.isError ? (
          <EmptyState
            title="Could not reach the exchange calendar"
            description={query.error instanceof Error ? query.error.message : 'The NSE connector did not answer.'}
          />
        ) : events.length === 0 ? (
          <EmptyState
            title="No upcoming events published"
            description="NSE has not published any board meetings for the period it serves."
          />
        ) : (
          <div className="space-y-4">
            {grouped.map(([date, rows]) => (
              <section key={date}>
                <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-faint">{date}</h3>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {rows.map((e, i) => (
                    <li key={`${e.symbol}-${i}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <span className="w-24 shrink-0 font-mono text-xs font-bold tabular-nums text-text">
                        {e.symbol}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-text">{e.company}</span>
                      <Badge tone="neutral" className="shrink-0 px-1.5 py-0 text-[9px]">
                        {e.purpose || 'BOARD MEETING'}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Card>

      <Card title="Not available yet" className="border-amber bg-amber-bg">
        <ul className="grid gap-1.5 text-xs text-muted sm:grid-cols-2">
          <li>Economic releases (CPI, RBI policy, GDP) — no macro feed is connected.</li>
          <li>Derivative expiry dates as calendar entries.</li>
          <li>Personal reminders — there is no store for user-created events.</li>
          <li>Your own trade log on the calendar — see Portfolio → Trade History.</li>
        </ul>
      </Card>

      <p className="text-[11px] text-faint">
        Trading-session status for today is on{' '}
        <Link href="/dashboard" className="text-teal hover:underline">
          Home
        </Link>{' '}
        and in the market ticker above.
      </p>
    </div>
  );
}

/** Group by the exchange's own date string, preserving its order. */
function groupByDate(events: NseEvent[]): Array<[string, NseEvent[]]> {
  const map = new Map<string, NseEvent[]>();
  for (const e of events) {
    const key = e.date || 'Date not published';
    const bucket = map.get(key);
    if (bucket) bucket.push(e);
    else map.set(key, [e]);
  }
  return Array.from(map.entries());
}

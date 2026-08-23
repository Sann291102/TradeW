'use client';

import { useMemo, useState } from 'react';
import { admin, type AuditRow } from '@/lib/api';
import {
  Empty, MetricCard, Panel, Pill, StatusIndicator, Table, Td, Th, WindowPicker, fmtNum, fmtTime, usePolling,
} from '@/components/ui';

/**
 * Audit & Compliance — the console's read of `AuditEvent`.
 *
 * ## Why this stopped being a placeholder
 *
 * It was the cheapest of the seven scaffolded modules by a wide margin: the
 * feed (`/admin/audit`) already existed, was already on the proxy allowlist,
 * and was already being read — the Users/System page has shown a 7-day auth
 * trail in a side panel since the console was built. What was missing was a
 * surface where the audit trail is the SUBJECT rather than a sidebar: filtered
 * by category and event, searchable, and showing the metadata that names what
 * an action was actually done TO.
 *
 * ## What it does not claim
 *
 * `AuditEvent` is what this platform actually records: authentication events
 * and the handful of privileged writes the console itself performs. It is not
 * a SOC2/GDPR reporting pipeline, there is no DSAR export behind it, and no
 * policy-violation stream feeds it — all of which the 2026-08-09 blueprint
 * promised for a page with this name. Rather than implying otherwise with an
 * empty "Compliance reports" panel, this page shows the trail that exists and
 * the footer says plainly what is not behind it.
 *
 * ## Event types are derived, not enumerated
 *
 * There is no endpoint that lists the vocabulary, and hardcoding one here would
 * go stale the first time a service adds an event. The dropdown is built from
 * the events actually present in the loaded window, so it always describes real
 * data — and says so, because "no such option" then means "nothing like that
 * happened in this window", not "unsupported".
 */

/** The two halves of the trail, told apart by prefix — see the writers in
 *  `auth.service.ts` (user./session.) and the console's own privileged writes
 *  (admin./execution.). */
type Category = '' | 'operator' | 'auth';

const CATEGORY_LABELS: Record<Category, string> = {
  '': 'All activity',
  operator: 'Operator & agent control',
  auth: 'Authentication',
};

function isOperatorEvent(eventType: string): boolean {
  return eventType.startsWith('admin.') || eventType.startsWith('execution.');
}

/** A failed sign-in is the one event class worth counting on its own: a run of
 *  them is the shape of credential stuffing, and it is the only signal in this
 *  table that is actionable rather than historical. */
function isFailure(eventType: string): boolean {
  return eventType.endsWith('.failure');
}

export default function AdminAuditPage() {
  const [hours, setHours] = useState(168);
  const [category, setCategory] = useState<Category>('');
  const [eventType, setEventType] = useState('');
  const [query, setQuery] = useState('');

  // Filtered server-side by event type (the endpoint supports it and the column
  // is indexed on (eventType, createdAt)); category and free text are applied
  // below, over the same rows, because neither has an upstream parameter.
  const events = usePolling(
    () => admin.audit({ hours, eventType: eventType || undefined, limit: 300 }),
    [hours, eventType],
    20_000,
  );

  // The dropdown's vocabulary comes from an UNFILTERED read of the same window,
  // not from `events`. Deriving it from the filtered rows collapses the list to
  // the one type already selected the moment a filter is applied, and there is
  // then no way back to another type without clearing first. Polled slowly:
  // the set of event types a platform emits changes on deploys, not on ticks.
  const vocabulary = usePolling(() => admin.audit({ hours, limit: 300 }), [hours], 60_000);

  const rows = events.data ?? [];

  const eventTypes = useMemo(
    () => Array.from(new Set((vocabulary.data ?? []).map((e) => e.eventType))).sort(),
    [vocabulary.data],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((e) => {
      if (category === 'operator' && !isOperatorEvent(e.eventType)) return false;
      if (category === 'auth' && isOperatorEvent(e.eventType)) return false;
      if (!q) return true;
      const haystack = [e.eventType, e.user?.email, e.ip, e.userAgent, JSON.stringify(e.metadata ?? {})]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [rows, category, query]);

  const operatorActions = visible.filter((e) => isOperatorEvent(e.eventType)).length;
  const failures = visible.filter((e) => isFailure(e.eventType)).length;
  const actors = new Set(visible.map((e) => e.user?.email ?? e.userId ?? e.ip ?? 'unknown')).size;

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Audit &amp; Compliance</h1>
          <p className="text-[12px] text-muted">
            Every recorded authentication event and every privileged action an operator took.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusIndicator
            label={
              events.loading && !events.data
                ? 'Loading…'
                : failures > 0
                  ? `${failures} failed attempt${failures === 1 ? '' : 's'} in view`
                  : 'No failed attempts in view'
            }
            tone={events.loading && !events.data ? 'idle' : failures > 0 ? 'warn' : 'good'}
            pulse={false}
          />
          <WindowPicker hours={hours} onChange={setHours} />
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Events" accent="teal" live value={fmtNum(visible.length)} sub={`of ${fmtNum(rows.length)} loaded`} />
        <MetricCard
          label="Operator actions"
          accent={operatorActions ? 'violet' : 'slate'}
          value={fmtNum(operatorActions)}
          sub="admin grants, profile arming, consent"
        />
        <MetricCard
          label="Failed attempts"
          accent={failures ? 'red' : 'green'}
          value={fmtNum(failures)}
          sub={failures ? 'logins or refreshes refused' : 'none in this window'}
          tone={failures ? 'warn' : 'good'}
        />
        <MetricCard label="Distinct actors" accent="slate" value={fmtNum(actors)} sub="by account, else by IP" />
      </div>

      <Panel
        title="Audit trail"
        subtitle={`${visible.length} shown · ${CATEGORY_LABELS[category]}`}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search email, IP, metadata…"
              className="w-[210px] rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11.5px] outline-none placeholder:text-faint focus:border-teal"
            />
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as Category)}
              className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11.5px] outline-none focus:border-teal"
            >
              {(Object.keys(CATEGORY_LABELS) as Category[]).map((c) => (
                <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
              ))}
            </select>
            <select
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
              className="max-w-[220px] rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11.5px] outline-none focus:border-teal"
            >
              <option value="">All event types</option>
              {/* The current selection is kept even if it has aged out of the
                  window, so the control never silently drops what it shows. */}
              {(!eventType || eventTypes.includes(eventType) ? eventTypes : [eventType, ...eventTypes]).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
        }
      >
        {visible.length > 0 ? (
          <Table head={<>
            <Th>Time</Th><Th>Event</Th><Th>Account</Th><Th>IP</Th><Th>Client</Th><Th>Details</Th>
          </>}>
            {visible.map((event: AuditRow) => (
              <tr key={event.id} className="transition-colors hover:bg-white/[0.03]">
                <Td className="num whitespace-nowrap text-muted">{fmtTime(event.createdAt)}</Td>
                <Td>
                  <Pill tone={isFailure(event.eventType) ? 'bad' : isOperatorEvent(event.eventType) ? 'info' : 'neutral'}>
                    {event.eventType}
                  </Pill>
                </Td>
                <Td className="max-w-[220px] truncate text-muted">
                  {/* An event with no account is not a gap in the record: a
                      failed login for an unknown email has no user to name, and
                      that is itself the fact worth reading. */}
                  {event.user?.email ?? <span className="text-faint">unauthenticated</span>}
                </Td>
                <Td className="num text-faint">{event.ip ?? '—'}</Td>
                <Td className="max-w-[180px] truncate text-[11px] text-faint" title={event.userAgent ?? undefined}>
                  {event.userAgent ?? '—'}
                </Td>
                <Td className="max-w-[320px] truncate text-[11px] text-faint" title={metaText(event.metadata)}>
                  {metaText(event.metadata)}
                </Td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>
            {events.loading
              ? 'Loading…'
              : rows.length > 0
                ? 'No event matches these filters.'
                : 'No audit events in this window.'}
          </Empty>
        )}
        <p className="border-t border-white/[0.06] px-4 py-2 text-[11px] leading-relaxed text-faint">
          This is the <code className="text-muted">AuditEvent</code> table as written by{' '}
          <code className="text-muted">services/api</code> — authentication events plus the privileged writes this
          console performs, each naming the operator who made it. Newest first, capped at 300 rows per window.
          There is no compliance-report generation, DSAR export or policy-violation stream behind this page; those
          were specified in an old blueprint and were never built.
        </p>
      </Panel>
    </div>
  );
}

/** Metadata as a compact one-liner. Rendered rather than hidden because it is
 *  what names the TARGET of an action — a grant row without `targetEmail` says
 *  someone granted something to somebody. */
function metaText(metadata: Record<string, unknown> | null | undefined): string {
  if (!metadata || Object.keys(metadata).length === 0) return '—';
  return Object.entries(metadata)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ');
}

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { istDateKey } from '../discipline/market-calendar';

/**
 * Turns validated Sentinel events into durable, per-user notifications.
 *
 * ## Why this is a separate service and not three lines in `SentinelApiService`
 *
 * `observe()` is on the request path of a 45-second poll from every open
 * workspace. Anything it does that is not "answer this observation" has to be
 * structurally incapable of slowing it down or failing it — so the dispatch
 * lives behind one `dispatch()` call that never throws and never awaits
 * anything the response depends on.
 *
 * ## What it is allowed to read
 *
 * `response.events` and nothing else. The observe response also carries
 * `sideInFocus`, `strategyAdvices` and the full publication record, and every
 * one of those is off-limits here: see the header of
 * `services/sentinel/src/events/sentinel-event.ts` for why a notification is
 * the one surface that must not carry a direction. The event contract is the
 * boundary, and `toNotification` below only ever names fields from it, so an
 * extra field arriving over HTTP cannot leak into a row by being spread.
 *
 * ## Dedupe, and why it is durable rather than in-memory
 *
 * Sentinel's `MarketTimelineEngine` dedupes in memory over a recent window,
 * which is right for a narrative rebuilt on every request. A notification is a
 * row a user comes back to, so its dedupe has to survive an API restart and
 * hold across replicas — an in-memory set would let every deploy re-notify
 * everyone about a setup they already read. The key is stored on
 * `Notification.metadata` and matched against today's IST trading day.
 *
 * This is a read-then-write without a unique constraint, so two concurrent
 * polls from the same user *can* both miss and insert a duplicate. That is a
 * deliberate trade for now: the failure mode is one extra row, the fix is a
 * `(userId, dedupeKey, tradingDate)` unique index, and adding the index later
 * needs no change to this code. It is recorded here rather than left for
 * someone to discover.
 */

/** The contract as it arrives over HTTP — validated, never trusted by shape. */
interface IncomingSentinelEvent {
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  symbol: string;
  dedupeKey: string;
  at: string;
  confidence: number | null;
  state: string;
}

const SEVERITIES = new Set(['info', 'warning', 'critical']);

/**
 * Upper bound on rows written per observation.
 *
 * The deriving function currently tops out well below this. The cap is here so
 * that a future bug which starts emitting per-factor or per-detection events
 * costs a user five notifications rather than fifty — a runaway loop should be
 * visible in the log line below, not in someone's notification drawer.
 */
const MAX_EVENTS_PER_OBSERVATION = 5;

@Injectable()
export class SentinelEventDispatcher {
  private readonly logger = new Logger(SentinelEventDispatcher.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persist any new events on this observation. Resolves to the number of rows
   * written. Never rejects: a delivery fault must not become an observation
   * fault.
   */
  async dispatch(userId: string, response: unknown): Promise<number> {
    try {
      const events = this.extract(response);
      if (events.length === 0) return 0;

      const tradingDate = istDateKey();
      const seen = await this.keysSeenToday(userId, tradingDate);

      const fresh: IncomingSentinelEvent[] = [];
      for (const event of events) {
        if (seen.has(event.dedupeKey)) continue;
        // Guard within the batch too — a single observation emitting the same
        // key twice would otherwise slip past the DB check, which was read
        // before either was written.
        seen.add(event.dedupeKey);
        fresh.push(event);
        if (fresh.length >= MAX_EVENTS_PER_OBSERVATION) {
          this.logger.warn(
            `sentinel events capped at ${MAX_EVENTS_PER_OBSERVATION} for user=${userId} — ` +
              `${events.length} derived, check deriveSentinelEvents`,
          );
          break;
        }
      }
      if (fresh.length === 0) return 0;

      await this.prisma.notification.createMany({
        data: fresh.map((event) => this.toNotification(userId, event, tradingDate)),
      });
      return fresh.length;
    } catch (err) {
      // Swallowed on purpose. The observation has already been computed and is
      // on its way to the user; failing it because a notification row could
      // not be written would trade the feature for the thing it decorates.
      this.logger.warn(`sentinel notification dispatch failed (non-fatal): ${err}`);
      return 0;
    }
  }

  /**
   * Build the row. Every field is named explicitly — no spread of the incoming
   * object — so the set of things that can reach the database is exactly the
   * set written here, whatever else the sentinel service starts sending.
   */
  private toNotification(userId: string, event: IncomingSentinelEvent, tradingDate: string) {
    return {
      userId,
      // 'sentinel' is an existing NotificationCategory value. Severity lives in
      // metadata rather than becoming new enum members, so this needs no
      // migration; see the note on the enum in
      // `knowledge/Patterns/2026-08-11 - Transactional email + in-app notification wiring`.
      category: 'sentinel' as const,
      title: event.title,
      body: event.body,
      metadata: {
        kind: `sentinel_${event.kind.replace(/-/g, '_')}`,
        dedupeKey: event.dedupeKey,
        severity: event.severity,
        symbol: event.symbol,
        state: event.state,
        confidence: event.confidence,
        observedAt: event.at,
        tradingDate,
      },
    };
  }

  /** Dedupe keys already notified to this user on this IST trading day. */
  private async keysSeenToday(userId: string, tradingDate: string): Promise<Set<string>> {
    const dayStart = new Date(`${tradingDate}T00:00:00+05:30`);
    const rows = await this.prisma.notification.findMany({
      where: { userId, category: 'sentinel', createdAt: { gte: dayStart } },
      select: { metadata: true },
    });

    const keys = new Set<string>();
    for (const row of rows) {
      const meta = row.metadata as { dedupeKey?: unknown } | null;
      if (meta && typeof meta.dedupeKey === 'string') keys.add(meta.dedupeKey);
    }
    return keys;
  }

  /**
   * Pull `events` out of the observe response and drop anything malformed.
   *
   * This crosses a service boundary over HTTP, so the shape is validated
   * rather than asserted: a partially-deployed sentinel service sending an
   * older or newer payload should cost us the notification, not throw inside
   * a poll.
   */
  private extract(response: unknown): IncomingSentinelEvent[] {
    if (!response || typeof response !== 'object') return [];
    const raw = (response as { events?: unknown }).events;
    if (!Array.isArray(raw)) return [];

    return raw.filter((e): e is IncomingSentinelEvent => {
      if (!e || typeof e !== 'object') return false;
      const c = e as Record<string, unknown>;
      return (
        typeof c.kind === 'string' &&
        typeof c.severity === 'string' &&
        SEVERITIES.has(c.severity) &&
        typeof c.title === 'string' &&
        c.title.length > 0 &&
        typeof c.body === 'string' &&
        c.body.length > 0 &&
        typeof c.symbol === 'string' &&
        typeof c.dedupeKey === 'string' &&
        c.dedupeKey.length > 0 &&
        typeof c.at === 'string' &&
        typeof c.state === 'string' &&
        (c.confidence === null || typeof c.confidence === 'number')
      );
    });
  }
}

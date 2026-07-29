/**
 * Module 8 — Market Timeline Engine.
 *
 * Replaces fragmented notifications with one continuous, chronological
 * session narrative:
 *
 *   09:15 ── Market open: NIFTY opened +45pt from the prior close. India VIX 13.4.
 *   09:31 ── Session classified as Bullish Trend Day.
 *   09:42 ── Opening Range Breakout Retest forming — 2 of 3 rules confirmed.
 *   09:51 ── Bullish side in focus (confidence 91%).
 *
 * `/observe` is polled, so the engine is **idempotent by design**: recording
 * the same event text again inside the dedupe window is a no-op. Without that
 * the "continuous narrative" would just be the notification spam it replaces.
 *
 * Timelines are held per session key (user + symbol + IST trading date), for
 * the same reason the state machine is: one singleton serves every trader.
 */
import { Injectable, Logger } from '@nestjs/common';
import { TimelineEntry, TimelineLevel } from '../domain';
import { istDateKey, istTimeLabel } from '../market-clock';

const MAX_ENTRIES = 400;
const SESSION_TTL_MS = 24 * 3_600_000;
/** How far back to look for an identical event before appending a new one. */
const DEDUPE_WINDOW = 12;

interface TimelineSession {
  entries: TimelineEntry[];
  touchedAt: number;
}

export interface RecordInput {
  event: string;
  level: TimelineLevel;
  confidence?: number;
  state?: TimelineEntry['state'];
  data?: Record<string, unknown>;
  at?: Date;
  /**
   * Collapse repeats of the same *kind* of event even when the wording
   * changed (e.g. a confidence figure that ticks). Entries sharing a
   * dedupeKey inside the window replace nothing and add nothing.
   */
  dedupeKey?: string;
}

@Injectable()
export class MarketTimelineEngine {
  private readonly logger = new Logger(MarketTimelineEngine.name);
  private readonly sessions = new Map<string, TimelineSession>();

  static sessionKey(userId: string, symbol: string, at: Date = new Date()): string {
    return `${userId}::${symbol}::${istDateKey(at)}`;
  }

  /**
   * Append an entry unless an equivalent one is already in the recent window.
   * Returns the entry when it was recorded, null when it was a duplicate.
   */
  record(key: string, input: RecordInput): TimelineEntry | null {
    const at = input.at ?? new Date();
    const session = this.session(key, at);
    session.touchedAt = at.getTime();

    const recent = session.entries.slice(-DEDUPE_WINDOW);
    const duplicate = recent.some((e) =>
      input.dedupeKey
        ? e.data?.dedupeKey === input.dedupeKey
        : e.event === input.event && e.level === input.level,
    );
    if (duplicate) return null;

    const entry: TimelineEntry = {
      at: at.toISOString(),
      time: istTimeLabel(at),
      event: input.event,
      level: input.level,
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.state ? { state: input.state } : {}),
      data: { ...input.data, ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}) },
    };

    session.entries.push(entry);
    if (session.entries.length > MAX_ENTRIES) {
      session.entries.splice(0, session.entries.length - MAX_ENTRIES);
    }
    this.prune(at);
    return entry;
  }

  /** Record several entries, returning only the ones that were new. */
  recordAll(key: string, inputs: RecordInput[]): TimelineEntry[] {
    return inputs.map((i) => this.record(key, i)).filter((e): e is TimelineEntry => e !== null);
  }

  /** The full session narrative, oldest first. */
  entries(key: string): TimelineEntry[] {
    return [...(this.sessions.get(key)?.entries ?? [])];
  }

  /** Entries recorded strictly after `isoTimestamp` — the polling read path. */
  since(key: string, isoTimestamp: string): TimelineEntry[] {
    const cutoff = new Date(isoTimestamp).getTime();
    if (Number.isNaN(cutoff)) return this.entries(key);
    return this.entries(key).filter((e) => new Date(e.at).getTime() > cutoff);
  }

  byLevel(key: string, level: TimelineLevel): TimelineEntry[] {
    return this.entries(key).filter((e) => e.level === level);
  }

  /** Plain-text rendering, matching the Master Plan's example layout. */
  format(key: string): string {
    return this.entries(key)
      .map((e) => {
        const confidence = e.confidence !== undefined ? ` (confidence ${e.confidence.toFixed(0)}%)` : '';
        return `${e.time} ── ${e.event}${confidence}`;
      })
      .join('\n');
  }

  /** Drop a session's narrative — used by the end-of-day roll-over. */
  clear(key: string): void {
    this.sessions.delete(key);
  }

  private session(key: string, at: Date): TimelineSession {
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const created: TimelineSession = { entries: [], touchedAt: at.getTime() };
    this.sessions.set(key, created);
    this.logger.debug(`timeline session opened: ${key}`);
    return created;
  }

  private prune(at: Date): void {
    const cutoff = at.getTime() - SESSION_TTL_MS;
    for (const [key, session] of this.sessions) {
      if (session.touchedAt < cutoff) this.sessions.delete(key);
    }
  }
}

import { MarketFeed, StatusHandler, TickHandler, TypedEmitter, Unsubscribe } from '../../contracts/feed';
import { InstrumentRef, isBrokerAddressable, refKey } from '../../contracts/instrument-ref';
import { FeedMode, FeedStatus, FeedStatusEvent, MarketTick } from '../../contracts/tick';
import { parseFrame } from './dhan-binary-parser';

/**
 * DhanHQ Live Market Feed client.
 *
 * Built but NOT enabled — `MARKET_DATA_FEED` defaults to the simulator, and
 * this class throws if started without credentials. Per the Phase 1 brief the
 * infrastructure is built first; switching to it is a configuration change once
 * the licensing question in DHAN-MARKET-DATA-INTEGRATION.md §3.1 is settled.
 *
 * Protocol constraints encoded here, all from the DhanHQ v2 docs:
 *   · 5 concurrent connections per user, 5,000 instruments each
 *   · at most 100 instruments per subscribe message
 *   · server pings every 10s and closes the socket after 40s of silence
 *   · responses are little-endian binary (see dhan-binary-parser.ts)
 *   · disconnect code 805 = too many connections
 *
 * The WebSocket implementation is injected rather than imported so this package
 * stays dependency-free and the reconnect logic is testable without a network.
 */

/** The subset of the WebSocket API this client uses. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  onopen: ((...args: unknown[]) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export const DHAN_FEED_URL = 'wss://api-feed.dhan.co';
export const MAX_INSTRUMENTS_PER_MESSAGE = 100;
export const MAX_INSTRUMENTS_PER_CONNECTION = 5000;
export const MAX_CONNECTIONS = 5;

/** RequestCode values from the DhanHQ annexure. */
const REQUEST_CODE: Record<FeedMode, number> = { ticker: 15, quote: 17, full: 21 };
const REQUEST_CODE_UNSUBSCRIBE = 16;
const REQUEST_CODE_DISCONNECT = 12;

export interface DhanFeedOptions {
  accessToken: string;
  clientId: string;
  webSocketFactory: WebSocketFactory;
  url?: string;
  /** Backoff ceiling. Reconnect delay doubles from 1s up to this. */
  maxReconnectDelayMs?: number;
  maxReconnectAttempts?: number;
  /**
   * How long a connection must survive before it counts as healthy and the
   * backoff is allowed to reset. See `STABLE_CONNECTION_MS`.
   */
  stableConnectionMs?: number;
  /**
   * Backoff floor applied after the server rate-limits us (HTTP 429).
   * See `RATE_LIMIT_COOLDOWN_MS`.
   */
  rateLimitCooldownMs?: number;
  now?: () => Date;
}

/**
 * How long a socket must stay open before the backoff counter is cleared.
 *
 * ── THE BUG THIS CONSTANT FIXES ───────────────────────────────────────────
 *
 * `onopen` used to reset `reconnectAttempt` to 0 unconditionally. That is
 * correct for a connection that then WORKS, and catastrophic for one that
 * opens and dies immediately: every flap reset the backoff to its 1s floor, so
 * the client never actually backed off. Measured on 2026-09-09 against Dhan:
 * 125 opens and 399 reconnects in 13 minutes, roughly ten handshakes a minute,
 * which Dhan answered with HTTP 429 — and the 429 closes fed straight back
 * into the same 1s retry. The loop was self-sustaining: it kept the rate limit
 * engaged, so a perfectly valid token refreshed mid-storm recovered nothing.
 *
 * Backoff must therefore be reset by EVIDENCE OF HEALTH, not by the mere fact
 * of a handshake succeeding. Thirty seconds is comfortably longer than the
 * flap interval being observed and far shorter than any real session.
 */
export const STABLE_CONNECTION_MS = 30_000;

/**
 * The minimum wait after the server says 429.
 *
 * A rate limit is not a transient network fault, and retrying it on the
 * ordinary 1s→2s→4s ladder is what turns one refusal into a storm. It is the
 * server telling us a rate — the only useful response is to stop asking for
 * appreciably longer than the ordinary ladder would.
 */
export const RATE_LIMIT_COOLDOWN_MS = 60_000;

export class DhanMarketFeed implements MarketFeed {
  readonly name = 'dhan';

  private socket: WebSocketLike | null = null;
  private _status: FeedStatus = 'idle';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set when stop() was called, so an in-flight close does not reconnect. */
  private stopping = false;
  /** When the current socket opened, for the stability test in `onclose`. */
  private openedAt: number | null = null;
  /** Set when the last close looked like a rate limit, to lengthen the wait. */
  private rateLimited = false;

  private readonly subscriptions = new Map<string, { ref: InstrumentRef; mode: FeedMode }>();
  private readonly ticks = new TypedEmitter<MarketTick>();
  private readonly statuses = new TypedEmitter<FeedStatusEvent>();
  private readonly now: () => Date;

  constructor(private readonly options: DhanFeedOptions) {
    this.now = options.now ?? (() => new Date());
    if (!options.accessToken || !options.clientId) {
      throw new Error('DhanMarketFeed requires accessToken and clientId — refusing to start unauthenticated.');
    }
  }

  get status(): FeedStatus {
    return this._status;
  }

  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.send(JSON.stringify({ RequestCode: REQUEST_CODE_DISCONNECT }));
      } catch {
        // Socket may already be closing; a failed courtesy disconnect is not
        // worth surfacing as an error.
      }
      this.socket.close();
      this.socket = null;
    }
    this.setStatus('stopped');
  }

  async subscribe(refs: InstrumentRef[], mode: FeedMode): Promise<void> {
    const addressable = refs.filter(isBrokerAddressable);
    const unmapped = refs.length - addressable.length;
    if (unmapped > 0) {
      // Instruments without a securityId cannot be subscribed at all. Silently
      // dropping them would look like a feed outage for those symbols.
      this.setStatus(this._status, {
        reason: `${unmapped} instrument(s) skipped — no securityId/exchangeSegment; run the scrip master sync`,
      });
    }

    for (const ref of addressable) this.subscriptions.set(refKey(ref), { ref, mode });

    if (this.subscriptions.size > MAX_INSTRUMENTS_PER_CONNECTION) {
      throw new Error(
        `subscription count ${this.subscriptions.size} exceeds the ${MAX_INSTRUMENTS_PER_CONNECTION}-per-connection limit; ` +
          'a connection pool is required (see DHAN-MARKET-DATA-INTEGRATION.md §5, Phase 4)',
      );
    }
    if (this._status === 'connected') this.sendSubscriptions(addressable, mode);
  }

  async unsubscribe(refs: InstrumentRef[]): Promise<void> {
    const addressable = refs.filter(isBrokerAddressable);
    for (const ref of addressable) this.subscriptions.delete(refKey(ref));
    if (this._status !== 'connected' || !this.socket) return;

    for (const chunk of chunked(addressable, MAX_INSTRUMENTS_PER_MESSAGE)) {
      this.socket.send(
        JSON.stringify({
          RequestCode: REQUEST_CODE_UNSUBSCRIBE,
          InstrumentCount: chunk.length,
          InstrumentList: chunk.map((r) => ({ ExchangeSegment: r.exchangeSegment, SecurityId: r.securityId })),
        }),
      );
    }
  }

  onTick(handler: TickHandler): Unsubscribe {
    return this.ticks.on(handler);
  }

  onStatus(handler: StatusHandler): Unsubscribe {
    return this.statuses.on(handler);
  }

  // -------------------------------------------------------------------------

  private async connect(): Promise<void> {
    this.setStatus(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting', { attempt: this.reconnectAttempt });

    const url =
      `${this.options.url ?? DHAN_FEED_URL}?version=2` +
      `&token=${encodeURIComponent(this.options.accessToken)}` +
      `&clientId=${encodeURIComponent(this.options.clientId)}&authType=2`;

    try {
      const socket = this.options.webSocketFactory(url);
      this.socket = socket;

      socket.onopen = () => {
        // NOT `reconnectAttempt = 0`. A handshake succeeding proves the server
        // accepted the connection, not that the connection is usable — and
        // resetting here is precisely what let a flapping socket retry forever
        // at the 1s floor. The counter is cleared in `onclose` instead, and
        // only for a socket that survived `STABLE_CONNECTION_MS`.
        this.openedAt = Date.now();
        this.rateLimited = false;
        this.setStatus('connected');
        this.resubscribeAll();
      };

      socket.onmessage = (event) => this.handleMessage(event.data);

      socket.onerror = (event) => {
        const reason = describeError(event);
        // The handshake failure arrives here, not on `onclose` — `ws` reports
        // a rejected upgrade as "Unexpected server response: 429" and then
        // closes with 1006, which carries no code of its own. Remembering it
        // is the only way the close below can tell a rate limit from an
        // ordinary drop.
        if (/\b429\b/.test(reason)) this.rateLimited = true;
        this.setStatus('error', { reason });
      };

      socket.onclose = (event) => {
        this.socket = null;
        const heldFor = this.openedAt === null ? 0 : Date.now() - this.openedAt;
        this.openedAt = null;
        if (this.stopping) return;
        // Health is measured by SURVIVAL, so only a connection that lasted
        // clears the backoff. Anything shorter is a flap and must keep
        // escalating.
        const stable = this.options.stableConnectionMs ?? STABLE_CONNECTION_MS;
        if (heldFor >= stable) this.reconnectAttempt = 0;
        // 805 means we opened a sixth connection and the server dropped the
        // oldest. Reconnecting immediately would fight whatever else is
        // connected, so it is surfaced distinctly rather than retried blindly.
        const reason = event?.code === 805 ? 'connection limit exceeded (805) — another ingestor instance is likely running' : event?.reason;
        this.scheduleReconnect(reason, event?.code);
      };
    } catch (err) {
      this.setStatus('error', { reason: err instanceof Error ? err.message : String(err) });
      if (!this.stopping) this.scheduleReconnect(err instanceof Error ? err.message : String(err));
    }
  }

  private scheduleReconnect(reason?: string, code?: number): void {
    const maxAttempts = this.options.maxReconnectAttempts ?? Number.POSITIVE_INFINITY;
    if (this.reconnectAttempt >= maxAttempts) {
      this.setStatus('error', { reason: `giving up after ${this.reconnectAttempt} reconnect attempts: ${reason ?? 'unknown'}`, code });
      return;
    }
    this.reconnectAttempt++;
    const ceiling = this.options.maxReconnectDelayMs ?? 30_000;
    // Exponential backoff with jitter — without jitter, several instruments or
    // instances recovering together would retry in lockstep.
    const base = Math.min(ceiling, 1000 * 2 ** (this.reconnectAttempt - 1));
    // A rate limit overrides the ladder rather than riding it. The server has
    // stated a rate; continuing to probe every second or two is what keeps it
    // engaged, so the cooldown is a FLOOR the ordinary delay cannot undercut.
    const cooldown = this.options.rateLimitCooldownMs ?? RATE_LIMIT_COOLDOWN_MS;
    const floor = this.rateLimited ? cooldown : 0;
    const delay = Math.max(floor, Math.round(base * (0.5 + Math.random() * 0.5)));

    this.setStatus('reconnecting', {
      // `||` not `??`: a close event carries an EMPTY-STRING reason far more
      // often than an absent one, and `??` would let that through and print a
      // dangling dash instead of saying what happened.
      reason: this.rateLimited
        ? `${reason || 'rate limited (HTTP 429)'} — cooling down ${Math.round(delay / 1000)}s`
        : reason,
      code,
      attempt: this.reconnectAttempt,
    });
    // Clearing first is defensive but load-bearing: two closes arriving close
    // together (an error close chased by a socket close) would otherwise leave
    // two live timers, and from then on every cycle doubles the number of
    // connection attempts.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private resubscribeAll(): void {
    // A reconnect starts with an empty server-side subscription set, so every
    // subscription must be replayed or the feed silently returns nothing.
    const byMode = new Map<FeedMode, InstrumentRef[]>();
    for (const { ref, mode } of this.subscriptions.values()) {
      const list = byMode.get(mode) ?? [];
      list.push(ref);
      byMode.set(mode, list);
    }
    for (const [mode, refs] of byMode) this.sendSubscriptions(refs, mode);
  }

  private sendSubscriptions(refs: InstrumentRef[], mode: FeedMode): void {
    if (!this.socket || refs.length === 0) return;
    for (const chunk of chunked(refs.filter(isBrokerAddressable), MAX_INSTRUMENTS_PER_MESSAGE)) {
      this.socket.send(
        JSON.stringify({
          RequestCode: REQUEST_CODE[mode],
          InstrumentCount: chunk.length,
          InstrumentList: chunk.map((r) => ({ ExchangeSegment: r.exchangeSegment, SecurityId: r.securityId })),
        }),
      );
    }
  }

  private handleMessage(data: unknown): void {
    const buf = toBuffer(data);
    if (!buf) return;

    for (const packet of parseFrame(buf, this.now())) {
      if (packet.kind === 'tick') {
        // The wire carries no symbol — only (segment, securityId). The ingestor
        // resolves that against Instrument; emitting as-is keeps this class
        // free of any database concern.
        this.ticks.emit(packet.tick);
      } else if (packet.kind === 'disconnect') {
        this.setStatus('error', { reason: `feed sent disconnect code ${packet.code}`, code: packet.code });
      }
    }
  }

  private setStatus(status: FeedStatus, extra: Partial<FeedStatusEvent> = {}): void {
    this._status = status;
    this.statuses.emit({ status, feed: this.name, at: this.now(), ...extra });
  }
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function toBuffer(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function describeError(event: unknown): string {
  if (event instanceof Error) return event.message;
  if (typeof event === 'object' && event !== null && 'message' in event) return String((event as { message: unknown }).message);
  return 'websocket error';
}

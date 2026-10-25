/**
 * The 2026-09-09 reconnect storm, as executable regressions.
 *
 * ## What happened
 *
 * Every index on the app's home screen read 0.00 through a live session. The
 * feed was not down and the token was not expired — the bridge was in a
 * self-sustaining reconnect loop: 125 opens, 399 reconnects and 75 HTTP 429s
 * in thirteen minutes, roughly ten handshakes a minute.
 *
 * The cause was a single line. `onopen` reset `reconnectAttempt` to 0, so a
 * socket that opened and died immediately reset the backoff to its 1s floor
 * every time. The client therefore never backed off, Dhan rate-limited it, and
 * the 429 closes fed straight back into the same 1s retry. Because the storm
 * kept the rate limit engaged, refreshing the (genuinely expired, earlier)
 * token recovered nothing — which is what made it look intermittent and
 * unfixable across mornings.
 *
 * ## What these tests pin
 *
 * That backoff is cleared by EVIDENCE OF HEALTH (a connection that survived)
 * and never by a bare handshake, and that a stated rate limit is honoured as a
 * floor rather than ridden on the ordinary ladder. Both are properties of the
 * retry policy, so they are tested through a fake socket with a fake clock —
 * no network, no Dhan account, deterministic.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DhanMarketFeed, RATE_LIMIT_COOLDOWN_MS, STABLE_CONNECTION_MS } from './dhan.feed';

/** The minimum of the `ws`-shaped surface `DhanMarketFeed` actually drives. */
class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null = null;
  readonly sent: string[] = [];
  send(payload: string): void {
    this.sent.push(payload);
  }
  close(): void {
    this.onclose?.({ code: 1000 });
  }
}

describe('DhanMarketFeed reconnect policy', () => {
  let sockets: FakeSocket[];
  let feed: DhanMarketFeed;

  const build = () => {
    sockets = [];
    feed = new DhanMarketFeed({
      accessToken: 'test-token',
      clientId: 'test-client',
      webSocketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s as never;
      },
    });
  };

  /** Open the newest socket, hold it `heldMs`, then close it. */
  const flap = (heldMs: number, close: { code?: number; reason?: string } = { code: 1006 }) => {
    const socket = sockets[sockets.length - 1];
    socket.onopen?.();
    vi.advanceTimersByTime(heldMs);
    socket.onclose?.(close);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    build();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The attempt number each retry cycle reached.
   *
   * Each cycle emits `reconnecting` twice with the SAME attempt — once when
   * the retry is scheduled and once when `connect()` runs it. That is
   * pre-existing behaviour and not what these tests are about, so consecutive
   * repeats are collapsed and the escalation itself is asserted.
   */
  const ladder = (attempts: number[]): number[] =>
    attempts.filter((a, i) => i === 0 || a !== attempts[i - 1]);

  it('escalates the delay across repeated flaps instead of resetting on open', () => {
    const delays: number[] = [];
    feed.onStatus((e) => {
      if (e.status === 'reconnecting' && e.attempt) delays.push(e.attempt);
    });

    void feed.start();
    // Five sockets that each open and die immediately — the exact shape of the
    // production storm.
    for (let i = 0; i < 5; i += 1) {
      flap(50);
      vi.advanceTimersByTime(60_000); // let whatever was scheduled fire
    }

    // The attempt counter must climb. Before the fix it was pinned at 1,
    // because every `onopen` zeroed it.
    expect(ladder(delays)).toEqual([1, 2, 3, 4, 5]);
  });

  it('clears the backoff only after a connection survives the stability window', () => {
    const attempts: number[] = [];
    feed.onStatus((e) => {
      if (e.status === 'reconnecting' && e.attempt) attempts.push(e.attempt);
    });

    void feed.start();
    flap(50);
    vi.advanceTimersByTime(60_000);
    flap(50);
    vi.advanceTimersByTime(60_000);
    expect(ladder(attempts)).toEqual([1, 2]);

    // A connection that actually held is evidence of health.
    flap(STABLE_CONNECTION_MS + 1_000);
    vi.advanceTimersByTime(60_000);

    // …so the ladder starts over from 1 rather than continuing at 4.
    expect(attempts[attempts.length - 1]).toBe(1);
  });

  it('honours a 429 as a cooldown floor rather than retrying on the 1s ladder', () => {
    let scheduled = -1;
    const spy = vi.spyOn(globalThis, 'setTimeout');

    void feed.start();
    const socket = sockets[sockets.length - 1];
    // `ws` reports a rejected upgrade through onerror, then closes 1006 with
    // no code of its own — so the rate limit is only knowable from the error.
    socket.onerror?.({ message: 'Unexpected server response: 429' });
    socket.onclose?.({ code: 1006 });

    for (const call of spy.mock.calls) {
      if (typeof call[1] === 'number' && call[1] >= 1000) scheduled = call[1];
    }
    // The first attempt's ordinary delay is 500–1000ms; the cooldown floor
    // must dominate it.
    expect(scheduled).toBeGreaterThanOrEqual(RATE_LIMIT_COOLDOWN_MS);
    spy.mockRestore();
  });

  it('reports the rate limit in the status reason so the log can show it', () => {
    const reasons: (string | undefined)[] = [];
    feed.onStatus((e) => {
      if (e.status === 'reconnecting') reasons.push(e.reason);
    });

    void feed.start();
    const socket = sockets[sockets.length - 1];
    socket.onerror?.({ message: 'Unexpected server response: 429' });
    socket.onclose?.({ code: 1006 });

    expect(reasons.some((r) => r?.includes('cooling down'))).toBe(true);
  });

  it('never leaves two reconnect timers alive after a doubled close', () => {
    void feed.start();
    const before = sockets.length;
    const socket = sockets[sockets.length - 1];

    // An error-close chased by a socket-close. Without the defensive clear,
    // this leaves two timers and every subsequent cycle doubles the number of
    // connection attempts.
    socket.onclose?.({ code: 1006 });
    socket.onclose?.({ code: 1006 });
    vi.advanceTimersByTime(120_000);

    // Exactly one new connection attempt, not two.
    expect(sockets.length).toBe(before + 1);
  });

  it('resubscribes everything it held after a reconnect', () => {
    void feed.start();
    feed.subscribe([{ symbol: 'NIFTY', exchangeSegment: 'IDX_I', securityId: '13' }], 'ticker');

    flap(STABLE_CONNECTION_MS + 1_000);
    vi.advanceTimersByTime(60_000);
    const reconnected = sockets[sockets.length - 1];
    reconnected.onopen?.();

    // A reconnect starts with an empty server-side subscription set, so a feed
    // that does not replay them goes silently quiet — which looks exactly like
    // a dead market.
    expect(reconnected.sent.length).toBeGreaterThan(0);
    expect(reconnected.sent[0]).toContain('"SecurityId":"13"');
  });
});

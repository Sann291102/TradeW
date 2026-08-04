import WebSocket from 'ws';
import type { WebSocketFactory, WebSocketLike } from '@tradew/market-data';

/**
 * Real transport for `DhanMarketFeed`. `packages/market-data` stays
 * dependency-free and takes a `WebSocketFactory` injected at the edge
 * (DHAN-MARKET-DATA-INTEGRATION.md Phase 4) — this is that edge.
 *
 * `ws`'s browser-compatibility mode already exposes onopen/onmessage/
 * onerror/onclose and a `readyState`, so it satisfies `WebSocketLike` as-is.
 */
export const dhanWebSocketFactory: WebSocketFactory = (url: string): WebSocketLike => {
  return new WebSocket(url) as unknown as WebSocketLike;
};

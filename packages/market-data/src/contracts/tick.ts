import { InstrumentRef } from './instrument-ref';

/**
 * The unit the ingestion pipeline moves: one observation of one instrument at
 * one moment, normalised across providers.
 *
 * Every field except `ref`, `at` and `source` is optional because feed modes
 * differ in what they carry — Dhan's Ticker packet has only LTP and trade time,
 * its Quote packet adds OHLC and volume, its Full packet adds depth and OI. A
 * consumer must be able to tell "not sent in this mode" from "sent as zero",
 * so absent fields are `undefined` rather than defaulted.
 */
export interface MarketTick {
  ref: InstrumentRef;
  /** When the exchange reported this, not when we received it. */
  at: Date;
  /** Provider name — becomes Quote.source, so simulated and live can never be conflated. */
  source: string;

  ltp?: number;
  lastTradedQuantity?: number;
  averageTradePrice?: number;
  volume?: number;
  totalBuyQuantity?: number;
  totalSellQuantity?: number;

  open?: number;
  high?: number;
  low?: number;
  /** Only sent post market close by Dhan; do not treat absence as zero. */
  close?: number;
  previousClose?: number;

  openInterest?: number;
  dayHighOpenInterest?: number;
  dayLowOpenInterest?: number;

  /** Best bid/ask, derived from depth level 0 when the provider sends depth. */
  bid?: number;
  ask?: number;
  /** Full L2 ladder. Realtime-only — never persisted (MARKET-DATA-ARCHITECTURE.md §3). */
  depth?: DepthLevel[];
}

export interface DepthLevel {
  bidQuantity: number;
  askQuantity: number;
  bidOrders: number;
  askOrders: number;
  bidPrice: number;
  askPrice: number;
}

/** What a feed is doing right now. Drives reconnect policy and health reporting. */
export type FeedStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped' | 'error';

export interface FeedStatusEvent {
  status: FeedStatus;
  feed: string;
  at: Date;
  /** Present on 'error' and on 'reconnecting' after a failure. */
  reason?: string;
  /** Provider disconnect code where one exists (Dhan sends these on the wire). */
  code?: number;
  attempt?: number;
}

/**
 * Feed richness. Maps onto Dhan's request codes, but is provider-neutral so the
 * simulator and future providers use the same vocabulary.
 *
 * Tiering matters for cost: a Full packet is 162 bytes/instrument/tick against
 * 16 for Ticker, so only actively-viewed instruments should be subscribed Full
 * (DHAN-MARKET-DATA-INTEGRATION.md §5, Phase 4).
 */
export type FeedMode = 'ticker' | 'quote' | 'full';

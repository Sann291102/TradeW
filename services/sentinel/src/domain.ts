/** Sentinel internal domain — signals, observations, and the observe contract. */

/** A single deterministic signal computed by an intelligence engine. */
export interface Signal {
  /** e.g. 'low_volume_breakout', 'revenge_trading', 'elevated_vix' */
  name: string;
  /** which engine produced it */
  agent: 'market-technical' | 'emotion' | 'trap-safety';
  triggered: boolean;
  /** 0..1 contribution toward the composite warning threshold */
  weight: number;
  /** human-readable evidence lines, cited in the final output */
  evidence: string[];
  /** structured values backing the evidence (for the audit trail) */
  data?: Record<string, unknown>;
}

/** Trade summary passed in by services/api (Sentinel never queries trading tables). */
export interface TradeSummary {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  fillPrice: number;
  realizedPnl?: number;
  createdAt: string; // ISO
}

export interface PositionSummary {
  symbol: string;
  quantity: number;
  avgPrice: number;
  realizedPnl: number;
}

export interface ObserveRequest {
  userId: string;
  /** primary symbol in focus (chart open / order ticket), optional */
  symbol?: string;
  /** recent trades, most recent first — supplied by services/api, read-only */
  recentTrades?: TradeSummary[];
  positions?: PositionSummary[];
  /** free-form UI context, e.g. 'order_ticket_open' */
  context?: string;
}

export interface SentinelObservationOut {
  agent: string;
  category: string;
  pattern?: string;
  symbol?: string;
  content: string;
  evidence: string[];
  confidence: number;
}

export interface ObserveResponse {
  /** the single synthesized, user-facing message (orchestrator only) — null when nothing warrants surfacing */
  synthesis: {
    content: string;
    pattern: string;
    confidence: number;
    disclaimer: string;
  } | null;
  /** individual agent observations (Observation Feed / Agent Activity Timeline) */
  observations: SentinelObservationOut[];
  /** every computed signal, triggered or not (Agent Activity Timeline transparency) */
  signals: Signal[];
}

export const SENTINEL_DISCLAIMER =
  'Sentinel shares observations and educational context only. It is not investment advice and never recommends trades.';

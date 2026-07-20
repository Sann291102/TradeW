/**
 * Shared Sentinel types + constants — used by both the full `/sentinel` page
 * (entitled experience) and the locked dock-panel teaser
 * (`terminal/panels/SentinelPanel.tsx`), so the two surfaces never drift on
 * agent labels/colors or the observation-only disclaimer. See
 * docs/product-architecture/SENTINEL.md §5.
 */

export type Synthesis = { content: string; pattern: string; confidence: number; disclaimer: string };
export type Observation = {
  agent: string;
  category: string;
  pattern?: string | null;
  symbol?: string | null;
  content: string;
  evidence: string[];
  confidence: number;
  createdAt?: string;
  surfaced?: boolean;
};
export type Signal = { name: string; agent: string; triggered: boolean; weight: number; evidence: string[] };
export type ObserveResponse = { synthesis: Synthesis | null; observations: Observation[]; signals: Signal[] };
export type SessionSummaryData = { tradesToday: number; flaggedEvents: number; realizedPnl: number };
export type JournalEntry = { id: string; mood?: string | null; content: string; flaggedByAi: boolean; createdAt: string };

export const AGENT_LABEL: Record<string, string> = {
  'market-technical': 'Market & Technical',
  emotion: 'Emotion Intelligence',
  'trap-safety': 'Trap & Safety',
  orchestrator: 'Sentinel Orchestrator',
  'compliance-audit': 'Compliance & Audit',
};

export const AGENT_COLOR: Record<string, string> = {
  'market-technical': '#14b8a6',
  emotion: '#f0a53c',
  'trap-safety': '#ef5350',
  orchestrator: '#8ea0c4',
};

/** The observation-only guardrail language — reused verbatim by the full
 *  page and the locked panel teaser (never a buy/sell instruction). */
export const OBSERVATION_ONLY_DISCLAIMER =
  'Sentinel observes market structure and your behavior in parallel — never a buy/sell instruction.';

export const pretty = (s?: string | null): string => (s ?? '').replace(/_/g, ' ');

export const DEMO: ObserveResponse = {
  synthesis: {
    content:
      'India VIX at 18.8 — elevated. 3 entries within 15 minutes of a losing exit in this session. Position sizing on the last trade was 2.3x your session average. Longest losing streak this session: 3 trades. Together these resemble a revenge trading pattern on NIFTY. This is an observation, not advice — consider waiting for confirmation before acting.',
    pattern: 'revenge_trading',
    confidence: 0.925,
    disclaimer:
      'Sentinel shares observations and educational context only. It is not investment advice and never recommends trades.',
  },
  observations: [
    { agent: 'market-technical', category: 'market_structure_observation', pattern: 'elevated_vix', symbol: 'NIFTY', content: 'India VIX at 18.8 — elevated', evidence: ['India VIX at 18.8 — elevated'], confidence: 0.7 },
    { agent: 'emotion', category: 'behavioral_pattern_observation', pattern: 'revenge_trading', symbol: 'NIFTY', content: '3 entries within 15 minutes of a losing exit in this session', evidence: [], confidence: 0.75 },
    { agent: 'emotion', category: 'behavioral_pattern_observation', pattern: 'position_sizing_drift', symbol: 'NIFTY', content: 'Position sizing on the last trade was 2.3x your session average', evidence: [], confidence: 0.7 },
    { agent: 'emotion', category: 'behavioral_pattern_observation', pattern: 'loss_streak', symbol: 'NIFTY', content: 'Longest losing streak this session: 3 trades', evidence: [], confidence: 0.7 },
  ],
  signals: [
    { name: 'elevated_vix', agent: 'market-technical', triggered: true, weight: 0.3, evidence: ['India VIX at 18.8'] },
    { name: 'revenge_trading', agent: 'emotion', triggered: true, weight: 0.35, evidence: ['3 entries within 15 min of a losing exit'] },
    { name: 'position_sizing_drift', agent: 'emotion', triggered: true, weight: 0.3, evidence: ['Last trade 2.3x session average'] },
    { name: 'loss_streak', agent: 'emotion', triggered: true, weight: 0.3, evidence: ['3 consecutive losing trades'] },
    { name: 'low_volume_breakout', agent: 'trap-safety', triggered: false, weight: 0.4, evidence: ['No breakout without participation'] },
    { name: 'bull_trap', agent: 'trap-safety', triggered: false, weight: 0.45, evidence: ['No failed breakout above resistance'] },
    { name: 'overbought_rsi', agent: 'market-technical', triggered: false, weight: 0.2, evidence: ['RSI(14) is 50.1'] },
    { name: 'weak_breadth', agent: 'market-technical', triggered: false, weight: 0.15, evidence: ['Advance/decline ratio 1.04'] },
  ],
};

export const DEMO_SUMMARY: SessionSummaryData = { tradesToday: 7, flaggedEvents: 1, realizedPnl: -10875 };
export const DEMO_JOURNAL: JournalEntry[] = [
  { id: 'demo-j1', mood: 'frustrated', content: 'Kept re-entering after stops. Sentinel flagged my pacing — taking a break.', flaggedByAi: true, createdAt: new Date().toISOString() },
];

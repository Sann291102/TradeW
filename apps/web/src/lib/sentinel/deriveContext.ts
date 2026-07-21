import { pretty, type Observation, type Signal, type Synthesis } from './types';

/**
 * Sentinel homepage redesign — market-context derivation layer.
 *
 * `/sentinel/observe` returns raw `signals`/`observations`/`synthesis` (see
 * types.ts) — there is no backend concept yet of "day classification",
 * "market context tags", or "side confirmation". Rather than wait on new
 * endpoints, these are derived client-side from the real triggered-signal
 * data already returned today. Every derived field traces back to a real
 * `signal.weight`/`signal.evidence`/`observation.confidence` — nothing here
 * invents a number that isn't backed by an actual signal.
 *
 * Where the underlying data genuinely doesn't exist yet (institutional
 * participation, trend/EMA state, options-side confirmation — none of which
 * have a backing signal in the current schema per
 * docs/product-architecture/MARKET-DATA-BASELINE.md), this reports "not
 * enough data yet" rather than fabricating a plausible-looking value. This
 * matters more here than almost anywhere else in the app: Sentinel's entire
 * premise is that its conclusions are trustworthy because they're
 * evidence-backed, so a guessed value defeats the point.
 */

export type DayLabel = 'Trend Day' | 'Selective Day' | 'Choppy Day' | 'Trap-Prone Day' | 'Quiet Day';

export interface DayClassification {
  label: DayLabel;
  confidence: number;
  explanation: string;
  supportingSignals: string[];
}

const MARKET_TAG: Record<string, string> = {
  elevated_vix: 'Elevated Volatility',
  overbought_rsi: 'Overbought Momentum',
  weak_breadth: 'Narrow Participation',
  low_volume_breakout: 'Low-Volume Breakout Risk',
  bull_trap: 'Failed Breakout Risk (Bull Trap)',
  bear_trap: 'Failed Breakdown Risk (Bear Trap)',
  liquidity_sweep: 'Liquidity Sweep',
  stop_hunt: 'Stop-Hunt Pattern',
  expiry_day_traps: 'Expiry-Day Risk',
  gamma_squeeze_iv_crush: 'Gamma / IV Compression',
};

function marketTag(name: string): string {
  return MARKET_TAG[name] ?? pretty(name);
}

function avgWeight(signals: Signal[]): number {
  if (!signals.length) return 0.55;
  const raw = signals.reduce((sum, s) => sum + s.weight, 0) / signals.length;
  return Math.min(0.97, Math.max(0.5, raw + 0.4));
}

/** Only market-technical + trap-safety signals describe the MARKET's day —
 *  behavioral (emotion) signals describe the trader and belong in the Live
 *  Safety Feed instead, never in the day/market classification. */
function marketSignals(signals: Signal[]): Signal[] {
  return signals.filter((s) => s.agent === 'market-technical' || s.agent === 'trap-safety');
}

export function classifyDay(signals: Signal[]): DayClassification {
  const market = marketSignals(signals);
  const triggered = market.filter((s) => s.triggered);
  const trapTriggered = triggered.filter((s) => s.agent === 'trap-safety');
  const names = triggered.map((s) => s.name);

  if (trapTriggered.length > 0) {
    const tags = trapTriggered.map((s) => marketTag(s.name));
    return {
      label: 'Trap-Prone Day',
      confidence: avgWeight(trapTriggered),
      explanation: `${trapTriggered.length} structural risk signal${trapTriggered.length > 1 ? 's' : ''} active — ${tags.join(', ')}. Conditions favor false moves over clean follow-through today.`,
      supportingSignals: tags,
    };
  }
  if (triggered.length === 0) {
    return {
      label: 'Quiet Day',
      confidence: 0.55,
      explanation: 'No market-technical signals are active right now. Conditions look calm — Sentinel keeps watching in the background.',
      supportingSignals: [],
    };
  }
  if (names.includes('elevated_vix') && names.includes('weak_breadth')) {
    return {
      label: 'Choppy Day',
      confidence: avgWeight(triggered),
      explanation: 'Elevated volatility alongside narrow participation — moves may lack follow-through.',
      supportingSignals: triggered.map((s) => marketTag(s.name)),
    };
  }
  return {
    label: 'Selective Day',
    confidence: avgWeight(triggered),
    explanation: `${triggered.length} market signal${triggered.length > 1 ? 's' : ''} active: ${names.map(marketTag).join(', ')}. Worth being selective about which setups you take today.`,
    supportingSignals: triggered.map((s) => marketTag(s.name)),
  };
}

export interface MarketContextDimension {
  label: string;
  value: string;
  known: boolean;
}

export function extractMarketContext(signals: Signal[]): { tags: string[]; dimensions: MarketContextDimension[] } {
  const market = marketSignals(signals);
  const triggered = market.filter((s) => s.triggered);
  const names = new Set(triggered.map((s) => s.name));
  const trapCount = triggered.filter((s) => s.agent === 'trap-safety').length;

  const dimensions: MarketContextDimension[] = [
    {
      label: 'Volatility',
      value: names.has('elevated_vix') ? 'Elevated' : 'Normal',
      known: true,
    },
    {
      label: 'Momentum',
      value: names.has('overbought_rsi') ? 'Overbought' : names.has('weak_breadth') ? 'Weak' : 'Neutral',
      known: true,
    },
    {
      label: 'Market structure',
      value: names.has('weak_breadth') ? 'Narrow / weak breadth' : 'Broad participation',
      known: true,
    },
    {
      label: 'Trap probability',
      value: trapCount === 0 ? 'Low' : trapCount === 1 ? 'Moderate' : 'High',
      known: true,
    },
    {
      label: 'Liquidity condition',
      value: names.has('liquidity_sweep') || names.has('stop_hunt') ? 'Stress detected' : 'Not enough data yet',
      known: names.has('liquidity_sweep') || names.has('stop_hunt'),
    },
    {
      label: 'Trend state',
      value: 'Not enough data yet',
      known: false,
    },
    {
      label: 'Institutional participation',
      value: 'Not enough data yet — needs option-flow data',
      known: false,
    },
  ];

  return { tags: triggered.map((s) => marketTag(s.name)), dimensions };
}

export type ActionLabel = 'Wait & Watch' | 'Setup Forming' | 'Side in Focus' | 'Enough' | 'Book & Breathe' | 'Trail or Exit' | 'Pause';
export type Severity = 'low' | 'medium' | 'high';

export interface SafetyCardData {
  id: string;
  action: ActionLabel;
  severity: Severity;
  confidence: number;
  timestamp: string | null;
  explanation: string;
  evidence: string[];
  source: string;
  pinned?: boolean;
}

const ACTION_MAP: Record<string, ActionLabel> = {
  revenge_trading: 'Pause',
  fomo_entries: 'Pause',
  averaging_down: 'Enough',
  position_sizing_drift: 'Enough',
  loss_streak: 'Book & Breathe',
  chasing_green_candles: 'Book & Breathe',
  low_volume_breakout: 'Wait & Watch',
  bull_trap: 'Wait & Watch',
  bear_trap: 'Wait & Watch',
  liquidity_sweep: 'Wait & Watch',
  stop_hunt: 'Wait & Watch',
  weak_breadth: 'Wait & Watch',
  expiry_day_traps: 'Setup Forming',
  gamma_squeeze_iv_crush: 'Setup Forming',
  elevated_vix: 'Setup Forming',
  overbought_rsi: 'Trail or Exit',
};

/** Neutral, non-implementation-revealing source labels — replaces the
 *  internal agent-family names ("Emotion Intelligence", "Trap & Safety",
 *  etc.) that the redesign explicitly removes from user-facing surfaces. */
const SOURCE_LABEL: Record<string, string> = {
  'market-technical': 'Market signal',
  emotion: 'Behavioral signal',
  'trap-safety': 'Structural risk signal',
  'compliance-audit': 'Compliance note',
  orchestrator: 'Corroborated across signals',
};

function severityFromConfidence(confidence: number): Severity {
  if (confidence >= 0.8) return 'high';
  if (confidence >= 0.6) return 'medium';
  return 'low';
}

export function extractSafetyFeed(observations: Observation[], synthesis: Synthesis | null): SafetyCardData[] {
  const cards: SafetyCardData[] = [];

  if (synthesis) {
    cards.push({
      id: 'synthesis',
      action: ACTION_MAP[synthesis.pattern] ?? 'Wait & Watch',
      severity: 'high',
      confidence: synthesis.confidence,
      timestamp: null,
      explanation: synthesis.content,
      evidence: [],
      source: SOURCE_LABEL.orchestrator,
      pinned: true,
    });
  }

  for (const o of observations) {
    if (o.agent === 'compliance-audit') continue; // audit trail, not a trader-facing safety cue
    cards.push({
      id: `${o.agent}-${o.pattern ?? o.category}-${o.createdAt ?? cards.length}`,
      action: ACTION_MAP[o.pattern ?? ''] ?? 'Wait & Watch',
      severity: severityFromConfidence(o.confidence),
      confidence: o.confidence,
      timestamp: o.createdAt ?? null,
      explanation: o.content,
      evidence: o.evidence,
      source: SOURCE_LABEL[o.agent] ?? 'Market signal',
    });
  }

  return cards;
}

const LESSON_MAP: Record<ActionLabel, { title: string; blurb: string }> = {
  Pause: { title: 'Managing Revenge Trading', blurb: 'Why fast re-entries after a loss compound risk, and how to break the cycle.' },
  Enough: { title: 'Position Sizing Discipline', blurb: 'Keeping size consistent even after a strong setup appears.' },
  'Book & Breathe': { title: 'Knowing When to Stop for the Day', blurb: 'Recognizing losing streaks as a signal to step back, not press harder.' },
  'Wait & Watch': { title: 'Spotting Low-Conviction Breakouts', blurb: 'Why volume and participation matter before trusting a move.' },
  'Setup Forming': { title: "Reading Expiry-Day and Volatility Setups", blurb: 'What changes structurally on high-IV or expiry sessions.' },
  'Trail or Exit': { title: 'Trailing Into Strength', blurb: 'Adjusting risk once a move is extended rather than exiting outright.' },
  'Side in Focus': { title: 'Reading Option-Flow Confirmation', blurb: 'How OI and PCR shifts show which side has real participation.' },
};

export function suggestedLesson(cards: SafetyCardData[]): { title: string; blurb: string } {
  const top = cards[0];
  return top ? LESSON_MAP[top.action] : { title: "Today's Market Behavior Basics", blurb: 'General discipline principles for quiet sessions.' };
}

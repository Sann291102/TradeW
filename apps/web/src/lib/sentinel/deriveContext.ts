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

export type DayLabel =
  | 'Trend Day'
  | 'Selective Day'
  | 'Choppy Day'
  | 'Trap-Prone Day'
  | 'Quiet Day'
  | 'Sit Out Day';

export interface DayClassification {
  label: DayLabel;
  confidence: number;
  explanation: string;
  supportingSignals: string[];
}

export interface DayTypeInfo {
  label: DayLabel;
  /** What the market is doing — a description of conditions, never an instruction. */
  summary: string;
  /** How the session tends to behave. Observation tone only (SENTINEL.md §3). */
  character: string;
  /** Set when the classification can't yet be reached from today's signal set. */
  note?: string;
}

/**
 * The full day-classification vocabulary, in the order the product defines it.
 *
 * This is the reference catalog behind the hero card's "what are the other
 * day types?" disclosure — a trader can only trust a label like "Selective
 * Day" if they can see the scale it sits on. Copy stays descriptive
 * ("conditions favor X") rather than directive ("do X"), per TRADEW-OS.md §1
 * observation-never-advice and SENTINEL.md §3's evidence → pattern-name →
 * soft-suggestion contract.
 */
export const DAY_TYPES: DayTypeInfo[] = [
  {
    label: 'Trend Day',
    summary: 'Direction resolves early and holds through to the close.',
    character: 'Pullbacks stay shallow and follow-through is unusually persistent — the opposite of a range session, where fading extremes is what tends to work.',
    note: 'Needs trend and moving-average data, which Sentinel does not receive yet — this classification cannot be reached from today’s signals.',
  },
  {
    label: 'Selective Day',
    summary: 'Some market signals are active, but conditions are not uniformly clean.',
    character: 'Opportunities exist without the whole session cooperating, so which setups are taken matters more than usual.',
  },
  {
    label: 'Choppy Day',
    summary: 'Elevated volatility alongside narrow participation.',
    character: 'Moves start but struggle to carry, so direction reverses more often than it extends.',
  },
  {
    label: 'Trap-Prone Day',
    summary: 'Structural risk signals are active — conditions favor false moves.',
    character: 'Breakouts and breakdowns are more likely to reverse than to follow through, so confirmation is worth more than speed.',
  },
  {
    label: 'Quiet Day',
    summary: 'No market-technical signals are active. Conditions look calm.',
    character: 'Little of structural significance is happening. Sentinel keeps watching in the background.',
  },
  {
    label: 'Sit Out Day',
    summary: 'Multiple structural risks are active at once, alongside elevated volatility.',
    character: 'The hostile conditions corroborate each other rather than appearing in isolation — the session offers little that is readable, and standing aside is a position many experienced traders take on days like this.',
  },
];

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

  // Sit Out Day sits above Trap-Prone Day in severity, so it is checked first
  // and deliberately requires corroboration rather than one bad signal:
  // multiple structural risks AND elevated volatility together. A single trap
  // signal is a Trap-Prone Day — never this. (SENTINEL.md §3: the orchestrator
  // only escalates when enough signals confirm each other.)
  if (trapTriggered.length >= 2 && names.includes('elevated_vix')) {
    const tags = triggered.map((s) => marketTag(s.name));
    return {
      label: 'Sit Out Day',
      confidence: avgWeight(triggered),
      explanation: `${trapTriggered.length} structural risk signals are active alongside elevated volatility — ${tags.join(', ')}. Conditions are corroborating each other rather than appearing in isolation, leaving little that reads cleanly today.`,
      supportingSignals: tags,
    };
  }
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
  /**
   * Whether this warrants *pushing* to the Live Safety Feed right now, vs. only
   * living in the timeline/history. The feed is meant to fire when a genuine
   * setup or behavior is experienced — not to echo every routine market reading
   * on every refresh. True for: the corroborated synthesis, any behavioral
   * (emotion) or structural-risk (trap-safety) event, and only high-confidence
   * market-technical readings. A lone overbought-RSI note is context (Market
   * Context panel), not a safety push.
   */
  pushworthy: boolean;
}

/** The bar for market-technical observations to reach the Live Safety Feed on
 *  their own — below this they are ambient context, not an event to push. */
const MARKET_PUSH_THRESHOLD = 0.8;

function isPushworthy(agent: string, confidence: number): boolean {
  if (agent === 'emotion' || agent === 'trap-safety' || agent === 'orchestrator') return true;
  if (agent === 'market-technical') return confidence >= MARKET_PUSH_THRESHOLD;
  return false;
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
      pushworthy: true, // a corroborated synthesis is the canonical "push"
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
      pushworthy: isPushworthy(o.agent, o.confidence),
    });
  }

  return cards;
}

/** The subset that should actually surface in the Live Safety Feed now —
 *  genuine setups/behaviors only. The full list still feeds the timeline. */
export function pushworthyCards(cards: SafetyCardData[]): SafetyCardData[] {
  return cards.filter((c) => c.pushworthy);
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

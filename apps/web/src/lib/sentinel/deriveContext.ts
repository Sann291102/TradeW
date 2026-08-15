import {
  pretty,
  type ConfidenceBreakdown,
  type MarketProfile,
  type MarketProfileType,
  type Observation,
  type SideInFocus,
  type Signal,
  type Synthesis,
} from './types';

/**
 * Sentinel — market-context presentation layer.
 *
 * This file used to *derive* the day classification and market context from
 * raw signals, because the backend had no concept of either. That is no
 * longer true: the Market Intelligence Engine now classifies the session into
 * one of ten market profiles and the Confidence Engine publishes a scored,
 * weighted figure (SENTINEL_MASTER_PLAN.md §4 Modules 1 and 7), both of which
 * arrive on the `/observe` response.
 *
 * So the server's reading is authoritative whenever it is present, and this
 * layer only maps it into the page's vocabulary. The signal-derived path is
 * retained solely as the fallback for demo mode and for a response that
 * predates those fields — it is no longer a second opinion competing with the
 * engine.
 *
 * One rule survives from the original design and still governs both paths:
 * where the underlying data genuinely does not exist, report "not enough data
 * yet" rather than fabricate a plausible-looking value. Sentinel's whole
 * premise is that its conclusions are trustworthy because they are
 * evidence-backed, so a guessed value defeats the point.
 */

export type DayLabel =
  | 'Trend Day'
  | 'Selective Day'
  | 'Choppy Day'
  | 'Trap-Prone Day'
  | 'Quiet Day'
  | 'Sit Out Day'
  | 'Low Confidence';

/** The floor every Sentinel-facing confidence figure must clear before it
 *  drives what's shown or pushed — the hero classification, the Live Safety
 *  Feed. Below this, Sentinel says so explicitly rather than asserting a
 *  specific read it can't back. */
export const SENTINEL_CONFIDENCE_FLOOR = 70;

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
  {
    label: 'Low Confidence',
    summary: `Sentinel's read on today's session scored below the ${SENTINEL_CONFIDENCE_FLOOR}% bar it holds every classification to.`,
    character: 'Rather than assert a specific day type it can’t back with enough evidence, Sentinel names what it was leaning toward and why that fell short — see "Why?" below.',
    note: 'Shown whenever the underlying confidence score does not clear the bar, regardless of which day type scored highest.',
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

/**
 * Market Intelligence Engine profile → the page's day vocabulary.
 * A ten-way structural classification collapses into the six labels the hero
 * card speaks; the profile's own name and description are carried through in
 * the explanation so nothing is lost in the mapping.
 */
const PROFILE_TO_DAY: Record<MarketProfileType, DayLabel> = {
  'Bullish Trend Day': 'Trend Day',
  'Bearish Trend Day': 'Trend Day',
  'Gap & Go': 'Trend Day',
  'Rally Continuation': 'Selective Day',
  'Descent Continuation': 'Selective Day',
  'Gap Fill / Mean Reversion': 'Selective Day',
  'High Volatility Range': 'Choppy Day',
  'Outside Day / Expansion': 'Choppy Day',
  'Low Volatility Compression': 'Quiet Day',
  'Inside Day': 'Quiet Day',
};

/**
 * Public entry point — wraps `classifyDayRaw` with the confidence floor
 * every Sentinel-facing read must clear (SENTINEL_CONFIDENCE_FLOOR). Applied
 * here rather than inside each branch of `classifyDayRaw` because only the
 * server-driven profile branch carries a real, comparable confidence score;
 * the signal-derived fallback branches compute their own local `avgWeight`
 * on a different 0..1 scale that isn't the same claim being gated. When the
 * server sent a real confidence breakdown and it falls short, the specific
 * day type is demoted to 'Low Confidence' regardless of which branch
 * produced it — the raw label survives only inside the explanation, as
 * context for what Sentinel was leaning toward.
 */
export function classifyDay(
  signals: Signal[],
  profile?: MarketProfile | null,
  confidence?: ConfidenceBreakdown,
): DayClassification {
  const raw = classifyDayRaw(signals, profile, confidence);
  if (confidence && confidence.score < SENTINEL_CONFIDENCE_FLOOR) {
    return {
      label: 'Low Confidence',
      confidence: confidence.score / 100,
      explanation:
        `Sentinel was leaning toward ${raw.label} (${confidence.score}% confidence against the ${SENTINEL_CONFIDENCE_FLOOR}% bar every classification is held to), ` +
        `but that falls short of a call Sentinel will stand behind. ${raw.explanation}`,
      supportingSignals: raw.supportingSignals,
    };
  }
  return raw;
}

function classifyDayRaw(
  signals: Signal[],
  profile?: MarketProfile | null,
  confidence?: ConfidenceBreakdown,
): DayClassification {
  const market = marketSignals(signals);
  const triggered = market.filter((s) => s.triggered);
  const trapTriggered = triggered.filter((s) => s.agent === 'trap-safety');
  const names = triggered.map((s) => s.name);

  // Structural risk still outranks the structural profile: a session can be a
  // textbook trend day and still be one where breakouts are failing. Those
  // two escalations are checked first, exactly as before.
  const severeRisk = trapTriggered.length >= 2 && names.includes('elevated_vix');

  if (profile && !severeRisk && trapTriggered.length === 0) {
    const tags = [profile.type, ...triggered.map((s) => marketTag(s.name))];
    return {
      label: PROFILE_TO_DAY[profile.type],
      confidence: confidence ? confidence.score / 100 : avgWeight(triggered),
      explanation:
        `${profile.type}: ${profile.description.toLowerCase()}. ${profile.evidence.join('. ')}.` +
        (confidence ? ` Sentinel scores this at ${confidence.score}% confidence against a ${confidence.threshold}% threshold.` : ''),
      supportingSignals: tags,
    };
  }

  // Sit Out Day sits above Trap-Prone Day in severity, so it is checked first
  // and deliberately requires corroboration rather than one bad signal:
  // multiple structural risks AND elevated volatility together. A single trap
  // signal is a Trap-Prone Day — never this. (SENTINEL.md §3: the orchestrator
  // only escalates when enough signals confirm each other.)
  if (severeRisk) {
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

const STRUCTURE_LABEL: Record<MarketProfile['structure'], string> = {
  trending: 'Trending',
  ranging: 'Range-bound',
  consolidating: 'Consolidating',
  'breaking-out': 'Breaking out',
};

export function extractMarketContext(
  signals: Signal[],
  context?: { profile?: MarketProfile | null; confidence?: ConfidenceBreakdown; risk?: { level: string } },
): { tags: string[]; dimensions: MarketContextDimension[] } {
  const market = marketSignals(signals);
  const triggered = market.filter((s) => s.triggered);
  const names = new Set(triggered.map((s) => s.name));
  const trapCount = triggered.filter((s) => s.agent === 'trap-safety').length;
  const profile = context?.profile ?? null;

  // Trend state and institutional participation used to read "not enough data
  // yet" because nothing computed them. The Market Intelligence Engine now
  // classifies structure, and the Confidence Engine's option-chain factor
  // reports real front-expiry PCR and max pain, so both are answerable —
  // but only when the response actually carries them.
  const optionFactor = context?.confidence?.factors.find((f) => f.name === 'option_chain_pcr_support');
  const optionKnown = !!optionFactor && optionFactor.evidence.some((e) => e.startsWith('Put-Call OI ratio'));
  const liquiditySignal = names.has('liquidity_sweep') || names.has('stop_hunt');
  const thinParticipation = names.has('below_average_participation');

  const dimensions: MarketContextDimension[] = [
    {
      label: 'Volatility',
      value: profile
        ? `${profile.volatility === 'high' ? 'Elevated' : profile.volatility === 'low' ? 'Compressed' : 'Normal'}${names.has('elevated_vix') ? ' · VIX elevated' : ''}`
        : names.has('elevated_vix')
          ? 'Elevated'
          : 'Normal',
      known: true,
    },
    {
      label: 'Momentum',
      value: names.has('overbought_rsi') ? 'Overbought' : names.has('weak_breadth') ? 'Weak' : 'Neutral',
      known: true,
    },
    {
      label: 'Market structure',
      value: profile
        ? `${STRUCTURE_LABEL[profile.structure]} — ${profile.type}`
        : names.has('weak_breadth')
          ? 'Narrow / weak breadth'
          : 'Broad participation',
      known: true,
    },
    {
      label: 'Trap probability',
      value: trapCount === 0 ? 'Low' : trapCount === 1 ? 'Moderate' : 'High',
      known: true,
    },
    {
      label: 'Liquidity condition',
      value: liquiditySignal
        ? 'Stress detected'
        : thinParticipation
          ? 'Thin participation'
          : profile
            ? 'No participation stress detected'
            : 'Not enough data yet',
      known: liquiditySignal || thinParticipation || !!profile,
    },
    {
      label: 'Trend state',
      value: profile ? `${profile.trend === 'choppy' ? 'Choppy / two-sided' : capitalise(profile.trend)}` : 'Not enough data yet',
      known: !!profile,
    },
    {
      label: 'Institutional participation',
      value: optionKnown
        ? optionFactor!.evidence.filter((e) => e.startsWith('Put-Call') || e.startsWith('Max pain')).join(' · ')
        : 'Not enough data yet — this instrument publishes no option chain',
      known: optionKnown,
    },
  ];

  const tags = [...(profile ? [profile.type] : []), ...triggered.map((s) => marketTag(s.name))];
  return { tags, dimensions };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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
   * The contract side this card is actually about, or absent when it is about
   * no side at all.
   *
   * Load-bearing: the "Side in Focus" ActionLabel is reached by two unrelated
   * routes. One is the genuine directional read from `sideInFocus` (which
   * resolves CE/PE from its own bias and is the only thing that ever knows a
   * side). The other is a bare pattern detection — `cpr_breakout_bounce`,
   * `orb_retest`, `vwap_pullback`, `ema_cross_bounce` all map to the same
   * label via ACTION_MAP and carry **no side whatsoever**.
   *
   * This used to be recovered in the view by substring-matching the
   * explanation for 'CE'/'PE', which failed both ways: a bearish CPR
   * breakdown matched neither and fell through to a bullish "CE CALL" badge,
   * while any incidental uppercase 'PE' (as in "OPEN range") forced "PE PUT".
   * Carrying the side as data means a card that has no side renders no side.
   */
  side?: 'CE' | 'PE';
  bias?: 'bullish' | 'bearish';
  /**
   * Whether this warrants *pushing* to the Live Safety Feed right now, vs. only
   * living in the timeline/history. The feed is meant to fire when a genuine
   * setup or behavior is experienced — not to echo every routine market reading
   * on every refresh, AND every card the feed pushes must clear
   * SENTINEL_CONFIDENCE_FLOOR, same as the hero classification. Reversed
   * 2026-08-05: emotion/trap-safety/risk/orchestrator observations used to
   * bypass any confidence check on the theory that "the agent only fires once
   * something's elevated" made the number moot — in practice that let a 45%
   * "Book & Breathe" push with the same visual weight as a well-corroborated
   * one, which is exactly the "confident-looking low-confidence result" this
   * threshold exists to prevent. A lone overbought-RSI note below the bar is
   * context (Market Context panel), not a safety push, same as before.
   */
  pushworthy: boolean;
}

/** Market-technical/strategy readings need to clear this before reaching the
 *  feed on their own — deliberately above SENTINEL_CONFIDENCE_FLOOR (a
 *  routine indicator crossing a level is weaker evidence than a corroborated
 *  behavioral or structural-risk event, so it earns a higher bar, not a
 *  lower one). Every other agent uses SENTINEL_CONFIDENCE_FLOOR directly. */
const MARKET_PUSH_THRESHOLD = 0.8;

function isPushworthy(agent: string, confidence: number): boolean {
  if (agent === 'strategy' || agent === 'market-technical') return confidence >= MARKET_PUSH_THRESHOLD;
  return confidence >= SENTINEL_CONFIDENCE_FLOOR / 100;
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
  // Strategy Engine (Master Plan Module 2) — a confirmed setup is the one
  // case the page can honestly call a side.
  orb_retest: 'Side in Focus',
  cpr_breakout_bounce: 'Side in Focus',
  vwap_pullback: 'Side in Focus',
  ema_cross_bounce: 'Side in Focus',
  liquidity_sweep_strategy: 'Wait & Watch',
  fake_breakout: 'Wait & Watch',
  ict_smart_money: 'Setup Forming',
  wyckoff_spring_upthrust: 'Setup Forming',
  // Risk Intelligence (Module 6) — every elevated factor is a reason to slow down.
  elevated_market_risk: 'Wait & Watch',
  elevated_trade_risk: 'Wait & Watch',
  elevated_position_risk: 'Enough',
  elevated_volatility_risk: 'Setup Forming',
  elevated_news_risk: 'Wait & Watch',
  elevated_emotional_risk: 'Pause',
  elevated_liquidity_risk: 'Wait & Watch',
  elevated_time_risk: 'Book & Breathe',
};

/** Neutral, non-implementation-revealing source labels — replaces the
 *  internal agent-family names ("Emotion Intelligence", "Trap & Safety",
 *  etc.) that the redesign explicitly removes from user-facing surfaces. */
const SOURCE_LABEL: Record<string, string> = {
  'market-technical': 'Market signal',
  emotion: 'Behavioral signal',
  'trap-safety': 'Structural risk signal',
  strategy: 'Strategy rule match',
  risk: 'Risk factor',
  'compliance-audit': 'Compliance note',
  orchestrator: 'Corroborated across signals',
};

function severityFromConfidence(confidence: number): Severity {
  if (confidence >= 0.8) return 'high';
  if (confidence >= 0.6) return 'medium';
  return 'low';
}

export function extractSafetyFeed(
  observations: Observation[],
  synthesis: Synthesis | null,
  sideInFocus?: SideInFocus | null,
): SafetyCardData[] {
  const cards: SafetyCardData[] = [];

  if (sideInFocus && sideInFocus.confidence >= 70) {
    const contractTitle = `NIFTY ${sideInFocus.strike ?? 24550} ${sideInFocus.side}`;
    const validationNote = sideInFocus.liveValidation?.label ? ` · ${sideInFocus.liveValidation.label}` : '';
    cards.push({
      id: `side-in-focus-${sideInFocus.side}-${sideInFocus.strike}`,
      action: 'Side in Focus',
      severity: sideInFocus.bias === 'bullish' ? 'low' : 'high',
      confidence: sideInFocus.confidence / 100,
      timestamp: null,
      explanation: `${contractTitle} — ${sideInFocus.bias === 'bullish' ? 'Bullish' : 'Bearish'} confirmation active${validationNote}`,
      evidence: [
        `Contract: ${contractTitle}`,
        ...(sideInFocus.liveValidation ? [sideInFocus.liveValidation.label] : []),
        ...sideInFocus.rationale,
      ],
      source: 'Strategy Engine',
      pinned: true,
      // The one card that genuinely knows a side.
      side: sideInFocus.side,
      bias: sideInFocus.bias,
      pushworthy: true,
    });
  }

  // The synthesis is an LLM rewrite of evidence the observations already
  // carry, so when it restates a pattern that is itself in the feed the user
  // reads the same signal twice — once as the terse evidence line and once as
  // a padded "evidence -> pattern -> soft suggestion" paragraph. The
  // observation is the one that survives: it is the measurement, and the
  // rewrite is where the tutor voice enters.
  const observedPatterns = new Set(
    observations.filter((o) => o.agent !== 'compliance-audit').map((o) => o.pattern).filter(Boolean),
  );

  if (synthesis && !observedPatterns.has(synthesis.pattern)) {
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
      // Even the corroborated synthesis has to clear the same bar as
      // everything else now — SentinelOrchestratorService's own composite
      // gate requires compositeWeight >= 0.7 to create this card at all, but
      // the DISPLAYED confidence it derives (compositeWeight/2 + 0.3) can
      // read as low as 65% right at that gate. "Corroborated" describes how
      // the number was built, not a reason to exempt it from the number.
      pushworthy: synthesis.confidence >= SENTINEL_CONFIDENCE_FLOOR / 100,
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

/**
 * The CE/PE badge a card is entitled to show, or null for no badge.
 *
 * Deliberately a pure function here rather than a few ternaries inside
 * `SafetyCard`. Whether a card may claim a direction is a data question, and
 * keeping it in the view is what allowed the original defect: the badge was
 * derived by `explanation.includes('PE')`, so a card with no side at all still
 * rendered one — always "CE CALL", because that was the fallback branch — and
 * a bearish detection therefore displayed a bullish badge over bullish
 * styling. Expressed here it is testable in the node-environment suite,
 * without pulling component rendering into a config that documents that it
 * must not collect component tests.
 */
export function contractBadge(card: SafetyCardData): { side: 'CE' | 'PE'; label: string; tone: 'up' | 'down' } | null {
  if (card.side === 'CE') return { side: 'CE', label: 'CE CALL', tone: 'up' };
  if (card.side === 'PE') return { side: 'PE', label: 'PE PUT', tone: 'down' };
  return null;
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

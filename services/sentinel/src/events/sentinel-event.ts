import type {
  ConfidenceBreakdown,
  MarketStateValue,
  ObserveResponse,
  RiskAssessment,
  SentinelEvent,
  StateTransition,
} from '../domain';

export type { SentinelEvent, SentinelEventKind, SentinelEventSeverity } from '../domain';

/**
 * The validated Sentinel event contract — the ONE shape that leaves this
 * service for any delivery channel (in-app notification, email, push).
 *
 * ## Why a separate contract rather than notifying from `ObserveResponse`
 *
 * `ObserveResponse` is a *dashboard* payload: it carries `sideInFocus`,
 * `institutionalCrossValidation`, per-strategy lifecycles and the full
 * publication record, because a trader looking at the workspace is entitled
 * to all of it in context. A notification has no context — it arrives on a
 * lock screen, in a mail client, next to a bell icon, stripped of the page
 * that explains it. Handing the raw response to a dispatcher and letting each
 * channel decide what to say is how a directional field ends up in a push
 * notification.
 *
 * So the gate produces events, and the events are what travels.
 *
 * ## The safety boundary (Rule 2, and the reason this file exists)
 *
 * A `SentinelEvent` structurally **cannot carry a direction**. There is no
 * `side`, no `bias`, no `strike`, no `direction` field on it, and
 * `deriveSentinelEvents` never reads `sideInFocus` — not "reads it and
 * suppresses it", never receives it at all. This is deliberate and load-
 * bearing: `Gotchas/2026-08-11 - Sentinel feed fabricated a CE direction on
 * signals that had none` records four stacked defects that each ended in a
 * bullish badge on bearish evidence, and every one of them was a *derivation*
 * recovering a side from something that did not carry one. A field that does
 * not exist cannot be defaulted to CE.
 *
 * What an event says instead is that Sentinel's state changed and why, and
 * that the workspace now holds a read worth looking at. The gated detail
 * stays on the page where the evidence sits beside it. This is a smaller
 * claim than a trade alert makes, and it is the claim Sentinel is actually
 * licensed to make — observation and education, never Buy/Sell/Entry/Target
 * (ARCHITECTURE.md, Rule 2).
 *
 * ## Prose is reused, never re-composed
 *
 * For the two kinds that carry a synthesized read, `body` is the synthesis
 * content verbatim. That text has already been through the vocabulary
 * enforcer; composing fresh prose here would route around it and give the
 * notification channel its own unreviewed voice.
 */

/**
 * ## On `dedupeKey`
 *
 * It shares its vocabulary with `MarketTimelineEngine`'s `dedupeKey`
 * (`guidance:…`, `risk:…`) on purpose: the timeline and the notification feed
 * are two renderings of one session, and two dedupe schemes would let a repeat
 * be a duplicate on the narrative and a fresh event in the inbox.
 *
 * The *window* differs by design — the timeline dedupes in memory over recent
 * entries, the dispatcher dedupes durably per user/symbol/trading day. An
 * in-memory window is not sufficient once a notification is a row a user can
 * come back to: this service restarts, and it is one singleton serving every
 * trader.
 */

/** Emotional-risk factor score at or above this surfaces an event. */
export const EMOTIONAL_RISK_THRESHOLD = 65;

/** Composite risk at or above this is a top-band safety warning. */
export const SAFETY_WARNING_THRESHOLD = 75;

/**
 * States worth waking someone for.
 *
 * Deliberately narrower than the gate's `GUIDANCE_STATES`: `WAIT_AND_WATCH`
 * and the early analysis states are where Sentinel spends most of a session,
 * so notifying on them would make the channel a heartbeat. A notification
 * earns its interruption by being unusual.
 */
const NOTIFIABLE_STATES: MarketStateValue[] = [
  'SIDE_IN_FOCUS',
  'OPPORTUNITY_ACTIVE',
  'MOVE_DEVELOPING',
  'MOMENTUM_WEAKENING',
  'MOVE_COMPLETE',
];

export interface DeriveEventsInput {
  symbol: string;
  at: Date;
  state: MarketStateValue;
  /** the transition made on THIS observation, if any */
  transition: StateTransition | null;
  /** whether the four-condition gate published */
  published: boolean;
  /** the surfaced read, when there was one */
  synthesis: ObserveResponse['synthesis'];
  risk: RiskAssessment;
  confidence: ConfidenceBreakdown;
}

/**
 * Pure derivation: observation state in, events out. No I/O, no clock, no
 * randomness — so the safety properties above are assertable in a unit test
 * rather than argued for in a comment. (The gotcha note this file guards
 * against stayed invisible precisely because its rule lived in JSX and had
 * no test; a rule that cannot be tested is a rule that can silently revert.)
 */
export function deriveSentinelEvents(input: DeriveEventsInput): SentinelEvent[] {
  const { symbol, at, state, transition, published, synthesis, risk, confidence } = input;
  const iso = at.toISOString();
  const events: SentinelEvent[] = [];

  // --- a read cleared all four conditions -------------------------------
  if (published && synthesis) {
    events.push({
      kind: 'guidance-published',
      severity: 'info',
      title: `${symbol} — ${synthesis.status}`,
      body: synthesis.content,
      symbol,
      dedupeKey: `guidance:${state}:${synthesis.status}`,
      at: iso,
      confidence: confidence.score,
      state,
    });
  }

  // --- a corroborated behavioural / trap warning ------------------------
  // The composite-risk path surfaces a synthesis WITHOUT the publication gate
  // clearing — that asymmetry is intentional upstream (a revenge-trading
  // pattern matters whether or not a technical setup confirmed), so the
  // absence of `published` here is the signal, not a bug.
  if (!published && synthesis) {
    events.push({
      kind: 'risk-elevated',
      severity: 'warning',
      title: `${symbol} — risk awareness`,
      body: synthesis.content,
      symbol,
      dedupeKey: `risk:${synthesis.pattern}`,
      at: iso,
      confidence: Math.round(synthesis.confidence * 100),
      state,
    });
  }

  // --- emotional risk ----------------------------------------------------
  // Banded rather than thresholded: a raw `>= 65` re-fires on every poll while
  // the score jitters around the line, and a user who dismissed it at 66 does
  // not want it again at 67. The band means the next notification requires a
  // genuine 10-point deterioration.
  const emotional = risk.factors.find((f) => f.name === 'emotional_risk');
  if (emotional && emotional.score >= EMOTIONAL_RISK_THRESHOLD) {
    const band = Math.floor(emotional.score / 10) * 10;
    events.push({
      kind: 'emotional-risk',
      severity: emotional.score >= 80 ? 'critical' : 'warning',
      title: 'Trading behaviour worth pausing on',
      body:
        emotional.evidence[0] ??
        `Sentinel is reading elevated emotional risk (${Math.round(emotional.score)}/100) in how today's session is being traded.`,
      symbol,
      dedupeKey: `emotion:${band}`,
      at: iso,
      confidence: null,
      state,
    });
  }

  // --- top-band composite risk ------------------------------------------
  // Independent of the composite-risk *synthesis* above: that one needs two
  // corroborating signals to compose a warning, this one is the risk engine's
  // own weighted score reaching the top band. Both can hold at once, and they
  // dedupe separately because they are answering different questions.
  if (risk.overallRisk >= SAFETY_WARNING_THRESHOLD) {
    events.push({
      kind: 'safety-warning',
      severity: 'critical',
      title: `${symbol} — composite risk ${risk.level.replace(/_/g, ' ')}`,
      body: `Sentinel's composite risk score is ${Math.round(risk.overallRisk)}/100 across ${risk.factors.length} factors.`,
      symbol,
      dedupeKey: `safety:${risk.level}`,
      at: iso,
      confidence: null,
      state,
    });
  }

  // --- state transition --------------------------------------------------
  // Emitted last and only into a notifiable state. Carries the machine's own
  // `trigger` string, which is written as an observation by construction —
  // see `StateTransition.trigger` in domain.ts.
  if (transition && NOTIFIABLE_STATES.includes(transition.to)) {
    events.push({
      kind: 'state-transition',
      severity: 'info',
      title: `${symbol} — ${humanState(transition.to)}`,
      body: transition.trigger,
      symbol,
      dedupeKey: `state:${transition.to}`,
      at: iso,
      confidence: confidence.score,
      state,
    });
  }

  return events;
}

function humanState(state: MarketStateValue): string {
  return state
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

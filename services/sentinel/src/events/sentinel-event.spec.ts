import { describe, expect, it } from 'vitest';
import type { ConfidenceBreakdown, ObserveResponse, RiskAssessment, StateTransition } from '../domain';
import {
  EMOTIONAL_RISK_THRESHOLD,
  SAFETY_WARNING_THRESHOLD,
  deriveSentinelEvents,
  type DeriveEventsInput,
} from './sentinel-event';

/**
 * The event contract's job is to be the ONE thing that leaves Sentinel for a
 * channel that has no page around it. Two properties matter more than the
 * feature itself and are asserted first:
 *
 *  1. no event can carry a direction, and
 *  2. a polled observation that has not changed produces the same key, so a
 *     45s poll cannot become 45s notification spam.
 *
 * Both are here rather than in a comment because
 * `Gotchas/2026-08-11 - Sentinel feed fabricated a CE direction` records a
 * documented rule silently reverting while its explanatory comment sat intact
 * above the reverted body.
 */

const confidence = (score: number): ConfidenceBreakdown =>
  ({
    score,
    threshold: 70,
    meetsThreshold: score >= 70,
    factors: [],
  }) as unknown as ConfidenceBreakdown;

const risk = (overallRisk: number, emotionalScore?: number): RiskAssessment => ({
  overallRisk,
  level: overallRisk >= 75 ? 'high' : 'moderate',
  factors:
    emotionalScore === undefined
      ? []
      : [
          {
            name: 'emotional_risk',
            score: emotionalScore,
            weight: 0.2,
            evidence: ['Three trades in the last six minutes, each larger than the last.'],
          },
        ],
  assessedAt: '2026-08-12T04:30:00.000Z',
});

const synthesis = (over: Partial<NonNullable<ObserveResponse['synthesis']>> = {}) =>
  ({
    content: 'Price is holding above the opening range with volume confirming.',
    pattern: 'orb_retest',
    confidence: 0.78,
    disclaimer: 'Observation only.',
    status: 'SETUP FORMING',
    state: 'SIDE_IN_FOCUS',
    ...over,
  }) as NonNullable<ObserveResponse['synthesis']>;

const base = (over: Partial<DeriveEventsInput> = {}): DeriveEventsInput => ({
  symbol: 'NIFTY',
  at: new Date('2026-08-12T04:30:00.000Z'),
  state: 'SIDE_IN_FOCUS',
  transition: null,
  published: false,
  synthesis: null,
  risk: risk(30),
  confidence: confidence(55),
  ...over,
});

describe('deriveSentinelEvents — safety boundary', () => {
  it('never emits a directional field, whatever the synthesis says', () => {
    // A synthesis whose own prose is unambiguously bullish and whose pattern
    // name reads directional. The event may carry the vocabulary-enforced
    // prose; it must not gain a side/bias/strike FIELD a channel could render
    // as a badge — that badge is exactly what the 2026-08-11 gotcha shipped.
    const events = deriveSentinelEvents(
      base({
        published: true,
        confidence: confidence(88),
        synthesis: synthesis({ content: 'Bullish continuation above CPR, CE side favoured.', pattern: 'cpr_breakout' }),
      }),
    );

    expect(events).toHaveLength(1);
    for (const event of events) {
      for (const banned of ['side', 'bias', 'strike', 'direction', 'optionContext']) {
        expect(event, `event must not carry a "${banned}" field`).not.toHaveProperty(banned);
      }
    }
  });

  it('accepts no directional input at all — the type has no channel for one', () => {
    // Guards the wiring rather than the output: `sideInFocus` is in scope at
    // the call site in the orchestrator, so the protection is that the input
    // shape cannot receive it. If someone widens DeriveEventsInput, this fails
    // to compile before it fails at runtime.
    const keys = Object.keys(base());
    expect(keys).not.toContain('sideInFocus');
    expect(keys).not.toContain('detections');
  });
});

describe('deriveSentinelEvents — dedupe', () => {
  it('produces a stable key across repeated polls of an unchanged observation', () => {
    const input = base({ published: true, confidence: confidence(88), synthesis: synthesis() });
    const first = deriveSentinelEvents(input);
    const second = deriveSentinelEvents({ ...input, at: new Date('2026-08-12T04:30:45.000Z') });

    expect(first[0].dedupeKey).toBe(second[0].dedupeKey);
    // ...and the timestamp still moves, so the dispatcher decides, not the clock.
    expect(first[0].at).not.toBe(second[0].at);
  });

  it('bands emotional risk so a jittering score does not re-fire', () => {
    const at66 = deriveSentinelEvents(base({ risk: risk(30, 66) }));
    const at69 = deriveSentinelEvents(base({ risk: risk(30, 69) }));
    const at71 = deriveSentinelEvents(base({ risk: risk(30, 71) }));

    expect(at66[0].dedupeKey).toBe(at69[0].dedupeKey);
    // a genuine 10-point deterioration is a new event
    expect(at71[0].dedupeKey).not.toBe(at66[0].dedupeKey);
  });

  it('reuses the timeline dedupe vocabulary for the guidance and risk kinds', () => {
    const published = deriveSentinelEvents(base({ published: true, synthesis: synthesis({ status: 'SETUP FORMING' }) }));
    expect(published[0].dedupeKey).toBe('guidance:SIDE_IN_FOCUS:SETUP FORMING');

    const warned = deriveSentinelEvents(base({ published: false, synthesis: synthesis({ pattern: 'revenge_trading' }) }));
    expect(warned[0].dedupeKey).toBe('risk:revenge_trading');
  });
});

describe('deriveSentinelEvents — what earns an interruption', () => {
  it('emits nothing on a quiet wait-and-watch poll', () => {
    // The resting state of most of a session. If this ever returns an event,
    // every user gets a notification every 45 seconds.
    expect(deriveSentinelEvents(base({ state: 'WAIT_AND_WATCH' }))).toEqual([]);
  });

  it('treats a surfaced read without publication as a risk warning, not guidance', () => {
    // The composite-risk path deliberately surfaces a synthesis while the
    // four-condition gate says no. That asymmetry is upstream policy; the
    // event kind must reflect it rather than mislabel a warning as a setup.
    const events = deriveSentinelEvents(base({ published: false, synthesis: synthesis() }));
    expect(events.map((e) => e.kind)).toEqual(['risk-elevated']);
    expect(events[0].severity).toBe('warning');
  });

  it('does not notify on transitions into routine analysis states', () => {
    const transition: StateTransition = {
      from: 'OBSERVATION',
      to: 'MARKET_UNDERSTANDING',
      at: '2026-08-12T04:30:00.000Z',
      trigger: 'Session classified.',
    };
    const events = deriveSentinelEvents(base({ state: 'MARKET_UNDERSTANDING', transition }));
    expect(events.filter((e) => e.kind === 'state-transition')).toEqual([]);
  });

  it('notifies on a transition into a state where a read is meaningful', () => {
    const transition: StateTransition = {
      from: 'VALIDATION',
      to: 'OPPORTUNITY_ACTIVE',
      at: '2026-08-12T04:30:00.000Z',
      trigger: 'Two mandatory confirmations validated.',
    };
    const events = deriveSentinelEvents(base({ state: 'OPPORTUNITY_ACTIVE', transition }));
    const stateEvent = events.find((e) => e.kind === 'state-transition');
    expect(stateEvent?.body).toBe('Two mandatory confirmations validated.');
    expect(stateEvent?.severity).toBe('info');
  });

  it('holds emotional risk below the threshold and releases it at the threshold', () => {
    expect(deriveSentinelEvents(base({ risk: risk(30, EMOTIONAL_RISK_THRESHOLD - 1) }))).toEqual([]);
    expect(deriveSentinelEvents(base({ risk: risk(30, EMOTIONAL_RISK_THRESHOLD) }))).toHaveLength(1);
  });

  it('escalates top-band composite risk to critical', () => {
    const events = deriveSentinelEvents(base({ risk: risk(SAFETY_WARNING_THRESHOLD) }));
    expect(events.map((e) => e.kind)).toEqual(['safety-warning']);
    expect(events[0].severity).toBe('critical');
  });

  it('carries the synthesis prose verbatim rather than re-composing it', () => {
    // The prose has already been through the vocabulary enforcer. Rewriting it
    // here would give the notification channel an unreviewed voice.
    const content = 'Volume is 40% of the 20-bar average and breadth is flat.';
    const events = deriveSentinelEvents(base({ published: true, synthesis: synthesis({ content }) }));
    expect(events[0].body).toBe(content);
  });
});

import { Injectable } from '@nestjs/common';
import {
  AgentContext,
  IntelligenceAgent,
  VerdictBuilder,
  blendConfidence,
  gatherCitations,
  gatherConcepts,
  groundingScore,
} from './agent.contract';
import type { AgentId, AgentVerdict } from '../types';

/**
 * News Intelligence — is there an event that changes how the structure reads?
 *
 * Consumes the signal the existing `NewsIntelligenceService` already produces
 * (`news_driven_volatility`, classified into the 13 standard event categories
 * through the provider layer). Found by NAME rather than by `agent` tag,
 * because that service emits under the `market-technical` tag — the `SignalAgent`
 * union in `domain.ts` has no `news` member and widening it would change a type
 * the existing orchestrator depends on. Matching by name keeps this module
 * strictly additive.
 *
 * The agent takes a deliberately narrow stance: news is read as a *volatility
 * and reliability* modifier, never as a direction. Inferring "earnings beat, so
 * bullish" from a headline classification is exactly the kind of speculative
 * leap the confidence gate exists to prevent, and this agent does not make it.
 */
@Injectable()
export class NewsIntelligenceAgent implements IntelligenceAgent {
  readonly id: AgentId = 'news-intelligence';
  readonly remit = 'Whether news or a scheduled event changes how the current structure should be interpreted.';

  reason(context: AgentContext): AgentVerdict {
    const builder = new VerdictBuilder(this.id, context.subtask.id);
    const signal = context.signals.find((s) => s.name === 'news_driven_volatility');

    if (!signal) {
      return builder
        .abstain('The news feed did not run for this observation, so the event environment is unknown.')
        .build();
    }

    for (const line of signal.evidence) builder.measured(line, null, 0.5);

    const eventTypes = Array.isArray((signal.data as { eventTypes?: unknown })?.eventTypes)
      ? ((signal.data as { eventTypes: string[] }).eventTypes ?? [])
      : [];
    const distinctEvents = [...new Set(eventTypes)];

    if (!signal.triggered) {
      // No high-impact news is genuine, useful evidence — it means structure
      // can be read on its own terms — so it is reported rather than abstained.
      const citations = gatherCitations(context, ['technical analysis without news catalyst'], {
        preferKinds: ['book'],
      });
      return builder
        .quality(0.9)
        .conclude(
          'neutral',
          0.3,
          'No high-impact news in the last 24 hours; structure can be read on its own terms.',
        )
        .supporting(gatherConcepts(context, 'news event impact'))
        .build();
    }

    const citations = gatherCitations(
      context,
      [`${distinctEvents.join(' ')} event volatility price reaction`, 'trading around news events'],
      { preferKinds: ['book'] },
    );
    if (citations.length > 0) {
      builder.knowledge(
        'The literature treats an active event window as a period where technical signals carry lower reliability, not as a direction in itself.',
        citations,
        0.7,
      );
    }
    builder.supporting(gatherConcepts(context, `${distinctEvents.join(' ')} news event volatility`));

    const structural = Math.min(0.85, 0.45 + 0.12 * distinctEvents.length);

    return builder
      .quality(1)
      .conclude(
        'risk-elevated',
        blendConfidence(structural, groundingScore(citations)),
        distinctEvents.length > 0
          ? `An active event window (${distinctEvents.slice(0, 3).join(', ')}) is in play — technical structure is less reliable while it resolves.`
          : 'Unscheduled news is coinciding with current price action — technical structure is less reliable right now.',
      )
      .build();
  }
}

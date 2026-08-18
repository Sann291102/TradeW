import { Injectable } from '@nestjs/common';
import {
  AgentContext,
  IntelligenceAgent,
  VerdictBuilder,
  blendConfidence,
  gatherCitations,
  gatherConcepts,
  groundingScore,
  triggeredFrom,
} from './agent.contract';
import type { AgentId, AgentVerdict } from '../types';

/**
 * Trap Intelligence — sweeps, failed breakouts, expiry and participation traps.
 *
 * Composite by design, per `SENTINEL.md` §2-3: a single pattern is never a
 * trap call. One wick through a swing high is an ordinary bar; the same wick
 * with fading volume, into an expiry session, against a lopsided chain is a
 * different object entirely. This agent therefore requires corroboration
 * *within itself* before taking a stance — a second gate, below the run-level
 * corroboration gate, because trap warnings are the highest-cost false
 * positive Sentinel can produce.
 *
 * Signals come from the existing `TrapIntelligenceService`, unchanged.
 */
@Injectable()
export class TrapIntelligenceAgent implements IntelligenceAgent {
  readonly id: AgentId = 'trap-intelligence';
  readonly remit = 'Composite trap signatures — liquidity sweeps, failed breakouts, expiry and low-participation traps.';

  /** Independent trap signals required before a stance is taken at all. */
  private static readonly MIN_CORROBORATING_SIGNALS = 2;

  reason(context: AgentContext): AgentVerdict {
    const builder = new VerdictBuilder(this.id, context.subtask.id);

    if (!context.snapshot) {
      return builder.abstain('No market data available, so trap signatures cannot be evaluated.').build();
    }

    const triggered = triggeredFrom(context.signals, 'trap-safety');
    const all = context.signals.filter((s) => s.agent === 'trap-safety');

    if (all.length === 0) {
      return builder.abstain('The trap engine produced no signals for this observation.').build();
    }

    if (triggered.length === 0) {
      // Clean is a real, useful finding here — it is what makes the *presence*
      // of a trap signal meaningful when it does appear.
      return builder
        .quality(1)
        .measured(`${all.length} trap checks ran and none triggered`, all.length, 0.6)
        .conclude('neutral', 0.3, 'No trap signatures are present on the current structure.')
        .supporting(gatherConcepts(context, 'liquidity sweep false breakout trap'))
        .build();
    }

    for (const signal of triggered) {
      builder.measured(signal.evidence[0] ?? signal.name.replace(/_/g, ' '), null, Math.min(0.9, 0.4 + signal.weight));
      for (const extra of signal.evidence.slice(1, 3)) builder.derived(extra, null, 0.4);
    }

    const names = triggered.map((s) => s.name.replace(/_/g, ' '));
    const composite = triggered.reduce((sum, s) => sum + s.weight, 0);
    const corroborated = triggered.length >= TrapIntelligenceAgent.MIN_CORROBORATING_SIGNALS;

    const citations = gatherCitations(context, [`${names.join(' ')} trap stop hunt liquidity`], {
      preferKinds: ['book', 'knowledge-base'],
    });
    if (citations.length > 0) {
      builder.knowledge(
        `The corpus describes ${names[0]} as a signature that only carries weight when other evidence corroborates it.`,
        citations,
        corroborated ? 0.75 : 0.45,
      );
    }

    // Ontology check: do the triggered signatures actually cohere, or does the
    // knowledge base say some of them contradict each other? Two "traps" the
    // ontology marks as mutually contradictory are ambiguity, not corroboration.
    const conceptIds = context.graph.detect(names.join(' ')).map((c) => c.id);
    const tensions = context.graph.tensionsAmong(conceptIds);
    for (const tension of tensions) {
      builder.derived(
        `Knowledge-base tension: ${tension.reads}${tension.note ? ` — ${tension.note}` : ''}`,
        false,
        0.5,
      );
    }

    builder.supporting(gatherConcepts(context, names.join(' ')));

    if (!corroborated) {
      // One signal is explicitly not a trap call. Reported as context so the
      // reader sees it, but with a stance and confidence that keep it well
      // below the surfacing gate.
      return builder
        .quality(1)
        .conclude(
          'neutral',
          Math.min(0.35, composite),
          `A single ${names[0]} signature is present, which on its own is not a trap — trap detection requires corroborating signals.`,
        )
        .build();
    }

    // Contradicting concepts reduce, not raise, the read: the evidence is
    // conflicting rather than mounting.
    const coherence = tensions.length > 0 ? 0.6 : 1;
    const structural = Math.min(0.95, composite * coherence);

    return builder
      .quality(1)
      .conclude(
        'risk-elevated',
        blendConfidence(structural, groundingScore(citations)),
        `${triggered.length} corroborating trap signatures are present (${names.slice(0, 3).join(', ')}), which together resemble a ${names[0]} pattern.`,
      )
      .build();
  }
}

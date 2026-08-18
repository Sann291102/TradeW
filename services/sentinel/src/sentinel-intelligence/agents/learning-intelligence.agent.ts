import { Injectable } from '@nestjs/common';
import {
  AgentContext,
  IntelligenceAgent,
  VerdictBuilder,
  gatherCitations,
  gatherConcepts,
  groundingScore,
} from './agent.contract';
import type { AgentId, AgentVerdict } from '../types';

/**
 * Learning Intelligence — what should the trader understand about this?
 *
 * The one agent whose output is purely educational. It takes no directional
 * stance at all: its job is to surface the concepts and passages that explain
 * what the other agents are observing, so a reader can check the reasoning
 * against the source rather than trusting the score.
 *
 * Because its stance is always `neutral`, it can never be one of the two
 * corroborating agents that clear the surfacing gate. That is deliberate — an
 * agent that always agrees would otherwise silently satisfy the corroboration
 * requirement on every run, and the gate would stop meaning anything.
 */
@Injectable()
export class LearningIntelligenceAgent implements IntelligenceAgent {
  readonly id: AgentId = 'learning-intelligence';
  readonly remit = 'The concepts and source passages that explain the current situation. Educational only.';

  reason(context: AgentContext): AgentVerdict {
    const builder = new VerdictBuilder(this.id, context.subtask.id);

    // Build the query from what the run is actually about, so the reading
    // follows the observation rather than the raw question text alone.
    const profile = context.snapshot?.marketProfile;
    const strategyNames = context.detections.slice(0, 2).map((d) => d.strategyName);
    const queryParts = [
      context.understood.rawText,
      profile ? `${profile.type} ${profile.structure}` : '',
      ...strategyNames,
      ...context.understood.indicators,
    ].filter((p) => p && p.trim().length > 0);

    if (queryParts.length === 0) {
      return builder
        .abstain('Nothing in this run was specific enough to retrieve relevant reading material against.')
        .build();
    }

    const query = queryParts.join(' ');
    const citations = gatherCitations(context, [query], { limit: 6, preferKinds: ['book', 'knowledge-base'] });
    const concepts = gatherConcepts(context, query, 5);

    if (citations.length === 0 && concepts.length === 0) {
      return builder
        .abstain(
          'The learned corpus has nothing indexed that bears on this situation. Run the corpus ingestion if this is unexpected.',
        )
        .build();
    }

    if (citations.length > 0) {
      builder.knowledge(
        `${citations.length} passage${citations.length === 1 ? '' : 's'} across ${new Set(citations.map((c) => c.sourceId)).size} source${new Set(citations.map((c) => c.sourceId)).size === 1 ? '' : 's'} bear directly on this situation.`,
        citations,
        0.7,
      );
    }

    // Concept explainers are the trader-facing prose the ontology was authored
    // to provide — quoted rather than paraphrased so the education is the
    // reviewed text, not a re-generation of it.
    for (const concept of concepts.slice(0, 3)) {
      const explainer = context.graph.explainerFor(concept.conceptId);
      if (!explainer) continue;
      const firstSentence = explainer.split(/(?<=[.!?])\s+/)[0] ?? explainer;
      if (concept.citations.length > 0) {
        builder.knowledge(`${concept.name}: ${firstSentence}`, concept.citations, concept.weight);
      } else {
        builder.derived(`${concept.name}: ${firstSentence}`, null, concept.weight * 0.7);
      }
    }

    builder.supporting(concepts);

    const grounding = groundingScore(citations);
    const headline =
      concepts.length > 0
        ? `Relevant concepts: ${concepts.slice(0, 3).map((c) => c.name).join(', ')}.`
        : `${citations.length} relevant passages found in the learned corpus.`;

    return builder
      .quality(citations.length > 0 ? 1 : 0.6)
      // Confidence here reports how well-supported the *reading material* is,
      // not a market view. The neutral stance keeps it out of corroboration.
      .conclude('neutral', Math.min(0.8, 0.3 + grounding * 0.5), headline)
      .build();
  }
}

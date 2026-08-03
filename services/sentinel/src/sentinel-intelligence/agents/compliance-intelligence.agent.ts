import { Injectable } from '@nestjs/common';
import { enforceVocabulary, hasDirectiveLanguage } from '../../vocabulary/vocabulary';
import {
  AgentContext,
  IntelligenceAgent,
  VerdictBuilder,
  gatherCitations,
} from './agent.contract';
import type { AgentId, AgentVerdict } from '../types';

/**
 * Compliance Intelligence — the observation-only boundary, checked in-run.
 *
 * Runs last, over the text the other agents produced, and reports what it
 * found. It is an *auditor*, not the enforcer: the actual enforcement is
 * `enforceVocabulary` applied to the synthesized output on its way out, which
 * rewrites rather than blocks. Two layers, doing different jobs — this one
 * makes a breach visible in the audit trail even when the rewriter silently
 * fixed it, because a model that keeps producing directives is a problem worth
 * seeing rather than one worth papering over.
 *
 * The stance is always `neutral` or `risk-elevated`, never directional, so a
 * compliance finding can never be mistaken for a market view.
 */
@Injectable()
export class ComplianceIntelligenceAgent implements IntelligenceAgent {
  readonly id: AgentId = 'compliance-intelligence';
  readonly remit = 'Audits every agent’s output for directive language and records the observation-only boundary.';

  /** Text produced earlier in this run, injected by the engine before this agent runs. */
  private pendingText: string[] = [];

  /**
   * Hand this agent the text to audit.
   *
   * Deliberately a setter rather than an extra `AgentContext` field: the other
   * nine agents have no business seeing each other's prose, and widening the
   * shared context would make cross-agent contamination possible by accident.
   */
  withText(text: string[]): this {
    this.pendingText = text;
    return this;
  }

  reason(context: AgentContext): AgentVerdict {
    const builder = new VerdictBuilder(this.id, context.subtask.id);
    const texts = this.pendingText.filter((t) => t && t.trim().length > 0);
    this.pendingText = [];

    if (texts.length === 0) {
      return builder
        .quality(0.5)
        .conclude('neutral', 0.3, 'No agent produced user-facing text in this run, so there was nothing to audit.')
        .build();
    }

    const breaches: { text: string; violations: string[] }[] = [];
    for (const text of texts) {
      const { violations } = enforceVocabulary(text);
      if (violations.length > 0) breaches.push({ text, violations });
    }

    // A residual probe on the *rewritten* text: if directive vocabulary
    // survives the rewriter, the rewrite table has a gap and that is a
    // materially more serious finding than a phrase it caught.
    const residual = texts
      .map((t) => enforceVocabulary(t).clean)
      .filter((clean) => hasDirectiveLanguage(clean));

    builder.measured(`${texts.length} agent statement(s) audited for directive language`, texts.length, 0.4);

    if (breaches.length === 0 && residual.length === 0) {
      return builder
        .quality(1)
        .conclude('neutral', 0.8, 'All agent output is observational — no directive language was produced.')
        .build();
    }

    for (const breach of breaches.slice(0, 3)) {
      builder.derived(
        `Directive phrasing rewritten by the vocabulary enforcer: ${breach.violations.slice(0, 3).map((v) => `"${v}"`).join(', ')}`,
        breach.violations.length,
        0.7,
      );
    }

    if (residual.length > 0) {
      builder.derived(
        `${residual.length} statement(s) still contain directive vocabulary after enforcement — the rewrite table has a gap`,
        residual.length,
        0.95,
      );
    }

    const citations = gatherCitations(context, ['investment advice boundary disclosure research analyst'], {
      preferKinds: ['vault', 'doc', 'knowledge-base'],
    });
    if (citations.length > 0) {
      builder.knowledge(
        'The platform boundary is explicit: analysis and education only, never a directive to trade.',
        citations,
        0.6,
      );
    }

    return builder
      .quality(1)
      .conclude(
        residual.length > 0 ? 'risk-elevated' : 'neutral',
        residual.length > 0 ? 0.9 : 0.6,
        residual.length > 0
          ? `${residual.length} statement(s) survived vocabulary enforcement with directive language intact — this run's output must not be surfaced as written.`
          : `${breaches.length} directive phrase(s) were rewritten into observational language before output.`,
      )
      .build();
  }
}

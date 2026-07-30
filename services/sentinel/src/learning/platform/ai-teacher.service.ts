import { Injectable } from '@nestjs/common';
import { KnowledgeRetrievalService } from '../../reasoning/knowledge-retrieval.service';
import { StrategyRegistryService } from '../strategy-registry.service';
import { enforceVocabulary } from '../../vocabulary/vocabulary';
import { ConceptSourceService } from './concept-source.service';
import { courseSpec } from './course-catalog';
import { parseLessonId } from './lesson-generator.service';

export interface TeacherAnswer {
  answer: string;
  /** true when the answer was grounded in the concept graph / Brain / registry */
  usedInternalKnowledge: boolean;
  sources: { kind: 'concept' | 'strategy' | 'brain'; ref: string; summary: string }[];
  /** the concept/strategy the current lesson is about */
  lessonConceptId: string | null;
}

/**
 * AI Teacher — "Ask Sentinel" inside a lesson.
 *
 * Answers are grounded, in priority order, in:
 *   1. the lesson's own concept (definition, explainer, cues, relations) or
 *      strategy registry entry — the most specific internal knowledge,
 *   2. the Brain's retrieved memories (which include the ingested book
 *      knowledge, namespace `sentinel-learning`) via the Phase 2 retriever,
 *      reusing its cache and multi-factor ranking — no new retrieval stack.
 *
 * The teacher only falls back to a generic "I don't have internal knowledge on
 * that yet" when BOTH sources are empty, satisfying "do not answer with a
 * generic response if internal knowledge exists". Every answer passes the
 * shared vocabulary compliance filter, so it can never emit a trade directive.
 */
@Injectable()
export class AiTeacherService {
  constructor(
    private readonly concepts: ConceptSourceService,
    private readonly strategies: StrategyRegistryService,
    private readonly retrieval: KnowledgeRetrievalService,
  ) {}

  async ask(lessonId: string, question: string): Promise<TeacherAnswer> {
    const parsed = parseLessonId(lessonId);
    const spec = parsed ? courseSpec(parsed.courseId) : null;
    const conceptId = parsed?.conceptId ?? null;
    const sources: TeacherAnswer['sources'] = [];
    const parts: string[] = [];

    // 1. Lesson-local knowledge — concept or strategy.
    if (conceptId && spec?.fromStrategyRegistry) {
      const s = this.strategies.get(conceptId);
      if (s) {
        parts.push(`${s.name}: ${s.educational}`);
        sources.push({ kind: 'strategy', ref: s.id, summary: s.purpose });
      }
    } else if (conceptId) {
      const c = this.concepts.get(conceptId);
      if (c) {
        parts.push(`${c.name} — ${c.explainer || c.definition}`);
        sources.push({ kind: 'concept', ref: c.id, summary: c.summary });
        // Pull in a couple of related concepts for context.
        for (const rel of c.relations.slice(0, 2)) {
          const t = this.concepts.get(rel.to);
          if (t) sources.push({ kind: 'concept', ref: t.id, summary: `${c.name} ${rel.type.replace(/_/g, ' ')} ${t.name}` });
        }
      }
    }

    // 2. Brain retrieval — question + lesson topic, across sentinel + sentinel-learning.
    const topic = conceptId ? conceptId.replace(/-/g, ' ') : '';
    try {
      const result = await this.retrieval.retrieve({ query: `${topic} ${question}`.trim(), limit: 4 });
      for (const item of result.items) {
        const summary = item.hit.record.summary;
        if (summary && !parts.some((p) => p.includes(summary))) {
          parts.push(summary);
          sources.push({ kind: 'brain', ref: item.hit.record.id, summary });
        }
      }
    } catch {
      // Retrieval is additive — a Brain outage still lets the concept answer stand.
    }

    const usedInternalKnowledge = parts.length > 0;
    const answer = usedInternalKnowledge
      ? clean(this.compose(question, parts))
      : clean(
          "Sentinel doesn't have internal knowledge on that yet. As more concepts and books are ingested into the knowledge base, this answer will improve. Try rephrasing around the lesson's core concept.",
        );

    return { answer, usedInternalKnowledge, sources: sources.slice(0, 6), lessonConceptId: conceptId };
  }

  private compose(question: string, parts: string[]): string {
    const body = parts.slice(0, 4).join(' ');
    return `${body} (In answer to: "${question.trim()}".) This is educational context drawn from Sentinel's knowledge base, not a trade instruction.`;
  }
}

function clean(text: string): string {
  return enforceVocabulary(text).clean;
}

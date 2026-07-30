import { Injectable } from '@nestjs/common';
import { Concept } from '../../brain/ontology/concept.schema';
import { RELATIONS, RelationType } from '../../brain/ontology/relations';
import { StrategyRegistryService } from '../strategy-registry.service';
import { enforceVocabulary } from '../../vocabulary/vocabulary';
import { ConceptSourceService } from './concept-source.service';
import { courseSpec } from './course-catalog';
import { parseLessonId } from './lesson-generator.service';
import { Quiz, QuizQuestion } from './types';

/**
 * Quiz Generator — builds a quiz for a lesson from its concept's structured
 * fields and its domain peers (for distractors).
 *
 * Deterministic: no randomness (banned in this environment and undesirable for
 * caching). The correct-answer position is derived from a stable hash of the
 * concept id so it is not always first, but is reproducible. Every question
 * carries an explanation shown after answering. Distractors are real peer
 * concepts, never nonsense, so a wrong answer is still educational.
 */
@Injectable()
export class QuizGeneratorService {
  constructor(
    private readonly concepts: ConceptSourceService,
    private readonly strategies: StrategyRegistryService,
  ) {}

  generate(lessonId: string): Quiz | null {
    const parsed = parseLessonId(lessonId);
    if (!parsed) return null;
    const spec = courseSpec(parsed.courseId);
    if (!spec) return null;

    const questions = spec.fromStrategyRegistry
      ? this.strategyQuestions(lessonId, parsed.conceptId)
      : this.conceptQuestions(lessonId, parsed.conceptId);

    return questions ? { lessonId, courseId: parsed.courseId, questions } : null;
  }

  private conceptQuestions(lessonId: string, conceptId: string): QuizQuestion[] | null {
    const c = this.concepts.get(conceptId);
    if (!c) return null;
    const peers = this.concepts.inDomain(c.domain).filter((p) => p.id !== c.id);
    const questions: QuizQuestion[] = [];

    // 1. Multiple choice — which definition matches the concept.
    questions.push(
      this.mcq(
        `${lessonId}:def`,
        `Which statement best describes ${c.name}?`,
        clean(c.summary),
        peers.slice(0, 3).map((p) => clean(p.summary)),
        clean(`${c.name}: ${c.definition}`),
        c.id,
      ),
    );

    // 2. True/False — an observable cue is genuinely a cue for this concept.
    if (c.observableWhen.length > 0) {
      questions.push({
        id: `${lessonId}:tf`,
        type: 'true-false',
        prompt: clean(`True or false: "${c.observableWhen[0]}" is an observable cue for ${c.name}.`),
        options: ['True', 'False'],
        answerIndex: 0,
        explanation: clean(`True. ${c.name} is suggested when: ${c.observableWhen[0]}.`),
        conceptId: c.id,
      });
    }

    // 3. Scenario — a relation-based reasoning question.
    const rel = c.relations.find((r) => this.concepts.get(r.to));
    if (rel) {
      const target = this.concepts.get(rel.to)!;
      const reads = RELATIONS[rel.type as RelationType]?.reads ?? 'relates to';
      const distractors = peers
        .filter((p) => p.id !== target.id)
        .slice(0, 3)
        .map((p) => clean(p.name));
      questions.push(
        this.mcq(
          `${lessonId}:rel`,
          `In the knowledge graph, ${c.name} ${reads} which of these?`,
          clean(target.name),
          distractors,
          clean(`${c.name} ${reads} ${target.name}${rel.note ? ` — ${rel.note}` : ''}.`),
          c.id,
        ),
      );
    }

    return questions.length > 0 ? questions : null;
  }

  private strategyQuestions(lessonId: string, strategyId: string): QuizQuestion[] | null {
    const s = this.strategies.get(strategyId);
    if (!s) return null;
    const peers = this.strategies.list().filter((x) => x.id !== s.id);
    const questions: QuizQuestion[] = [];

    questions.push(
      this.mcq(
        `${lessonId}:purpose`,
        `What is ${s.name} designed to study?`,
        clean(s.purpose),
        peers.slice(0, 3).map((p) => clean(p.purpose)),
        clean(`${s.name}: ${s.purpose}`),
        s.id,
      ),
    );

    if (s.whenNotToUse.length > 0) {
      questions.push({
        id: `${lessonId}:tf`,
        type: 'true-false',
        prompt: clean(`True or false: ${s.name} is a good fit when "${s.whenNotToUse[0]}".`),
        options: ['True', 'False'],
        answerIndex: 1,
        explanation: clean(`False. ${s.name} should not be used when: ${s.whenNotToUse[0]}.`),
        conceptId: s.id,
      });
    }

    if (s.regimes.length > 0) {
      const allRegimes = ['trending', 'ranging', 'volatile', 'breakout', 'accumulation', 'distribution'];
      const wrong = allRegimes.filter((r) => !s.regimes.includes(r)).slice(0, 3);
      questions.push(
        this.mcq(
          `${lessonId}:regime`,
          `Which market regime best suits ${s.name}?`,
          clean(s.regimes[0]),
          wrong.map(clean),
          clean(`${s.name} suits ${s.regimes.join(', ')} regimes.`),
          s.id,
        ),
      );
    }

    return questions.length > 0 ? questions : null;
  }

  /** Build an MCQ, placing the correct option at a stable hash-derived index. */
  private mcq(id: string, prompt: string, correct: string, distractors: string[], explanation: string, conceptId: string): QuizQuestion {
    const uniqueDistractors = distractors.filter((d) => d && d !== correct);
    const options = [correct, ...uniqueDistractors];
    const answerIndex = uniqueDistractors.length === 0 ? 0 : hash(id) % options.length;
    // Move `correct` from index 0 to answerIndex deterministically.
    if (answerIndex !== 0) {
      options[0] = options[answerIndex];
      options[answerIndex] = correct;
    }
    return { id, type: 'multiple-choice', prompt: clean(prompt), options, answerIndex, explanation: clean(explanation), conceptId };
  }
}

function clean(text: string): string {
  return enforceVocabulary(text).clean;
}

/** Small stable string hash (djb2), used only for deterministic option placement. */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

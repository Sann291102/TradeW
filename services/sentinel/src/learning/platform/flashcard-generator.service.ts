import { Injectable } from '@nestjs/common';
import { Concept } from '../../brain/ontology/concept.schema';
import { StrategyRegistryService } from '../strategy-registry.service';
import { enforceVocabulary } from '../../vocabulary/vocabulary';
import { ConceptSourceService } from './concept-source.service';
import { CourseGeneratorService } from './course-generator.service';
import { courseSpec } from './course-catalog';
import { parseLessonId } from './lesson-generator.service';
import { Flashcard, FlashcardDeck } from './types';

/**
 * Flashcard Generator — builds spaced-repetition cards from definitions,
 * indicators, patterns, trading rules and important concepts.
 *
 * A card's category is derived from the concept's domain (technical-analysis →
 * indicator, patterns → pattern, risk-management → rule, …) so a deck can be
 * filtered by kind. Fronts and backs are composed from the concept's own
 * fields — original prose, never book text.
 */
@Injectable()
export class FlashcardGeneratorService {
  constructor(
    private readonly concepts: ConceptSourceService,
    private readonly strategies: StrategyRegistryService,
    private readonly courses: CourseGeneratorService,
  ) {}

  /** Cards for a single lesson (its concept + immediate cues). */
  forLesson(lessonId: string): FlashcardDeck | null {
    const parsed = parseLessonId(lessonId);
    if (!parsed) return null;
    const spec = courseSpec(parsed.courseId);
    if (!spec) return null;

    const cards = spec.fromStrategyRegistry
      ? this.strategyCards(parsed.conceptId)
      : this.conceptCards(parsed.conceptId);
    return cards.length > 0 ? { lessonId, courseId: parsed.courseId, cards } : null;
  }

  /** A deck for an entire course — one definition card per lesson, plus cue cards. */
  forCourse(courseId: string): FlashcardDeck | null {
    if (!courseSpec(courseId)) return null;
    const stubs = this.courses.lessonStubs(courseId);
    const cards: Flashcard[] = [];
    const spec = courseSpec(courseId)!;
    for (const stub of stubs) {
      cards.push(...(spec.fromStrategyRegistry ? this.strategyCards(stub.conceptId) : this.conceptCards(stub.conceptId)).slice(0, 2));
    }
    return cards.length > 0 ? { courseId, cards } : null;
  }

  private conceptCards(conceptId: string): Flashcard[] {
    const c = this.concepts.get(conceptId);
    if (!c) return [];
    const category = categoryFor(c);
    const cards: Flashcard[] = [
      { id: `fc::${c.id}::def`, front: clean(`What is ${c.name}?`), back: clean(c.definition || c.summary), category, conceptId: c.id },
    ];
    if (c.observableWhen.length > 0) {
      cards.push({
        id: `fc::${c.id}::cue`,
        front: clean(`How do you spot ${c.name}?`),
        back: clean(c.observableWhen.join('; ')),
        category,
        conceptId: c.id,
      });
    }
    if (c.aliases.length > 0) {
      cards.push({
        id: `fc::${c.id}::alias`,
        front: clean(`${c.name} is also known as…`),
        back: clean(c.aliases.join(', ')),
        category: 'concept',
        conceptId: c.id,
      });
    }
    return cards;
  }

  private strategyCards(strategyId: string): Flashcard[] {
    const s = this.strategies.get(strategyId);
    if (!s) return [];
    const cards: Flashcard[] = [
      { id: `fc::${s.id}::purpose`, front: clean(`What does ${s.name} study?`), back: clean(s.purpose), category: 'rule', conceptId: s.id },
    ];
    if (s.whenNotToUse.length > 0) {
      cards.push({
        id: `fc::${s.id}::avoid`,
        front: clean(`When should you NOT use ${s.name}?`),
        back: clean(s.whenNotToUse.join('; ')),
        category: 'rule',
        conceptId: s.id,
      });
    }
    return cards;
  }
}

function categoryFor(c: Concept): Flashcard['category'] {
  switch (c.domain) {
    case 'technical-analysis':
      return 'indicator';
    case 'patterns':
      return 'pattern';
    case 'risk-management':
      return 'rule';
    case 'glossary':
      return 'definition';
    default:
      return 'concept';
  }
}

function clean(text: string): string {
  return enforceVocabulary(text).clean;
}

/**
 * Phase 4 (Slice 1) — Learning Platform generation-engine tests.
 *
 * Deterministic, DB-free. Wires the generators against the REAL knowledge base
 * (via OntologyLoaderService + StrategyRegistryService) so the assertions run
 * on genuine concept content, then verifies:
 *   - courses generate with dynamic (non-hardcoded) lesson counts
 *   - lessons generate with every required section, from concept fields
 *   - no copyrighted book text is copied (structural check)
 *   - quizzes generate (MCQ/true-false/scenario) with explanations + valid answers
 *   - flashcards generate from definitions/cues
 *   - generation is deterministic (cache-safe)
 *   - compliance: no buy/sell directives in any generated text
 *
 *   npm run learning-platform:test
 */
import { OntologyLoaderService, resolveKnowledgeBaseDir } from '../src/brain/ontology/ontology-loader.service';
import { StrategyRegistryService } from '../src/learning/strategy-registry.service';
import { ConceptSourceService } from '../src/learning/platform/concept-source.service';
import { CourseGeneratorService } from '../src/learning/platform/course-generator.service';
import { LessonGeneratorService } from '../src/learning/platform/lesson-generator.service';
import { QuizGeneratorService } from '../src/learning/platform/quiz-generator.service';
import { FlashcardGeneratorService } from '../src/learning/platform/flashcard-generator.service';
import { FREE_COURSE_ID } from '../src/learning/platform/course-catalog';
import { Lesson } from '../src/learning/platform/types';

let passes = 0;
let failures = 0;

function section(name: string): void {
  console.log(`\n== ${name} ==`);
}
function test(name: string, body: () => void): void {
  try {
    body();
    passes++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(err as Error).message}`);
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
function assertEq<T>(a: T, b: T, m?: string): void {
  if (a !== b) throw new Error(m ?? `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ---- wire real generators (no DI container needed — plain construction) ----
const loader = new OntologyLoaderService(resolveKnowledgeBaseDir());
const conceptSource = new ConceptSourceService(loader);
conceptSource.reload();
const registry = new StrategyRegistryService();
const courses = new CourseGeneratorService(conceptSource, registry);
const lessons = new LessonGeneratorService(conceptSource, registry, courses);
const quizzes = new QuizGeneratorService(conceptSource, registry);
const flashcards = new FlashcardGeneratorService(conceptSource, registry, courses);

const DIRECTIVE = /\b(buy|sell|short)\s+(now|here|immediately)\b|\bentry\s*[:=]\s*[\d₹$]|\btarget\s*[:=]\s*[\d₹$]|\byou should (buy|sell)\b/i;

function allLessonText(l: Lesson): string {
  return [
    l.introduction,
    l.aiExplanation,
    l.summary,
    ...l.learningObjectives,
    ...l.visualConcepts,
    ...l.commonMistakes,
    ...l.practicalTips,
    ...l.keyTakeaways,
    ...l.realMarketExamples,
    ...l.tradingExamples.flatMap((e) => [e.title, e.context, e.outcome]),
  ].join('\n');
}

// ------------------------------------------------------------------ Courses
section('Course generation');
{
  const list = courses.listCourses();

  test('generates a full course catalogue', () => {
    assert(list.length >= 10, `expected >=10 courses, got ${list.length}`);
  });

  test('lesson counts are dynamic (derived from the knowledge graph, not uniform)', () => {
    const counts = list.map((c) => c.lessonCount);
    const distinct = new Set(counts);
    assert(distinct.size > 1, `lesson counts look hardcoded/uniform: ${counts.join(',')}`);
    // And they must match the concept source, not a magic number.
    const priceAction = courses.getCourse('price-action')!;
    assertEq(priceAction.lessonCount, conceptSource.inDomain('price-action').length, 'price-action count != concepts in domain');
  });

  test('exactly one free course (Trading Basics)', () => {
    const free = list.filter((c) => c.free);
    assertEq(free.length, 1);
    assertEq(free[0].id, FREE_COURSE_ID);
  });

  test('Strategies course is built from the registry (12 strategies)', () => {
    const strat = courses.getCourse('strategies')!;
    assertEq(strat.lessonCount, registry.list().length);
    assertEq(strat.source.kind, 'strategy');
  });

  test('every course lesson stub has a resolvable id', () => {
    for (const c of list) {
      for (const stub of c.lessons) {
        assert(stub.id.includes('::'), `bad stub id ${stub.id}`);
        assertEq(stub.id, `${c.id}::${stub.conceptId}`);
      }
    }
  });
}

// ------------------------------------------------------------------ Lessons
section('Lesson generation');
{
  const priceAction = courses.getCourse('price-action')!;
  assert(priceAction.lessons.length > 0, 'price-action has no lessons to test');
  const firstId = priceAction.lessons[0].id;
  const lesson = lessons.generate(firstId)!;

  test('generates a lesson from a concept', () => {
    assert(lesson, 'lesson not generated');
    assertEq(lesson.id, firstId);
  });

  test('lesson has every required section populated', () => {
    assert(lesson.introduction.length > 0, 'no introduction');
    assert(lesson.learningObjectives.length > 0, 'no objectives');
    assert(lesson.aiExplanation.length > 0, 'no AI explanation');
    assert(lesson.commonMistakes.length > 0, 'no common mistakes');
    assert(lesson.practicalTips.length > 0, 'no practical tips');
    assert(lesson.summary.length > 0, 'no summary');
    assert(lesson.keyTakeaways.length > 0, 'no key takeaways');
  });

  test('lesson content is sourced from the concept (provenance present)', () => {
    const c = conceptSource.get(lesson.conceptId)!;
    assert(c, 'concept missing');
    assertEq(lesson.source.conceptId, c.id);
    // The AI explanation is the concept's own original explainer/definition.
    assert(lesson.aiExplanation === cleanish(c.explainer) || lesson.aiExplanation === cleanish(c.definition), 'aiExplanation not from concept');
  });

  test('next-lesson chaining is correct', () => {
    assert(lesson.nextLesson, 'expected a next lesson');
    assertEq(lesson.nextLesson!.id, priceAction.lessons[1].id);
  });

  test('unknown lesson id returns null (graceful)', () => {
    assertEq(lessons.generate('price-action::does-not-exist'), null);
    assertEq(lessons.generate('garbage'), null);
  });

  test('strategy lessons generate from the registry', () => {
    const strat = courses.getCourse('strategies')!;
    const l = lessons.generate(strat.lessons[0].id)!;
    assert(l, 'strategy lesson not generated');
    assert(l.source.strategyId, 'expected strategyId in source');
    assert(l.aiExplanation.length > 0, 'no explanation');
  });

  test('every lesson carries a live-practice exercise where cues exist', () => {
    assert(lesson.practice, 'expected a practice exercise (concept has observable cues)');
    assert(lesson.practice!.successCriteria.length > 0, 'practice has no success criteria');
    assert(/educational/i.test(lesson.practice!.disclaimer), 'practice disclaimer missing');
  });
}

// -------------------------------------------------------- No copyrighted text
section('Copyright safety');
{
  test('lessons contain no book-length verbatim blocks (structural)', () => {
    // Every lesson field maps to a concept field; assert the lesson never
    // contains a suspiciously long single paragraph that would indicate a
    // pasted book excerpt (concept fields are short, curated prose).
    let maxParagraph = 0;
    for (const c of courses.listCourses()) {
      for (const stub of c.lessons.slice(0, 3)) {
        const l = lessons.generate(stub.id);
        if (!l) continue;
        for (const field of allLessonText(l).split('\n')) {
          maxParagraph = Math.max(maxParagraph, field.length);
        }
      }
    }
    assert(maxParagraph < 1200, `a generated paragraph is ${maxParagraph} chars — unexpectedly long, check for pasted text`);
  });
}

// ------------------------------------------------------------------- Quizzes
section('Quiz generation');
{
  const priceAction = courses.getCourse('price-action')!;
  const lessonId = priceAction.lessons[0].id;
  const quiz = quizzes.generate(lessonId)!;

  test('generates a quiz for a lesson', () => {
    assert(quiz, 'no quiz');
    assert(quiz.questions.length > 0, 'no questions');
  });

  test('includes multiple question types', () => {
    const types = new Set(quiz.questions.map((q) => q.type));
    assert(types.size >= 2, `expected >=2 question types, got ${[...types].join(',')}`);
  });

  test('every question has a valid answer index and an explanation', () => {
    for (const q of quiz.questions) {
      assert(q.options.length >= 2, `question ${q.id} has <2 options`);
      assert(q.answerIndex >= 0 && q.answerIndex < q.options.length, `bad answerIndex on ${q.id}`);
      assert(q.explanation.length > 0, `no explanation on ${q.id}`);
    }
  });

  test('MCQ distractors are distinct from the answer', () => {
    for (const q of quiz.questions.filter((x) => x.type === 'multiple-choice')) {
      const correct = q.options[q.answerIndex];
      const others = q.options.filter((_, i) => i !== q.answerIndex);
      assert(!others.includes(correct), `duplicate correct option in ${q.id}`);
    }
  });

  test('strategy quiz generates too', () => {
    const strat = courses.getCourse('strategies')!;
    const q = quizzes.generate(strat.lessons[0].id)!;
    assert(q && q.questions.length > 0, 'no strategy quiz');
  });
}

// ---------------------------------------------------------------- Flashcards
section('Flashcard generation');
{
  const priceAction = courses.getCourse('price-action')!;
  const deck = flashcards.forLesson(priceAction.lessons[0].id)!;

  test('generates flashcards for a lesson', () => {
    assert(deck && deck.cards.length > 0, 'no cards');
  });

  test('each card has a front, a back, and a category', () => {
    for (const card of deck.cards) {
      assert(card.front.length > 0 && card.back.length > 0, `empty card ${card.id}`);
      assert(['definition', 'indicator', 'pattern', 'rule', 'concept'].includes(card.category), `bad category ${card.category}`);
    }
  });

  test('course-wide deck aggregates across lessons', () => {
    const courseDeck = flashcards.forCourse('price-action')!;
    assert(courseDeck.cards.length >= deck.cards.length, 'course deck smaller than one lesson deck');
  });

  test('indicators course produces indicator-category cards', () => {
    const ind = courses.getCourse('indicators')!;
    if (ind.lessons.length > 0) {
      const d = flashcards.forLesson(ind.lessons[0].id)!;
      assert(d.cards.some((c) => c.category === 'indicator'), 'no indicator-category card in indicators course');
    }
  });
}

// --------------------------------------------------------------- Determinism
section('Determinism & caching-safety');
{
  test('same lesson id generates byte-identical output', () => {
    const id = courses.getCourse('price-action')!.lessons[0].id;
    const a = JSON.stringify(lessons.generate(id));
    const b = JSON.stringify(lessons.generate(id));
    assertEq(a, b, 'lesson generation is not deterministic');
  });
  test('same quiz id generates identical output', () => {
    const id = courses.getCourse('price-action')!.lessons[0].id;
    assertEq(JSON.stringify(quizzes.generate(id)), JSON.stringify(quizzes.generate(id)));
  });
}

// --------------------------------------------------------------- Compliance
section('Compliance (no directives)');
{
  test('no generated lesson text contains a buy/sell directive', () => {
    for (const c of courses.listCourses()) {
      for (const stub of c.lessons) {
        const l = lessons.generate(stub.id);
        if (!l) continue;
        const text = allLessonText(l);
        assert(!DIRECTIVE.test(text), `directive leaked in lesson ${l.id}: ${(text.match(DIRECTIVE) || [])[0]}`);
      }
    }
  });
  test('no generated quiz text contains a buy/sell directive', () => {
    for (const c of courses.listCourses()) {
      for (const stub of c.lessons) {
        const q = quizzes.generate(stub.id);
        if (!q) continue;
        const text = q.questions.flatMap((x) => [x.prompt, x.explanation, ...x.options]).join('\n');
        assert(!DIRECTIVE.test(text), `directive leaked in quiz ${stub.id}`);
      }
    }
  });
}

function cleanish(s: string): string {
  // mirror of enforceVocabulary's no-op on already-clean text; the concept
  // fields are lint-clean, so a plain identity is the expected transform here.
  return s;
}

console.log(`\n---`);
console.log(`Results: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);

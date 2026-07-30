/**
 * Types for the AI Learning Platform (Phase 4).
 *
 * Everything here is GENERATED at runtime from the concept ontology
 * (knowledge-base) and the Strategy Registry — no lesson content is authored
 * or stored in these types. The types only describe the shape of the
 * generated output.
 */

export type CourseTier = 'Beginner' | 'Intermediate' | 'Advanced' | 'All levels';

/** A generated learning path (course). Lesson count is derived, never hardcoded. */
export interface Course {
  id: string;
  name: string;
  tier: CourseTier;
  /** short generated blurb describing the course scope */
  summary: string;
  /** number of lessons available — computed from the knowledge graph */
  lessonCount: number;
  /** true for the single free course (Trading Basics); everything else is premium */
  free: boolean;
  /** ordered lesson stubs (id + title only) for the path view */
  lessons: LessonStub[];
  /** which knowledge domains / strategy sources back this course */
  source: { kind: 'domain' | 'strategy' | 'mixed'; domains: string[] };
}

export interface LessonStub {
  id: string;
  title: string;
  /** concept id or strategy id this lesson is generated from */
  conceptId: string;
  order: number;
}

/** A fully generated, structured lesson. Original educational text only. */
export interface Lesson {
  id: string;
  courseId: string;
  conceptId: string;
  title: string;
  order: number;
  introduction: string;
  learningObjectives: string[];
  aiExplanation: string;
  /** observable cues rendered as "visual concepts" when the concept has them */
  visualConcepts: string[];
  tradingExamples: LessonExample[];
  realMarketExamples: string[];
  commonMistakes: string[];
  practicalTips: string[];
  summary: string;
  keyTakeaways: string[];
  /** related concepts pulled from the knowledge graph, for further reading */
  relatedConcepts: { id: string; name: string; relation: string }[];
  nextLesson: LessonStub | null;
  /** live-practice exercise offered on completion, when the concept supports one */
  practice: PracticeExercise | null;
  /** provenance — which concept/strategy and domain this was generated from */
  source: { conceptId: string; domain: string; strategyId?: string };
}

export interface LessonExample {
  title: string;
  context: string;
  outcome: string;
  date?: string;
}

export type QuizQuestionType = 'multiple-choice' | 'true-false' | 'scenario';

export interface QuizQuestion {
  id: string;
  type: QuizQuestionType;
  prompt: string;
  options: string[];
  /** index into `options` of the correct answer */
  answerIndex: number;
  /** shown after answering, regardless of correctness */
  explanation: string;
  conceptId: string;
}

export interface Quiz {
  lessonId: string;
  courseId: string;
  questions: QuizQuestion[];
}

export interface Flashcard {
  id: string;
  front: string;
  back: string;
  category: 'definition' | 'indicator' | 'pattern' | 'rule' | 'concept';
  conceptId: string;
}

export interface FlashcardDeck {
  lessonId?: string;
  courseId: string;
  cards: Flashcard[];
}

/** A live-market practice exercise. Educational only — never an order. */
export interface PracticeExercise {
  id: string;
  conceptId: string;
  title: string;
  /** what the learner is asked to identify on a live chart */
  task: string;
  /** the observable cues that define a correct identification */
  successCriteria: string[];
  /** suggested symbols to practise on */
  suggestedSymbols: string[];
  disclaimer: string;
}

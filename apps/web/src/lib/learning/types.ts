/**
 * Types for the AI Learning Platform frontend — mirror the services/api
 * `/learning/*` responses (Slice 2). Kept minimal: only the fields the UI
 * renders.
 */

export type AccessReason = 'admin' | 'free' | 'pro' | 'requires_pro';

export interface LessonStub {
  id: string;
  title: string;
  conceptId: string;
  order: number;
}

export interface CourseCard {
  id: string;
  name: string;
  tier: string;
  summary: string;
  free: boolean;
  lessonCount: number;
  lessons: LessonStub[];
  locked: boolean;
  accessReason: AccessReason;
  progress: { completed: number; total: number; pct: number };
}

export interface CoursesResponse {
  isAdmin: boolean;
  hasPro: boolean;
  courses: CourseCard[];
  progress: {
    overallPct: number;
    streak: number;
    lastActivityAt: string | null;
    continueLearning: { lessonId: string; courseId: string } | null;
  };
}

export interface LessonExample {
  title: string;
  context: string;
  outcome: string;
  date?: string;
}

export interface PracticeExercise {
  id: string;
  conceptId: string;
  title: string;
  task: string;
  successCriteria: string[];
  suggestedSymbols: string[];
  disclaimer: string;
}

export interface Lesson {
  id: string;
  courseId: string;
  conceptId: string;
  title: string;
  order: number;
  introduction: string;
  learningObjectives: string[];
  aiExplanation: string;
  visualConcepts: string[];
  tradingExamples: LessonExample[];
  realMarketExamples: string[];
  commonMistakes: string[];
  practicalTips: string[];
  summary: string;
  keyTakeaways: string[];
  relatedConcepts: { id: string; name: string; relation: string }[];
  nextLesson: LessonStub | null;
  practice: PracticeExercise | null;
  source: { conceptId: string; domain: string; strategyId?: string };
}

export interface QuizQuestion {
  id: string;
  type: 'multiple-choice' | 'true-false' | 'scenario';
  prompt: string;
  options: string[];
  answerIndex: number;
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
  category: string;
  conceptId: string;
}

export interface TeacherAnswer {
  answer: string;
  usedInternalKnowledge: boolean;
  sources: { kind: string; ref: string; summary: string }[];
  lessonConceptId: string | null;
}

/** The upgrade payload returned by a locked course. */
export interface LockedPayload {
  locked: true;
  title: string;
  unlocks: string[];
  upgradeHref: string;
}

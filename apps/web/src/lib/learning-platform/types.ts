/**
 * Restored 2026-08-04 from archive/apps-web-learning-course-platform-superseded
 * (this file itself was never archived — only api.ts and the routes were —
 * so it's reconstructed here from services/api/src/learning/learning.controller.ts
 * and learning.service.ts, which still serve this exact shape unmodified).
 */

export interface CourseLesson {
  id: string;
  title: string;
  conceptId: string;
  order: number;
}

export interface CourseCard {
  id: string;
  name: string;
  free: boolean;
  lessonCount: number;
  tier: string;
  summary: string;
  lessons: CourseLesson[];
  locked: boolean;
  accessReason: 'admin' | 'free' | 'pro' | 'requires_pro';
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
    /** The most recent activity's course + first incomplete lesson within it
     *  (services/api's LearningProgressService.pickContinue) — `lessonId` was
     *  missing from this type though the API always returns it; corrected
     *  2026-08-05 so the frontend can link straight to the right lesson
     *  instead of guessing. */
    continueLearning: { lessonId: string; courseId: string } | null;
  };
}

export interface TradingExample {
  title: string;
  date?: string;
  context: string;
  outcome: string;
}

export interface PracticeExercise {
  title: string;
  task: string;
  successCriteria: string[];
  suggestedSymbols: string[];
  disclaimer: string;
}

export interface Lesson {
  id: string;
  title: string;
  introduction: string;
  learningObjectives: string[];
  aiExplanation: string;
  visualConcepts: string[];
  tradingExamples: TradingExample[];
  realMarketExamples: string[];
  commonMistakes: string[];
  practicalTips: string[];
  summary: string;
  keyTakeaways: string[];
  practice?: PracticeExercise;
  nextLesson?: { conceptId: string; title: string };
}

export interface QuizQuestion {
  id: string;
  prompt: string;
  options: string[];
  answerIndex: number;
  explanation: string;
}

export interface Quiz {
  questions: QuizQuestion[];
}

export interface Flashcard {
  id: string;
  category: string;
  front: string;
  back: string;
}

export interface TeacherAnswer {
  answer: string;
  usedInternalKnowledge: boolean;
  sources: unknown[];
  lessonConceptId: string | null;
}

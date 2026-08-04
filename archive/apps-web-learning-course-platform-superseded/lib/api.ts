'use client';

import { api } from '@/lib/api';
import type { CoursesResponse, Flashcard, Lesson, PracticeExercise, Quiz, TeacherAnswer } from './types';

/**
 * Thin, typed wrappers over the `/learning/*` API (Slice 2). No caching here —
 * the API + Sentinel already cache generation; these just type the responses.
 */
export const learningApi = {
  courses: () => api('/learning/courses') as Promise<CoursesResponse>,

  lesson: (lessonId: string) =>
    api(`/learning/lessons/${encodeURIComponent(lessonId)}`) as Promise<{ found: boolean; lesson?: Lesson }>,

  quiz: (lessonId: string) =>
    api(`/learning/lessons/${encodeURIComponent(lessonId)}/quiz`) as Promise<{ found: boolean; quiz?: Quiz }>,

  flashcards: (lessonId: string) =>
    api(`/learning/lessons/${encodeURIComponent(lessonId)}/flashcards`) as Promise<{ found: boolean; deck?: { cards: Flashcard[] } }>,

  practice: (lessonId: string) =>
    api(`/learning/lessons/${encodeURIComponent(lessonId)}/practice`) as Promise<{ found: boolean; practice?: PracticeExercise }>,

  ask: (lessonId: string, question: string) =>
    api('/learning/teacher', { method: 'POST', body: JSON.stringify({ lessonId, question }) }) as Promise<TeacherAnswer>,

  completeLesson: (lessonId: string) =>
    api('/learning/progress/lesson-complete', { method: 'POST', body: JSON.stringify({ lessonId }) }) as Promise<{ ok: boolean }>,

  recordQuiz: (lessonId: string, score: number, total: number) =>
    api('/learning/progress/quiz', { method: 'POST', body: JSON.stringify({ lessonId, score, total }) }) as Promise<{ ok: boolean }>,

  // admin
  refresh: () => api('/learning/admin/refresh', { method: 'POST', body: '{}' }),
  regenerate: (lessonId: string) =>
    api('/learning/admin/regenerate', { method: 'POST', body: JSON.stringify({ lessonId }) }) as Promise<{ found: boolean; lesson?: Lesson }>,
};

/** Compose the API lesson id from a course id + concept id (URL-friendly parts). */
export function lessonIdOf(courseId: string, conceptId: string): string {
  return `${courseId}::${conceptId}`;
}

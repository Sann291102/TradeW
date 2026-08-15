'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { learningApi } from '@/lib/learning-platform/api';
import type { CoursesResponse } from '@/lib/learning-platform/types';
import { qk } from './keys';

/**
 * The course catalogue with its progress annotations.
 *
 * `/learning/courses` is the single response that drives the Learning hub, the
 * per-course path page and the lock/upgrade states — it arrives already
 * annotated with entitlement and completion, which is why one request can
 * serve all three. Both pages called it independently, so walking from the hub
 * into a course fetched the identical payload a second time and showed a
 * "Loading…" line while doing it, for data the previous screen had in hand.
 *
 * One key means the course page paints from cache on arrival. It is reference
 * data that only changes when the user completes something, so it takes the
 * default five-minute staleTime and is invalidated explicitly by the mutations
 * below rather than polled.
 */
export function useCourses() {
  return useQuery({
    queryKey: qk.learning.courses(),
    queryFn: () => learningApi.courses(),
  });
}

/** Invalidate everything a progress change can alter. */
function useInvalidateLearning() {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: qk.learning.all });
}

/**
 * Marking a lesson complete used to update only the lesson screen's own state.
 * The hub's progress ring, the streak strip and the course page's completion
 * ticks all read `/learning/courses`, and none of them were told — so the user
 * finished a lesson, went back, and saw the old count. Invalidating the
 * catalogue is what makes the tick appear everywhere it should.
 */
export function useCompleteLesson() {
  const invalidate = useInvalidateLearning();
  return useMutation({
    mutationFn: (lessonId: string) => learningApi.completeLesson(lessonId),
    onSuccess: invalidate,
  });
}

export function useRecordQuiz() {
  const invalidate = useInvalidateLearning();
  return useMutation({
    mutationFn: ({ lessonId, score, total }: { lessonId: string; score: number; total: number }) =>
      learningApi.recordQuiz(lessonId, score, total),
    onSuccess: invalidate,
  });
}

/** Admin-only knowledge rebuild; refreshes the catalogue it regenerates. */
export function useRefreshKnowledge() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => learningApi.refresh(),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: qk.learning.all });
    },
  });
}

export type { CoursesResponse };

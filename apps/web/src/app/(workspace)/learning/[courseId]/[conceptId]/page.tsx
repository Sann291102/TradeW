import { LessonClient } from '@/components/learning/LessonClient';

export const metadata = { title: 'Lesson — TradeW Learning' };

/** Restored 2026-08-04. Generated lesson viewer. `courseId` + `conceptId` compose the lesson id. */
export default async function LessonPage({ params: paramsPromise }: { params: Promise<{ courseId: string; conceptId: string }> }) {
  // Next 15+ passes route params as a Promise.
  const params = await paramsPromise;
  return <LessonClient courseId={params.courseId} conceptId={params.conceptId} />;
}
